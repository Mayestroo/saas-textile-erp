import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { EntityManager } from 'typeorm';
import type { ModelAccountAdjustmentMutationPayload, ModelAccountAdjustmentProjection } from '@textile/sync-protocol';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService, normalizePrice } from '../operations/operation-price.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

interface AdjustmentRow extends ModelAccountAdjustmentProjection {}

function badRequest(code: string, message: string, details: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ code, message, details });
}

function conflict(code: string, message: string, details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ code, message, details });
}

function requiredUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw badRequest('PAYLOAD_INVALID', `${field} UUID bo‘lishi kerak`, { field });
  return value.toLowerCase();
}

function assertQuantity(quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
    throw badRequest('MODEL_ACCOUNT_ADJUSTMENT_QUANTITY_INVALID', 'Qo‘lda qo‘shilgan soni musbat butun son bo‘lishi kerak');
  }
  return quantity;
}

function assertTimestamp(value: string): string {
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw badRequest('MODEL_ACCOUNT_ADJUSTMENT_ENTERED_AT_INVALID', 'Kiritilgan sana ISO-8601 vaqt ko‘rinishida bo‘lishi kerak');
  }
  return value;
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw badRequest('MODEL_ACCOUNT_ADJUSTMENT_BUSINESS_DATE_INVALID', 'Ish sanasi YYYY-MM-DD ko‘rinishida bo‘lishi kerak');
  }
}

function adjustmentProjection(data: ModelAccountAdjustmentProjection) {
  return {
    projection_version: 3 as const,
    entity_type: 'model_account_adjustments' as const,
    entity_id: data.id,
    entity_version: data.version,
    data,
  };
}

