import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit.service.js';
import {
  duplicateModelName,
  modelNotFound,
  postgresConstraint,
  versionConflict,
} from './model-errors.js';
import { canonicalizeBusinessName } from './business-name.js';
import type { CreateModelDto } from './dto/create-model.dto.js';
import type { UpdateModelDto } from './dto/update-model.dto.js';

export type ModelStatus = 'ACTIVE' | 'INACTIVE';

export interface ModelRecord {
  id: string;
  name: string;
  status: ModelStatus;
  version: string;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: string;
  name: string;
  status: ModelStatus;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const isoValue = value.replace(' ', 'T');
  return isoValue.replace(/([+-][0-9]{2})$/, '$1:00');
}

const MODEL_COLUMNS = `"id", "name", "status", "version"::text AS "version",
  to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
  to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`;

function serializeModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    version: String(row.version),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

function mapModelWriteError(error: unknown): never {
  if (postgresConstraint(error) === 'uq_models_active_name') {
    throw duplicateModelName();
  }
  throw error;
}

@Injectable()
export class ModelsService {
  constructor(private readonly auditService: AuditService) {}

  async list(dataSource: DataSource, status: ModelStatus = 'ACTIVE'): Promise<ModelRecord[]> {
    const rows: ModelRow[] = await dataSource.query(
      `SELECT ${MODEL_COLUMNS}
       FROM "models" WHERE "status" = $1
       ORDER BY "name_normalized", "id"`,
      [status],
    );
    return rows.map(serializeModel);
  }

  async getById(dataSource: DataSource, modelId: string): Promise<ModelRecord> {
    const rows: ModelRow[] = await dataSource.query(
      `SELECT ${MODEL_COLUMNS}
       FROM "models" WHERE "id" = $1`,
      [modelId],
    );
    const model = rows[0];
    if (!model) {
      throw modelNotFound();
    }
    return serializeModel(model);
  }

  async create(
    dataSource: DataSource,
    actorUserId: string,
    input: Pick<CreateModelDto, 'name' | 'status'>,
  ): Promise<ModelRecord> {
    const name = canonicalizeBusinessName(input.name);
    if (!name) {
      throw new BadRequestException({
        code: 'INVALID_MODEL_NAME',
        message: 'Model nomi bo‘sh bo‘lishi mumkin emas',
        details: {},
      });
    }
    const status: ModelStatus = input.status ?? 'ACTIVE';

    try {
      return await dataSource.transaction(async (manager) => {
        const rows: ModelRow[] = await manager.query(
          `INSERT INTO "models" ("name", "status") VALUES ($1, $2)
           RETURNING ${MODEL_COLUMNS}`,
          [name, status],
        );
        const created = rows[0];
        if (!created) {
          throw new Error('Model insert did not return the created record');
        }
        const result = serializeModel(created);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'model',
          entityId: result.id,
          action: 'model.create',
          before: null,
          after: result,
        });
        return result;
      });
    } catch (error) {
      return mapModelWriteError(error);
    }
  }

  async update(
    dataSource: DataSource,
    actorUserId: string,
    modelId: string,
    input: Pick<UpdateModelDto, 'name' | 'status' | 'expected_version'>,
  ): Promise<ModelRecord> {
    if (input.name === undefined && input.status === undefined) {
      throw new BadRequestException({
        code: 'EMPTY_UPDATE',
        message: 'O‘zgartiriladigan maydon yuborilmadi',
        details: {},
      });
    }
    const name = input.name === undefined ? undefined : canonicalizeBusinessName(input.name);
    if (name === '') {
      throw new BadRequestException({
        code: 'INVALID_MODEL_NAME',
        message: 'Model nomi bo‘sh bo‘lishi mumkin emas',
        details: {},
      });
    }

    try {
      return await dataSource.transaction(async (manager) => {
        const lockedRows: ModelRow[] = await manager.query(
          `SELECT ${MODEL_COLUMNS}
           FROM "models" WHERE "id" = $1 FOR UPDATE`,
          [modelId],
        );
        const locked = lockedRows[0];
        if (!locked) {
          throw modelNotFound();
        }
        const before = serializeModel(locked);
        if (before.version !== input.expected_version) {
          throw versionConflict(input.expected_version, before.version);
        }

        const assignments: string[] = [];
        const values: unknown[] = [modelId];
        if (name !== undefined) {
          values.push(name);
          assignments.push(`"name" = $${values.length}`);
        }
        if (input.status !== undefined) {
          values.push(input.status);
          assignments.push(`"status" = $${values.length}`);
        }
        values.push(input.expected_version);
        assignments.push('"version" = "version" + 1');
        assignments.push('"updated_at" = transaction_timestamp()');
        await manager.query(
          `UPDATE "models" SET ${assignments.join(', ')}
           WHERE "id" = $1 AND "version" = $${values.length}::bigint`,
          values,
        );
        const rows: ModelRow[] = await manager.query(
          `SELECT ${MODEL_COLUMNS} FROM "models" WHERE "id" = $1`,
          [modelId],
        );
        const updated = rows[0];
        if (!updated) {
          throw versionConflict(input.expected_version, before.version);
        }
        const after = serializeModel(updated);
        const action: AuditAction = before.status === 'ACTIVE' && after.status === 'INACTIVE'
          ? 'model.deactivate'
          : 'model.update';
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'model',
          entityId: modelId,
          action,
          before,
          after,
        });
        return after;
      });
    } catch (error) {
      if (error instanceof ConflictException || postgresConstraint(error) === 'uq_models_active_name') {
        if (postgresConstraint(error) === 'uq_models_active_name') {
          throw duplicateModelName();
        }
        throw error;
      }
      return mapModelWriteError(error);
    }
  }
}
