import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  PattaSheetOperationSnapshotProjection,
  PattaSheetProjection,
  PattaSheetRowProjection,
  SyncProjectionV2,
} from '@textile/sync-protocol';
import { AuditService } from '../audit/audit.service.js';
import { BadgeResolutionService } from '../badges/badge-resolution.service.js';
import { canonicalizeBusinessName } from '../models/business-name.js';
import { pattaRecordNotFound } from '../patta/patta-errors.js';
import { OperationPriceService, normalizePrice } from '../operations/operation-price.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import type {
  CreatePattaSheetDto,
  PattaSheetOperationSnapshotInputDto,
  PattaSheetRowInputDto,
  UpdatePattaSheetDto,
} from './dto/patta-sheet-input.dto.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIGINT_PATTERN = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

interface PattaRow {
  id: string;
  model_id: string;
  partiya_number: string;
  patta_number: string;
  model_name_snapshot: string;
  ish_soni: number | null;
  status: 'ACTIVE' | 'VOID';
}

interface SheetRow {
  id: string;
  patta_hisob_id: string;
  entered_at: string;
  business_date: string;
  conveyor_snapshot: string | null;
  version: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

interface PattaOperationRow {
  id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

interface SheetOperationRow extends PattaSheetOperationSnapshotProjection {}
interface SheetAssignmentRow extends PattaSheetRowProjection {}
interface TransactionTimeRow { transaction_time: string }

export interface PattaSheetMutationContext {
  actorUserId: string;
  validatedDeviceId: string;
  timezone: string;
}

export interface PattaSheetPurgeResult {
  id: string;
  change_sequence: string;
}

export interface ModelAccountSheetResult {
  model_id: string;
  operations: readonly { model_operation_id: string; operation_name: string; sort_order: number }[];
  rows: readonly {
    worker_id: string;
    worker_name: string;
    model_operation_id: string;
    quantity: string;
  }[];
}

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

function assertEnteredAt(value: string): string {
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw badRequest('PATTA_SHEET_ENTERED_AT_INVALID', 'Kiritilgan sana ISO-8601 vaqt ko‘rinishida bo‘lishi kerak');
  }
  return value;
}

function assertBusinessDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw badRequest('PATTA_SHEET_BUSINESS_DATE_INVALID', 'Ish sanasi YYYY-MM-DD ko‘rinishida bo‘lishi kerak');
  }
}

function assertQuantity(value: number, expected: number): void {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw conflict('PATTA_SHEET_QUANTITY_MISMATCH', 'Varaqdagi miqdor Patta mahsulot miqdoriga mos emas', {
      patta_quantity: expected,
      submitted_quantity: value,
    });
  }
}

function normalizeConveyor(value: string | null | undefined): string | null {
  if (value == null) return null;
  const conveyor = canonicalizeBusinessName(value);
  if (!conveyor) throw badRequest('PATTA_SHEET_CONVEYOR_INVALID', 'Konveyer qiymati bo‘sh bo‘lishi mumkin emas');
  return conveyor;
}

function assertWorkerId(value: string): string {
  if (!BIGINT_PATTERN.test(value) || BigInt(value) > MAX_POSTGRES_BIGINT) {
    throw badRequest('PATTA_SHEET_WORKER_ID_INVALID', 'Ishchi identifikatori musbat BIGINT bo‘lishi kerak');
  }
  return value;
}

function projection(
  data: PattaSheetProjection,
): SyncProjectionV2 {
  return {
    projection_version: 2,
    entity_type: 'patta_sheets',
    entity_id: data.id,
    entity_version: data.version,
    data,
  };
}

