import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  SyncProtocolVersion,
  SyncChange,
  SyncProjectionV2,
  SyncProjection,
  SyncPullResponse,
  SyncPushResult,
  SyncPushResponse,
} from '@textile/sync-protocol';
import type { DataSource } from 'typeorm';
import type { TenantRequestContext } from '../auth/require-tenant-context.js';
import { SyncEventProcessor } from './sync-event-processor.js';
import { SYNC_CONFIGURATION } from './sync.config.js';
import type { SyncConfiguration } from './sync.config.js';

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const SYNC_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'workers',
  'worker_badge_history',
  'models',
  'model_operations',
  'model_operation_prices',
  'patta_templates',
  'patta_hisob',
  'patta_operation_snapshots',
  'patta_number_blocks',
  'patta_partiya_number_blocks',
  'patta_print_batches',
  'patta_print_batch_sizes',
  'patta_print_events',
  'patta_sheets',
  'patta_sheet_operation_snapshots',
  'patta_sheet_rows',
]);

interface ServerChangeRow {
  sequence_id: string;
  entity_type: string;
  entity_id: string;
  operation: 'UPSERT' | 'DELETE';
  entity_version: string | null;
  projection_version: number;
  payload: unknown;
  changed_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCursor(): BadRequestException {
  return new BadRequestException({
    code: 'SYNC_CURSOR_INVALID',
    message: 'Sinxronlash cursor qiymati musbat BIGINT decimal matn bo‘lishi kerak',
    details: {},
  });
}

function invalidPullLimit(maximum: number): BadRequestException {
  return new BadRequestException({
    code: 'SYNC_PULL_LIMIT_INVALID',
    message: `Sinxronlash sahifasi 1 dan ${maximum} gacha o‘zgarish olishi mumkin`,
    details: { maximum },
  });
}

function batchTooLarge(maximum: number): BadRequestException {
  return new BadRequestException({
    code: 'SYNC_PUSH_BATCH_TOO_LARGE',
    message: `Sinxronlash to‘plami ko‘pi bilan ${maximum} hodisadan iborat bo‘lishi kerak`,
    details: { maximum },
  });
}

function pattaProtocolUpgradeRequired(): ConflictException {
  return new ConflictException({
    code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
    message: 'Patta ma’lumotlarini sinxronlash uchun dastur versiyasini yangilang',
    details: {},
  });
}

function pattaBatchRequired(): ConflictException {
  return new ConflictException({
    code: 'PATTA_PRINT_BATCH_REQUIRED',
    message: 'Yangi Pattalar v2 bosma to‘plami orqali yaratilishi kerak',
    details: {},
  });
}

function parseCursor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw invalidCursor();
  const cursor = BigInt(value);
  if (cursor > MAX_POSTGRES_BIGINT) throw invalidCursor();
  return cursor;
}

function projectionForChange(
  row: ServerChangeRow,
  protocolVersion: SyncProtocolVersion,
): SyncProjection | SyncProjectionV2 | null {
  if (!SYNC_ENTITY_TYPES.has(row.entity_type)) {
    throw new Error('Server change log contains an unknown sync entity type');
  }
  if (row.operation !== 'UPSERT' && row.operation !== 'DELETE') {
    throw new Error('Server change log contains an invalid change operation');
  }
  if (row.projection_version !== 1 && row.projection_version !== 2) {
    throw new Error('Server change log contains an unsupported projection version');
  }
  if (row.payload === null) {
    if (row.operation === 'UPSERT') {
      throw new Error('UPSERT sync change is missing its projection');
    }
    return null;
  }
  if (
    !isRecord(row.payload) ||
    Reflect.get(row.payload, 'projection_version') !== row.projection_version ||
    Reflect.get(row.payload, 'entity_type') !== row.entity_type ||
    Reflect.get(row.payload, 'entity_id') !== row.entity_id
  ) {
    throw new Error('Server change log projection identity does not match its change');
  }
  if (row.projection_version === 2) {
    if (protocolVersion !== 2 || !row.entity_type.startsWith('patta')) {
      throw pattaProtocolUpgradeRequired();
    }
    return row.payload as unknown as SyncProjectionV2;
  }

  if (protocolVersion === 2 && row.entity_type === 'patta_hisob') {
    const legacyData = Reflect.get(row.payload, 'data');
    if (!isRecord(legacyData) || typeof legacyData['ish_soni'] !== 'number') {
      throw new Error('Legacy Patta projection has no historical operation-count value');
    }
    const { ish_soni: legacyOperationCount, ...data } = legacyData;
    return {
      projection_version: 2,
      entity_type: 'patta_hisob',
      entity_id: row.entity_id,
      entity_version: row.entity_version ?? '1',
      data: {
        ...data,
        konveyer_snapshot: typeof data['konveyer_snapshot'] === 'string'
          ? data['konveyer_snapshot']
          : null,
        ish_soni: null,
        legacy_operation_count: legacyOperationCount,
        status: 'ACTIVE',
        print_batch_id: null,
      },
    } as SyncProjectionV2;
  }
  if (protocolVersion === 2 && row.entity_type === 'patta_operation_snapshots') {
    return {
      ...(row.payload as Record<string, unknown>),
      projection_version: 2,
    } as unknown as SyncProjectionV2;
  }
  return row.payload as unknown as SyncProjection;
}

