import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { DataSource, EntityManager } from 'typeorm';
import type {
  PattaSheetOperationSnapshotProjection,
  PattaSheetOperationSnapshotProjectionV3,
  PattaSheetProjection,
  PattaSheetProjectionV3,
  PattaSheetRowProjection,
  SyncProjectionV3,
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
import type {
  CreatePattaSheetV3Dto,
  PattaSheetV3OperationSnapshotInputDto,
  UpdatePattaSheetV3Dto,
} from './dto/patta-sheet-v3-input.dto.js';

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
  rang: string | null;
  razmer: string | null;
  status: 'ACTIVE' | 'VOID';
}

interface SheetRow {
  id: string;
  entry_kind: 'PATTA_LINKED' | 'STANDALONE';
  patta_hisob_id: string | null;
  model_id: string;
  model_name_snapshot: string;
  ish_soni: number;
  partiya_number_snapshot: string | null;
  patta_number_snapshot: string | null;
  rang_snapshot: string | null;
  razmer_snapshot: string | null;
  entered_at: string;
  business_date: string;
  conveyor_snapshot: string | null;
  version: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_by_name_snapshot: string | null;
}

interface PattaOperationRow {
  id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

interface SheetOperationRow extends PattaSheetOperationSnapshotProjectionV3 {}
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
    throw conflict('PATTA_SHEET_QUANTITY_MISMATCH', 'Varaq qatoridagi miqdor Entry miqdoriga mos emas', {
      entry_quantity: expected,
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

function normalizeOptionalSnapshot(value: string | null | undefined, field: string): string | null {
  if (value == null) return null;
  const normalized = canonicalizeBusinessName(value);
  if (!normalized) throw badRequest('PATTA_SHEET_SNAPSHOT_INVALID', `${field} qiymati bo‘sh bo‘lishi mumkin emas`, { field });
  return normalized;
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

function projectionV3(data: PattaSheetProjectionV3): Extract<SyncProjectionV3, { projection_version: 3 }> {
  return {
    projection_version: 3,
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
    projectionVersion: 2 | 3 = 2,
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
        "model_name_snapshot", "ish_soni", "rang", "razmer", "status"
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
    const rows = await this.validateRows(manager, context, patta.ish_soni, enteredAt, snapshots, input.rows);
    const transactionTimeRows: TransactionTimeRow[] = await manager.query(
      'SELECT transaction_timestamp()::text AS "transaction_time"',
    );
    const transactionTime = transactionTimeRows[0]?.transaction_time;
    if (!transactionTime) throw new Error('Database transaction timestamp was not returned');
    await manager.query(
      `INSERT INTO "patta_sheets"
        ("id", "entry_kind", "patta_hisob_id", "model_id", "model_name_snapshot", "ish_soni",
         "partiya_number_snapshot", "patta_number_snapshot", "rang_snapshot", "razmer_snapshot",
         "entered_at", "business_date", "conveyor_snapshot", "created_by")
       VALUES ($1, 'PATTA_LINKED', $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::date, $12, $13)`,
      [sheetId, pattaId, patta.model_id, patta.model_name_snapshot, patta.ish_soni,
        patta.partiya_number, patta.patta_number, patta.rang, patta.razmer,
        enteredAt, businessDate, conveyor, context.actorUserId],
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
    const auditResult = projectionVersion === 3
      ? await this.getProjectionV3(manager, sheetId)
      : result;
    await this.auditService.append(manager, {
      actorUserId: context.actorUserId,
      deviceId: context.validatedDeviceId,
      entityType: 'patta_sheet',
      entityId: sheetId,
      action: 'patta_sheet.create',
      before: null,
      after: auditResult,
    });
    await this.recordChange(manager, result, projectionVersion);
    return result;
  }

  async createV3(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    input: CreatePattaSheetV3Dto,
  ): Promise<PattaSheetProjectionV3> {
    try {
      return await dataSource.transaction((manager) => this.createV3InTransaction(manager, context, input));
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

  async createV3InTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    input: CreatePattaSheetV3Dto,
  ): Promise<PattaSheetProjectionV3> {
    if (input.entry_kind === 'PATTA_LINKED') {
      if (input.patta_hisob_id === null) {
        throw badRequest('PATTA_SHEET_LINK_INVALID', 'PATTA_LINKED entry uchun Patta ID kerak');
      }
      const legacyInput: CreatePattaSheetDto = {
        id: input.id,
        patta_hisob_id: input.patta_hisob_id,
        entered_at: input.entered_at,
        business_date: input.business_date,
        conveyor_snapshot: input.conveyor_snapshot ?? null,
        deleted_at: input.deleted_at ?? null,
        deleted_by: input.deleted_by ?? null,
        operation_snapshots: this.toLegacyOperationSnapshots(input.operation_snapshots),
        rows: input.rows,
        depends_on_event_ids: input.depends_on_event_ids,
        device_id: input.device_id,
      };
      const linked = await this.createInTransaction(manager, context, legacyInput, 3);
      const result = await this.getProjectionV3(manager, linked.id);
      this.assertV3Metadata(result, input);
      if (input.deleted_by_name_snapshot != null) {
        throw badRequest('PATTA_SHEET_CREATE_DELETION_INVALID', 'Yangi varaq o‘chirilgan foydalanuvchi snapshoti bilan yaratilmaydi');
      }
      return result;
    }
    return this.createStandaloneV3InTransaction(manager, context, input);
  }

  private async createStandaloneV3InTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    input: CreatePattaSheetV3Dto,
  ): Promise<PattaSheetProjectionV3> {
    const sheetId = requiredUuid(input.id, 'id');
    if (input.patta_hisob_id !== null) {
      throw badRequest('PATTA_SHEET_LINK_INVALID', 'STANDALONE entry Patta ID saqlamasligi kerak');
    }
    if (input.deleted_at != null || input.deleted_by != null || input.deleted_by_name_snapshot != null) {
      throw badRequest('PATTA_SHEET_CREATE_DELETION_INVALID', 'Yangi varaq o‘chirilgan holatda yaratilmaydi');
    }
    const modelId = requiredUuid(input.model_id, 'model_id');
    const enteredAt = assertEnteredAt(input.entered_at);
    assertBusinessDate(input.business_date);
    const conveyor = normalizeConveyor(input.conveyor_snapshot);
    const modelRows: Array<{ id: string; name: string; status: string }> = await manager.query(
      `SELECT "id"::text AS "id", "name", "status" FROM "models" WHERE "id" = $1 FOR SHARE`,
      [modelId],
    );
    const model = modelRows[0];
    if (!model || model.status !== 'ACTIVE') {
      throw conflict('PATTA_SHEET_MODEL_UNAVAILABLE', 'Mustaqil Entry uchun faol model kerak');
    }
    const modelName = canonicalizeBusinessName(model.name);
    if (canonicalizeBusinessName(input.model_name_snapshot) !== modelName) {
      throw conflict('PATTA_SHEET_MODEL_SNAPSHOT_MISMATCH', 'Model nomi serverdagi ma’lumotga mos emas');
    }
    const quantity = input.ish_soni;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
      throw badRequest('PATTA_SHEET_QUANTITY_INVALID', 'Ish soni musbat butun son bo‘lishi kerak');
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
    const partiya = normalizeOptionalSnapshot(input.partiya_number_snapshot, 'partiya_number_snapshot');
    const pattaNumber = input.patta_number_snapshot ?? null;
    if (pattaNumber !== null && (!/^[1-9][0-9]*$/.test(pattaNumber) || pattaNumber.length > 19)) {
      throw badRequest('PATTA_SHEET_SNAPSHOT_INVALID', 'Patta raqami noto‘g‘ri', { field: 'patta_number_snapshot' });
    }
    const rang = normalizeOptionalSnapshot(input.rang_snapshot, 'rang_snapshot');
    const razmer = normalizeOptionalSnapshot(input.razmer_snapshot, 'razmer_snapshot');
    const snapshots = await this.validateStandaloneSnapshots(
      manager, modelId, enteredAt, input.operation_snapshots,
    );
    const rows = await this.validateRows(manager, context, quantity, enteredAt, snapshots, input.rows);
    const collision: Array<{ id: string }> = await manager.query(
      `SELECT "id"::text AS "id" FROM "patta_sheets" WHERE "id" = $1 FOR UPDATE`, [sheetId],
    );
    if (collision[0]) throw conflict('PATTA_SHEET_ID_REUSED', 'Entry identifikatori oldin ishlatilgan');
    await manager.query(
      `INSERT INTO "patta_sheets" (
         "id", "entry_kind", "patta_hisob_id", "model_id", "model_name_snapshot", "ish_soni",
         "partiya_number_snapshot", "patta_number_snapshot", "rang_snapshot", "razmer_snapshot",
         "entered_at", "business_date", "conveyor_snapshot", "created_by"
       ) VALUES ($1, 'STANDALONE', NULL, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::date, $11, $12)`,
      [sheetId, modelId, modelName, quantity, partiya, pattaNumber, rang, razmer,
        enteredAt, businessDate, conveyor, context.actorUserId],
    );
    await this.insertSnapshotsAndRows(manager, sheetId, snapshots, rows);
    const result = await this.getProjectionV3(manager, sheetId);
    await this.auditService.append(manager, {
      actorUserId: context.actorUserId,
      deviceId: context.validatedDeviceId,
      entityType: 'patta_sheet',
      entityId: sheetId,
      action: 'patta_sheet.create',
      before: null,
      after: result,
    });
    await this.recordChangeV3(manager, result);
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
        `UPDATE "patta_sheets" SET "ish_soni" = $1, "version" = "version" + 1,
          "updated_at" = transaction_timestamp() WHERE "id" = $2`,
        [quantity, sheetId],
      );
      await manager.query(
        `UPDATE "patta_sheet_rows" SET "quantity_snapshot" = $1
         WHERE "patta_sheet_id" = $2 AND "deleted_at" IS NULL`,
        [quantity, sheetId],
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
    projectionVersion: 2 | 3 = 2,
  ): Promise<PattaSheetProjection> {
      const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
      const current = await this.lockSheet(manager, sheetId);
      this.assertExpectedVersion(current, input.expected_version);
      if (current.entry_kind !== 'PATTA_LINKED' || current.patta_hisob_id === null) {
        throw conflict('SYNC_PROTOCOL_UPGRADE_REQUIRED', 'Standalone varaqni V3 API orqali oching');
      }
      if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
      if (current.deleted_at !== null) throw conflict('PATTA_SHEET_TRASHED', 'Korzinkadagi varaqni tahrirlab bo‘lmaydi');
      const before = await this.getProjection(manager, sheetId);
      const beforeForAudit = projectionVersion === 3
        ? await this.getProjectionV3(manager, sheetId)
        : before;
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
          "model_name_snapshot", "ish_soni", "rang", "razmer", "status" FROM "patta_hisob" WHERE "id" = $1 FOR UPDATE`,
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
        manager, context, patta.ish_soni, current.entered_at, snapshots, input.rows, existingWorkerByRowId,
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
        before: beforeForAudit,
        after: projectionVersion === 3 ? await this.getProjectionV3(manager, sheetId) : result,
      });
      await this.recordChange(manager, result, projectionVersion);
      return result;
  }

  async updateV3(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    input: UpdatePattaSheetV3Dto,
  ): Promise<PattaSheetProjectionV3> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    return dataSource.transaction((manager) => this.updateV3InTransaction(manager, context, sheetId, input));
  }

  async updateV3InTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    input: UpdatePattaSheetV3Dto,
    clientMutationAt?: string,
  ): Promise<PattaSheetProjectionV3> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    const current = await this.getProjectionV3(manager, sheetId);
    this.assertExpectedVersion(current, input.expected_version);
    if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
    if (current.deleted_at !== null) throw conflict('PATTA_SHEET_TRASHED', 'Korzinkadagi varaqni tahrirlab bo‘lmaydi');
    if (input.entry_kind !== current.entry_kind || requiredUuid(input.id, 'id') !== current.id ||
      (input.patta_hisob_id ?? null) !== current.patta_hisob_id ||
      requiredUuid(input.model_id, 'model_id') !== current.model_id ||
      canonicalizeBusinessName(input.model_name_snapshot) !== current.model_name_snapshot ||
      input.ish_soni !== current.ish_soni ||
      normalizeOptionalSnapshot(input.partiya_number_snapshot, 'partiya_number_snapshot') !== current.partiya_number_snapshot ||
      (input.patta_number_snapshot ?? null) !== current.patta_number_snapshot ||
      normalizeOptionalSnapshot(input.rang_snapshot, 'rang_snapshot') !== current.rang_snapshot ||
      normalizeOptionalSnapshot(input.razmer_snapshot, 'razmer_snapshot') !== current.razmer_snapshot) {
      throw conflict('PATTA_SHEET_IDENTITY_IMMUTABLE', 'Varaq turi, model, miqdor va mahsulot snapshotlari o‘zgarmaydi');
    }
    const submittedEnteredAt = await this.canonicalDatabaseTimestamp(manager, assertEnteredAt(input.entered_at));
    if (submittedEnteredAt !== current.entered_at || input.business_date !== current.business_date) {
      throw conflict('PATTA_SHEET_IDENTITY_IMMUTABLE', 'Kiritilgan sana va ish sanasi o‘zgarmaydi');
    }
    if ((input.deleted_at ?? null) !== current.deleted_at || (input.deleted_by ?? null) !== current.deleted_by ||
      (input.deleted_by_name_snapshot ?? null) !== current.deleted_by_name_snapshot) {
      throw conflict('PATTA_SHEET_LIFECYCLE_REQUIRES_EXPLICIT_ACTION', 'Korzinka amali alohida V3 RESTORE yoki TRASH so‘rovi bilan bajariladi');
    }
    if (current.entry_kind === 'PATTA_LINKED') {
      if (current.patta_hisob_id === null) throw conflict('PATTA_SHEET_LINK_INVALID', 'Linked varaqda Patta ID yo‘q');
      const legacyInput: UpdatePattaSheetDto = {
        id: input.id,
        patta_hisob_id: current.patta_hisob_id,
        entered_at: input.entered_at,
        business_date: input.business_date,
        conveyor_snapshot: input.conveyor_snapshot ?? null,
        deleted_at: input.deleted_at ?? null,
        deleted_by: input.deleted_by ?? null,
        expected_version: input.expected_version,
        operation_snapshots: this.toLegacyOperationSnapshots(input.operation_snapshots),
        rows: input.rows,
        depends_on_event_ids: input.depends_on_event_ids,
        device_id: input.device_id,
      };
      await this.updateInTransaction(manager, context, sheetId, legacyInput, clientMutationAt, 3);
      const result = await this.getProjectionV3(manager, sheetId);
      this.assertV3Metadata(result, input);
      return result;
    }
    const before = current;
    const snapshots = await this.validateStandaloneSnapshots(
      manager, current.model_id, current.entered_at, input.operation_snapshots, sheetId,
    );
    const existingRows: Array<{ id: string; worker_id: string }> = await manager.query(
      `SELECT "id", "worker_id"::text AS "worker_id" FROM "patta_sheet_rows"
       WHERE "patta_sheet_id" = $1 AND "deleted_at" IS NULL`, [sheetId],
    );
    const existingWorkerByRowId = new Map(existingRows.map(({ id, worker_id }) => [id, worker_id]));
    const rows = await this.validateRows(
      manager, context, current.ish_soni, current.entered_at, snapshots, input.rows, existingWorkerByRowId,
    );
    await this.persistUpdatedSnapshots(manager, sheetId, snapshots);
    await this.persistUpdatedRows(manager, context, sheetId, rows, clientMutationAt);
    const nextVersion = (BigInt(current.version) + 1n).toString();
    await manager.query(
      `UPDATE "patta_sheets" SET "conveyor_snapshot" = $1, "version" = $2::bigint,
        "updated_at" = transaction_timestamp() WHERE "id" = $3`,
      [normalizeConveyor(input.conveyor_snapshot), nextVersion, sheetId],
    );
    const result = await this.getProjectionV3(manager, sheetId);
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
    await this.recordChangeV3(manager, result);
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
    projectionVersion: 2 | 3 = 2,
  ): Promise<PattaSheetPurgeResult> {
      const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
      const current = await this.lockSheet(manager, sheetId);
      this.assertExpectedVersion(current, expectedVersion);
      if (projectionVersion === 2 && current.entry_kind !== 'PATTA_LINKED') {
        throw conflict('SYNC_PROTOCOL_UPGRADE_REQUIRED', 'Standalone varaqni V3 API orqali oching');
      }
      if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
      if (current.deleted_at === null) throw conflict('PATTA_SHEET_PURGE_REQUIRES_TRASH', 'Butunlay o‘chirishdan oldin varaqni Korzinkaga yuboring');
      const effectiveProjectionVersion: 2 | 3 = projectionVersion === 3 && current.entry_kind === 'PATTA_LINKED' ? 2 : projectionVersion;
      const before = effectiveProjectionVersion === 3
        ? await this.getProjectionV3(manager, sheetId)
        : await this.getProjection(manager, sheetId);
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
        await this.recordTombstone(manager, 'patta_sheet_rows', row.id, effectiveProjectionVersion);
      }
      for (const snapshot of before.operation_snapshots) {
        await this.recordTombstone(manager, 'patta_sheet_operation_snapshots', snapshot.id, effectiveProjectionVersion);
      }
      await this.recordTombstone(manager, 'patta_sheets', sheetId, effectiveProjectionVersion);
      await manager.query('DELETE FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1', [sheetId]);
      await manager.query('DELETE FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1', [sheetId]);
      await manager.query('DELETE FROM "patta_sheets" WHERE "id" = $1', [sheetId]);
      const last = await this.syncChangeRecorder.record(manager, {
        entityType: 'patta_sheets', entityId: sheetId, operation: 'DELETE',
        entityVersion: current.version, projectionVersion: effectiveProjectionVersion, payload: null,
      });
      return { id: sheetId, change_sequence: last.sequenceId };
  }

  async trashV3(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetId: string,
    expectedVersion: string,
  ): Promise<PattaSheetProjectionV3> {
    return dataSource.transaction((manager) =>
      this.setTrashedV3InTransaction(manager, context, sheetId, expectedVersion, true));
  }

  async restoreV3(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetId: string,
    expectedVersion: string,
  ): Promise<PattaSheetProjectionV3> {
    return dataSource.transaction((manager) =>
      this.setTrashedV3InTransaction(manager, context, sheetId, expectedVersion, false));
  }

  async purgeV3(
    dataSource: DataSource,
    context: PattaSheetMutationContext,
    sheetId: string,
    expectedVersion: string,
  ): Promise<PattaSheetPurgeResult> {
    const id = requiredUuid(sheetId, 'sheet_id');
    return dataSource.transaction((manager) => this.purgeInTransaction(manager, context, id, expectedVersion, 3));
  }

  async setTrashedV3InTransaction(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    sheetIdInput: string,
    expectedVersion: string,
    trashed: boolean,
    occurredAt?: string,
  ): Promise<PattaSheetProjectionV3> {
    const sheetId = requiredUuid(sheetIdInput, 'sheet_id');
    const current = await this.lockSheet(manager, sheetId);
    this.assertExpectedVersion(current, expectedVersion);
    if (BigInt(current.version) >= MAX_POSTGRES_BIGINT) throw conflict('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi');
    if ((current.deleted_at !== null) === trashed) {
      throw conflict(trashed ? 'PATTA_SHEET_ALREADY_TRASHED' : 'PATTA_SHEET_NOT_TRASHED',
        trashed ? 'Varaq allaqachon Korzinkada' : 'Varaq Korzinkada emas');
    }
    const before = await this.getProjectionV3(manager, sheetId);
    const actorRows: Array<{ full_name: string }> = trashed
      ? await manager.query('SELECT "full_name" FROM "users" WHERE "id" = $1', [context.actorUserId])
      : [];
    const actorName = actorRows[0]?.full_name;
    if (trashed && !actorName) throw new Error('Trash actor display name was not found');
    const nextVersion = (BigInt(current.version) + 1n).toString();
    await manager.query(
      `UPDATE "patta_sheets" SET
        "deleted_at" = CASE WHEN $1 THEN COALESCE($5::timestamptz, transaction_timestamp()) ELSE NULL END,
        "deleted_by" = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
        "deleted_by_name_snapshot" = CASE WHEN $1 THEN $6 ELSE NULL END,
        "version" = $3::bigint, "updated_at" = transaction_timestamp()
       WHERE "id" = $4`,
      [trashed, context.actorUserId, nextVersion, sheetId, occurredAt ?? null, actorName ?? null],
    );
    const after = await this.getProjectionV3(manager, sheetId);
    await this.auditService.append(manager, {
      actorUserId: context.actorUserId,
      deviceId: context.validatedDeviceId,
      entityType: 'patta_sheet',
      entityId: sheetId,
      action: trashed ? 'patta_sheet.trash' : 'patta_sheet.restore',
      before,
      after,
    });
    await this.recordChangeV3(manager, after);
    return after;
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
    projectionVersion: 2 | 3 = 2,
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
      const actorRows: Array<{ full_name: string }> = trashed
        ? await manager.query('SELECT "full_name" FROM "users" WHERE "id" = $1', [context.actorUserId])
        : [];
      const actorName = actorRows[0]?.full_name;
      if (trashed && !actorName) throw new Error('Trash actor display name was not found');
      const nextVersion = (BigInt(current.version) + 1n).toString();
      await manager.query(
        `UPDATE "patta_sheets" SET "deleted_at" = CASE WHEN $1 THEN COALESCE($5::timestamptz, transaction_timestamp()) ELSE NULL END,
          "deleted_by" = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
          "deleted_by_name_snapshot" = CASE WHEN $1 THEN $6 ELSE NULL END,
          "version" = $3::bigint, "updated_at" = transaction_timestamp()
         WHERE "id" = $4`,
        [trashed, context.actorUserId, nextVersion, sheetId, occurredAt ?? null, actorName ?? null],
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
      await this.recordChange(manager, after, projectionVersion);
      return after;
  }

  private async lockSheet(manager: EntityManager, sheetId: string): Promise<SheetRow> {
    const rows: SheetRow[] = await manager.query(
      `SELECT "id", "entry_kind", "patta_hisob_id"::text AS "patta_hisob_id",
        "model_id"::text AS "model_id", "model_name_snapshot", "ish_soni",
        "partiya_number_snapshot", "patta_number_snapshot", "rang_snapshot", "razmer_snapshot",
        to_char("entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
        "business_date"::text AS "business_date", "conveyor_snapshot", "version"::text AS "version",
        "created_by"::text AS "created_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by", "deleted_by_name_snapshot"
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
      `SELECT "id", "entry_kind", "patta_hisob_id"::text AS "patta_hisob_id",
        "model_id"::text AS "model_id", "model_name_snapshot", "ish_soni",
        "partiya_number_snapshot", "patta_number_snapshot", "rang_snapshot", "razmer_snapshot",
        to_char("entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
        "business_date"::text AS "business_date", "conveyor_snapshot", "version"::text AS "version",
        "created_by"::text AS "created_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by", "deleted_by_name_snapshot"
       FROM "patta_sheets" WHERE "id" = $1`,
      [sheetId],
    );
    const sheet = rows[0];
    if (!sheet) throw new NotFoundException({ code: 'PATTA_SHEET_NOT_FOUND', message: 'Patta varag‘i topilmadi', details: {} });
    if (sheet.entry_kind !== 'PATTA_LINKED' || sheet.patta_hisob_id === null) {
      throw conflict('SYNC_PROTOCOL_UPGRADE_REQUIRED', 'Standalone varaqni V3 API orqali oching');
    }
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
    const v2OperationSnapshots: PattaSheetOperationSnapshotProjection[] = operationSnapshots.map((snapshot) => {
      if (snapshot.source_type === 'MODEL') {
        throw conflict('SYNC_PROTOCOL_UPGRADE_REQUIRED', 'Standalone operatsiyani V3 API orqali oching');
      }
      return { ...snapshot, source_type: snapshot.source_type as 'PATTA' | 'CUSTOM' };
    });
    return {
      id: sheet.id,
      patta_hisob_id: sheet.patta_hisob_id,
      entered_at: sheet.entered_at,
      business_date: sheet.business_date,
      conveyor_snapshot: sheet.conveyor_snapshot,
      version: sheet.version,
      created_by: sheet.created_by,
      created_at: sheet.created_at,
      updated_at: sheet.updated_at,
      deleted_at: sheet.deleted_at,
      deleted_by: sheet.deleted_by,
      operation_snapshots: v2OperationSnapshots,
      rows: rowsProjection,
    };
  }

  async getProjectionV3(manager: DataSource | EntityManager, sheetId: string): Promise<PattaSheetProjectionV3> {
    const rows: SheetRow[] = await manager.query(
      `SELECT "id", "entry_kind", "patta_hisob_id"::text AS "patta_hisob_id",
        "model_id"::text AS "model_id", "model_name_snapshot", "ish_soni",
        "partiya_number_snapshot", "patta_number_snapshot", "rang_snapshot", "razmer_snapshot",
        to_char("entered_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "entered_at",
        "business_date"::text AS "business_date", "conveyor_snapshot", "version"::text AS "version",
        "created_by"::text AS "created_by",
        to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
        to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at",
        CASE WHEN "deleted_at" IS NULL THEN NULL ELSE
          to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "deleted_at",
        "deleted_by"::text AS "deleted_by", "deleted_by_name_snapshot"
       FROM "patta_sheets" WHERE "id" = $1`,
      [sheetId],
    );
    const sheet = rows[0];
    if (!sheet) throw new NotFoundException({ code: 'PATTA_SHEET_NOT_FOUND', message: 'Patta varag‘i topilmadi', details: {} });
    const operationSnapshots: PattaSheetOperationSnapshotProjectionV3[] = await manager.query(
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
      id: sheet.id,
      entry_kind: sheet.entry_kind,
      patta_hisob_id: sheet.patta_hisob_id,
      model_id: sheet.model_id,
      model_name_snapshot: sheet.model_name_snapshot,
      ish_soni: sheet.ish_soni,
      partiya_number_snapshot: sheet.partiya_number_snapshot,
      patta_number_snapshot: sheet.patta_number_snapshot,
      rang_snapshot: sheet.rang_snapshot,
      razmer_snapshot: sheet.razmer_snapshot,
      entered_at: sheet.entered_at,
      business_date: sheet.business_date,
      conveyor_snapshot: sheet.conveyor_snapshot,
      version: sheet.version,
      created_by: sheet.created_by,
      created_at: sheet.created_at,
      updated_at: sheet.updated_at,
      deleted_at: sheet.deleted_at,
      deleted_by: sheet.deleted_by,
      deleted_by_name_snapshot: sheet.deleted_by_name_snapshot,
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
        results.push({ ...existingSnapshot, source_type: existingSnapshot.source_type as 'PATTA' | 'CUSTOM' });
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

  private toLegacyOperationSnapshots(
    inputs: readonly PattaSheetV3OperationSnapshotInputDto[],
  ): PattaSheetOperationSnapshotInputDto[] {
    return inputs.map((input) => {
      if (input.source_type === 'MODEL') {
        throw badRequest('PATTA_SHEET_OPERATION_SOURCE_INVALID', 'PATTA_LINKED entry MODEL manbali operatsiya saqlay olmaydi');
      }
      return {
        ...input,
        source_type: input.source_type,
        source_patta_operation_snapshot_id: input.source_patta_operation_snapshot_id,
      };
    });
  }

  private assertV3Metadata(
    actual: PattaSheetProjectionV3,
    input: CreatePattaSheetV3Dto | UpdatePattaSheetV3Dto,
  ): void {
    const partiya = normalizeOptionalSnapshot(input.partiya_number_snapshot, 'partiya_number_snapshot');
    const rang = normalizeOptionalSnapshot(input.rang_snapshot, 'rang_snapshot');
    const razmer = normalizeOptionalSnapshot(input.razmer_snapshot, 'razmer_snapshot');
    if (actual.entry_kind !== input.entry_kind || actual.patta_hisob_id !== input.patta_hisob_id ||
      actual.model_id !== requiredUuid(input.model_id, 'model_id') ||
      actual.model_name_snapshot !== canonicalizeBusinessName(input.model_name_snapshot) ||
      actual.ish_soni !== input.ish_soni || actual.partiya_number_snapshot !== partiya ||
      actual.patta_number_snapshot !== (input.patta_number_snapshot ?? null) ||
      actual.rang_snapshot !== rang || actual.razmer_snapshot !== razmer ||
      actual.conveyor_snapshot !== normalizeConveyor(input.conveyor_snapshot)) {
      throw conflict('PATTA_SHEET_SNAPSHOT_MISMATCH', 'Entry snapshotlari serverdagi ma’lumotga mos emas');
    }
  }

  private async validateStandaloneSnapshots(
    manager: EntityManager,
    modelId: string,
    enteredAt: string,
    inputs: readonly PattaSheetV3OperationSnapshotInputDto[],
    sheetId?: string,
  ): Promise<PattaSheetOperationSnapshotProjectionV3[]> {
    if (inputs.length === 0) throw badRequest('PATTA_SHEET_OPERATION_REQUIRED', 'Varaqda kamida bitta operatsiya bo‘lishi kerak');
    const inputIds = new Set<string>();
    const operationIds = new Set<string>();
    const sortOrders = new Set<number>();
    for (const input of inputs) {
      requiredUuid(input.id, 'operation_snapshot.id');
      requiredUuid(input.model_operation_id, 'model_operation_id');
      if (input.source_type === 'PATTA' || input.source_patta_operation_snapshot_id != null) {
        throw badRequest('PATTA_SHEET_OPERATION_SOURCE_INVALID', 'Standalone operatsiyada Patta manbasi bo‘lmasligi kerak');
      }
      if (!Number.isSafeInteger(input.sort_order) || input.sort_order < 0 || sortOrders.has(input.sort_order)) {
        throw badRequest('PATTA_SHEET_OPERATION_ORDER_INVALID', 'Operatsiya tartibi noto‘g‘ri');
      }
      if (inputIds.has(input.id.toLowerCase()) || operationIds.has(input.model_operation_id.toLowerCase())) {
        throw badRequest('PATTA_SHEET_OPERATION_DUPLICATE', 'Varaq operatsiyasi takrorlangan');
      }
      inputIds.add(input.id.toLowerCase());
      operationIds.add(input.model_operation_id.toLowerCase());
      sortOrders.add(input.sort_order);
    }
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
    const results: PattaSheetOperationSnapshotProjectionV3[] = [];
    for (const input of inputs) {
      const id = input.id.toLowerCase();
      const operationId = requiredUuid(input.model_operation_id, 'model_operation_id');
      const name = canonicalizeBusinessName(input.operation_name_snapshot);
      const price = normalizePrice(input.unit_price_snapshot);
      const existing = currentById.get(id);
      const operationRows: Array<{ model_id: string; name: string; status: string }> = await manager.query(
        `SELECT "model_id"::text AS "model_id", "name", "status"
         FROM "model_operations" WHERE "id" = $1 FOR SHARE`,
        [operationId],
      );
      const operation = operationRows[0];
      if (!operation || operation.model_id !== modelId ||
        (!existing && (operation.status !== 'ACTIVE' || operation.name !== name))) {
        throw conflict('PATTA_SHEET_OPERATION_INVALID', 'Operatsiya tanlangan faol modelga tegishli bo‘lishi kerak');
      }
      if (!existing) {
        const historicalPrice = await this.operationPriceService.resolvePrice(operationId, enteredAt, manager);
        if (new Decimal(historicalPrice).toFixed(2) !== price) {
          throw conflict('PATTA_SHEET_OPERATION_PRICE_MISMATCH', 'Narx Kiritilgan vaqtdagi tarixiy narxga mos emas');
        }
        results.push({
          id,
          patta_sheet_id: sheetId ?? '',
          model_operation_id: operationId,
          source_type: input.source_type,
          source_patta_operation_snapshot_id: null,
          operation_name_snapshot: name,
          unit_price_snapshot: price,
          sort_order: input.sort_order,
          created_at: '',
        });
        continue;
      }
      if (existing.patta_sheet_id !== sheetId || existing.model_operation_id !== operationId ||
        existing.source_type !== input.source_type || existing.source_patta_operation_snapshot_id !== null ||
        existing.operation_name_snapshot !== name || new Decimal(existing.unit_price_snapshot).toFixed(2) !== price ||
        existing.sort_order !== input.sort_order) {
        throw conflict('PATTA_SHEET_OPERATION_IMMUTABLE', 'Varaq operatsiya tarixini o‘zgartirib bo‘lmaydi');
      }
      results.push(existing);
    }
    if (sheetId && currentSnapshots.some((snapshot) => !inputIds.has(snapshot.id))) {
      throw conflict('PATTA_SHEET_OPERATION_IMMUTABLE', 'Varaqdagi tarixiy operatsiya snapshotlarini olib tashlab bo‘lmaydi');
    }
    return results;
  }

  private async insertSnapshotsAndRows(
    manager: EntityManager,
    sheetId: string,
    snapshots: readonly PattaSheetOperationSnapshotProjectionV3[],
    rows: readonly (PattaSheetRowInputDto & { worker_id: string })[],
  ): Promise<void> {
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
  }

  private async validateRows(
    manager: EntityManager,
    context: PattaSheetMutationContext,
    expectedQuantity: number,
    enteredAt: string,
    snapshots: readonly PattaSheetOperationSnapshotProjectionV3[],
    inputRows: readonly PattaSheetRowInputDto[],
    existingWorkerByRowId: ReadonlyMap<string, string> = new Map(),
  ): Promise<Array<PattaSheetRowInputDto & { worker_id: string }>> {
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
      assertQuantity(input.quantity_snapshot, expectedQuantity);
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
    snapshots: readonly PattaSheetOperationSnapshotProjectionV3[],
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

  private async recordChange(
    manager: EntityManager,
    sheet: PattaSheetProjection,
    projectionVersion: 2 | 3 = 2,
  ): Promise<string> {
    if (projectionVersion === 3) {
      const v3 = await this.getProjectionV3(manager, sheet.id);
      return this.recordChangeV3(manager, v3);
    }
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

  private async recordChangeV3(manager: EntityManager, sheet: PattaSheetProjectionV3): Promise<string> {
    const change = await this.syncChangeRecorder.record(manager, {
      entityType: 'patta_sheets',
      entityId: sheet.id,
      operation: 'UPSERT',
      entityVersion: sheet.version,
      projectionVersion: 3,
      payload: projectionV3(sheet),
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

  private recordTombstone(
    manager: EntityManager,
    entityType: string,
    entityId: string,
    projectionVersion: 2 | 3 = 2,
  ): Promise<{ sequenceId: string }> {
    return this.syncChangeRecorder.record(manager, {
      entityType,
      entityId,
      operation: 'DELETE',
      entityVersion: null,
      projectionVersion,
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
