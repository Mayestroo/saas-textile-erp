import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { AuditAction } from '../audit/audit.service.js';
import { createSyncProjection } from '../sync/sync-projections.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { canonicalizeBusinessName } from '../models/business-name.js';
import {
  duplicateOperationName,
  inactiveModel,
  isPostgresErrorCode,
  modelNotFound,
  operationNotFound,
  postgresConstraint,
  versionConflict,
} from '../models/model-errors.js';
import type { CreateOperationDto } from './dto/create-operation.dto.js';
import type { UpdateOperationDto } from './dto/update-operation.dto.js';
import { normalizePrice, OperationPriceService } from './operation-price.service.js';

export type OperationStatus = 'ACTIVE' | 'INACTIVE';

export interface OperationRecord {
  id: string;
  model_id: string;
  name: string;
  price: string;
  sort_order: number;
  status: OperationStatus;
  version: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePattaSheetOperationInput {
  id: string;
  name: string;
  initial_price: string;
  sort_order: number;
  effective_from: string;
}

interface OperationRow {
  id: string;
  model_id: string;
  name: string;
  sort_order: number;
  status: OperationStatus;
  version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ModelLockRow {
  id: string;
  status: 'ACTIVE' | 'INACTIVE';
}

interface OperationReferenceRow {
  model_id: string;
}

function timestamp(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const isoValue = value.replace(' ', 'T');
  return isoValue.replace(/([+-][0-9]{2})$/, '$1:00');
}

const OPERATION_COLUMNS = `"id", "model_id", "name", "sort_order", "status", "version"::text AS "version",
  to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
  to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"`;

function serializeOperation(row: OperationRow, effectivePrice: string): OperationRecord {
  return {
    id: row.id,
    model_id: row.model_id,
    name: row.name,
    price: new Decimal(effectivePrice).toFixed(2),
    sort_order: Number(row.sort_order),
    status: row.status,
    version: String(row.version),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

function ensureMutableInput(input: Pick<UpdateOperationDto, 'name' | 'sort_order' | 'status'>): void {
  if (input.name === undefined && input.sort_order === undefined && input.status === undefined) {
    throw new BadRequestException({
      code: 'EMPTY_UPDATE',
      message: 'O‘zgartiriladigan maydon yuborilmadi',
      details: {},
    });
  }
}

function mapWriteError(error: unknown): never {
  if (postgresConstraint(error) === 'uq_model_operations_active_name') {
    throw duplicateOperationName();
  }
  if (isPostgresErrorCode(error, '23505')) {
    throw duplicateOperationName();
  }
  throw error;
}

@Injectable()
export class OperationsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly operationPriceService: OperationPriceService,
    private readonly syncChangeRecorder: SyncChangeRecorder,
  ) {}

  async listByModel(
    dataSource: DataSource,
    modelId: string,
    status: OperationStatus = 'ACTIVE',
  ): Promise<OperationRecord[]> {
    const models: Array<{ id: string }> = await dataSource.query(
      `SELECT "id" FROM "models" WHERE "id" = $1`,
      [modelId],
    );
    if (!models[0]) {
      throw modelNotFound();
    }
    const rows: OperationRow[] = await dataSource.query(
      `SELECT ${OPERATION_COLUMNS}
       FROM "model_operations" WHERE "model_id" = $1 AND "status" = $2
       ORDER BY "sort_order", "name_normalized", "id"`,
      [modelId, status],
    );
    const currentPrices = await this.operationPriceService.resolveCurrentPrices(
      dataSource,
      rows.map(({ id }) => id),
    );
    return rows.map((row) => {
      const price = currentPrices.get(row.id);
      if (price === undefined) {
        throw new Error(`Operation ${row.id} has no price effective at the current database time`);
      }
      return serializeOperation(row, price);
    });
  }

  async getById(dataSource: DataSource, operationId: string): Promise<OperationRecord> {
    const rows: OperationRow[] = await dataSource.query(
      `SELECT ${OPERATION_COLUMNS}
       FROM "model_operations" WHERE "id" = $1`,
      [operationId],
    );
    const operation = rows[0];
    if (!operation) {
      throw operationNotFound();
    }
    const currentPrice = await this.operationPriceService.resolveCurrentPrice(dataSource, operationId);
    return serializeOperation(operation, currentPrice);
  }

  async create(
    dataSource: DataSource,
    modelId: string,
    actorUserId: string,
    input: Pick<CreateOperationDto, 'name' | 'price' | 'sort_order' | 'status'>,
  ): Promise<OperationRecord> {
    const name = canonicalizeBusinessName(input.name);
    if (!name) {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_NAME',
        message: 'Operatsiya nomi bo‘sh bo‘lishi mumkin emas',
        details: {},
      });
    }
    const price = normalizePrice(input.price);
    this.validateSortOrder(input.sort_order);
    const status: OperationStatus = input.status ?? 'ACTIVE';

