import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import type { GeneratePattaDto } from './dto/generate-patta.dto.js';
import type { ListPattaDto } from './dto/list-patta.dto.js';
import { PATTA_CONFIGURATION } from './patta.config.js';
import type { PattaConfiguration } from './patta.config.js';
import {
  pattaAlreadyExists,
  pattaBatchSizeInvalid,
  pattaDateRangeInvalid,
  pattaModelHasNoOperations,
  pattaModelInactive,
  pattaNumberInvalid,
  pattaNumberRangeExhausted,
  pattaNumberSequenceUnavailable,
  pattaRecordNotFound,
  pattaTemplateInactive,
  pattaTemplateModelMismatch,
  pattaTemplateNotFound,
} from './patta-errors.js';
import { postgresConstraint } from '../models/model-errors.js';
import { canonicalizeBusinessName } from '../models/business-name.js';

export interface PattaOperationSnapshotRecord {
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

export interface PattaRecord {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  ish_soni: number;
  created_at: string;
  operations: PattaOperationSnapshotRecord[];
}

export interface PattaDetailRecord extends PattaRecord {
  model: { id: string; name: string };
}

export interface PattaListRecord {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  razmer: string | null;
  rang: string | null;
  konveyer_snapshot: string;
  ish_soni: number;
  created_at: string;
}

export interface PaginatedPattaRecord {
  items: PattaListRecord[];
  total: string;
  page: number;
  limit: number;
}

interface ModelLockRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
}

interface OperationLockRow {
  id: string;
  name: string;
  sort_order: number;
}

interface TemplateReferenceRow {
  model_id: string;
}

interface LockedTemplateRow {
  id: string;
  model_id: string;
  konveyer: string;
  razmer: string | null;
  rang: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}

interface TransactionTimeRow {
  transaction_time: string;
}

interface SequenceRow {
  next_number: string;
}

interface SnapshotCountRow {
  snapshot_count: number | string;
}

interface PattaRow {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  ish_soni: number;
  created_at: Date | string;
}

type PattaDetailRow = PattaRow;

interface PattaListRow extends Omit<PattaRow, 'template_id'> {}

interface SnapshotRow {
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

interface ResolvedOperationSnapshot extends PattaOperationSnapshotRecord {}

interface PattaDraft {
  id: string;
  pattaNumber: bigint;
  templateId: string | null;
  conveyor: string;
  size: string | null;
  color: string | null;
  snapshots: ResolvedOperationSnapshot[];
}

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const PATTA_COLUMNS = `"id", "partiya_number", "patta_number"::text AS "patta_number",
  "model_id", "model_name_snapshot", "template_id", "konveyer_snapshot", "razmer", "rang",
  "ish_soni", to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"`;

function formatTimestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const isoValue = value.replace(' ', 'T');
  return isoValue.replace(/([+-][0-9]{2})$/, '$1:00');
}

function normalizePartiyaNumber(value: string): string {
  const normalized = canonicalizeBusinessName(value);
  if (!normalized) {
    throw new BadRequestException({
      code: 'INVALID_PARTIYA_NUMBER',
      message: 'Partiya raqami bo‘sh bo‘lishi mumkin emas',
      details: {},
    });
  }
  return normalized;
}

function parsePattaNumber(value: string | bigint): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else {
    if (!POSITIVE_DECIMAL_PATTERN.test(value)) {
      throw pattaNumberInvalid();
    }
    parsed = BigInt(value);
  }
  if (parsed <= 0n || parsed > MAX_POSTGRES_BIGINT) {
    throw pattaNumberInvalid();
  }
  return parsed;
}

function canonicalRequired(value: string, field: string): string {
  const normalized = canonicalizeBusinessName(value);
  if (!normalized) {
    throw new BadRequestException({
      code: 'INVALID_PATTA_GENERATION_FIELD',
      message: `${field} bo‘sh bo‘lishi mumkin emas`,
      details: { field },
    });
  }
  return normalized;
}

function resolveOptionalValue(
  requested: string | null | undefined,
  templateValue: string | null,
  field: string,
): string | null {
  if (requested === undefined) {
    return templateValue;
  }
  if (requested === null) {
    return null;
  }
  return canonicalRequired(requested, field);
}

