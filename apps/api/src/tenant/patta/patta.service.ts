import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
import {
  pattaAlreadyExists,
  pattaNumberInvalid,
  pattaProtocolUpgradeRequired,
  pattaReferenceDataStale,
  pattaSnapshotMismatch,
} from './patta-errors.js';
import { postgresConstraint } from '../models/model-errors.js';

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

@Injectable()
export class PattaService {
  constructor(
    private readonly auditService: AuditService,
    private readonly operationPriceService: OperationPriceService,
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
    void dataSource;
    void actorUserId;
      void validatedDeviceId;
      void input;
    throw pattaProtocolUpgradeRequired();
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
    void dataSource;
    void partiyaNumberInput;
    void pattaNumberInput;
    throw pattaProtocolUpgradeRequired();
  }

  async list(dataSource: DataSource, filters: ListPattaDto): Promise<never> {
    void dataSource;
    void filters;
    throw pattaProtocolUpgradeRequired();
  }
}
