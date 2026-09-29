import { ConflictException, HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import type {
  SyncEvent,
  SyncErrorCode,
  SyncFailure,
  SyncPushResult,
} from '@textile/sync-protocol';
import { SYNC_CONFIGURATION } from './sync.config.js';
import { loadSyncConfiguration } from './sync.config.js';
import type { SyncConfiguration } from './sync.config.js';
import { fingerprintSyncEvent } from './canonical-event.js';
import type {
  SyncApplyContext,
  SyncHandlerResult,
} from './sync-entity-handler.js';
import { SyncHandlerRegistry } from './sync-handler.registry.js';

const EVENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const APPLY_SAVEPOINT = 'sync_event_application';
const TERMINAL_EVENT_STATUSES = new Set(['SYNCED', 'CONFLICT', 'FAILED']);
const CONFLICT_CODES = new Set([
  'VERSION_CONFLICT',
  'PATTA_ALREADY_EXISTS',
  'PATTA_NUMBER_OUTSIDE_BLOCK',
  'PATTA_BLOCK_DEVICE_MISMATCH',
  'PATTA_SNAPSHOT_MISMATCH',
  'REFERENCE_DATA_STALE',
  'DEVICE_NOT_ACTIVE',
  'SYNC_PERMISSION_REQUIRED',
  'TENANT_PERMISSION_REQUIRED',
  'PATTA_ALREADY_IN_USE',
  'PATTA_PRINT_BATCH_INACTIVE',
  'PATTA_CORRECTION_PAYLOAD_MISMATCH',
  'PATTA_BATCH_IDENTITY_CORRECTION_REQUIRES_REPLACEMENT',
  'PATTA_CORRECTION_DEPENDENCY_UNSUPPORTED',
  'CONFLICT_BADGE_ASSIGNMENT',
  'PATTA_SHEET_ALREADY_EXISTS',
  'PATTA_SHEET_TRASHED',
  'PATTA_SHEET_QUANTITY_MISMATCH',
  'PATTA_SHEET_ROW_INVALID',
  'PATTA_SHEET_ROW_REQUIRED',
  'PATTA_SHEET_ROW_DELETED',
  'PATTA_SHEET_OPERATION_IMMUTABLE',
  'PATTA_SHEET_SOURCE_SNAPSHOT_INVALID',
  'PATTA_SHEET_CUSTOM_OPERATION_INVALID',
  'PATTA_SHEET_OPERATION_PRICE_MISMATCH',
  'PATTA_SHEET_SOURCE_SNAPSHOT_REQUIRED',
  'PATTA_SHEET_PATTA_UNAVAILABLE',
  'PATTA_SHEET_PURGE_REQUIRES_TRASH',
  'PATTA_QUANTITY_UNKNOWN',
  'TENANT_TIMEZONE_UNAVAILABLE',
  'PATTA_SHEET_ALREADY_TRASHED',
  'PATTA_SHEET_NOT_TRASHED',
  'PATTA_SHEET_ROW_OPERATION_IMMUTABLE',
  'PATTA_SHEET_LIFECYCLE_REQUIRES_EXPLICIT_ACTION',
  'MODEL_OPERATION_DEPENDENCY_NOT_SYNCED',
  'MODEL_OPERATION_CANONICAL_NAME_CONFLICT',
  'PATTA_SHEET_BUSINESS_DATE_MISMATCH',
  'PATTA_SHEET_IDENTITY_IMMUTABLE',
  'PATTA_SHEET_OPERATION_ALREADY_ASSIGNED',
  'PATTA_SHEET_OPERATION_REQUIRED',
  'PATTA_SHEET_BADGE_REQUIRED',
]);
const EVENT_FIELDS = new Set([
  'event_id',
  'entity_type',
  'entity_id',
  'operation',
  'base_version',
  'client_created_at',
  'occurred_at',
  'reference_cursor',
  'payload',
]);

interface EventMetadata {
  entityType: string;
  entityId: string | null;
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
}

interface ProcessedEventRow {
  request_fingerprint: string;
  device_id: string | null;
  result_status: string;
  result_json: unknown;
}

interface InsertedEventRow {
  event_id: string;
}

interface UpdatedEventRow {
  event_id: string;
}

interface ClientClockValidityRow {
  client_time_valid: boolean;
}

class StoredSyncOutcomeError extends Error {
  constructor(readonly outcome: SyncPushResult) {
    super('Sync event has a terminal application outcome');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventIdOf(rawEvent: unknown): string | null {
  if (!isRecord(rawEvent)) return null;
  const value = Reflect.get(rawEvent, 'event_id');
  return typeof value === 'string' && EVENT_UUID_PATTERN.test(value)
    ? value
    : null;
}

function metadataOf(rawEvent: unknown): EventMetadata {
  if (!isRecord(rawEvent)) {
    return { entityType: 'INVALID', entityId: null, operation: 'CREATE' };
  }
  const rawType = Reflect.get(rawEvent, 'entity_type');
  const rawId = Reflect.get(rawEvent, 'entity_id');
  const rawOperation = Reflect.get(rawEvent, 'operation');
  return {
    entityType:
      typeof rawType === 'string' && rawType.trim() ? rawType : 'INVALID',
    entityId: typeof rawId === 'string' && rawId.length > 0 ? rawId : null,
    operation:
      rawOperation === 'CREATE' ||
      rawOperation === 'UPDATE' ||
      rawOperation === 'DELETE'
        ? rawOperation
        : 'CREATE',
  };
}

function invalidEvent(message: string): StoredSyncOutcomeError {
  return new StoredSyncOutcomeError({
    event_id: null,
    status: 'FAILED',
    error: { code: 'PAYLOAD_INVALID', message, details: {} },
  });
}

function permissionForEvent(event: SyncEvent): string | null {
  if (event.entity_type === 'patta' && event.operation === 'CREATE') return 'patta.chiqarish.create';
  if (event.entity_type === 'patta_print_batch' && event.operation === 'CREATE') return 'patta.chiqarish.create';
  if (event.entity_type === 'patta_print_batch' && event.operation === 'UPDATE') return 'patta.chiqarish.correct';
  if (event.entity_type === 'patta_print_event' && event.operation === 'CREATE') return 'patta.chiqarish.create';
  if (event.entity_type === 'patta_sheet' && event.operation === 'CREATE') return 'patta_varaq.create';
  if (event.entity_type === 'patta_sheet' && event.operation === 'DELETE') return 'patta_varaq.purge';
  if (event.entity_type === 'model_operation' && event.operation === 'CREATE') return 'patta_varaq.custom_operation';
  return null;
}

async function assertSyncEventPermission(
  manager: EntityManager,
  actorUserId: string,
  event: SyncEvent,
): Promise<void> {
  const permissionCode = permissionForEvent(event);
  if (permissionCode === null) return;
  const rows: Array<{ allowed: boolean }> = await manager.query(
    `SELECT EXISTS (
       SELECT 1 FROM "users" user_account
       JOIN "roles" role ON role."id" = user_account."role_id"
       JOIN "role_permissions" assignment ON assignment."role_id" = role."id"
       JOIN "permissions" permission ON permission."id" = assignment."permission_id"
       WHERE user_account."id" = $1::uuid AND user_account."status" = 'ACTIVE'
         AND permission."code" = $2
     ) AS "allowed"`,
    [actorUserId, permissionCode],
  );
  if (rows[0]?.allowed !== true) {
    throw new ConflictException({
      code: 'SYNC_PERMISSION_REQUIRED',
      message: 'Bu sinxronlash amalini bajarish uchun korxona ruxsati yetarli emas',
      details: { permission: permissionCode },
    });
  }
}

function validateIsoTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalidEvent(`${field} ISO-8601 vaqt ko‘rinishida bo‘lishi kerak`);
  }
}

function parseSyncEvent(rawEvent: unknown, reservedEventId: string): SyncEvent {
  if (!isRecord(rawEvent)) {
    throw invalidEvent('Sinxronlash hodisasi obyekt bo‘lishi kerak');
  }
  if (Object.keys(rawEvent).some((field) => !EVENT_FIELDS.has(field))) {
    throw invalidEvent('Sinxronlash hodisasida noma’lum maydon mavjud');
  }
  const eventId = Reflect.get(rawEvent, 'event_id');
  const entityType = Reflect.get(rawEvent, 'entity_type');
  const entityId = Reflect.get(rawEvent, 'entity_id');
  const operation = Reflect.get(rawEvent, 'operation');
  const baseVersion = Reflect.get(rawEvent, 'base_version');
  const referenceCursor = Reflect.get(rawEvent, 'reference_cursor');
  const payload = Reflect.get(rawEvent, 'payload');

  if (
    typeof eventId !== 'string' ||
    eventId.toLowerCase() !== reservedEventId.toLowerCase()
  ) {
    throw invalidEvent('Sinxronlash hodisasi ID si yaroqsiz');
  }
  if (typeof entityType !== 'string' || entityType.trim() === '') {
    throw invalidEvent('Sinxronlash obyekt turi bo‘sh bo‘lishi mumkin emas');
  }
  if (
    entityId !== null &&
    (typeof entityId !== 'string' || entityId.trim() === '')
  ) {
    throw invalidEvent('Sinxronlash obyekt ID si matn bo‘lishi kerak');
  }
  if (
    operation !== 'CREATE' &&
    operation !== 'UPDATE' &&
    operation !== 'DELETE'
  ) {
    throw invalidEvent('Sinxronlash amali yaroqsiz');
  }
  if (
    baseVersion !== null &&
    (typeof baseVersion !== 'string' || baseVersion === '')
  ) {
    throw invalidEvent('Asosiy versiya matn yoki null bo‘lishi kerak');
  }
  validateIsoTimestamp(
    Reflect.get(rawEvent, 'client_created_at'),
    'client_created_at',
  );
  validateIsoTimestamp(Reflect.get(rawEvent, 'occurred_at'), 'occurred_at');
  if (
    typeof referenceCursor !== 'string' ||
    !DECIMAL_INTEGER_PATTERN.test(referenceCursor)
  ) {
    throw invalidEvent(
      'Ma’lumotnoma cursor qiymati decimal matn bo‘lishi kerak',
    );
  }
  if (!isRecord(payload)) {
    throw invalidEvent('Sinxronlash hodisasi payload obyekt bo‘lishi kerak');
  }

  return rawEvent as unknown as SyncEvent;
}

function errorDetails(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function codeFromException(exception: HttpException): string | null {
  const response = exception.getResponse();
  if (!isRecord(response)) return null;
  const code = Reflect.get(response, 'code');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : null;
}

function messageFromException(exception: HttpException): string {
  const response = exception.getResponse();
  if (isRecord(response)) {
    const message = Reflect.get(response, 'message');
    if (typeof message === 'string') return message;
  }
  return 'Sinxronlash hodisasida biznes ziddiyati aniqlandi';
}

function terminalOutcome(
  error: unknown,
  eventId: string,
  rawEvent: unknown,
): SyncPushResult | null {
  if (error instanceof StoredSyncOutcomeError) {
    const outcome = error.outcome;
    return { ...outcome, event_id: eventId };
  }
  if (!(error instanceof HttpException)) return null;

  const response = error.getResponse();
  const rawCode = codeFromException(error);
  const code =
    rawCode === 'PATTA_NUMBER_BLOCK_DEVICE_MISMATCH'
      ? 'PATTA_BLOCK_DEVICE_MISMATCH'
      : rawCode;
  const status = error.getStatus();
  const details = errorDetails(
    isRecord(response) ? Reflect.get(response, 'details') : undefined,
  );
  if (status === 409 || (code !== null && CONFLICT_CODES.has(code))) {
    const conflictCode: SyncErrorCode = (code ??
      'VERSION_CONFLICT') as SyncErrorCode;
    return {
      event_id: eventId,
      status: 'CONFLICT',
      conflict: {
        code: conflictCode,
        message: messageFromException(error),
        details,
        local_payload: rawEvent,
        server_payload: Reflect.get(details, 'server_payload') ?? null,
      },
    };
  }
  if (status === 400 || status === 403 || status === 404) {
    const failure: SyncFailure = {
      code: code === 'PAYLOAD_INVALID' ? 'PAYLOAD_INVALID' : 'PAYLOAD_INVALID',
      message:
        status === 400
          ? messageFromException(error)
          : 'Sinxronlash ma’lumoti serverda yaroqsiz',
      details,
    };
    return { event_id: eventId, status: 'FAILED', error: failure };
  }
  return null;
}

@Injectable()
export class SyncEventProcessor {
  private readonly configuration: SyncConfiguration;

  constructor(
    private readonly handlerRegistry: SyncHandlerRegistry,
    @Optional() @Inject(SYNC_CONFIGURATION) configuration?: SyncConfiguration,
  ) {
    this.configuration = configuration ?? loadSyncConfiguration({});
  }

  async process(
    dataSource: DataSource,
    context: SyncApplyContext,
    rawEvent: unknown,
  ): Promise<SyncPushResult> {
    const eventId = eventIdOf(rawEvent);
    if (!eventId) {
      return {
        event_id: null,
        status: 'FAILED',
        error: {
          code: 'PAYLOAD_INVALID',
          message: 'event_id UUID formati yaroqsiz',
          details: {},
        },
      };
    }

    const fingerprint = fingerprintSyncEvent(
      rawEvent,
      context.validatedDeviceId,
    );
    const metadata = metadataOf(rawEvent);
    const runner = dataSource.createQueryRunner();
    let transactionStarted = false;

    try {
      await runner.connect();
      await runner.startTransaction('READ COMMITTED');
      transactionStarted = true;
      const reservations: InsertedEventRow[] = await runner.manager.query(
        `INSERT INTO "processed_sync_events"
           ("event_id", "device_id", "user_id", "entity_type", "entity_id", "operation",
            "request_fingerprint", "result_status")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'PROCESSING')
         ON CONFLICT ("event_id") DO NOTHING
         RETURNING "event_id"::text AS "event_id"`,
        [
          eventId,
          context.validatedDeviceId,
          context.actorUserId,
          metadata.entityType,
          metadata.entityId,
          metadata.operation,
          fingerprint,
        ],
      );

      if (reservations.length === 0) {
        const existingRows: ProcessedEventRow[] = await runner.manager.query(
          `SELECT "request_fingerprint", "device_id"::text AS "device_id",
                  "result_status", "result_json"
           FROM "processed_sync_events" WHERE "event_id" = $1::uuid`,
          [eventId],
        );
        const existing = existingRows[0];
        if (!existing || !TERMINAL_EVENT_STATUSES.has(existing.result_status)) {
          throw new Error(
            'Existing processed sync event has no committed terminal result',
          );
        }
        if (
          existing.request_fingerprint !== fingerprint ||
          existing.device_id !== context.validatedDeviceId
        ) {
          const result: SyncPushResult = {
            event_id: eventId,
            status: 'CONFLICT',
            conflict: {
              code: 'EVENT_ID_REUSE_MISMATCH',
              message:
                'event_id boshqa qurilma yoki boshqa payload uchun ishlatilgan',
              details: {},
              local_payload: rawEvent,
              server_payload: null,
            },
          };
          await runner.commitTransaction();
          transactionStarted = false;
          return result;
        }

        const storedResult = parseStoredResult(existing.result_json);
        await runner.commitTransaction();
        transactionStarted = false;
        return storedResult;
      }

      await runner.manager.query(`SAVEPOINT "${APPLY_SAVEPOINT}"`);
      try {
        const event = parseSyncEvent(rawEvent, eventId);
        if (context.protocolVersion === 2 && event.entity_type === 'patta') {
          throw new ConflictException({
            code: 'PATTA_PRINT_BATCH_REQUIRED',
            message: 'Yangi Pattalar v2 bosma to‘plami orqali sinxronlanishi kerak',
            details: {},
          });
        }
        if (context.protocolVersion === 1 && event.entity_type.startsWith('patta')) {
          throw new ConflictException({
            code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED',
            message: 'Patta ma’lumotlarini sinxronlash uchun dastur versiyasini yangilang',
            details: {},
          });
        }
        await this.assertClientClock(runner, event);
        await assertSyncEventPermission(runner.manager, context.actorUserId, event);
        const handler = this.handlerRegistry.find(
          event.entity_type,
          event.operation,
        );
        if (!handler) {
          throw new StoredSyncOutcomeError({
            event_id: eventId,
            status: 'FAILED',
            error: {
              code: 'PAYLOAD_INVALID',
              message:
                'Bu obyekt turi va amal uchun sinxronlash ishlovchisi mavjud emas',
              details: {
                entity_type: event.entity_type,
                operation: event.operation,
              },
            },
          });
        }
        const applied = await handler.apply(runner.manager, context, event);
        const result = this.successResult(eventId, applied);
        await runner.manager.query(`RELEASE SAVEPOINT "${APPLY_SAVEPOINT}"`);
        await this.storeTerminalResult(runner.manager, eventId, result);
        await runner.commitTransaction();
        transactionStarted = false;
        return result;
      } catch (error) {
        const result = terminalOutcome(error, eventId, rawEvent);
        if (!result) throw error;

        await runner.manager.query(
          `ROLLBACK TO SAVEPOINT "${APPLY_SAVEPOINT}"`,
        );
        await runner.manager.query(`RELEASE SAVEPOINT "${APPLY_SAVEPOINT}"`);
        await this.storeTerminalResult(runner.manager, eventId, result);
        await runner.commitTransaction();
        transactionStarted = false;
        return result;
      }
    } catch (error) {
      if (transactionStarted && runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async assertClientClock(
    runner: QueryRunner,
    event: SyncEvent,
  ): Promise<void> {
    const rows: ClientClockValidityRow[] = await runner.manager.query(
      `SELECT
         $1::timestamptz <= transaction_timestamp() + ($3::integer * interval '1 second')
           AND $2::timestamptz <= transaction_timestamp() + ($3::integer * interval '1 second')
           AS "client_time_valid"`,
      [
        event.client_created_at,
        event.occurred_at,
        this.configuration.maxFutureSkewSeconds,
      ],
    );
    if (rows[0]?.client_time_valid !== true) {
      throw new StoredSyncOutcomeError({
        event_id: event.event_id,
        status: 'FAILED',
        error: {
          code: 'PAYLOAD_INVALID',
          message:
            'Qurilma vaqti server vaqtiga nisbatan ruxsat etilgan chegaradan oldinda',
          details: {
            maximum_future_skew_seconds:
              this.configuration.maxFutureSkewSeconds,
          },
        },
      });
    }
  }

  private successResult(
    eventId: string,
    applied: SyncHandlerResult,
  ): SyncPushResult {
    return {
      event_id: eventId,
      status: 'SYNCED',
      entity_version: applied.entityVersion,
      projection: applied.projection,
      change_sequence: applied.changeSequence,
    };
  }

  private async storeTerminalResult(
    manager: EntityManager,
    eventId: string,
    result: SyncPushResult,
  ): Promise<void> {
    const updateResult: [UpdatedEventRow[], number] = await manager.query(
      `UPDATE "processed_sync_events"
       SET "result_status" = $2, "result_json" = $3::jsonb
       WHERE "event_id" = $1::uuid AND "result_status" = 'PROCESSING'
       RETURNING "event_id"::text AS "event_id"`,
      [eventId, result.status, JSON.stringify(result)],
    );
    if (updateResult[0].length !== 1 || updateResult[1] !== 1) {
      throw new Error('Sync event terminal result was not stored');
    }
  }
}

function parseStoredResult(result: unknown): SyncPushResult {
  if (
    isRecord(result) &&
    (result.status === 'SYNCED' ||
      result.status === 'CONFLICT' ||
      result.status === 'FAILED')
  ) {
    return result as unknown as SyncPushResult;
  }
  throw new Error('Stored processed sync event result is invalid');
}
