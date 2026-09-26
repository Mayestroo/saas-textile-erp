import { ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type {
  SyncEvent,
  SyncProjection,
  SyncPushResult,
} from '@textile/sync-protocol';
import type { TenantRequestContext } from '../auth/require-tenant-context.js';
import { SyncEntityHandler, SyncHandlerResult } from './sync-entity-handler.js';
import { SyncHandlerRegistry } from './sync-handler.registry.js';
import { SyncEventProcessor } from './sync-event-processor.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const entityId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const companyId = '55555555-5555-4555-8555-555555555555';

interface ProcessedEventState {
  fingerprint: string;
  deviceId: string;
  status: string;
  result: SyncPushResult | null;
}

function makeEvent(overrides: Partial<SyncEvent> = {}): SyncEvent {
  return {
    event_id: eventId,
    entity_type: 'patta',
    entity_id: entityId,
    operation: 'CREATE',
    base_version: '0',
    client_created_at: '2026-09-26T00:00:00.000Z',
    occurred_at: '2026-09-26T00:00:00.000Z',
    reference_cursor: '0',
    payload: { partiya_number: 'A-1' },
    ...overrides,
  };
}

function projection(): SyncProjection {
  return {
    projection_version: 1,
    entity_type: 'patta_hisob',
    entity_id: entityId,
    entity_version: '1',
    data: {
      id: entityId,
      partiya_number: 'A-1',
      patta_number: '1000',
      model_id: '66666666-6666-4666-8666-666666666666',
      model_name_snapshot: 'Atlas',
      template_id: null,
      konveyer_snapshot: '1',
      razmer: null,
      rang: null,
      ish_soni: 1,
      created_device_id: deviceId,
      created_from_block_id: '77777777-7777-4777-8777-777777777777',
      created_at: '2026-09-26T00:00:00.000Z',
      client_created_at: '2026-09-26T00:00:00.000Z',
      occurred_at: '2026-09-26T00:00:00.000Z',
    },
  };
}

function successResult(): SyncHandlerResult {
  return {
    entityVersion: '1',
    projection: projection(),
    changeSequence: '9007199254740993',
  };
}

function createHarness(handler: SyncEntityHandler) {
  let committedEvent: ProcessedEventState | undefined;
  let transactionEvent: ProcessedEventState | undefined;
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes('client_time_valid')) {
      return [{ client_time_valid: true }];
    }
    if (sql.includes('INSERT INTO "processed_sync_events"')) {
      if (committedEvent || transactionEvent) return [];
      transactionEvent = {
        fingerprint: String(parameters[6]),
        deviceId: String(parameters[1]),
        status: 'PROCESSING',
        result: null,
      };
      return [{ event_id: parameters[0] }];
    }
    if (sql.includes('SELECT "request_fingerprint"')) {
      const row = transactionEvent ?? committedEvent;
      return row
        ? [
            {
              request_fingerprint: row.fingerprint,
              device_id: row.deviceId,
              result_status: row.status,
              result_json: row.result,
            },
          ]
        : [];
    }
    if (sql.includes('UPDATE "processed_sync_events"')) {
      if (!transactionEvent) return [];
      transactionEvent = {
        ...transactionEvent,
        status: String(parameters[1]),
        result: JSON.parse(String(parameters[2])) as SyncPushResult,
      };
      return [{ event_id: parameters[0] }];
    }
    return [];
  });
  const runner = {
    manager: { query },
    query,
    connect: vi.fn(async () => undefined),
    startTransaction: vi.fn(async () => {
      transactionEvent = undefined;
    }),
    commitTransaction: vi.fn(async () => {
      if (transactionEvent) committedEvent = transactionEvent;
      transactionEvent = undefined;
    }),
    rollbackTransaction: vi.fn(async () => {
      transactionEvent = undefined;
    }),
    release: vi.fn(async () => undefined),
    isTransactionActive: true,
  };
  const dataSource = {
    createQueryRunner: vi.fn(() => runner),
  } as unknown as DataSource;
  const context: TenantRequestContext & { validatedDeviceId: string } = {
    dataSource,
    actorUserId: actorId,
    companyId,
    validatedDeviceId: deviceId,
  };
  const processor = new SyncEventProcessor(new SyncHandlerRegistry([handler]));
  return { processor, context, dataSource, runner, query };
}

function successfulHandler(
  apply: () => Promise<SyncHandlerResult>,
): SyncEntityHandler {
  return {
    supports: (entityType, operation) =>
      entityType === 'patta' && operation === 'CREATE',
    apply: vi.fn(async (_manager: EntityManager) => apply()),
  };
}