    try {
      return await dataSource.transaction(async (manager) => {
        const modelRows: ModelLockRow[] = await manager.query(
          `SELECT "id", "status" FROM "models" WHERE "id" = $1 FOR UPDATE`,
          [modelId],
        );
        const model = modelRows[0];
        if (!model) {
          throw modelNotFound();
        }
        if (model.status !== 'ACTIVE') {
          throw inactiveModel();
        }
        const clockRows: Array<{ transaction_time: string }> = await manager.query(
          'SELECT transaction_timestamp()::text AS "transaction_time"',
        );
        const transactionTime = clockRows[0]?.transaction_time;
        if (!transactionTime) {
          throw new Error('Database transaction timestamp was not returned');
        }
        const operationRows: OperationRow[] = await manager.query(
          `INSERT INTO "model_operations" ("model_id", "name", "price", "sort_order", "status")
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${OPERATION_COLUMNS}`,
          [modelId, name, price, input.sort_order, status],
        );
        const operation = operationRows[0];
        if (!operation) {
          throw new Error('Operation insert did not return the created record');
        }
        const history = await this.operationPriceService.createInitialPrice(
          manager,
          operation.id,
          price,
          actorUserId,
          transactionTime,
        );
        const result = serializeOperation(operation, history.price);
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'operation',
          entityId: operation.id,
          action: 'operation.create',
          before: null,
          after: result,
        });
        await this.syncChangeRecorder.record(manager, {
          entityType: 'model_operations',
          entityId: result.id,
          operation: 'UPSERT',
          entityVersion: result.version,
          projectionVersion: 1,
          payload: createSyncProjection({
            entityType: 'model_operations',
            data: {
              id: result.id,
              model_id: result.model_id,
              name: result.name,
              sort_order: result.sort_order,
              status: result.status,
              version: result.version,
              created_at: result.created_at,
              updated_at: result.updated_at,
            },
            entityVersion: result.version,
          }),
        });
        return result;
      });
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async createForPattaSheet(
    dataSource: DataSource,
    modelId: string,
    actorUserId: string,
    validatedDeviceId: string,
    input: CreatePattaSheetOperationInput,
  ): Promise<OperationRecord> {
    const operationId = input.id.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) {
      throw new BadRequestException({ code: 'INVALID_OPERATION_ID', message: 'Operatsiya identifikatori yaroqsiz', details: {} });
    }
    const name = canonicalizeBusinessName(input.name);
    if (!name) {
      throw new BadRequestException({ code: 'INVALID_OPERATION_NAME', message: 'Operatsiya nomi bo‘sh bo‘lishi mumkin emas', details: {} });
    }
    const price = normalizePrice(input.initial_price);
    this.validateSortOrder(input.sort_order);
    if (!Number.isFinite(Date.parse(input.effective_from)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(input.effective_from)) {
      throw new BadRequestException({ code: 'INVALID_EFFECTIVE_FROM', message: 'Operatsiya narxi kuchga kirish vaqti yaroqsiz', details: {} });
    }
    try {
      return await dataSource.transaction((manager) => this.createForPattaSheetInTransaction(
        manager, modelId, actorUserId, validatedDeviceId, { ...input, id: operationId, name, initial_price: price },
      ));
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async createForPattaSheetInTransaction(
    manager: EntityManager,
    modelId: string,
    actorUserId: string,
    validatedDeviceId: string,
    input: CreatePattaSheetOperationInput,
  ): Promise<OperationRecord> {
    const operationId = input.id.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) {
      throw new BadRequestException({ code: 'INVALID_OPERATION_ID', message: 'Operatsiya identifikatori yaroqsiz', details: {} });
    }
    const name = canonicalizeBusinessName(input.name);
    if (!name) throw new BadRequestException({ code: 'INVALID_OPERATION_NAME', message: 'Operatsiya nomi bo‘sh bo‘lishi mumkin emas', details: {} });
    const price = normalizePrice(input.initial_price);
    this.validateSortOrder(input.sort_order);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(input.effective_from) ||
      !Number.isFinite(Date.parse(input.effective_from))) {
      throw new BadRequestException({ code: 'INVALID_EFFECTIVE_FROM', message: 'Operatsiya narxi kuchga kirish vaqti yaroqsiz', details: {} });
    }
    input = { ...input, id: operationId, name, initial_price: price };
    const modelRows: ModelLockRow[] = await manager.query(
      `SELECT "id", "status" FROM "models" WHERE "id" = $1 FOR UPDATE`, [modelId],
    );
    const model = modelRows[0];
    if (!model) throw modelNotFound();
    if (model.status !== 'ACTIVE') throw inactiveModel();
    const timeRows: Array<{ transaction_time: string }> = await manager.query(
      'SELECT transaction_timestamp()::text AS "transaction_time"',
    );
    const transactionTime = timeRows[0]?.transaction_time;
    if (!transactionTime) throw new Error('Database transaction timestamp was not returned');
    if (Date.parse(input.effective_from) > Date.parse(transactionTime)) {
      throw new BadRequestException({ code: 'INVALID_EFFECTIVE_FROM', message: 'Yangi operatsiya narxi Kiritilgan vaqtdan keyin boshlanmaydi', details: {} });
    }
    const existingRows: OperationRow[] = await manager.query(
      `SELECT ${OPERATION_COLUMNS} FROM "model_operations"
       WHERE "model_id" = $1 AND "name_normalized" = lower("canonicalize_business_name"($2))
         AND "status" = 'ACTIVE' ORDER BY "id" FOR UPDATE`,
      [modelId, input.name],
    );
    const existing = existingRows[0];
    if (existing) {
      const effectivePrice = await this.operationPriceService.resolvePrice(existing.id, input.effective_from, manager);
      return serializeOperation(existing, effectivePrice);
    }
    const duplicateIds: Array<{ id: string }> = await manager.query(
      `SELECT "id" FROM "model_operations" WHERE "id" = $1 FOR UPDATE`, [input.id],
    );
    if (duplicateIds.length > 0) {
      throw new ConflictException({
        code: 'MODEL_OPERATION_ID_ALREADY_EXISTS',
        message: 'Operatsiya identifikatori boshqa yozuvda ishlatilgan',
        details: { operation_id: input.id },
      });
    }
    const operationRows: OperationRow[] = await manager.query(
      `INSERT INTO "model_operations" ("id", "model_id", "name", "price", "sort_order", "status")
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE') RETURNING ${OPERATION_COLUMNS}`,
      [input.id, modelId, input.name, normalizePrice(input.initial_price), input.sort_order],
    );
    const operation = operationRows[0];
    if (!operation) throw new Error('Patta varag‘i custom operation insert did not return a record');
    const history = await this.operationPriceService.createInitialPrice(
      manager, operation.id, normalizePrice(input.initial_price), actorUserId, input.effective_from,
    );
    const result = serializeOperation(operation, history.price);
    await this.auditService.append(manager, {
      actorUserId,
      deviceId: validatedDeviceId,
      entityType: 'operation',
      entityId: result.id,
      action: 'operation.create',
      before: null,
      after: result,
    });
    await this.syncChangeRecorder.record(manager, {
      entityType: 'model_operations', entityId: result.id, operation: 'UPSERT',
      entityVersion: result.version, projectionVersion: 1,
      payload: createSyncProjection({
        entityType: 'model_operations',
        data: {
          id: result.id, model_id: result.model_id, name: result.name, sort_order: result.sort_order,
          status: result.status, version: result.version, created_at: result.created_at, updated_at: result.updated_at,
        },
        entityVersion: result.version,
      }),
    });
    return result;
  }

