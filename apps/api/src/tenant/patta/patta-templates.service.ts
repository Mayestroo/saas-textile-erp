import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit.service.js';
import { canonicalizeBusinessName } from '../models/business-name.js';
import { modelNotFound, postgresConstraint } from '../models/model-errors.js';
import { pattaModelInactive, pattaTemplateNameConflict, pattaTemplateNotFound, pattaVersionConflict } from './patta-errors.js';
import type { CreatePattaTemplateDto } from './dto/create-patta-template.dto.js';
import type { ListPattaTemplatesDto } from './dto/list-patta-templates.dto.js';
import type { UpdatePattaTemplateDto } from './dto/update-patta-template.dto.js';

export type PattaTemplateStatus = 'ACTIVE' | 'INACTIVE';

export interface PattaTemplateRecord {
  id: string;
  name: string;
  model_id: string;
  konveyer: string;
  razmer: string | null;
  rang: string | null;
  status: PattaTemplateStatus;
  version: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface PattaTemplateRow {
  id: string;
  name: string;
  model_id: string;
  konveyer: string;
  razmer: string | null;
  rang: string | null;
  status: PattaTemplateStatus;
  version: string | number;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TemplateModelRow {
  id: string;
  status: 'ACTIVE' | 'INACTIVE';
}

function timestamp(value: Date | string, column: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    throw new Error(`Patta template query did not return ${column}`);
  }
  const isoValue = value.replace(' ', 'T');
  return isoValue.replace(/([+-][0-9]{2})$/, '$1:00');
}

const TEMPLATE_COLUMNS = `"id", "name", "model_id", "konveyer", "razmer", "rang", "status",
  "version"::text AS "version", "created_by",
  to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
  to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`;

function serializeTemplate(row: PattaTemplateRow): PattaTemplateRecord {
  if (row.created_at === undefined || row.updated_at === undefined) {
    throw new Error(`Patta template row is missing timestamps; fields=${Object.keys(row).join(',')}`);
  }
  return {
    id: row.id,
    name: row.name,
    model_id: row.model_id,
    konveyer: row.konveyer,
    razmer: row.razmer,
    rang: row.rang,
    status: row.status,
    version: String(row.version),
    created_by: row.created_by,
    created_at: timestamp(row.created_at, 'created_at'),
    updated_at: timestamp(row.updated_at, 'updated_at'),
  };
}

function requiredCanonical(value: string, field: string): string {
  const normalized = canonicalizeBusinessName(value);
  if (!normalized) {
    throw new BadRequestException({
      code: 'INVALID_PATTA_TEMPLATE_FIELD',
      message: `${field} bo‘sh bo‘lishi mumkin emas`,
      details: { field },
    });
  }
  return normalized;
}

function optionalCanonical(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const normalized = canonicalizeBusinessName(value);
  return normalized || null;
}

function mapTemplateWriteError(error: unknown): never {
  if (postgresConstraint(error) === 'uq_patta_templates_active_name') {
    throw pattaTemplateNameConflict();
  }
  throw error;
}

@Injectable()
export class PattaTemplatesService {
  constructor(private readonly auditService: AuditService) {}

  async list(
    dataSource: DataSource,
    query: Pick<ListPattaTemplatesDto, 'status'> = {},
  ): Promise<PattaTemplateRecord[]> {
    const status = query.status ?? 'ACTIVE';
    const rows: PattaTemplateRow[] = await dataSource.query(
      `SELECT ${TEMPLATE_COLUMNS} FROM "patta_templates"
       WHERE "status" = $1 ORDER BY "name_normalized", "id"`,
      [status],
    );
    return rows.map(serializeTemplate);
  }

  async getById(dataSource: DataSource, templateId: string): Promise<PattaTemplateRecord> {
    const rows: PattaTemplateRow[] = await dataSource.query(
      `SELECT ${TEMPLATE_COLUMNS} FROM "patta_templates" WHERE "id" = $1`,
      [templateId],
    );
    const row = rows[0];
    if (!row) {
      throw pattaTemplateNotFound();
    }
    return serializeTemplate(row);
  }

