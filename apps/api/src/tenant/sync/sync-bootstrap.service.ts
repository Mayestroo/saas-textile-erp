import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type {
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncProtocolVersion,
  SyncProjectionV3,
} from '@textile/sync-protocol';
import type { DataSource, QueryRunner } from 'typeorm';
import { SYNC_CONFIGURATION } from './sync.config.js';
import type { SyncConfiguration } from './sync.config.js';
import { SYNC_CHANGE_LOCK_KEY } from './sync-change-recorder.js';
import {
  MATERIALIZE_BOOTSTRAP_ITEMS_SQL,
  MATERIALIZE_PATTA_V2_BOOTSTRAP_ITEMS_SQL,
  UPGRADE_PATTA_SHEET_BOOTSTRAP_ITEMS_TO_V3_SQL,
  MATERIALIZE_MODEL_ACCOUNT_ADJUSTMENT_BOOTSTRAP_ITEMS_SQL,
} from './sync-bootstrap-projections.js';

const DEVICE_BOOTSTRAP_LOCK_CLASS = 1_398_365_763;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;
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
  'model_account_adjustments',
]);

interface BootstrapSessionRow {
  id: string;
  device_id: string;
  watermark: string;
  status: 'ACTIVE' | 'COMPLETED' | 'EXPIRED';
  protocol_version: SyncProtocolVersion;
  expires_at?: string;
  is_expired?: boolean;
}

interface BootstrapItemRow {
  order_key: string;
  entity_type: string;
  entity_id: string;
  projection_version: number;
  payload_json: unknown;
}

interface WatermarkRow {
  watermark: string;
}

function expiredSession(): ConflictException {
  return new ConflictException({
    code: 'SYNC_BOOTSTRAP_EXPIRED',
    message: 'Boshlang‘ich sinxronlash sessiyasi tugagan, qayta boshlang',
    details: {},
  });
}

function sessionDeviceMismatch(): ForbiddenException {
  return new ForbiddenException({
    code: 'SYNC_BOOTSTRAP_DEVICE_MISMATCH',
    message: 'Boshlang‘ich sinxronlash sessiyasi boshqa qurilmaga tegishli',
    details: {},
  });
}

function invalidCursor(): ConflictException {
  return new ConflictException({
    code: 'SYNC_BOOTSTRAP_CURSOR_INVALID',
    message: 'Boshlang‘ich sinxronlash cursor qiymati yaroqsiz',
    details: {},
  });
}

