import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { createSyncProjection } from '../sync/sync-projections.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import type { SyncProjection } from '@textile/sync-protocol';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import type { ValidatedOfflinePattaRegistration } from './patta-offline-registration.validator.js';
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
  pattaReferenceDataStale,
  pattaRecordNotFound,
  pattaSnapshotMismatch,
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

export interface OfflinePattaRegistrationResult {
  record: PattaRecord;
  version: string;
  changeSequence: string;
  projection: SyncProjection;
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

interface OfflinePattaRow extends PattaRow {
  version: string | number;
}

interface OfflineModelReferenceRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: string | number;
}

interface OfflineOperationReferenceRow {
  id: string;
  model_id: string;
  name: string;
  sort_order: number;
  status: 'ACTIVE' | 'INACTIVE';
  version: string | number;
}

interface OfflineTemplateReferenceRow {
  id: string;
  model_id: string;
  konveyer: string;
  razmer: string | null;
  rang: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  version: string | number;
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

interface PersistedOperationSnapshot {
  id: string;
  snapshot: ResolvedOperationSnapshot;
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
    private readonly syncChangeRecorder: SyncChangeRecorder,
    private readonly offlineRegistrationValidator: PattaOfflineRegistrationValidator,
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

        const snapshotsByPatta = new Map<string, PersistedOperationSnapshot[]>();
        for (const draft of drafts) {
          const persistedSnapshots: PersistedOperationSnapshot[] = [];
          for (const snapshot of draft.snapshots) {
            const snapshotId = randomUUID();
            await manager.query(
              `INSERT INTO "patta_operation_snapshots"
                 ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot",
                  "unit_price_snapshot", "sort_order")
               VALUES ($1, $2, $3, $4, $5::numeric(14,2), $6)`,
              [
                snapshotId,
                draft.id,
                snapshot.operation_id,
                snapshot.operation_name_snapshot,
                snapshot.unit_price_snapshot,
                snapshot.sort_order,
              ],
            );
            persistedSnapshots.push({ id: snapshotId, snapshot });
          }
          snapshotsByPatta.set(draft.id, persistedSnapshots);
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
          await this.syncChangeRecorder.record(manager, {
            entityType: 'patta_hisob',
            entityId: result.id,
            operation: 'UPSERT',
            entityVersion: '1',
            projectionVersion: 1,
            payload: createSyncProjection({
              entityType: 'patta_hisob',
              entityVersion: '1',
              data: {
                id: result.id,
                partiya_number: result.partiya_number,
                patta_number: result.patta_number,
                model_id: result.model_id,
                model_name_snapshot: result.model_name_snapshot,
                template_id: result.template_id,
                konveyer_snapshot: result.konveyer_snapshot,
                razmer: result.razmer,
                rang: result.rang,
                ish_soni: result.ish_soni,
                created_device_id: validatedDeviceId,
                created_from_block_id: null,
                created_at: result.created_at,
                client_created_at: null,
                occurred_at: null,
              },
            }),
          });
          const persistedSnapshots = snapshotsByPatta.get(result.id);
          if (!persistedSnapshots) {
            throw new Error('Patta operation snapshots were not retained for sync recording');
          }
          for (const persisted of persistedSnapshots) {
            const snapshotData = {
              id: persisted.id,
              patta_hisob_id: result.id,
              operation_id: persisted.snapshot.operation_id,
              operation_name_snapshot: persisted.snapshot.operation_name_snapshot,
              unit_price_snapshot: persisted.snapshot.unit_price_snapshot,
              sort_order: persisted.snapshot.sort_order,
              created_at: formatTimestamp(transactionTime),
            };
            await this.syncChangeRecorder.record(manager, {
              entityType: 'patta_operation_snapshots',
              entityId: persisted.id,
              operation: 'UPSERT',
              entityVersion: null,
              projectionVersion: 1,
              payload: createSyncProjection({
                entityType: 'patta_operation_snapshots',
                entityVersion: null,
                data: snapshotData,
              }),
            });
          }
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

  async registerOffline(
    manager: EntityManager,
    actorUserId: string,
    validatedDeviceId: string,
    event: unknown,
  ): Promise<OfflinePattaRegistrationResult> {
    const registration = this.offlineRegistrationValidator.validateRegistration(event);
    const pattaNumber = parsePattaNumber(registration.patta_number);

    try {
      return await this.registerValidatedOffline(
        manager,
        actorUserId,
        validatedDeviceId,
        registration,
        pattaNumber,
      );
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      const constraint = postgresConstraint(error);
      if (constraint === 'uq_patta_hisob_partiya_patta' || constraint === 'pk_patta_hisob') {
        throw pattaAlreadyExists();
      }
      if (
        constraint === 'pk_patta_operation_snapshots' ||
        constraint === 'uq_patta_operation_snapshots_patta_operation'
      ) {
        throw pattaSnapshotMismatch({ reason: 'snapshot_id_collision' });
      }
      throw error;
    }
  }

  private async registerValidatedOffline(
    manager: EntityManager,
    actorUserId: string,
    validatedDeviceId: string,
    registration: ValidatedOfflinePattaRegistration,
    pattaNumber: bigint,
  ): Promise<OfflinePattaRegistrationResult> {
    const cursorRows: Array<{ current_cursor: string }> = await manager.query(
      `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "current_cursor"
       FROM "server_change_log"`,
    );
    const currentCursor = cursorRows[0]?.current_cursor;
    if (!currentCursor || BigInt(registration.reference_cursor) > BigInt(currentCursor)) {
      throw pattaReferenceDataStale({ reference_cursor: registration.reference_cursor });
    }

    const modelRows: OfflineModelReferenceRow[] = await manager.query(
      `SELECT "id"::text AS "id", "name", "status", "version"::text AS "version"
       FROM "models" WHERE "id" = $1::uuid FOR SHARE`,
      [registration.model_id],
    );
    const model = modelRows[0];
    if (!model || model.status !== 'ACTIVE' || String(model.version) !== registration.reference_versions.model) {
      throw pattaReferenceDataStale({ model_id: registration.model_id });
    }
    if (model.name !== registration.model_name_snapshot) {
      throw pattaSnapshotMismatch({ field: 'model_name_snapshot' });
    }

    if (registration.template_id !== null) {
      const templateRows: OfflineTemplateReferenceRow[] = await manager.query(
        `SELECT "id"::text AS "id", "model_id"::text AS "model_id",
                "konveyer", "razmer", "rang", "status",
                "version"::text AS "version"
         FROM "patta_templates" WHERE "id" = $1::uuid FOR SHARE`,
        [registration.template_id],
      );
      const template = templateRows[0];
      if (
        !template ||
        template.status !== 'ACTIVE' ||
        template.model_id !== registration.model_id ||
        String(template.version) !== registration.reference_versions.template
      ) {
        throw pattaReferenceDataStale({ template_id: registration.template_id });
      }
      const overrides = registration.template_overrides;
      const expectedConveyor = overrides && Object.hasOwn(overrides, 'konveyer')
        ? overrides.konveyer ?? template.konveyer
        : template.konveyer;
      const expectedSize = overrides && Object.hasOwn(overrides, 'razmer')
        ? overrides.razmer ?? null
        : template.razmer;
      const expectedColor = overrides && Object.hasOwn(overrides, 'rang')
        ? overrides.rang ?? null
        : template.rang;
      if (
        registration.konveyer_snapshot !== expectedConveyor ||
        registration.razmer !== expectedSize ||
        registration.rang !== expectedColor
      ) {
        throw pattaSnapshotMismatch({
          template_id: registration.template_id,
          field: 'template_snapshot',
        });
      }
    }

    const currentOperations: OfflineOperationReferenceRow[] = await manager.query(
      `SELECT "id"::text AS "id", "model_id"::text AS "model_id", "name",
              "sort_order", "status", "version"::text AS "version"
       FROM "model_operations"
       WHERE "model_id" = $1::uuid AND "status" = 'ACTIVE'
       ORDER BY "sort_order", "id" FOR SHARE`,
      [registration.model_id],
    );
    if (currentOperations.length !== registration.operations.length) {
      throw pattaReferenceDataStale({ model_id: registration.model_id, reason: 'operation_set_changed' });
    }

    const operationIds = currentOperations.map(({ id }) => id);
    const newerReferenceChanges: Array<{ has_changes: boolean }> = await manager.query(
      `SELECT EXISTS (
         SELECT 1 FROM "server_change_log"
         WHERE "sequence_id" > $1::bigint AND (
           ("entity_type" = 'models' AND "entity_id" = $2) OR
           ("entity_type" = 'patta_templates' AND $3::varchar IS NOT NULL AND "entity_id" = $3) OR
           ("entity_type" = 'model_operations' AND (
             "entity_id" = ANY($4::varchar[]) OR "payload_json" #>> '{data,model_id}' = $2
           )) OR
           ("entity_type" = 'model_operation_prices' AND
             "payload_json" #>> '{data,operation_id}' = ANY($4::varchar[]))
         )
       ) AS "has_changes"`,
      [
        registration.reference_cursor,
        registration.model_id,
        registration.template_id,
        operationIds,
      ],
    );
    if (newerReferenceChanges[0]?.has_changes === true) {
      throw pattaReferenceDataStale({
        reference_cursor: registration.reference_cursor,
        model_id: registration.model_id,
      });
    }

    for (let index = 0; index < currentOperations.length; index += 1) {
      const current = currentOperations[index];
      const snapshot = registration.operations[index];
      if (!current || !snapshot) {
        throw pattaReferenceDataStale({ model_id: registration.model_id, reason: 'operation_set_changed' });
      }
      if (
        current.id !== snapshot.operation_id ||
        current.model_id !== registration.model_id
      ) {
        throw pattaReferenceDataStale({ operation_id: snapshot.operation_id, reason: 'operation_set_changed' });
      }
      if (String(current.version) !== registration.reference_versions.operations[current.id]) {
        throw pattaReferenceDataStale({ operation_id: current.id });
      }
      if (current.name !== snapshot.operation_name_snapshot || current.sort_order !== snapshot.sort_order) {
        throw pattaSnapshotMismatch({ operation_id: current.id, field: 'operation_snapshot' });
      }
      let effectivePrice: string;
      try {
        effectivePrice = await this.operationPriceService.resolvePrice(
          current.id,
          registration.occurred_at,
          manager,
        );
      } catch {
        throw pattaReferenceDataStale({ operation_id: current.id, reason: 'price_history_missing' });
      }
      if (effectivePrice !== snapshot.unit_price_snapshot) {
        throw pattaSnapshotMismatch({ operation_id: current.id, field: 'unit_price_snapshot' });
      }
    }

    await this.offlineRegistrationValidator.assertBlockMembership(
      manager,
      validatedDeviceId,
      registration.block_id,
      pattaNumber,
    );
    await this.offlineRegistrationValidator.assertBusinessKeyAvailable(
      manager,
      registration.partiya_number,
      pattaNumber,
    );
    await this.offlineRegistrationValidator.assertPattaIdAvailable(manager, registration.id);

    const snapshotIdRows: Array<{ exists: boolean }> = await manager.query(
      `SELECT EXISTS (
         SELECT 1 FROM "patta_operation_snapshots" WHERE "id" = ANY($1::uuid[])
       ) AS "exists"`,
      [registration.operations.map(({ id }) => id)],
    );
    if (snapshotIdRows[0]?.exists === true) {
      throw pattaSnapshotMismatch({ reason: 'snapshot_id_collision' });
    }

    const serverTimeRows: Array<{ server_time: string }> = await manager.query(
      `SELECT to_char(
         transaction_timestamp() AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS "server_time"`,
    );
    const serverTime = serverTimeRows[0]?.server_time;
    if (!serverTime) throw new Error('Database transaction timestamp was not returned');

    for (const snapshot of registration.operations) {
      await manager.query(
        `INSERT INTO "patta_operation_snapshots"
           ("id", "patta_hisob_id", "operation_id", "operation_name_snapshot",
            "unit_price_snapshot", "sort_order")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric(14,2), $6)`,
        [
          snapshot.id,
          registration.id,
          snapshot.operation_id,
          snapshot.operation_name_snapshot,
          snapshot.unit_price_snapshot,
          snapshot.sort_order,
        ],
      );
    }

    const pattaRows: OfflinePattaRow[] = await manager.query(
      `INSERT INTO "patta_hisob"
         ("id", "partiya_number", "patta_number", "model_id", "model_name_snapshot",
          "template_id", "konveyer_snapshot", "razmer", "rang", "ish_soni",
          "created_device_id", "created_from_block_id", "created_by", "client_created_at", "occurred_at")
       VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5, $6::uuid, $7, $8, $9, $10,
               $11::uuid, $12::uuid, $13::uuid, $14::timestamptz, $15::timestamptz)
       RETURNING ${PATTA_COLUMNS}, "version"::text AS "version"`,
      [
        registration.id,
        registration.partiya_number,
        pattaNumber.toString(),
        registration.model_id,
        registration.model_name_snapshot,
        registration.template_id,
        registration.konveyer_snapshot,
        registration.razmer,
        registration.rang,
        registration.ish_soni,
        validatedDeviceId,
        registration.block_id,
        actorUserId,
        registration.client_created_at,
        registration.occurred_at,
      ],
    );
    const row = pattaRows[0];
    if (!row) throw new Error('Offline Patta insert did not return a record');
    const record = serializePatta(row, registration.operations.map(({ operation_id, operation_name_snapshot, unit_price_snapshot, sort_order }) => ({
      operation_id,
      operation_name_snapshot,
      unit_price_snapshot,
      sort_order,
    })));
    const version = String(row.version);

    await this.auditService.append(manager, {
      actorUserId,
      entityType: 'patta',
      entityId: record.id,
      action: 'patta.create',
      before: null,
      after: {
        id: record.id,
        partiya_number: record.partiya_number,
        patta_number: record.patta_number,
        model_id: record.model_id,
        model_name_snapshot: record.model_name_snapshot,
        device_id: validatedDeviceId,
        block_id: registration.block_id,
        source: 'OFFLINE_SYNC',
        client_created_at: registration.client_created_at,
        occurred_at: registration.occurred_at,
        reference_cursor: registration.reference_cursor,
        ish_soni: record.ish_soni,
      },
    });

    const pattaProjection = createSyncProjection({
      entityType: 'patta_hisob',
      entityVersion: version,
      data: {
        id: record.id,
        partiya_number: record.partiya_number,
        patta_number: record.patta_number,
        model_id: record.model_id,
        model_name_snapshot: record.model_name_snapshot,
        template_id: record.template_id,
        konveyer_snapshot: record.konveyer_snapshot,
        razmer: record.razmer,
        rang: record.rang,
        ish_soni: record.ish_soni,
        created_device_id: validatedDeviceId,
        created_from_block_id: registration.block_id,
        created_at: record.created_at,
        client_created_at: registration.client_created_at,
        occurred_at: registration.occurred_at,
      },
    });
    const parentChange = await this.syncChangeRecorder.record(manager, {
      entityType: 'patta_hisob',
      entityId: record.id,
      operation: 'UPSERT',
      entityVersion: version,
      projectionVersion: 1,
      payload: pattaProjection,
    });

    for (const snapshot of registration.operations) {
      await this.syncChangeRecorder.record(manager, {
        entityType: 'patta_operation_snapshots',
        entityId: snapshot.id,
        operation: 'UPSERT',
        entityVersion: null,
        projectionVersion: 1,
        payload: createSyncProjection({
          entityType: 'patta_operation_snapshots',
          entityVersion: null,
          data: {
            id: snapshot.id,
            patta_hisob_id: record.id,
            operation_id: snapshot.operation_id,
            operation_name_snapshot: snapshot.operation_name_snapshot,
            unit_price_snapshot: snapshot.unit_price_snapshot,
            sort_order: snapshot.sort_order,
            created_at: serverTime,
          },
        }),
      });
    }

    return {
      record,
      version,
      changeSequence: parentChange.sequenceId,
      projection: pattaProjection,
    };
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