function serializeChange(row: ServerChangeRow, protocolVersion: SyncProtocolVersion): SyncChange {
  if (!/^[1-9][0-9]*$/.test(row.sequence_id)) {
    throw new Error('Server change sequence is not a decimal BIGINT string');
  }
  if (!row.entity_id) throw new Error('Server change log entity ID is empty');
  const payload = projectionForChange(row, protocolVersion);
  const projectionVersion = payload?.projection_version ?? (
    protocolVersion === 2 && (row.entity_type === 'patta_hisob' || row.entity_type === 'patta_operation_snapshots')
      ? 2
      : row.projection_version
  );
  return {
    sequence_id: row.sequence_id,
    entity_type: row.entity_type as SyncChange['entity_type'],
    entity_id: row.entity_id,
    operation: row.operation,
    entity_version: row.entity_version,
    projection_version: projectionVersion as 1 | 2,
    payload,
    changed_at: row.changed_at,
  };
}

@Injectable()
export class SyncService {
  constructor(
    private readonly eventProcessor: SyncEventProcessor,
    @Inject(SYNC_CONFIGURATION) private readonly configuration: SyncConfiguration,
  ) {}

  async push(
    context: TenantRequestContext,
    validatedDeviceId: string,
    events: readonly unknown[],
    protocolVersion: SyncProtocolVersion = 1,
  ): Promise<SyncPushResponse> {
    if (events.length > this.configuration.pushMaxEvents) {
      throw batchTooLarge(this.configuration.pushMaxEvents);
    }
    if (protocolVersion === 1 && events.some((event) => {
      if (!isRecord(event)) return false;
      const entityType = event['entity_type'];
      return typeof entityType === 'string' && entityType.startsWith('patta');
    })) {
      throw pattaProtocolUpgradeRequired();
    }
    if (protocolVersion === 2 && events.some((event) =>
      isRecord(event) && event['entity_type'] === 'patta')) {
      throw pattaBatchRequired();
    }
    const results: SyncPushResult[] = [];
    for (const event of events) {
      results.push(await this.eventProcessor.process(context.dataSource, {
        actorUserId: context.actorUserId,
        companyId: context.companyId,
        validatedDeviceId,
        protocolVersion,
        timezone: context.timezone,
      }, event));
    }
    return { results };
  }

  async pull(
    dataSource: DataSource,
    cursorInput: string | undefined,
    limitInput: number | undefined,
    protocolVersion: SyncProtocolVersion = 1,
  ): Promise<SyncPullResponse> {
    const cursorText = cursorInput ?? '0';
    const cursor = parseCursor(cursorText);
    const limit = limitInput ?? this.configuration.pullMaxChanges;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.configuration.pullMaxChanges
    ) {
      throw invalidPullLimit(this.configuration.pullMaxChanges);
    }

    const rows: ServerChangeRow[] = await dataSource.query(
      `SELECT "sequence_id"::text AS "sequence_id", "entity_type", "entity_id",
              "operation", "entity_version", "projection_version", "payload_json" AS "payload",
              to_char("changed_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "changed_at"
       FROM "server_change_log"
       WHERE "sequence_id" > $1::bigint
       ORDER BY "server_change_log"."sequence_id" ASC
       LIMIT $2::integer`,
      [cursor.toString(), limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (protocolVersion === 1 && page.some((row) => row.entity_type.startsWith('patta') || row.projection_version !== 1)) {
      throw pattaProtocolUpgradeRequired();
    }
    const changes = page.map((row) => serializeChange(row, protocolVersion));
    return {
      changes,
      next_cursor: changes[changes.length - 1]?.sequence_id ?? cursorText,
      has_more: hasMore,
    };
  }
}