  async update(
    dataSource: DataSource,
    actorUserId: string,
    operationId: string,
    input: Pick<UpdateOperationDto, 'name' | 'sort_order' | 'status' | 'expected_version'>,
  ): Promise<OperationRecord> {
    ensureMutableInput(input);
    const name = input.name === undefined ? undefined : canonicalizeBusinessName(input.name);
    if (name === '') {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_NAME',
        message: 'Operatsiya nomi bo‘sh bo‘lishi mumkin emas',
        details: {},
      });
    }
    if (input.sort_order !== undefined) {
      this.validateSortOrder(input.sort_order);
    }

    try {
      return await dataSource.transaction(async (manager) => {
        const references: OperationReferenceRow[] = await manager.query(
          `SELECT "model_id" FROM "model_operations" WHERE "id" = $1`,
          [operationId],
        );
        const reference = references[0];
        if (!reference) {
          throw operationNotFound();
        }
        const models: ModelLockRow[] = await manager.query(
          `SELECT "id", "status" FROM "models" WHERE "id" = $1 FOR UPDATE`,
          [reference.model_id],
        );
        const model = models[0];
        if (!model) {
          throw modelNotFound();
        }
        const lockedRows: OperationRow[] = await manager.query(
          `SELECT ${OPERATION_COLUMNS}
           FROM "model_operations" WHERE "id" = $1 FOR UPDATE`,
          [operationId],
        );
        const locked = lockedRows[0];
        if (!locked) {
          throw operationNotFound();
        }
        const currentVersion = String(locked.version);
        if (currentVersion !== input.expected_version) {
          throw versionConflict(input.expected_version, currentVersion);
        }
        if (input.status === 'ACTIVE' && model.status !== 'ACTIVE') {
          throw inactiveModel();
        }
        const beforePrice = await this.operationPriceService.resolveCurrentPrice(manager, operationId);
        const before = serializeOperation(locked, beforePrice);

        const assignments: string[] = [];
        const values: unknown[] = [operationId];
        if (name !== undefined) {
          values.push(name);
          assignments.push(`"name" = $${values.length}`);
        }
        if (input.sort_order !== undefined) {
          values.push(input.sort_order);
          assignments.push(`"sort_order" = $${values.length}`);
        }
        if (input.status !== undefined) {
          values.push(input.status);
          assignments.push(`"status" = $${values.length}`);
        }
        values.push(input.expected_version);
        assignments.push('"version" = "version" + 1');
        assignments.push('"updated_at" = transaction_timestamp()');
        await manager.query(
          `UPDATE "model_operations" SET ${assignments.join(', ')}
           WHERE "id" = $1 AND "version" = $${values.length}::bigint`,
          values,
        );
        const rows: OperationRow[] = await manager.query(
          `SELECT ${OPERATION_COLUMNS} FROM "model_operations" WHERE "id" = $1`,
          [operationId],
        );
        const updated = rows[0];
        if (!updated) {
          throw versionConflict(input.expected_version, before.version);
        }
        const afterPrice = await this.operationPriceService.resolveCurrentPrice(manager, operationId);
        const after = serializeOperation(updated, afterPrice);
        const action: AuditAction = before.status === 'ACTIVE' && updated.status === 'INACTIVE'
          ? 'operation.deactivate'
          : 'operation.update';
        await this.auditService.append(manager, {
          actorUserId,
          entityType: 'operation',
          entityId: operationId,
          action,
          before,
          after,
        });
        await this.syncChangeRecorder.record(manager, {
          entityType: 'model_operations',
          entityId: after.id,
          operation: 'UPSERT',
          entityVersion: after.version,
          projectionVersion: 1,
          payload: createSyncProjection({
            entityType: 'model_operations',
            data: {
              id: after.id,
              model_id: after.model_id,
              name: after.name,
              sort_order: after.sort_order,
              status: after.status,
              version: after.version,
              created_at: after.created_at,
              updated_at: after.updated_at,
            },
            entityVersion: after.version,
          }),
        });
        return after;
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof ForbiddenException) {
        throw error;
      }
      return mapWriteError(error);
    }
  }

  private validateSortOrder(sortOrder: number): void {
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 2_147_483_647) {
      throw new BadRequestException({
        code: 'INVALID_SORT_ORDER',
        message: 'Tartib raqami 0 yoki undan katta butun son bo‘lishi kerak',
        details: {},
      });
    }
  }
}