function serializePatta(row: PattaRow, operations: PattaOperationSnapshotRecord[]): PattaRecord {
  return {
    id: row.id,
    partiya_number: row.partiya_number,
    patta_number: row.patta_number,
    model_id: row.model_id,
    model_name_snapshot: row.model_name_snapshot,
    template_id: row.template_id,
    konveyer_snapshot: row.konveyer_snapshot,
    razmer: row.razmer,
    rang: row.rang,
    ish_soni: row.ish_soni,
    created_at: formatTimestamp(row.created_at),
    operations,
  };
}

function serializePattaListRow(row: PattaListRow): PattaListRecord {
  return {
    id: row.id,
    partiya_number: row.partiya_number,
    patta_number: row.patta_number,
    model_id: row.model_id,
    model_name_snapshot: row.model_name_snapshot,
    razmer: row.razmer,
    rang: row.rang,
    konveyer_snapshot: row.konveyer_snapshot,
    ish_soni: row.ish_soni,
    created_at: formatTimestamp(row.created_at),
  };
}

function mapPattaWriteError(error: unknown): never {
  if (postgresConstraint(error) === 'uq_patta_hisob_partiya_patta') {
    throw pattaAlreadyExists();
  }
  throw error;
}

@Injectable()
export class PattaService {
  constructor(
    private readonly auditService: AuditService,
    private readonly operationPriceService: OperationPriceService,
    @Inject(PATTA_CONFIGURATION) private readonly configuration: PattaConfiguration,
  ) {}