describe('SyncEventProcessor', () => {
  it('resolves only a matching entity/operation adapter', () => {
    const handler = successfulHandler(async () => successResult());
    const registry = new SyncHandlerRegistry([handler]);

    expect(registry.find('patta', 'CREATE')).toBe(handler);
    expect(registry.find('workers', 'CREATE')).toBeUndefined();
    expect(registry.find('patta', 'UPDATE')).toBeUndefined();
  });

  it('rejects duplicate adapters for one entity and operation', () => {
    const handler = successfulHandler(async () => successResult());
    const duplicate = successfulHandler(async () => successResult());
    const registry = new SyncHandlerRegistry([handler, duplicate]);

    expect(() => registry.find('patta', 'CREATE')).toThrow(
      'Multiple sync handlers support patta/CREATE',
    );
  });

  it('applies a supported event and stores its terminal result transactionally', async () => {
    const handler = successfulHandler(async () => successResult());
    const harness = createHarness(handler);

    await expect(
      harness.processor.process(
        harness.dataSource,
        harness.context,
        makeEvent(),
      ),
    ).resolves.toMatchObject({
      event_id: eventId,
      status: 'SYNCED',
      change_sequence: '9007199254740993',
      entity_version: '1',
    });
    expect(handler.apply).toHaveBeenCalledOnce();
    expect(harness.runner.commitTransaction).toHaveBeenCalledOnce();
    expect(harness.runner.release).toHaveBeenCalledOnce();
  });

  it('returns the committed result for a repeated event ID without applying twice', async () => {
    const handler = successfulHandler(async () => successResult());
    const harness = createHarness(handler);
    const event = makeEvent();

    const first = await harness.processor.process(
      harness.dataSource,
      harness.context,
      event,
    );
    const retry = await harness.processor.process(
      harness.dataSource,
      harness.context,
      event,
    );

    expect(retry).toEqual(first);
    expect(handler.apply).toHaveBeenCalledOnce();
  });

  it('rejects reusing a committed event ID with a different canonical payload', async () => {
    const handler = successfulHandler(async () => successResult());
    const harness = createHarness(handler);
    await harness.processor.process(
      harness.dataSource,
      harness.context,
      makeEvent(),
    );

    await expect(
      harness.processor.process(
        harness.dataSource,
        harness.context,
        makeEvent({ payload: { partiya_number: 'A-2' } }),
      ),
    ).resolves.toMatchObject({
      event_id: eventId,
      status: 'CONFLICT',
      conflict: { code: 'EVENT_ID_REUSE_MISMATCH' },
    });
    expect(handler.apply).toHaveBeenCalledOnce();
  });

  it('stores and replays a domain conflict without re-running its handler', async () => {
    const handler = successfulHandler(async () => {
      throw new ConflictException({
        code: 'PATTA_ALREADY_EXISTS',
        message: 'Patta mavjud',
        details: { entity_id: entityId },
      });
    });
    const harness = createHarness(handler);
    const event = makeEvent();

    const results: SyncPushResult[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(
        await harness.processor.process(
          harness.dataSource,
          harness.context,
          event,
        ),
      );
    }

    expect(results.every((result) => result.status === 'CONFLICT')).toBe(true);
    expect(
      results.every(
        (result) =>
          result === results[0] ||
          JSON.stringify(result) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    expect(handler.apply).toHaveBeenCalledOnce();
  });

  it('rolls the full reservation back on an infrastructure error so the same ID can retry', async () => {
    let shouldFail = true;
    const handler = successfulHandler(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('database transport disconnected');
      }
      return successResult();
    });
    const harness = createHarness(handler);

    await expect(
      harness.processor.process(
        harness.dataSource,
        harness.context,
        makeEvent(),
      ),
    ).rejects.toThrow('database transport disconnected');
    expect(harness.runner.rollbackTransaction).toHaveBeenCalledOnce();
    await expect(
      harness.processor.process(
        harness.dataSource,
        harness.context,
        makeEvent(),
      ),
    ).resolves.toMatchObject({ status: 'SYNCED', event_id: eventId });
    expect(handler.apply).toHaveBeenCalledTimes(2);
  });

  it('returns a per-item validation failure for an event without a UUID', async () => {
    const handler = successfulHandler(async () => successResult());
    const harness = createHarness(handler);

    await expect(
      harness.processor.process(harness.dataSource, harness.context, {
        ...makeEvent(),
        event_id: 'invalid',
      }),
    ).resolves.toMatchObject({
      event_id: null,
      status: 'FAILED',
      error: { code: 'PAYLOAD_INVALID' },
    });
    expect(handler.apply).not.toHaveBeenCalled();
    expect(harness.query).not.toHaveBeenCalled();
  });
});