  async create(
    dataSource: DataSource,
    actorUserId: string,
    input: Pick<CreatePattaTemplateDto, 'name' | 'model_id' | 'konveyer' | 'razmer' | 'rang' | 'status'>,
  ): Promise<PattaTemplateRecord> {
    const name = requiredCanonical(input.name, 'Qolip nomi');
    const konveyer = requiredCanonical(input.konveyer, 'Konveyer');
    const razmer = optionalCanonical(input.razmer) ?? null;
    const rang = optionalCanonical(input.rang) ?? null;
    const status = input.status ?? 'ACTIVE';

    try {
      return await dataSource.transaction(async (manager) => {
        await this.lockActiveModel(manager, input.model_id);
        const rows: PattaTemplateRow[] = await manager.query(
          `INSERT INTO "patta_templates"
             ("name", "model_id", "konveyer", "razmer", "rang", "status", "created_by")
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${TEMPLATE_COLUMNS}`,
          [name, input.model_id, konveyer, razmer, rang, status, actorUserId],
        );
        const row = rows[0];
        if (!row) {
          throw new Error('Patta template insert did not return a record');
        }
        const result = serializeTemplate(row);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'patta_template',
          entityId: result.id,
          action: 'patta_template.create',
          before: null,
          after: result,
        });
        return result;
      });
    } catch (error) {
      return mapTemplateWriteError(error);
    }
  }

  async update(
    dataSource: DataSource,
    actorUserId: string,
    templateId: string,
    input: Pick<UpdatePattaTemplateDto,
      'name' | 'model_id' | 'konveyer' | 'razmer' | 'rang' | 'status' | 'expected_version'>,
  ): Promise<PattaTemplateRecord> {
    const mutableFields = [input.name, input.model_id, input.konveyer, input.razmer, input.rang, input.status];
    if (mutableFields.every((value) => value === undefined)) {
      throw new BadRequestException({
        code: 'EMPTY_UPDATE',
        message: 'O‘zgartiriladigan maydon yuborilmadi',
        details: {},
      });
    }
    const name = input.name === undefined ? undefined : requiredCanonical(input.name, 'Qolip nomi');
    const konveyer = input.konveyer === undefined
      ? undefined
      : requiredCanonical(input.konveyer, 'Konveyer');
    const razmer = optionalCanonical(input.razmer);
    const rang = optionalCanonical(input.rang);

    try {
      return await dataSource.transaction(async (manager) => {
        const initialRows: Array<Pick<PattaTemplateRow, 'model_id' | 'status' | 'version'>> =
          await manager.query(
            `SELECT "model_id", "status", "version"::text AS "version"
             FROM "patta_templates" WHERE "id" = $1`,
            [templateId],
          );
        const initial = initialRows[0];
        if (!initial) {
          throw pattaTemplateNotFound();
        }
        if (String(initial.version) !== input.expected_version) {
          throw pattaVersionConflict(input.expected_version, String(initial.version));
        }

        const targetModelId = input.model_id ?? initial.model_id;
        const modelMustBeActive = input.model_id !== undefined ||
          (input.status === 'ACTIVE' && initial.status === 'INACTIVE');
        if (modelMustBeActive) {
          await this.lockActiveModel(manager, targetModelId);
        }

        const lockedRows: PattaTemplateRow[] = await manager.query(
          `SELECT ${TEMPLATE_COLUMNS} FROM "patta_templates" WHERE "id" = $1 FOR UPDATE`,
          [templateId],
        );
        const locked = lockedRows[0];
        if (!locked) {
          throw pattaTemplateNotFound();
        }
        const before = serializeTemplate(locked);
        if (before.version !== input.expected_version) {
          throw pattaVersionConflict(input.expected_version, before.version);
        }

        const assignments: string[] = [];
        const parameters: unknown[] = [templateId];
        const addAssignment = (column: string, value: unknown): void => {
          parameters.push(value);
          assignments.push(`"${column}" = $${parameters.length}`);
        };
        if (name !== undefined) addAssignment('name', name);
        if (input.model_id !== undefined) addAssignment('model_id', targetModelId);
        if (konveyer !== undefined) addAssignment('konveyer', konveyer);
        if (input.razmer !== undefined) addAssignment('razmer', razmer ?? null);
        if (input.rang !== undefined) addAssignment('rang', rang ?? null);
        if (input.status !== undefined) addAssignment('status', input.status);
        assignments.push('"version" = "version" + 1');
        assignments.push('"updated_at" = transaction_timestamp()');
        parameters.push(input.expected_version);
        const versionParameter = parameters.length;
        const updateResult: [PattaTemplateRow[], number] = await manager.query(
          `UPDATE "patta_templates" SET ${assignments.join(', ')}
           WHERE "id" = $1 AND "version" = $${versionParameter}::bigint
           RETURNING ${TEMPLATE_COLUMNS}`,
          parameters,
        );
        const updated = updateResult[0][0];
        if (!updated) {
          throw pattaVersionConflict(input.expected_version, before.version);
        }
        const after = serializeTemplate(updated);
        const action: AuditAction = before.status === 'ACTIVE' && after.status === 'INACTIVE'
          ? 'patta_template.deactivate'
          : 'patta_template.update';
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'patta_template',
          entityId: templateId,
          action,
          before,
          after,
        });
        return after;
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) {
        throw error;
      }
      return mapTemplateWriteError(error);
    }
  }

  private async lockActiveModel(manager: EntityManager, modelId: string): Promise<void> {
    const rows: TemplateModelRow[] = await manager.query(
      `SELECT "id", "status" FROM "models" WHERE "id" = $1 FOR SHARE`,
      [modelId],
    );
    const model = rows[0];
    if (!model) {
      throw modelNotFound();
    }
    if (model.status !== 'ACTIVE') {
      throw pattaModelInactive();
    }
  }
}