  async generate(
    dataSource: DataSource,
    actorUserId: string,
    validatedDeviceId: string,
    input: Pick<GeneratePattaDto,
      'partiya_number' | 'model_id' | 'template_id' | 'konveyer' | 'razmer' | 'rang' | 'count'>,
  ): Promise<PattaRecord[]> {
    if (
      !Number.isSafeInteger(input.count) ||
      input.count <= 0 ||
      input.count > this.configuration.maxBatchSize
    ) {
      throw pattaBatchSizeInvalid(this.configuration.maxBatchSize);
    }
    const partiyaNumber = normalizePartiyaNumber(input.partiya_number);

    try {
      return await dataSource.transaction(async (manager) => {
        const templateReference = input.template_id
          ? await this.findTemplateModelReference(manager, input.template_id)
          : null;
        if (
          templateReference &&
          input.model_id &&
          input.model_id.toLowerCase() !== templateReference.model_id.toLowerCase()
        ) {
          throw pattaTemplateModelMismatch();
        }
        const modelId = templateReference?.model_id ?? input.model_id;
        if (!modelId) {
          throw new BadRequestException({
            code: 'PATTA_MODEL_REQUIRED',
            message: 'Patta yaratish uchun model tanlang',
            details: {},
          });
        }

        const modelRows: ModelLockRow[] = await manager.query(
          `SELECT "id", "name", "status" FROM "models" WHERE "id" = $1 FOR SHARE`,
          [modelId],
        );
        const model = modelRows[0];
        if (!model) {
          throw new NotFoundException({ code: 'MODEL_NOT_FOUND', message: 'Model topilmadi', details: {} });
        }
        if (model.status !== 'ACTIVE') {
          throw pattaModelInactive();
        }

        const operationRows: OperationLockRow[] = await manager.query(
          `SELECT "id", "name", "sort_order" FROM "model_operations"
           WHERE "model_id" = $1 AND "status" = 'ACTIVE'
           ORDER BY "sort_order", "id" FOR SHARE`,
          [model.id],
        );
        if (operationRows.length === 0) {
          throw pattaModelHasNoOperations();
        }

        let template: LockedTemplateRow | null = null;
        if (input.template_id) {
          const templateRows: LockedTemplateRow[] = await manager.query(
            `SELECT "id", "model_id", "konveyer", "razmer", "rang", "status"
             FROM "patta_templates" WHERE "id" = $1 FOR SHARE`,
            [input.template_id],
          );
          template = templateRows[0] ?? null;
          if (!template) {
            throw pattaTemplateNotFound();
          }
          if (template.status !== 'ACTIVE') {
            throw pattaTemplateInactive();
          }
          if (
            template.model_id.toLowerCase() !== model.id.toLowerCase() ||
            (input.model_id !== undefined && input.model_id.toLowerCase() !== template.model_id.toLowerCase())
          ) {
            throw pattaTemplateModelMismatch();
          }
        }

        const konveyer = input.konveyer === undefined
          ? template?.konveyer
          : canonicalRequired(input.konveyer, 'Konveyer');
        if (!konveyer) {
          throw new BadRequestException({
            code: 'PATTA_KONVEYER_REQUIRED',
            message: 'Patta yaratish uchun konveyer tanlang',
            details: {},
          });
        }
        const razmer = resolveOptionalValue(input.razmer, template?.razmer ?? null, 'Razmer');
        const rang = resolveOptionalValue(input.rang, template?.rang ?? null, 'Rang');

        const timeRows: TransactionTimeRow[] = await manager.query(
          'SELECT transaction_timestamp()::text AS "transaction_time"',
        );
        const transactionTime = timeRows[0]?.transaction_time;
        if (!transactionTime) {
          throw new Error('Database transaction timestamp was not returned');
        }

        const snapshots: ResolvedOperationSnapshot[] = [];
        for (const operation of operationRows) {
          const unitPrice = await this.operationPriceService.resolvePrice(
            operation.id,
            transactionTime,
            manager,
          );
          snapshots.push({
            operation_id: operation.id,
            operation_name_snapshot: operation.name,
            unit_price_snapshot: unitPrice,
            sort_order: operation.sort_order,
          });
        }

        const sequenceRows: SequenceRow[] = await manager.query(
          `SELECT "next_number"::text AS "next_number"
           FROM "patta_number_sequence" WHERE "id" = 1 FOR UPDATE`,
        );
        const sequence = sequenceRows[0];
        if (!sequence) {
          throw pattaNumberSequenceUnavailable();
        }
        const firstNumber = BigInt(sequence.next_number);
        const batchCount = BigInt(input.count);
        const lastNumber = firstNumber + batchCount - 1n;
        const nextNumber = lastNumber + 1n;
        if (lastNumber > MAX_POSTGRES_BIGINT || nextNumber > MAX_POSTGRES_BIGINT) {
          throw pattaNumberRangeExhausted();
        }

        const drafts: PattaDraft[] = [];
        for (let offset = 0n; offset < batchCount; offset += 1n) {
          drafts.push({
            id: randomUUID(),
            pattaNumber: firstNumber + offset,
            templateId: template?.id ?? null,
            conveyor: konveyer,
            size: razmer,
            color: rang,
            snapshots,
          });
        }

        await manager.query(
          `UPDATE "patta_number_sequence"
           SET "next_number" = $1::bigint, "version" = "version" + 1,
               "updated_at" = transaction_timestamp()
           WHERE "id" = 1`,
          [nextNumber.toString()],
        );

        for (const draft of drafts) {
          for (const snapshot of draft.snapshots) {
            await manager.query(
              `INSERT INTO "patta_operation_snapshots"
                 ("patta_hisob_id", "operation_id", "operation_name_snapshot",
                  "unit_price_snapshot", "sort_order")
               VALUES ($1, $2, $3, $4::numeric(14,2), $5)`,
              [
                draft.id,
                snapshot.operation_id,
                snapshot.operation_name_snapshot,
                snapshot.unit_price_snapshot,
                snapshot.sort_order,
              ],
            );
          }
        }

        const results: PattaRecord[] = [];
        for (const draft of drafts) {
          const countRows: SnapshotCountRow[] = await manager.query(
            `SELECT count(*)::integer AS "snapshot_count"
             FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1`,
            [draft.id],
          );
          const snapshotCount = Number(countRows[0]?.snapshot_count);
          if (!Number.isSafeInteger(snapshotCount) || snapshotCount !== draft.snapshots.length) {
            throw new Error('Patta operation snapshot count did not match inserted rows');
          }
          const pattaRows: PattaRow[] = await manager.query(
            `INSERT INTO "patta_hisob"
               ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
                "template_id", "konveyer_snapshot", "razmer", "rang", "ish_soni",
                "created_device_id", "created_from_block_id", "created_by")
             VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12)
             RETURNING ${PATTA_COLUMNS}`,
            [
              draft.id,
              partiyaNumber,
              draft.pattaNumber.toString(),
              model.id,
              model.name,
              draft.templateId,
              draft.conveyor,
              draft.size,
              draft.color,
              snapshotCount,
              validatedDeviceId,
              actorUserId,
            ],
          );
          const row = pattaRows[0];
          if (!row) {
            throw new Error('Patta insert did not return a record');
          }
          const result = serializePatta(row, draft.snapshots);
          await this.auditService.append(manager, {
            actorUserId,
            entityType: 'patta',
            entityId: result.id,
            action: 'patta.create',
            before: null,
            after: {
              id: result.id,
              partiya_number: result.partiya_number,
              patta_number: result.patta_number,
              model_id: result.model_id,
              model_name_snapshot: result.model_name_snapshot,
              device_id: validatedDeviceId,
              block_id: null,
              source: 'ONLINE',
              ish_soni: result.ish_soni,
            },
          });
          results.push(result);
        }

        return results;
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      return mapPattaWriteError(error);
    }
  }

  async lookup(
    dataSource: DataSource,
    partiyaNumberInput: string,
    pattaNumberInput: string | bigint,
  ): Promise<PattaDetailRecord> {
    const partiyaNumber = normalizePartiyaNumber(partiyaNumberInput);
    const pattaNumber = parsePattaNumber(pattaNumberInput);
    const rows: PattaDetailRow[] = await dataSource.query(
      `SELECT ${PATTA_COLUMNS} FROM "patta_hisob"
       WHERE "partiya_number" = $1 AND "patta_number" = $2::bigint`,
      [partiyaNumber, pattaNumber.toString()],
    );
    const row = rows[0];
    if (!row) {
      throw pattaRecordNotFound();
    }
    const operationRows: SnapshotRow[] = await dataSource.query(
      `SELECT "operation_id", "operation_name_snapshot",
              "unit_price_snapshot"::text AS "unit_price_snapshot", "sort_order"
       FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1
       ORDER BY "sort_order", "operation_id"`,
      [row.id],
    );
    return {
      ...serializePatta(row, operationRows),
      model: { id: row.model_id, name: row.model_name_snapshot },
    };
  }

  async list(dataSource: DataSource, filters: ListPattaDto): Promise<PaginatedPattaRecord> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw pattaBatchSizeInvalid(100);
    }
    if (
      filters.created_from && filters.created_to &&
      Date.parse(filters.created_from) > Date.parse(filters.created_to)
    ) {
      throw pattaDateRangeInvalid();
    }

    const partiyaNumber = filters.partiya_number === undefined
      ? undefined
      : normalizePartiyaNumber(filters.partiya_number);
    const pattaNumber = filters.patta_number === undefined
      ? undefined
      : parsePattaNumber(filters.patta_number);
    const values: unknown[] = [];
    const predicates: string[] = [];
    const addFilter = (sql: (placeholder: string) => string, value: unknown): void => {
      values.push(value);
      predicates.push(sql(`$${values.length}`));
    };
    if (partiyaNumber !== undefined) addFilter((parameter) => `"partiya_number" = ${parameter}`, partiyaNumber);
    if (filters.model_id !== undefined) addFilter((parameter) => `"model_id" = ${parameter}::uuid`, filters.model_id);
    if (pattaNumber !== undefined) addFilter((parameter) => `"patta_number" = ${parameter}::bigint`, pattaNumber.toString());
    if (filters.created_from !== undefined) addFilter((parameter) => `"created_at" >= ${parameter}::timestamptz`, filters.created_from);
    if (filters.created_to !== undefined) addFilter((parameter) => `"created_at" <= ${parameter}::timestamptz`, filters.created_to);
    const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
    const offset = BigInt(page - 1) * BigInt(limit);

    return dataSource.transaction('REPEATABLE READ', async (manager) => {
      const totals: Array<{ total: string }> = await manager.query(
        `SELECT count(*)::text AS "total" FROM "patta_hisob" ${where}`,
        values,
      );
      const pageValues = [...values, limit, offset.toString()];
      const rows: PattaListRow[] = await manager.query(
        `SELECT ${PATTA_COLUMNS} FROM "patta_hisob" ${where}
         ORDER BY "created_at" DESC, "id" DESC
         LIMIT $${pageValues.length - 1}::integer OFFSET $${pageValues.length}::bigint`,
        pageValues,
      );
      return {
        items: rows.map(serializePattaListRow),
        total: totals[0]?.total ?? '0',
        page,
        limit,
      };
    });
  }

  private async findTemplateModelReference(
    manager: EntityManager,
    templateId: string,
  ): Promise<TemplateReferenceRow> {
    const rows: TemplateReferenceRow[] = await manager.query(
      `SELECT "model_id" FROM "patta_templates" WHERE "id" = $1`,
      [templateId],
    );
    const row = rows[0];
    if (!row) {
      throw pattaTemplateNotFound();
    }
    return row;
  }
}