@Injectable()
export class ModelAccountAdjustmentsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly operationPriceService: OperationPriceService,
    private readonly syncChangeRecorder: SyncChangeRecorder,
  ) {}

  async createInTransaction(
    manager: EntityManager,
    actorUserId: string,
    deviceId: string,
    timezone: string,
    adjustmentIdInput: string,
    input: ModelAccountAdjustmentMutationPayload,
  ): Promise<ModelAccountAdjustmentProjection> {
    const id = requiredUuid(adjustmentIdInput, 'adjustment_id');
    if (input.deleted_at !== null || input.deleted_by !== null) {
      throw badRequest('MODEL_ACCOUNT_ADJUSTMENT_CREATE_TRASHED', 'Yangi qo‘shimcha Korzinkada yaratilmaydi');
    }
    const modelId = requiredUuid(input.model_id, 'model_id');
    const operationId = requiredUuid(input.model_operation_id, 'model_operation_id');
    const workerId = this.workerId(input.worker_id);
    const quantity = assertQuantity(input.quantity);
    const enteredAt = assertTimestamp(input.entered_at);
    assertBusinessDate(input.business_date);
    const businessDate = await this.deriveBusinessDate(manager, enteredAt, timezone, input.business_date);
    const references = await this.validateReferences(manager, modelId, operationId, workerId);
    const unitPrice = await this.validatePriceSnapshot(manager, operationId, enteredAt, input.unit_price_snapshot);

    await manager.query(
      `INSERT INTO "model_account_adjustments" (
         "id", "model_id", "model_operation_id", "worker_id", "quantity", "unit_price_snapshot",
         "entered_at", "business_date", "created_by", "created_device_id"
       ) VALUES ($1, $2, $3, $4::bigint, $5, $6::numeric(14,2), $7::timestamptz, $8::date, $9, $10)`,
      [id, references.model_id, references.model_operation_id, workerId, quantity, unitPrice,
        enteredAt, businessDate, actorUserId, deviceId],
    );
    const after = await this.getProjection(manager, id);
    await this.auditService.append(manager, {
      actorUserId,
      deviceId,
      entityType: 'model_account_adjustment',
      entityId: id,
      action: 'model_account_adjustment.create',
      before: null,
      after,
    });
    await this.recordChange(manager, after);
    return after;
  }

  async updateInTransaction(
    manager: EntityManager,
    actorUserId: string,
    deviceId: string,
    adjustmentIdInput: string,
    expectedVersion: string,
    input: ModelAccountAdjustmentMutationPayload,
  ): Promise<ModelAccountAdjustmentProjection> {
    const id = requiredUuid(adjustmentIdInput, 'adjustment_id');
    const current = await this.lockProjection(manager, id);
    this.assertExpectedVersion(current, expectedVersion);
    if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Qo‘shimcha versiyasi tugadi');
    this.assertIdentity(current, input);
    if (current.deleted_at !== null || input.deleted_at !== null || input.deleted_by !== null) {
      throw conflict('MODEL_ACCOUNT_ADJUSTMENT_LIFECYCLE_REQUIRES_ACTION', 'Korzinka amali alohida TRASH yoki RESTORE bilan bajariladi');
    }
    const quantity = assertQuantity(input.quantity);
    const nextVersion = (BigInt(current.version) + 1n).toString();
    await manager.query(
      `UPDATE "model_account_adjustments" SET "quantity" = $1, "version" = $2::bigint,
        "updated_at" = transaction_timestamp() WHERE "id" = $3`,
      [quantity, nextVersion, id],
    );
    const after = await this.getProjection(manager, id);
    await this.auditService.append(manager, {
      actorUserId,
      deviceId,
      entityType: 'model_account_adjustment',
      entityId: id,
      action: 'model_account_adjustment.update',
      before: current,
      after,
    });
    await this.recordChange(manager, after);
    return after;
  }

  async setTrashedInTransaction(
    manager: EntityManager,
    actorUserId: string,
    deviceId: string,
    adjustmentIdInput: string,
    expectedVersion: string,
    trashed: boolean,
    occurredAt?: string,
  ): Promise<ModelAccountAdjustmentProjection> {
    const id = requiredUuid(adjustmentIdInput, 'adjustment_id');
    const current = await this.lockProjection(manager, id);
    this.assertExpectedVersion(current, expectedVersion);
    if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Qo‘shimcha versiyasi tugadi');
    if ((current.deleted_at !== null) === trashed) {
      throw conflict(trashed ? 'MODEL_ACCOUNT_ADJUSTMENT_ALREADY_TRASHED' : 'MODEL_ACCOUNT_ADJUSTMENT_NOT_TRASHED',
        trashed ? 'Qo‘shimcha allaqachon Korzinkada' : 'Qo‘shimcha Korzinkada emas');
    }
    const nextVersion = (BigInt(current.version) + 1n).toString();
    await manager.query(
      `UPDATE "model_account_adjustments" SET
        "deleted_at" = CASE WHEN $1 THEN COALESCE($5::timestamptz, transaction_timestamp()) ELSE NULL END,
        "deleted_by" = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
        "version" = $3::bigint, "updated_at" = transaction_timestamp()
       WHERE "id" = $4`,
      [trashed, actorUserId, nextVersion, id, occurredAt ?? null],
    );
    const after = await this.getProjection(manager, id);
    await this.auditService.append(manager, {
      actorUserId,
      deviceId,
      entityType: 'model_account_adjustment',
      entityId: id,
      action: trashed ? 'model_account_adjustment.trash' : 'model_account_adjustment.restore',
      before: current,
      after,
    });
    await this.recordChange(manager, after);
    return after;
  }

  async getProjection(manager: EntityManager, id: string): Promise<ModelAccountAdjustmentProjection> {
    const rows: AdjustmentRow[] = await manager.query(
      `SELECT "id"::text AS "id", "model_id"::text AS "model_id",
        "model_operation_id"::text AS "model_operation_id", "worker_id"::text AS "worker_id",
        "quantity", "unit_price_snapshot"::text AS "unit_price_snapshot",
        to_char("entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
        "business_date"::text AS "business_date", "version"::text AS "version",
        "created_by"::text AS "created_by", "created_device_id"::text AS "created_device_id",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by"
       FROM "model_account_adjustments" WHERE "id" = $1`,
      [id],
    );
    const projection = rows[0];
    if (!projection) throw new NotFoundException({
      code: 'MODEL_ACCOUNT_ADJUSTMENT_NOT_FOUND', message: 'Qo‘lda qo‘shilgan yozuv topilmadi', details: {},
    });
    return projection;
  }

  async latestChangeSequence(manager: EntityManager, adjustmentId: string): Promise<string> {
    const rows: Array<{ sequence_id: string }> = await manager.query(
      `SELECT "sequence_id"::text AS "sequence_id" FROM "server_change_log"
       WHERE "entity_type" = 'model_account_adjustments' AND "entity_id" = $1
       ORDER BY "sequence_id" DESC LIMIT 1`,
      [adjustmentId],
    );
    const sequence = rows[0]?.sequence_id;
    if (!sequence) throw new Error('Manual Model hisob change sequence was not recorded');
    return sequence;
  }

  private async lockProjection(manager: EntityManager, id: string): Promise<ModelAccountAdjustmentProjection> {
    await manager.query('SELECT "id" FROM "model_account_adjustments" WHERE "id" = $1 FOR UPDATE', [id]);
    return this.getProjection(manager, id);
  }

  private assertExpectedVersion(current: ModelAccountAdjustmentProjection, expectedVersion: string): void {
    if (!POSITIVE_BIGINT_PATTERN.test(expectedVersion) || BigInt(expectedVersion) > MAX_POSTGRES_BIGINT) {
      throw badRequest('VERSION_INVALID', 'Qo‘shimcha versiyasi musbat BIGINT bo‘lishi kerak');
    }
    if (current.version !== expectedVersion) {
      throw conflict('VERSION_CONFLICT', 'Model hisob yozuvi boshqa foydalanuvchi tomonidan o‘zgartirilgan', {
        expected_version: expectedVersion,
        current_version: current.version,
      });
    }
  }

  private assertIdentity(current: ModelAccountAdjustmentProjection, input: ModelAccountAdjustmentMutationPayload): void {
    if (requiredUuid(input.model_id, 'model_id') !== current.model_id ||
      requiredUuid(input.model_operation_id, 'model_operation_id') !== current.model_operation_id ||
      this.workerId(input.worker_id) !== current.worker_id ||
      assertTimestamp(input.entered_at) !== current.entered_at || input.business_date !== current.business_date ||
      normalizePrice(input.unit_price_snapshot) !== new Decimal(current.unit_price_snapshot).toFixed(2)) {
      throw conflict('MODEL_ACCOUNT_ADJUSTMENT_IDENTITY_IMMUTABLE', 'Qo‘shimcha ishchi, operatsiya, sana va narx snapshoti o‘zgarmaydi');
    }
  }

  private async validateReferences(
    manager: EntityManager,
    modelId: string,
    operationId: string,
    workerId: string,
  ): Promise<{ model_id: string; model_operation_id: string }> {
    const modelRows: Array<{ id: string; status: string }> = await manager.query(
      `SELECT "id"::text AS "id", "status" FROM "models" WHERE "id" = $1 FOR SHARE`, [modelId],
    );
    if (modelRows[0]?.status !== 'ACTIVE') throw conflict('MODEL_ACCOUNT_ADJUSTMENT_MODEL_UNAVAILABLE', 'Tanlangan model faol emas');
    const operationRows: Array<{ id: string; model_id: string; status: string }> = await manager.query(
      `SELECT "id"::text AS "id", "model_id"::text AS "model_id", "status"
       FROM "model_operations" WHERE "id" = $1 FOR SHARE`, [operationId],
    );
    const operation = operationRows[0];
    if (!operation || operation.status !== 'ACTIVE' || operation.model_id !== modelId) {
      throw conflict('MODEL_ACCOUNT_ADJUSTMENT_OPERATION_INVALID', 'Operatsiya tanlangan faol modelga tegishli emas');
    }
    const workerRows: Array<{ id: string; status: string }> = await manager.query(
      `SELECT "id"::text AS "id", "status" FROM "workers" WHERE "id" = $1::bigint FOR SHARE`, [workerId],
    );
    if (!workerRows[0]) throw conflict('MODEL_ACCOUNT_ADJUSTMENT_WORKER_NOT_FOUND', 'Ishchi topilmadi');
    return { model_id: modelId, model_operation_id: operation.id };
  }

  private async validatePriceSnapshot(manager: EntityManager, operationId: string, enteredAt: string, inputPrice: string): Promise<string> {
    const unitPrice = normalizePrice(inputPrice);
    const expectedPrice = await this.operationPriceService.resolvePrice(operationId, enteredAt, manager);
    if (new Decimal(expectedPrice).toFixed(2) !== unitPrice) {
      throw conflict('MODEL_ACCOUNT_ADJUSTMENT_PRICE_MISMATCH', 'Narx kiritilgan vaqtdagi tarixiy narxga mos emas');
    }
    return unitPrice;
  }

  private async deriveBusinessDate(
    manager: EntityManager,
    enteredAt: string,
    timezone: string,
    submittedDate: string,
  ): Promise<string> {
    const rows: Array<{ business_date: string }> = await manager.query(
      `SELECT (($1::timestamptz AT TIME ZONE $2::text)::date)::text AS "business_date"`, [enteredAt, timezone],
    );
    const businessDate = rows[0]?.business_date;
    if (!businessDate) throw new Error('Database did not derive Model hisob business date');
    if (submittedDate !== businessDate) {
      throw conflict('MODEL_ACCOUNT_ADJUSTMENT_BUSINESS_DATE_MISMATCH', 'Ish sanasi korxona vaqt mintaqasiga mos emas', {
        submitted_business_date: submittedDate,
        server_business_date: businessDate,
      });
    }
    return businessDate;
  }

  private workerId(value: string): string {
    if (!POSITIVE_BIGINT_PATTERN.test(value) || BigInt(value) > MAX_POSTGRES_BIGINT) {
      throw badRequest('MODEL_ACCOUNT_ADJUSTMENT_WORKER_ID_INVALID', 'Ishchi identifikatori musbat BIGINT bo‘lishi kerak');
    }
    return value;
  }

  private async recordChange(manager: EntityManager, adjustment: ModelAccountAdjustmentProjection): Promise<void> {
    const projection = adjustmentProjection(adjustment);
    await this.syncChangeRecorder.record(manager, {
      entityType: 'model_account_adjustments',
      entityId: adjustment.id,
      operation: 'UPSERT',
      entityVersion: adjustment.version,
      projectionVersion: 3,
      payload: projection,
    });
  }
}