function invalidPageLimit(maximum: number): ConflictException {
  return new ConflictException({
    code: 'SYNC_BOOTSTRAP_LIMIT_INVALID',
    message: `Boshlang‘ich sinxronlash sahifasi 1 dan ${maximum} gacha yozuv olishi mumkin`,
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

function validateCursor(value: string): bigint {
  if (!CURSOR_PATTERN.test(value)) throw invalidCursor();
  const parsed = BigInt(value);
  if (parsed > MAX_POSTGRES_BIGINT) throw invalidCursor();
  return parsed;
}

function validateProjection(
  row: BootstrapItemRow,
  protocolVersion: SyncProtocolVersion,
): SyncProjectionV3 {
  if ((row.projection_version === 2 && protocolVersion === 1) ||
    (row.projection_version === 3 && protocolVersion !== 3)) {
    throw pattaProtocolUpgradeRequired();
  }
  if (
    !SYNC_ENTITY_TYPES.has(row.entity_type) ||
    !Number.isSafeInteger(row.projection_version) ||
    (row.projection_version !== 1 && row.projection_version !== 2 && row.projection_version !== 3) ||
    typeof row.payload_json !== 'object' ||
    row.payload_json === null ||
    Array.isArray(row.payload_json)
  ) {
    throw new Error('Materialized bootstrap item has an invalid versioned projection');
  }
  const projection = row.payload_json as Record<string, unknown>;
  if (
    Reflect.get(projection, 'projection_version') !== row.projection_version ||
    Reflect.get(projection, 'entity_type') !== row.entity_type ||
    Reflect.get(projection, 'entity_id') !== row.entity_id
  ) {
    throw new Error('Materialized bootstrap projection identity does not match its item');
  }
  if (!CURSOR_PATTERN.test(row.order_key)) {
    throw new Error('Materialized bootstrap order key is not a decimal string');
  }
  return projection as unknown as SyncProjectionV3;
}

@Injectable()
export class SyncBootstrapService {
  constructor(
    @Inject(SYNC_CONFIGURATION) private readonly configuration: SyncConfiguration,
  ) {}

  async create(
    dataSource: DataSource,
    validatedDeviceId: string,
    protocolVersion: SyncProtocolVersion = 1,
  ): Promise<SyncBootstrapSession> {
    const queryRunner = dataSource.createQueryRunner();
    let deviceLockHeld = false;
    let changeLogLockHeld = false;
    let transactionStarted = false;
    try {
      await queryRunner.connect();
      await queryRunner.query(
        `SELECT pg_advisory_lock($1::integer, hashtext('sync-bootstrap-device:' || $2::text))`,
        [DEVICE_BOOTSTRAP_LOCK_CLASS, validatedDeviceId],
      );
      deviceLockHeld = true;
      await this.cleanupStaging(queryRunner);

      await queryRunner.query('SELECT pg_advisory_lock($1::bigint)', [SYNC_CHANGE_LOCK_KEY]);
      changeLogLockHeld = true;
      await queryRunner.startTransaction('REPEATABLE READ');
      transactionStarted = true;
      await queryRunner.query('SELECT txid_current_snapshot()');
      const watermarkRows: WatermarkRow[] = await queryRunner.query(
        `SELECT COALESCE(MAX("sequence_id"), 0)::text AS "watermark"
         FROM "server_change_log"`,
      );
      const watermark = watermarkRows[0]?.watermark;
      if (!watermark || !CURSOR_PATTERN.test(watermark)) {
        throw new Error('Tenant database did not return a valid bootstrap watermark');
      }

      await queryRunner.query('SELECT pg_advisory_unlock($1::bigint)', [SYNC_CHANGE_LOCK_KEY]);
      changeLogLockHeld = false;

      const activeSessions: Array<{ id: string }> = await queryRunner.query(
        `SELECT "id"::text AS "id" FROM "bootstrap_sessions"
         WHERE "device_id" = $1::uuid AND "status" = 'ACTIVE'
         FOR UPDATE`,
        [validatedDeviceId],
      );
      for (const { id } of activeSessions) {
        await queryRunner.query(
          `UPDATE "bootstrap_sessions" SET "status" = 'EXPIRED'
           WHERE "id" = $1::uuid AND "status" = 'ACTIVE'`,
          [id],
        );
        await queryRunner.query('DELETE FROM "bootstrap_sessions" WHERE "id" = $1::uuid', [id]);
      }

      const sessionId = randomUUID();
      const sessionRows: BootstrapSessionRow[] = await queryRunner.query(
        `INSERT INTO "bootstrap_sessions" ("id", "device_id", "watermark", "expires_at", "protocol_version")
         VALUES ($1::uuid, $2::uuid, $3::bigint,
                 transaction_timestamp() + make_interval(mins => $4::integer), $5::smallint)
         RETURNING "id"::text AS "id", "device_id"::text AS "device_id",
                   "watermark"::text AS "watermark", "status",
                   "protocol_version",
                   to_char("expires_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expires_at"`,
        [sessionId, validatedDeviceId, watermark, this.configuration.bootstrapSessionTtlMinutes, protocolVersion],
      );
      const session = sessionRows[0];
      if (!session) throw new Error('Bootstrap session insert did not return a session');

      await queryRunner.query(MATERIALIZE_BOOTSTRAP_ITEMS_SQL, [sessionId, protocolVersion]);
      if (protocolVersion === 2 || protocolVersion === 3) {
        await queryRunner.query(MATERIALIZE_PATTA_V2_BOOTSTRAP_ITEMS_SQL, [sessionId]);
        if (protocolVersion === 3) {
          await queryRunner.query(UPGRADE_PATTA_SHEET_BOOTSTRAP_ITEMS_TO_V3_SQL, [sessionId]);
          await queryRunner.query(MATERIALIZE_MODEL_ACCOUNT_ADJUSTMENT_BOOTSTRAP_ITEMS_SQL, [sessionId]);
        } else {
          const standaloneEntries: Array<{ present: boolean }> = await queryRunner.query(
            `SELECT EXISTS (SELECT 1 FROM "patta_sheets" WHERE "entry_kind" = 'STANDALONE')
              OR EXISTS (SELECT 1 FROM "model_account_adjustments") AS "present"`,
          );
          if (standaloneEntries[0]?.present === true) throw pattaProtocolUpgradeRequired();
        }
      } else {
        const pattaData: Array<{ present: boolean }> = await queryRunner.query(
          `SELECT EXISTS (SELECT 1 FROM "patta_templates")
            OR EXISTS (SELECT 1 FROM "patta_operation_snapshots")
            OR EXISTS (SELECT 1 FROM "patta_hisob")
            OR EXISTS (SELECT 1 FROM "patta_number_blocks")
            OR EXISTS (SELECT 1 FROM "patta_partiya_number_blocks")
            OR EXISTS (SELECT 1 FROM "patta_print_batches")
            OR EXISTS (SELECT 1 FROM "patta_print_events")
            OR EXISTS (SELECT 1 FROM "patta_sheets")
            OR EXISTS (SELECT 1 FROM "patta_sheet_operation_snapshots")
            OR EXISTS (SELECT 1 FROM "patta_sheet_rows")
            OR EXISTS (SELECT 1 FROM "model_account_adjustments") AS "present"`,
        );
        if (pattaData[0]?.present === true) throw pattaProtocolUpgradeRequired();
      }
      await queryRunner.commitTransaction();
      transactionStarted = false;
      return {
        id: session.id,
        device_id: session.device_id,
        watermark: session.watermark,
        status: 'ACTIVE',
        expires_at: session.expires_at ?? '',
      };
    } catch (error) {
      if (transactionStarted && queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      try {
        if (changeLogLockHeld) {
          await queryRunner.query('SELECT pg_advisory_unlock($1::bigint)', [SYNC_CHANGE_LOCK_KEY]);
        }
        if (deviceLockHeld) {
          await queryRunner.query(
            `SELECT pg_advisory_unlock($1::integer, hashtext('sync-bootstrap-device:' || $2::text))`,
            [DEVICE_BOOTSTRAP_LOCK_CLASS, validatedDeviceId],
          );
        }
      } finally {
        await queryRunner.release();
      }
    }
  }

  async page(
    dataSource: DataSource,
    validatedDeviceId: string,
    sessionId: string,
    after: string | null,
    limitInput: number | undefined,
    protocolVersion: SyncProtocolVersion = 1,
  ): Promise<SyncBootstrapPage> {
    const afterValue = after ?? '0';
    const cursor = validateCursor(afterValue);
    const limit = limitInput ?? this.configuration.bootstrapPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.configuration.bootstrapPageSize) {
      throw invalidPageLimit(this.configuration.bootstrapPageSize);
    }

    const sessionRows: BootstrapSessionRow[] = await dataSource.query(
      `SELECT "id"::text AS "id", "device_id"::text AS "device_id",
              "watermark"::text AS "watermark", "status", "protocol_version",
              "expires_at" <= transaction_timestamp() AS "is_expired"
       FROM "bootstrap_sessions" WHERE "id" = $1::uuid`,
      [sessionId],
    );
    const session = sessionRows[0];
    if (!session) throw expiredSession();
    if (session.device_id !== validatedDeviceId) throw sessionDeviceMismatch();
    if (session.protocol_version !== protocolVersion) throw invalidCursor();
    if (session.status !== 'ACTIVE' || session.is_expired === true) {
      if (session.status === 'ACTIVE' && session.is_expired === true) {
        await dataSource.query(
          `UPDATE "bootstrap_sessions" SET "status" = 'EXPIRED'
           WHERE "id" = $1::uuid AND "status" = 'ACTIVE'`,
          [sessionId],
        );
      }
      throw expiredSession();
    }

    const rows: BootstrapItemRow[] = await dataSource.query(
      `SELECT "order_key"::text AS "order_key", "entity_type", "entity_id",
              "projection_version", "payload_json"
       FROM "bootstrap_items"
       WHERE "session_id" = $1::uuid AND "order_key" > $2::bigint
       ORDER BY "bootstrap_items"."order_key" ASC
       LIMIT $3::integer`,
      [sessionId, cursor.toString(), limit + 1],
    );
    const hasMore = rows.length > limit;
    const pageItems = hasMore ? rows.slice(0, limit) : rows;
    if (protocolVersion === 1 && pageItems.some((row) => row.entity_type.startsWith('patta') || row.projection_version !== 1)) {
      throw pattaProtocolUpgradeRequired();
    }
    const items = pageItems.map((row) => ({
      order_key: row.order_key,
      projection: validateProjection(row, protocolVersion),
    }));
    return {
      session_id: session.id,
      watermark: session.watermark,
      items,
      next_order_key: items[items.length - 1]?.order_key ?? null,
      has_more: hasMore,
    };
  }

  async complete(
    dataSource: DataSource,
    validatedDeviceId: string,
    sessionId: string,
  ): Promise<{ session_id: string; status: 'COMPLETED' }> {
    return dataSource.transaction(async (manager) => {
      const sessionRows: BootstrapSessionRow[] = await manager.query(
        `SELECT "id"::text AS "id", "device_id"::text AS "device_id",
                "watermark"::text AS "watermark", "status",
                "expires_at" <= transaction_timestamp() AS "is_expired"
         FROM "bootstrap_sessions" WHERE "id" = $1::uuid FOR UPDATE`,
        [sessionId],
      );
      const session = sessionRows[0];
      if (!session) throw expiredSession();
      if (session.device_id !== validatedDeviceId) throw sessionDeviceMismatch();
      if (session.status === 'COMPLETED') {
        return { session_id: session.id, status: 'COMPLETED' };
      }
      if (session.status !== 'ACTIVE' || session.is_expired === true) {
        throw expiredSession();
      }
      const rows: Array<{ id: string }> = await manager.query(
        `UPDATE "bootstrap_sessions"
         SET "status" = 'COMPLETED', "completed_at" = transaction_timestamp()
         WHERE "id" = $1::uuid AND "status" = 'ACTIVE'
         RETURNING "id"::text AS "id"`,
        [sessionId],
      );
      if (!rows[0]) throw expiredSession();
      return { session_id: session.id, status: 'COMPLETED' };
    });
  }

  private async cleanupStaging(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `WITH expired_sessions AS (
         SELECT "id" FROM "bootstrap_sessions"
         WHERE "status" = 'ACTIVE' AND "expires_at" <= transaction_timestamp()
         ORDER BY "expires_at", "id"
         LIMIT $1::integer
         FOR UPDATE SKIP LOCKED
       )
       UPDATE "bootstrap_sessions" AS session
       SET "status" = 'EXPIRED'
       FROM expired_sessions
       WHERE session."id" = expired_sessions."id"`,
      [this.configuration.bootstrapCleanupBatchSize],
    );
    await queryRunner.query(
      `WITH old_sessions AS (
         SELECT "id" FROM "bootstrap_sessions"
         WHERE "status" IN ('COMPLETED', 'EXPIRED')
           AND COALESCE("completed_at", "expires_at") <=
               transaction_timestamp() - make_interval(hours => $1::integer)
         ORDER BY COALESCE("completed_at", "expires_at"), "id"
         LIMIT $2::integer
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM "bootstrap_sessions" AS session
       USING old_sessions
       WHERE session."id" = old_sessions."id"`,
      [
        this.configuration.bootstrapTerminalRetentionHours,
        this.configuration.bootstrapCleanupBatchSize,
      ],
    );
  }
}
