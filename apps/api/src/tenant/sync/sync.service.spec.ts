import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent, SyncProjection, SyncPushResult } from '@textile/sync-protocol';
import type { TenantRequestContext } from '../auth/require-tenant-context.js';
import { loadSyncConfiguration } from './sync.config.js';
import type { SyncEventProcessor } from './sync-event-processor.js';
import { SyncService } from './sync.service.js';

const deviceId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';
const companyId = '33333333-3333-4333-8333-333333333333';
const eventIds = [
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];

function context(dataSource: DataSource): TenantRequestContext {
  return { dataSource, actorUserId, companyId };
}

function event(index: number): SyncEvent {
  return {
    event_id: eventIds[index] ?? eventIds[0]!,
    entity_type: 'models',
    entity_id: `77777777-7777-4777-8777-77777777777${index}`,
    operation: 'CREATE',
    base_version: '0',
    client_created_at: '2026-09-26T10:00:00.000Z',
    occurred_at: '2026-09-26T10:00:00.000Z',
    reference_cursor: '0',
    payload: { partiya_number: `A-${index}` },
  };
}

function workerProjection(id: string, version: string): SyncProjection {
  return {
    projection_version: 1,
    entity_type: 'workers',
    entity_id: id,
    entity_version: version,
    data: {
      id,
      full_name: 'Abdullayeva Nodira',
      status: 'ACTIVE',
      version,
      created_at: '2026-09-26T00:00:00.000000Z',
      updated_at: '2026-09-26T00:00:00.000000Z',
    },
  };
}