@Injectable()
export class PattaSheetsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly badgeResolutionService: BadgeResolutionService,
    private readonly operationPriceService: OperationPriceService,
    private readonly syncChangeRecorder: SyncChangeRecorder,
  ) {}

  async create(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    input: CreatePattaSheetDto,
  ): Promise<PattaSheetProjection> {
    try {
      return await dataSource.transaction((manager) => this.createInTransaction(manager, context, input));
    } catch (error) {
      if (isConstraint(error, 'uq_patta_sheets_patta')) {
        throw conflict('PATTA_SHEET_ALREADY_EXISTS', 'Ushbu Patta uchun varaq allaqachon yaratilgan');
      }
      if (isConstraint(error, 'uq_patta_sheet_rows_active_operation')) {
        throw conflict('PATTA_SHEET_OPERATION_ALREADY_ASSIGNED', 'Bu operatsiya qatorida faol topshiriq allaqachon bor');
      }
      throw error;
    }
  }

  async createInTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    input: CreatePattaSheetDto,
  ): Promise<PattaSheetProjection> {
    const sheetId = requiredUuid(input.id, 'id');
    const pattaId = requiredUuid(input.patta_hisob_id, 'patta_hisob_id');
    const enteredAt = assertEnteredAt(input.entered_at);
    assertBusinessDate(input.business_date);
    if (input.deleted_at != null || input.deleted_by != null) {
      throw badRequest('PATTA_SHEET_CREATE_DELETION_INVALID', 'Yangi varaq o‘chirilgan holatda yaratilmaydi');
    }
    const conveyor = normalizeConveyor(input.conveyor_snapshot);
    const pattaRows: PattaRow[] = await manager.query(
      `SELECT "id", "model_id", "partiya_number", "patta_number"::text AS "patta_number",
        "model_name_snapshot", "ish_soni", "status"
       FROM "patta_hisob" WHERE "id" = $1 FOR UPDATE`,
      [pattaId],
    );
    const patta = pattaRows[0];
    if (!patta) throw pattaRecordNotFound();
    if (patta.status !== 'ACTIVE') throw conflict('PATTA_INACTIVE', 'VOID qilingan Patta uchun varaq yaratib bo‘lmaydi');
    if (patta.ish_soni === null) {
      throw conflict('PATTA_QUANTITY_UNKNOWN', 'Patta haqiqiy mahsulot miqdori tuzatilmaguncha varaq yaratib bo‘lmaydi');
    }
    const priorSheets: SheetRow[] = await manager.query(
      `SELECT "id", "patta_hisob_id", "entered_at"::text AS "entered_at",
        "business_date"::text AS "business_date", "conveyor_snapshot", "version"::text AS "version",
        "created_by"::text AS "created_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by"
       FROM "patta_sheets" WHERE "patta_hisob_id" = $1 FOR UPDATE`,
      [pattaId],
    );
    const existing = priorSheets[0];
    if (existing) {
      if (existing.deleted_at !== null) {
        throw conflict('PATTA_SHEET_TRASHED', 'Patta Korzinkada; avval varaqni qayta tiklang');
      }
      return this.getProjection(manager, existing.id);
    }

    const businessDateRows: Array<{ business_date: string }> = await manager.query(
      `SELECT (($1::timestamptz AT TIME ZONE $2::text)::date)::text AS "business_date"`,
      [enteredAt, context.timezone],
    );
    const businessDate = businessDateRows[0]?.business_date;
    if (!businessDate) throw new Error('Database did not derive Patta Sheet business date');
    if (businessDate !== input.business_date) {
      throw conflict('PATTA_SHEET_BUSINESS_DATE_MISMATCH', 'Ish sanasi korxona vaqt mintaqasiga mos emas', {
        submitted_business_date: input.business_date,
        server_business_date: businessDate,
      });
    }

    const snapshots = await this.validateSnapshots(manager, patta, enteredAt, input.operation_snapshots);
    const rows = await this.validateRows(manager, context, patta, enteredAt, snapshots, input.rows);
    const transactionTimeRows: TransactionTimeRow[] = await manager.query(
      'SELECT transaction_timestamp()::text AS "transaction_time"',
    );
    const transactionTime = transactionTimeRows[0]?.transaction_time;
    if (!transactionTime) throw new Error('Database transaction timestamp was not returned');
    await manager.query(
      `INSERT INTO "patta_sheets"
        ("id", "patta_hisob_id", "entered_at", "business_date", "conveyor_snapshot", "created_by")
       VALUES ($1, $2, $3::timestamptz, $4::date, $5, $6)`,
      [sheetId, pattaId, enteredAt, businessDate, conveyor, context.actorUserId],
    );
    for (const snapshot of snapshots) {
      await manager.query(
        `INSERT INTO "patta_sheet_operation_snapshots"
          ("id", "patta_sheet_id", "model_operation_id", "source_type",
           "source_patta_operation_snapshot_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric(14,2), $8)`,
        [snapshot.id, sheetId, snapshot.model_operation_id, snapshot.source_type,
          snapshot.source_patta_operation_snapshot_id, snapshot.operation_name_snapshot,
          snapshot.unit_price_snapshot, snapshot.sort_order],
      );
    }
    for (const row of rows) {
      await manager.query(
        `INSERT INTO "patta_sheet_rows"
          ("id", "patta_sheet_id", "patta_sheet_operation_snapshot_id", "worker_id",
           "quantity_snapshot", "nuqson", "deleted_at", "deleted_by")
         VALUES ($1, $2, $3, $4::bigint, $5, $6, $7::timestamptz, $8::uuid)`,
        [row.id, sheetId, row.patta_sheet_operation_snapshot_id, row.worker_id,
          row.quantity_snapshot, row.nuqson, row.deleted_at ?? null, row.deleted_by ?? null],
      );
    }
    const result = await this.getProjection(manager, sheetId);
    await this.auditService.append(manager, {
      actorUserId: context.actorUserId,
      deviceId: context.validatedDeviceId,
      entityType: 'patta_sheet',
      entityId: sheetId,
      action: 'patta_sheet.create',
      before: null,
      after: result,
    });
    await this.recordChange(manager, result);
    return result;
  }

  async getById(dataSource: DataSource, sheetIdInput: string): Promise<PattaSheetProjection> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    return this.getProjection(dataSource, sheetId);
  }

  async findByPatta(dataSource: DataSource, pattaIdInput: string): Promise<PattaSheetProjection | null> {
    const pattaId = requiredUuid(pattaIdInput, 'patta_hisob_id');
    const rows: Array<{ id: string }> = await dataSource.query(
      `SELECT "id"::text AS "id" FROM "patta_sheets" WHERE "patta_hisob_id" = $1`, [pattaId],
    );
    const sheet = rows[0];
    return sheet ? this.getProjection(dataSource, sheet.id) : null;
  }

  async correctQuantitySnapshots(
    manager: EntityManager,
    actorUserId: string,
    deviceId: string,
    sheetIds: readonly string[],
    quantity: number,
    reason: string,
  ): Promise<void> {
    for (const sheetId of [...new Set(sheetIds)].sort()) {
      const before = await this.getProjection(manager, sheetId);
      await manager.query(
        `UPDATE "patta_sheet_rows" SET "quantity_snapshot" = $1
         WHERE "patta_sheet_id" = $2 AND "deleted_at" IS NULL`,
        [quantity, sheetId],
      );
      await manager.query(
        `UPDATE "patta_sheets" SET "version" = "version" + 1,
          "updated_at" = transaction_timestamp() WHERE "id" = $1`,
        [sheetId],
      );
      const after = await this.getProjection(manager, sheetId);
      await this.auditService.append(manager, {
        actorUserId,
        deviceId,
        entityType: 'patta_sheet',
        entityId: sheetId,
        action: 'patta_sheet.update',
        before,
        after: { ...after, quantity_correction_reason: reason },
      });
      await this.recordChange(manager, after);
    }
  }

  async update(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    input: UpdatePattaSheetDto,
  ): Promise<PattaSheetProjection> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    return dataSource.transaction((manager) => this.updateInTransaction(manager, context, sheetId, input));
  }

  async updateInTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    input: UpdatePattaSheetDto,
    clientMutationAt?: string,
  ): Promise<PattaSheetProjection> {
      const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
      const current = await this.lockSheet(manager, sheetId);
      this.assertExpectedVersion(current, input.expected_version);
      if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
      if (current.deleted_at !== null) throw conflict('PATTA_SHEET_TRASHED', 'Korzinkadagi varaqni tahrirlab bo‘lmaydi');
      const before = await this.getProjection(manager, sheetId);
      const submittedEnteredAt = await this.canonicalDatabaseTimestamp(manager, assertEnteredAt(input.entered_at));
      if (requiredUuid(input.id, 'id') !== current.id ||
        requiredUuid(input.patta_hisob_id, 'patta_hisob_id') !== current.patta_hisob_id ||
        submittedEnteredAt !== current.entered_at ||
        input.business_date !== current.business_date) {
        throw conflict('PATTA_SHEET_IDENTITY_IMMUTABLE', 'Varaq identifikatori, Patta va Kiritilgan sana o‘zgarmaydi');
      }
      if ((input.deleted_at ?? null) !== current.deleted_at || (input.deleted_by ?? null) !== current.deleted_by) {
        throw conflict('PATTA_SHEET_LIFECYCLE_REQUIRES_EXPLICIT_ACTION', 'Korzinka amali alohida RESTORE yoki TRASH so‘rovi bilan bajariladi');
      }
      const pattaRows: PattaRow[] = await manager.query(
        `SELECT "id", "model_id", "partiya_number", "patta_number"::text AS "patta_number",
          "model_name_snapshot", "ish_soni", "status" FROM "patta_hisob" WHERE "id" = $1 FOR UPDATE`,
        [current.patta_hisob_id],
      );
      const patta = pattaRows[0];
      if (!patta) throw pattaRecordNotFound();
      if (patta.status !== 'ACTIVE' || patta.ish_soni === null) {
        throw conflict('PATTA_SHEET_PATTA_UNAVAILABLE', 'Ushbu Patta uchun varaqni tahrirlab bo‘lmaydi');
      }
      const existingAssignmentRows: Array<{ id: string; worker_id: string }> = await manager.query(
        `SELECT "id", "worker_id"::text AS "worker_id" FROM "patta_sheet_rows"
         WHERE "patta_sheet_id" = $1 AND "deleted_at" IS NULL`, [sheetId],
      );
      const existingWorkerByRowId = new Map(existingAssignmentRows.map(({ id, worker_id }) => [id, worker_id]));
      const snapshots = await this.validateSnapshots(manager, patta, current.entered_at, input.operation_snapshots, sheetId);
      const validatedRows = await this.validateRows(
        manager, context, patta, current.entered_at, snapshots, input.rows, existingWorkerByRowId,
      );
      await this.persistUpdatedSnapshots(manager, sheetId, snapshots);
      await this.persistUpdatedRows(manager, context, sheetId, validatedRows, clientMutationAt);
      const conveyor = normalizeConveyor(input.conveyor_snapshot);
      const nextVersion = (BigInt(current.version) + 1n).toString();
      await manager.query(
        `UPDATE "patta_sheets" SET "conveyor_snapshot" = $1, "version" = $2::bigint,
          "updated_at" = transaction_timestamp() WHERE "id" = $3`,
        [conveyor, nextVersion, sheetId],
      );
      const result = await this.getProjection(manager, sheetId);
      const previousRows = new Map(before.rows.map((row) => [row.id, row]));
      for (const row of result.rows) {
        const previous = previousRows.get(row.id);
        if (previous && previous.deleted_at === null && row.deleted_at !== null) {
          await this.auditService.append(manager, {
            actorUserId: context.actorUserId,
            deviceId: context.validatedDeviceId,
            entityType: 'patta_sheet',
            entityId: row.id,
            action: 'patta_sheet.row_delete',
            before: previous,
            after: row,
          });
        }
      }
      await this.auditService.append(manager, {
        actorUserId: context.actorUserId,
        deviceId: context.validatedDeviceId,
        entityType: 'patta_sheet',
        entityId: sheetId,
        action: 'patta_sheet.update',
        before,
        after: result,
      });
      await this.recordChange(manager, result);
      return result;
  }

  async trash(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
  ): Promise<PattaSheetProjection> {
    return this.setTrashed(dataSource, context, sheetIdInput, expectedVersion, true);
  }

  async restore(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
  ): Promise<PattaSheetProjection> {
    return this.setTrashed(dataSource, context, sheetIdInput, expectedVersion, false);
  }

  async purge(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
  ): Promise<PattaSheetPurgeResult> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    return dataSource.transaction((manager) => this.purgeInTransaction(manager, context, sheetId, expectedVersion));
  }

  async purgeInTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
  ): Promise<PattaSheetPurgeResult> {
      const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
      const current = await this.lockSheet(manager, sheetId);
      this.assertExpectedVersion(current, expectedVersion);
      if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
      if (current.deleted_at === null) throw conflict('PATTA_SHEET_PURGE_REQUIRES_TRASH', 'Butunlay o‘chirishdan oldin varaqni Korzinkaga yuboring');
      const before = await this.getProjection(manager, sheetId);
      await this.auditService.append(manager, {
        actorUserId: context.actorUserId,
        deviceId: context.validatedDeviceId,
        entityType: 'patta_sheet',
        entityId: sheetId,
        action: 'patta_sheet.purge',
        before,
        after: { id: sheetId, patta_hisob_id: current.patta_hisob_id, purged: true },
      });
      for (const row of before.rows) {
        await this.recordTombstone(manager, 'patta_sheet_rows', row.id);
      }
      for (const snapshot of before.operation_snapshots) {
        await this.recordTombstone(manager, 'patta_sheet_operation_snapshots', snapshot.id);
      }
      await this.recordTombstone(manager, 'patta_sheets', sheetId);
      await manager.query('DELETE FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1', [sheetId]);
      await manager.query('DELETE FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1', [sheetId]);
      await manager.query('DELETE FROM "patta_sheets" WHERE "id" = $1', [sheetId]);
      const last = await this.syncChangeRecorder.record(manager, {
        entityType: 'patta_sheets', entityId: sheetId, operation: 'DELETE',
        entityVersion: current.version, projectionVersion: 2, payload: null,
      });
      return { id: sheetId, change_sequence: last.sequenceId };
  }

  private async setTrashed(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
    trashed: boolean,
  ): Promise<PattaSheetProjection> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    return dataSource.transaction((manager) => this.setTrashedInTransaction(
      manager, context, sheetId, expectedVersion, trashed,
    ));
  }

  async setTrashedInTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
    trashed: boolean,
    occurredAt?: string,
  ): Promise<PattaSheetProjection> {
      const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
      const current = await this.lockSheet(manager, sheetId);
      this.assertExpectedVersion(current, expectedVersion);
      if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
      if ((current.deleted_at !== null) === trashed) {
        throw conflict(trashed ? 'PATTA_SHEET_ALREADY_TRASHED' : 'PATTA_SHEET_NOT_TRASHED',
          trashed ? 'Varaq allaqachon Korzinkada' : 'Varaq Korzinkada emas');
      }
      const before = await this.getProjection(manager, sheetId);
      const nextVersion = (BigInt(current.version) + 1n).toString();
      await manager.query(
        `UPDATE "patta_sheets" SET "deleted_at" = CASE WHEN $1 THEN COALESCE($5::timestamptz, transaction_timestamp()) ELSE NULL END,
          "deleted_by" = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
          "version" = $3::bigint, "updated_at" = transaction_timestamp()
         WHERE "id" = $4`,
        [trashed, context.actorUserId, nextVersion, sheetId, occurredAt ?? null],
      );
      const after = await this.getProjection(manager, sheetId);
      await this.auditService.append(manager, {
        actorUserId: context.actorUserId,
        deviceId: context.validatedDeviceId,
        entityType: 'patta_sheet',
        entityId: sheetId,
        action: trashed ? 'patta_sheet.trash' : 'patta_sheet.restore',
        before,
        after,
      });
      await this.recordChange(manager, after);
      return after;
  }

  private async lockSheet(manager: EntityManager, sheetId: string): Promise<SheetRow> {
    const rows: SheetRow[] = await manager.query(
      `SELECT "id", "patta_hisob_id"::text AS "patta_hisob_id",
        to_char("entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
        "business_date"::text AS "business_date", "conveyor_snapshot", "version"::text AS "version",
        "created_by"::text AS "created_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by"
       FROM "patta_sheets" WHERE "id" = $1 FOR UPDATE`,
      [sheetId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: 'PATTA_SHEET_NOT_FOUND', message: 'Patta varag‘i topilmadi', details: {} });
    return row;
  }

  private assertExpectedVersion(sheet: SheetRow, expectedVersion: string): void {
    if (!BIGINT_PATTERN.test(expectedVersion) || BigInt(expectedVersion) > MAX_POSTGRES_BIGINT) {
      throw badRequest('VERSION_INVALID', 'Varaq versiyasi musbat BIGINT bo‘lishi kerak');
    }
    if (sheet.version !== expectedVersion) {
      throw conflict('VERSION_CONFLICT', 'Patta varag‘i boshqa foydalanuvchi tomonidan o‘zgartirilgan', {
        expected_version: expectedVersion,
        current_version: sheet.version,
      });
    }
  }

  async getProjection(manager: DataSource | EntityManager, sheetId: string): Promise<PattaSheetProjection> {
    const rows: SheetRow[] = await manager.query(
      `SELECT "id", "patta_hisob_id"::text AS "patta_hisob_id",
        to_char("entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
        "business_date"::text AS "business_date", "conveyor_snapshot", "version"::text AS "version",
        "created_by"::text AS "created_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by"
       FROM "patta_sheets" WHERE "id" = $1`,
      [sheetId],
    );
    const sheet = rows[0];
    if (!sheet) throw new NotFoundException({ code: 'PATTA_SHEET_NOT_FOUND', message: 'Patta varag‘i topilmadi', details: {} });
    const operationSnapshots: SheetOperationRow[] = await manager.query(
      `SELECT "id", "patta_sheet_id"::text AS "patta_sheet_id", "model_operation_id"::text AS "model_operation_id",
        "source_type", "source_patta_operation_snapshot_id"::text AS "source_patta_operation_snapshot_id",
        "operation_name_snapshot", "unit_price_snapshot"::text AS "unit_price_snapshot", "sort_order",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
       FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1
       ORDER BY "sort_order", "model_operation_id"`,
      [sheetId],
    );
    const rowsProjection: SheetAssignmentRow[] = await manager.query(
      `SELECT "id", "patta_sheet_id"::text AS "patta_sheet_id",
        "patta_sheet_operation_snapshot_id"::text AS "patta_sheet_operation_snapshot_id",
        "worker_id"::text AS "worker_id", "quantity_snapshot", "nuqson",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at"
       FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1
       ORDER BY "created_at", "id"`,
      [sheetId],
    );
    return {
      ...sheet,
      operation_snapshots: operationSnapshots,
      rows: rowsProjection,
    };
  }

  private async canonicalDatabaseTimestamp(manager: EntityManager, value: string): Promise<string> {
    const rows: Array<{ timestamp_value: string }> = await manager.query(
      `SELECT to_char($1::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "timestamp_value"`,
      [value],
    );
    const timestampValue = rows[0]?.timestamp_value;
    if (!timestampValue) throw new Error('Database did not normalize the Patta Sheet timestamp');
    return timestampValue;
  }

  private async validateSnapshots(
    manager: EntityManager,
    patta: PattaRow,
    enteredAt: string,
    inputs: readonly PattaSheetOperationSnapshotInputDto[],
    sheetId?: string,
  ): Promise<PattaSheetOperationSnapshotProjection[]> {
    if (inputs.length === 0) throw badRequest('PATTA_SHEET_OPERATION_REQUIRED', 'Varaqda kamida bitta operatsiya bo‘lishi kerak');
    const inputIds = new Set<string>();
    const modelOperationIds = new Set<string>();
    const sortOrders = new Set<number>();
    for (const input of inputs) {
      requiredUuid(input.id, 'operation_snapshot.id');
      requiredUuid(input.model_operation_id, 'model_operation_id');
      if (input.source_type !== 'PATTA' && input.source_type !== 'CUSTOM') {
        throw badRequest('PATTA_SHEET_OPERATION_SOURCE_INVALID', 'Operatsiya manbasi PATTA yoki CUSTOM bo‘lishi kerak');
      }
      if (!Number.isSafeInteger(input.sort_order) || input.sort_order < 0 || sortOrders.has(input.sort_order)) {
        throw badRequest('PATTA_SHEET_OPERATION_ORDER_INVALID', 'Operatsiya tartibi noto‘g‘ri');
      }
      if (inputIds.has(input.id) || modelOperationIds.has(input.model_operation_id)) {
        throw badRequest('PATTA_SHEET_OPERATION_DUPLICATE', 'Varaq operatsiyasi takrorlangan');
      }
      inputIds.add(input.id);
      modelOperationIds.add(input.model_operation_id);
      sortOrders.add(input.sort_order);
    }
    const originalRows: PattaOperationRow[] = await manager.query(
      `SELECT "id"::text AS "id", "operation_id"::text AS "operation_id",
        "operation_name_snapshot", "unit_price_snapshot"::text AS "unit_price_snapshot", "sort_order"
       FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1
       ORDER BY "sort_order", "operation_id"`,
      [patta.id],
    );
    if (originalRows.length === 0) throw conflict('PATTA_SNAPSHOT_MISMATCH', 'Patta operatsiya tarixi topilmadi');
    const originalById = new Map(originalRows.map((row) => [row.id, row]));
    const currentSnapshots: SheetOperationRow[] = sheetId
      ? await manager.query(
        `SELECT "id", "patta_sheet_id"::text AS "patta_sheet_id", "model_operation_id"::text AS "model_operation_id",
          "source_type", "source_patta_operation_snapshot_id"::text AS "source_patta_operation_snapshot_id",
          "operation_name_snapshot", "unit_price_snapshot"::text AS "unit_price_snapshot", "sort_order",
          to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at"
         FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1`,
        [sheetId],
      )
      : [];
    const currentById = new Map(currentSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const results: PattaSheetOperationSnapshotProjection[] = [];
    for (const input of inputs) {
      const id = input.id.toLowerCase();
      const modelOperationId = input.model_operation_id.toLowerCase();
      const name = canonicalizeBusinessName(input.operation_name_snapshot);
      const price = normalizePrice(input.unit_price_snapshot);
      const existingSnapshot = currentById.get(id);
      let sourceId: string | null = input.source_patta_operation_snapshot_id ?? null;
      if (input.source_type === 'PATTA') {
        if (!sourceId) throw badRequest('PATTA_SHEET_SOURCE_SNAPSHOT_INVALID', 'Patta snapshot manbasi ko‘rsatilmagan');
        sourceId = requiredUuid(sourceId, 'source_patta_operation_snapshot_id');
        const original = originalById.get(sourceId);
        if (!original || original.operation_id !== modelOperationId || original.operation_name_snapshot !== name ||
          new Decimal(original.unit_price_snapshot).toFixed(2) !== price || original.sort_order !== input.sort_order) {
          throw conflict('PATTA_SHEET_SOURCE_SNAPSHOT_INVALID', 'Patta operatsiya snapshotini o‘zgartirib bo‘lmaydi');
        }
      } else {
        if (sourceId !== null) throw badRequest('PATTA_SHEET_SOURCE_SNAPSHOT_INVALID', 'CUSTOM operatsiyada Patta manbasi bo‘lmasligi kerak');
        const operationRows: Array<{ model_id: string; name: string; status: string; sort_order: number }> = await manager.query(
          `SELECT "model_id"::text AS "model_id", "name", "status", "sort_order"
           FROM "model_operations" WHERE "id" = $1 FOR SHARE`,
          [modelOperationId],
        );
        const operation = operationRows[0];
        if (!operation || operation.model_id !== patta.model_id ||
          (!existingSnapshot && (operation.status !== 'ACTIVE' || operation.name !== name))) {
          throw conflict('PATTA_SHEET_CUSTOM_OPERATION_INVALID', 'CUSTOM operatsiya shu modelga tegishli faol operatsiya bo‘lishi kerak');
        }
        if (!existingSnapshot) {
          const historicalPrice = await this.operationPriceService.resolvePrice(modelOperationId, enteredAt, manager);
          if (new Decimal(historicalPrice).toFixed(2) !== price) {
            throw conflict('PATTA_SHEET_OPERATION_PRICE_MISMATCH', 'Operatsiya narxi Kiritilgan vaqtdagi narxga mos emas');
          }
        }
      }
      if (existingSnapshot) {
        if (existingSnapshot.patta_sheet_id !== sheetId || existingSnapshot.model_operation_id !== modelOperationId ||
          existingSnapshot.source_type !== input.source_type ||
          existingSnapshot.source_patta_operation_snapshot_id !== sourceId ||
          existingSnapshot.operation_name_snapshot !== name ||
          new Decimal(existingSnapshot.unit_price_snapshot).toFixed(2) !== price ||
          existingSnapshot.sort_order !== input.sort_order) {
          throw conflict('PATTA_SHEET_OPERATION_IMMUTABLE', 'Varaq operatsiya tarixini o‘zgartirib bo‘lmaydi');
        }
        results.push(existingSnapshot);
      } else {
        results.push({
          id,
          patta_sheet_id: sheetId ?? '',
          model_operation_id: modelOperationId,
          source_type: input.source_type,
          source_patta_operation_snapshot_id: sourceId,
          operation_name_snapshot: name,
          unit_price_snapshot: price,
          sort_order: input.sort_order,
          created_at: '',
        });
      }
    }
    if (sheetId && currentSnapshots.some((snapshot) => !inputIds.has(snapshot.id))) {
      throw conflict('PATTA_SHEET_OPERATION_IMMUTABLE', 'Varaqdagi tarixiy operatsiya snapshotlarini olib tashlab bo‘lmaydi');
    }
    for (const original of originalRows) {
      const matched = inputs.some((input) => input.source_type === 'PATTA' &&
        input.source_patta_operation_snapshot_id?.toLowerCase() === original.id);
      if (!matched) throw conflict('PATTA_SHEET_SOURCE_SNAPSHOT_REQUIRED', 'Barcha original Patta operatsiyalari varaqda saqlanishi kerak');
    }
    return results;
  }

  private async validateRows(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    patta: PattaRow,
    enteredAt: string,
    snapshots: readonly PattaSheetOperationSnapshotProjection[],
    inputRows: readonly PattaSheetRowInputDto[],
    existingWorkerByRowId: ReadonlyMap<string, string> = new Map(),
  ): Promise<Array<PattaSheetRowInputDto & { worker_id: string }>> {
    if (patta.ish_soni === null) throw conflict('PATTA_QUANTITY_UNKNOWN', 'Patta miqdori noma’lum');
    const snapshotIds = new Set(snapshots.map(({ id }) => id.toLowerCase()));
    const rowIds = new Set<string>();
    const activeAssignmentIds = new Set<string>();
    const output: Array<PattaSheetRowInputDto & { worker_id: string }> = [];
    for (const input of inputRows) {
      const rowId = requiredUuid(input.id, 'row.id');
      const operationSnapshotId = requiredUuid(input.patta_sheet_operation_snapshot_id, 'patta_sheet_operation_snapshot_id');
      const deleted = input.deleted_at != null;
      if (typeof input.nuqson !== 'boolean') throw badRequest('PATTA_SHEET_ROW_INVALID', 'Nuqson belgisi boolean bo‘lishi kerak');
      if (deleted && (typeof input.deleted_at !== 'string' || !ISO_TIMESTAMP.test(input.deleted_at) ||
        !Number.isFinite(Date.parse(input.deleted_at)))) {
        throw badRequest('PATTA_SHEET_ROW_DELETE_TIME_INVALID', 'Qator o‘chirilgan vaqti ISO-8601 bo‘lishi kerak');
      }
      if (rowIds.has(rowId) || (!deleted && activeAssignmentIds.has(operationSnapshotId)) || !snapshotIds.has(operationSnapshotId)) {
        throw badRequest('PATTA_SHEET_ROW_INVALID', 'Ish topshirig‘i takrorlangan yoki operatsiya varaqda yo‘q');
      }
      rowIds.add(rowId);
      if (!deleted) activeAssignmentIds.add(operationSnapshotId);
      assertQuantity(input.quantity_snapshot, patta.ish_soni);
      if (deleted) {
        if (!UUID_PATTERN.test(input.deleted_by ?? '') || !ISO_TIMESTAMP.test(input.deleted_at ?? '') ||
          !Number.isFinite(Date.parse(input.deleted_at ?? ''))) {
          throw badRequest('PATTA_SHEET_ROW_DELETE_TIME_INVALID', 'O‘chirilgan qator foydalanuvchisi yoki vaqti noto‘g‘ri');
        }
        output.push({ ...input, id: rowId, patta_sheet_operation_snapshot_id: operationSnapshotId,
          worker_id: assertWorkerId(input.worker_id) });
        continue;
      }
      const badge = canonicalizeBusinessName(input.entered_badge_number);
      const submittedWorkerId = assertWorkerId(input.worker_id);
      const currentWorkerId = existingWorkerByRowId.get(rowId);
      if (!badge && currentWorkerId === submittedWorkerId) {
        output.push({ ...input, id: rowId, patta_sheet_operation_snapshot_id: operationSnapshotId,
          worker_id: submittedWorkerId, entered_badge_number: '' });
        continue;
      }
      if (!badge) throw badRequest('PATTA_SHEET_BADGE_REQUIRED', 'Ishchi jetonini kiriting');
      const resolution = await this.badgeResolutionService.resolve(manager, badge, enteredAt);
      if (resolution.worker_id !== submittedWorkerId) {
        throw conflict('CONFLICT_BADGE_ASSIGNMENT', 'Jeton Kiritilgan vaqtda boshqa ishchiga tegishli', {
          badge_number: badge,
          submitted_worker_id: submittedWorkerId,
          resolved_worker_id: resolution.worker_id,
        });
      }
      output.push({ ...input, id: rowId, patta_sheet_operation_snapshot_id: operationSnapshotId,
        worker_id: submittedWorkerId, entered_badge_number: badge });
    }
    return output;
  }

  private async persistUpdatedSnapshots(
    manager: EntityManager,
    sheetId: string,
    snapshots: readonly PattaSheetOperationSnapshotProjection[],
  ): Promise<void> {
    for (const snapshot of snapshots) {
      if (snapshot.created_at !== '') continue;
      await manager.query(
        `INSERT INTO "patta_sheet_operation_snapshots"
          ("id", "patta_sheet_id", "model_operation_id", "source_type",
           "source_patta_operation_snapshot_id", "operation_name_snapshot", "unit_price_snapshot", "sort_order")
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric(14,2), $8)`,
        [snapshot.id, sheetId, snapshot.model_operation_id, snapshot.source_type,
          snapshot.source_patta_operation_snapshot_id, snapshot.operation_name_snapshot,
          snapshot.unit_price_snapshot, snapshot.sort_order],
      );
    }
  }

  private async persistUpdatedRows(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    sheetId: string,
    rows: readonly (PattaSheetRowInputDto & { worker_id: string })[],
    clientMutationAt?: string,
  ): Promise<void> {
    const existingRows: Array<{
      id: string; patta_sheet_operation_snapshot_id: string;
      deleted_at: Date | string | null; deleted_by: string | null;
    }> = await manager.query(
      `SELECT "id", "patta_sheet_operation_snapshot_id"::text AS "patta_sheet_operation_snapshot_id",
        "deleted_at", "deleted_by"::text AS "deleted_by"
       FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1 FOR UPDATE`, [sheetId],
    );
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const inputIds = new Set(rows.map(({ id }) => id));
    if (existingRows.some((row) => !inputIds.has(row.id))) {
      throw conflict('PATTA_SHEET_ROW_REQUIRED', 'Mavjud varaq qatorlarini olib tashlash mumkin emas; O‘chirish amalidan foydalaning');
    }
    const newlyDeleted = new Set<string>();
    for (const row of rows) {
      const existing = existingById.get(row.id);
      if (existing && existing.deleted_at === null && row.deleted_at != null) {
        await manager.query(
          `UPDATE "patta_sheet_rows" SET
            "deleted_at" = COALESCE("deleted_at", COALESCE($1::timestamptz, transaction_timestamp())),
            "deleted_by" = COALESCE("deleted_by", $2::uuid), "updated_at" = transaction_timestamp()
           WHERE "id" = $3`,
          [row.deleted_at ?? clientMutationAt ?? null, context.actorUserId, row.id],
        );
        newlyDeleted.add(row.id);
      }
    }
    for (const row of rows) {
      const existing = existingById.get(row.id);
      const deleting = row.deleted_at != null;
      if (existing?.deleted_at != null && !deleting) {
        throw conflict('PATTA_SHEET_ROW_DELETED', 'O‘chirilgan qatorga qayta tayinlash uchun yangi qator yarating');
      }
      if (existing && existing.deleted_at === null && !deleting &&
        existing.patta_sheet_operation_snapshot_id !== row.patta_sheet_operation_snapshot_id) {
        throw conflict('PATTA_SHEET_ROW_OPERATION_IMMUTABLE', 'Boshqa operatsiyaga tayinlash uchun eski qatorni o‘chirib, yangi qator yarating');
      }
      if (deleting) {
        if (!existing) throw badRequest('PATTA_SHEET_ROW_INVALID', 'Yangi qatorni o‘chirilgan holatda yaratib bo‘lmaydi');
        if (existing.deleted_at === null && !newlyDeleted.has(row.id)) {
          throw new Error('Entry row delete phase did not apply');
        }
      } else if (existing) {
        await manager.query(
          `UPDATE "patta_sheet_rows" SET "patta_sheet_operation_snapshot_id" = $1,
            "worker_id" = $2::bigint, "quantity_snapshot" = $3, "nuqson" = $4,
            "updated_at" = transaction_timestamp()
           WHERE "id" = $5 AND "patta_sheet_id" = $6`,
          [row.patta_sheet_operation_snapshot_id, row.worker_id, row.quantity_snapshot,
            row.nuqson, row.id, sheetId],
        );
      } else {
        await manager.query(
          `INSERT INTO "patta_sheet_rows"
            ("id", "patta_sheet_id", "patta_sheet_operation_snapshot_id", "worker_id", "quantity_snapshot", "nuqson")
           VALUES ($1, $2, $3, $4::bigint, $5, $6)`,
          [row.id, sheetId, row.patta_sheet_operation_snapshot_id, row.worker_id,
            row.quantity_snapshot, row.nuqson],
        );
      }
    }
  }

  private async recordChange(manager: EntityManager, sheet: PattaSheetProjection): Promise<string> {
    const change = await this.syncChangeRecorder.record(manager, {
      entityType: 'patta_sheets',
      entityId: sheet.id,
      operation: 'UPSERT',
      entityVersion: sheet.version,
      projectionVersion: 2,
      payload: projection(sheet),
    });
    return change.sequenceId;
  }

  async latestChangeSequence(manager: EntityManager, sheetId: string): Promise<string> {
    const rows: Array<{ sequence_id: string }> = await manager.query(
      `SELECT "sequence_id"::text AS "sequence_id" FROM "server_change_log"
       WHERE "entity_type" = 'patta_sheets' AND "entity_id" = $1
       ORDER BY "sequence_id" DESC LIMIT 1`,
      [sheetId],
    );
    const sequence = rows[0]?.sequence_id;
    if (!sequence) throw new Error('Patta Sheet change sequence was not recorded');
    return sequence;
  }

  private recordTombstone(manager: EntityManager, entityType: string, entityId: string): Promise<{ sequenceId: string }> {
    return this.syncChangeRecorder.record(manager, {
      entityType,
      entityId,
      operation: 'DELETE',
      entityVersion: null,
      projectionVersion: 2,
      payload: null,
    });
  }
}

function isConstraint(error: unknown, constraintName: string): boolean {
  if (!(error instanceof Error)) return false;
  const driverError = Reflect.get(error, 'driverError');
  return typeof driverError === 'object' && driverError !== null &&
    Reflect.get(driverError, 'constraint') === constraintName;
}