describe('SyncService', () => {
  it('returns independent outcomes for a mixed batch and preserves input order', async () => {
    const outcomes: SyncPushResult[] = [
      { event_id: eventIds[0]!, status: 'SYNCED', entity_version: '1', projection: workerProjection('18', '1'), change_sequence: '1' },
      { event_id: eventIds[1]!, status: 'CONFLICT', conflict: { code: 'PATTA_ALREADY_EXISTS', message: 'Takroriy Patta', details: {}, local_payload: {}, server_payload: {} } },
      { event_id: eventIds[2]!, status: 'FAILED', error: { code: 'PAYLOAD_INVALID', message: 'Yaroqsiz', details: {} } },
    ];
    const processor = {
      process: vi.fn(async () => outcomes.shift()!),
    };
    const service = new SyncService(
      processor as unknown as SyncEventProcessor,
      loadSyncConfiguration({ SYNC_PUSH_MAX_EVENTS: '3' }),
    );
    const dataSource = { query: vi.fn() } as unknown as DataSource;

    await expect(service.push(context(dataSource), deviceId, [event(0), event(1), event(2)]))
      .resolves.toEqual({ results: [
        expect.objectContaining({ status: 'SYNCED' }),
        expect.objectContaining({ status: 'CONFLICT' }),
        expect.objectContaining({ status: 'FAILED' }),
      ] });
    expect(processor.process).toHaveBeenCalledTimes(3);
    expect(processor.process.mock.calls.map((call) => call[1].validatedDeviceId)).toEqual([
      deviceId,
      deviceId,
      deviceId,
    ]);
  });

  it('rejects an oversized batch before invoking any event handler', async () => {
    const processor = { process: vi.fn() };
    const service = new SyncService(
      processor as unknown as SyncEventProcessor,
      loadSyncConfiguration({ SYNC_PUSH_MAX_EVENTS: '2' }),
    );
    const dataSource = { query: vi.fn() } as unknown as DataSource;

    await expect(service.push(context(dataSource), deviceId, [event(0), event(1), event(2)]))
      .rejects.toMatchObject({ response: { code: 'SYNC_PUSH_BATCH_TOO_LARGE' } });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('pulls deterministic ordered pages with decimal-string cursors above JS safe integer', async () => {
    const projection = workerProjection('18', '2');
    const rows = ['9007199254740993', '9007199254740994', '9007199254740995'].map((sequence_id) => ({
      sequence_id,
      entity_type: 'workers',
      entity_id: '18',
      operation: 'UPSERT',
      entity_version: '2',
      projection_version: 1,
      payload: projection,
      changed_at: '2026-09-26T00:00:00.000000Z',
    }));
    const query = vi.fn(async () => rows);
    const dataSource = { query } as unknown as DataSource;
    const service = new SyncService(
      { process: vi.fn() } as unknown as SyncEventProcessor,
      loadSyncConfiguration({ SYNC_PULL_MAX_CHANGES: '2' }),
    );

    await expect(service.pull(dataSource, '9007199254740992', 2)).resolves.toEqual({
      changes: [
        expect.objectContaining({ sequence_id: '9007199254740993', entity_id: '18' }),
        expect.objectContaining({ sequence_id: '9007199254740994', entity_id: '18' }),
      ],
      next_cursor: '9007199254740994',
      has_more: true,
    });
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY "server_change_log"."sequence_id" ASC');
    expect(query.mock.calls[0]?.[1]).toEqual(['9007199254740992', 3]);
  });

  it('rejects v1 Patta mutations before invoking a domain handler', async () => {
    const processor = { process: vi.fn() };
    const service = new SyncService(
      processor as unknown as SyncEventProcessor,
      loadSyncConfiguration({}),
    );
    const dataSource = { query: vi.fn() } as unknown as DataSource;

    await expect(service.push(context(dataSource), deviceId, [{ ...event(0), entity_type: 'patta' }], 1))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('rejects v2 single-Patta mutations in favor of aggregate print batches', async () => {
    const processor = { process: vi.fn() };
    const service = new SyncService(
      processor as unknown as SyncEventProcessor,
      loadSyncConfiguration({}),
    );
    const dataSource = { query: vi.fn() } as unknown as DataSource;

    await expect(service.push(context(dataSource), deviceId, [{ ...event(0), entity_type: 'patta' }], 2))
      .rejects.toMatchObject({ response: { code: 'PATTA_PRINT_BATCH_REQUIRED' } });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('returns a structured upgrade error instead of a projection failure when a v1 pull reaches Patta data', async () => {
    const query = vi.fn(async () => [{
      sequence_id: '42',
      entity_type: 'patta_print_batches',
      entity_id: '77777777-7777-4777-8777-777777777777',
      operation: 'UPSERT',
      entity_version: '1',
      projection_version: 2,
      payload: {},
      changed_at: '2026-09-28T10:00:00.000000Z',
    }]);
    const dataSource = { query } as unknown as DataSource;
    const service = new SyncService(
      { process: vi.fn() } as unknown as SyncEventProcessor,
      loadSyncConfiguration({}),
    );

    await expect(service.pull(dataSource, '0', 100))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
  });

  it('adapts legacy Patta operation counts to the explicit v2 legacy field without inventing quantity', async () => {
    const legacyProjection = {
      projection_version: 1,
      entity_type: 'patta_hisob',
      entity_id: '77777777-7777-4777-8777-777777777777',
      entity_version: '1',
      data: {
        id: '77777777-7777-4777-8777-777777777777',
        partiya_number: 'LEGACY-1',
        patta_number: '15',
        model_id: 'model-1',
        model_name_snapshot: 'Atlas',
        template_id: null,
        konveyer_snapshot: '1',
        razmer: 'S',
        rang: 'Qora',
        ish_soni: 13,
        created_device_id: deviceId,
        created_from_block_id: null,
        created_at: '2026-09-26T10:00:00.000000Z',
        client_created_at: null,
        occurred_at: null,
      },
    };
    const query = vi.fn(async () => [{
      sequence_id: '43',
      entity_type: 'patta_hisob',
      entity_id: '77777777-7777-4777-8777-777777777777',
      operation: 'UPSERT',
      entity_version: '1',
      projection_version: 1,
      payload: legacyProjection,
      changed_at: '2026-09-28T10:00:00.000000Z',
    }]);
    const service = new SyncService(
      { process: vi.fn() } as unknown as SyncEventProcessor,
      loadSyncConfiguration({}),
    );

    const page = await service.pull({ query } as unknown as DataSource, '42', 10, 2);
    expect(page.changes[0]).toMatchObject({
      projection_version: 2,
      payload: {
        projection_version: 2,
        data: { ish_soni: null, legacy_operation_count: 13 },
      },
    });
    expect(Reflect.get(page.changes[0]?.payload?.data ?? {}, 'ish_soni')).toBeNull();
  });

  it('keeps the supplied cursor when no changes exist and rejects invalid cursor/limit values', async () => {
    const query = vi.fn(async () => []);
    const dataSource = { query } as unknown as DataSource;
    const service = new SyncService(
      { process: vi.fn() } as unknown as SyncEventProcessor,
      loadSyncConfiguration({ SYNC_PULL_MAX_CHANGES: '2' }),
    );

    await expect(service.pull(dataSource, '9007199254740993', undefined)).resolves.toEqual({
      changes: [],
      next_cursor: '9007199254740993',
      has_more: false,
    });
    await expect(service.pull(dataSource, '01', 1))
      .rejects.toMatchObject({ response: { code: 'SYNC_CURSOR_INVALID' } });
    await expect(service.pull(dataSource, '9223372036854775808', 1))
      .rejects.toMatchObject({ response: { code: 'SYNC_CURSOR_INVALID' } });
    await expect(service.pull(dataSource, '0', 3))
      .rejects.toMatchObject({ response: { code: 'SYNC_PULL_LIMIT_INVALID' } });
  });
});
