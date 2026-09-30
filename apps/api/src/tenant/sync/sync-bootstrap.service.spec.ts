import { ForbiddenException } from '@nestjs/common';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncProjection } from '@textile/sync-protocol';
import { loadSyncConfiguration } from './sync.config.js';
import { SYNC_CHANGE_LOCK_KEY } from './sync-change-recorder.js';
import { SyncBootstrapService } from './sync-bootstrap.service.js';

const deviceId = '11111111-1111-4111-8111-111111111111';
const foreignDeviceId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';

const workerProjection: SyncProjection = {
  projection_version: 1,
  entity_type: 'workers',
  entity_id: '18',
  entity_version: '2',
  data: {
    id: '18',
    full_name: 'Abdullayeva Nodira',
    status: 'ACTIVE',
    version: '2',
    created_at: '2026-09-26T00:00:00.000000Z',
    updated_at: '2026-09-26T00:00:00.000000Z',
  },
};

function bootstrapSessionQueryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    device_id: deviceId,
    watermark: '12840',
    status: 'ACTIVE',
    protocol_version: 1,
    is_expired: false,
    ...overrides,
  };
}

function queryRunnerHarness(pattaDataPresent = false) {
  const commands: string[] = [];
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    commands.push(sql);
    if (sql.includes('INSERT INTO "bootstrap_sessions"')) {
      return [{
        id: parameters[0],
        device_id: parameters[1],
        watermark: parameters[2],
        status: 'ACTIVE',
        expires_at: '2026-09-26T10:30:00.000000Z',
      }];
    }
    if (sql.includes('SELECT COALESCE(MAX("sequence_id")')) {
      return [{ watermark: '12840' }];
    }
    if (sql.includes('SELECT "id"::text AS "id" FROM "bootstrap_sessions"')) {
      return [];
    }
    if (sql.includes('AS "present"')) return [{ present: pattaDataPresent }];
    return [];
  });
  const runner = {
    manager: { query },
    query,
    connect: vi.fn(async () => undefined),
    startTransaction: vi.fn(async () => undefined),
    commitTransaction: vi.fn(async () => undefined),
    rollbackTransaction: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    isTransactionActive: true,
  } as unknown as QueryRunner;
  const dataSource = { createQueryRunner: vi.fn(() => runner) } as unknown as DataSource;
  return { commands, dataSource, query, runner };
}

describe('SyncBootstrapService', () => {
  it('captures watermark, releases the writer lock, then materializes before returning', async () => {
    const harness = queryRunnerHarness();
    const service = new SyncBootstrapService(loadSyncConfiguration({}));

    await expect(service.create(harness.dataSource, deviceId)).resolves.toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      device_id: deviceId,
      watermark: '12840',
      status: 'ACTIVE',
    });

    const snapshotIndex = harness.commands.findIndex((sql) => sql.includes('txid_current_snapshot'));
    const watermarkIndex = harness.commands.findIndex((sql) => sql.includes('COALESCE(MAX("sequence_id")'));
    const releaseWriterLockIndex = harness.commands.findIndex((sql) => sql.includes('pg_advisory_unlock($1::bigint)'));
    const materializeIndex = harness.commands.findIndex((sql) => sql.includes('INSERT INTO "bootstrap_items"'));
    expect(snapshotIndex).toBeLessThan(watermarkIndex);
    expect(watermarkIndex).toBeLessThan(releaseWriterLockIndex);
    expect(releaseWriterLockIndex).toBeLessThan(materializeIndex);
    expect(harness.query.mock.calls.find(([sql]) => sql.includes('pg_advisory_lock($1::bigint)'))?.[1])
      .toEqual([SYNC_CHANGE_LOCK_KEY]);
    expect(harness.runner.startTransaction).toHaveBeenCalledWith('REPEATABLE READ');
    expect(harness.runner.commitTransaction).toHaveBeenCalledOnce();
    expect(harness.runner.release).toHaveBeenCalledOnce();
  });

  it('uses keyset pages, checks device/session ownership, and returns decimal keys', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "bootstrap_sessions"')) {
        return [bootstrapSessionQueryRow()];
      }
      if (sql.includes('FROM "bootstrap_items"')) {
        return [
          { order_key: '9007199254740993', entity_type: 'workers', entity_id: '18', projection_version: 1, payload_json: workerProjection },
          { order_key: '9007199254740994', entity_type: 'workers', entity_id: '47', projection_version: 1, payload_json: { ...workerProjection, entity_id: '47', data: { ...workerProjection.data, id: '47' } } },
          { order_key: '9007199254740995', entity_type: 'models', entity_id: 'model-1', projection_version: 1, payload_json: { ...workerProjection, entity_type: 'models', entity_id: 'model-1', entity_version: '1', data: { ...workerProjection.data, id: 'model-1' } } },
        ];
      }
      return [];
    });
    const service = new SyncBootstrapService(loadSyncConfiguration({ SYNC_BOOTSTRAP_PAGE_SIZE: '2' }));
    const dataSource = { query } as unknown as DataSource;

    await expect(service.page(dataSource, deviceId, sessionId, '9007199254740992', 2)).resolves.toMatchObject({
      session_id: sessionId,
      watermark: '12840',
      items: [
        { order_key: '9007199254740993', projection: workerProjection },
        { order_key: '9007199254740994', projection: expect.objectContaining({ entity_id: '47' }) },
      ],
      next_order_key: '9007199254740994',
      has_more: true,
    });
    expect(query.mock.calls[1]?.[0]).toContain('"order_key" > $2::bigint');
    expect(query.mock.calls[1]?.[0]).toContain('ORDER BY "bootstrap_items"."order_key" ASC');
    expect(query.mock.calls[1]?.[1]).toEqual([sessionId, '9007199254740992', 3]);

    await expect(service.page(dataSource, foreignDeviceId, sessionId, null, 2))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('materializes only non-Patta references for the default v1 bootstrap protocol', async () => {
    const harness = queryRunnerHarness();
    const service = new SyncBootstrapService(loadSyncConfiguration({}));

    await expect(service.create(harness.dataSource, deviceId)).resolves.toMatchObject({
      status: 'ACTIVE',
      device_id: deviceId,
    });
    const materialize = harness.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "bootstrap_items"'));
    expect(materialize?.[0]).toContain('NOT LIKE \'patta%\'');
    expect(harness.runner.commitTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a v1 bootstrap that would omit existing Patta data', async () => {
    const harness = queryRunnerHarness(true);
    const service = new SyncBootstrapService(loadSyncConfiguration({}));

    await expect(service.create(harness.dataSource, deviceId))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    expect(harness.runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(harness.runner.commitTransaction).not.toHaveBeenCalled();
  });

  it('materializes v2 Patta projections in addition to non-Patta references', async () => {
    const harness = queryRunnerHarness();
    const service = new SyncBootstrapService(loadSyncConfiguration({}));

    await service.create(harness.dataSource, deviceId, 2);
    const materializationCalls = harness.query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO "bootstrap_items"'),
    );
    expect(materializationCalls).toHaveLength(2);
    expect(String(materializationCalls[0]?.[0])).toContain('NOT LIKE \'patta%\'');
    expect(String(materializationCalls[1]?.[0])).toContain("'patta_print_batches'");
  });

  it('upgrades Patta Sheet bootstrap items to protocol V3 for Standalone-capable clients', async () => {
    const harness = queryRunnerHarness();
    const service = new SyncBootstrapService(loadSyncConfiguration({}));

    await service.create(harness.dataSource, deviceId, 3);
    expect(harness.commands.some((sql) => sql.includes('UPDATE "bootstrap_items" item') &&
      sql.includes("'deleted_by_name_snapshot'"))).toBe(true);
    expect(harness.commands.filter((sql) => sql.includes('INSERT INTO "bootstrap_items"'))).toHaveLength(3);
    expect(harness.runner.commitTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a V2 bootstrap if Standalone sheet data is present', async () => {
    const harness = queryRunnerHarness(true);
    const service = new SyncBootstrapService(loadSyncConfiguration({}));

    await expect(service.create(harness.dataSource, deviceId, 2))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    expect(harness.runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(harness.runner.commitTransaction).not.toHaveBeenCalled();
  });

  it('returns a structured upgrade error when a v1 bootstrap page would expose Patta data', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "bootstrap_sessions"')) return [bootstrapSessionQueryRow()];
      if (sql.includes('FROM "bootstrap_items"')) return [{
        order_key: '1',
        entity_type: 'patta_print_batches',
        entity_id: '77777777-7777-4777-8777-777777777777',
        projection_version: 2,
        payload_json: {},
      }];
      return [];
    });
    const service = new SyncBootstrapService(loadSyncConfiguration({}));
    const dataSource = { query } as unknown as DataSource;

    await expect(service.page(dataSource, deviceId, sessionId, null, 50))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
  });

  it('requires a new session after expiry or terminal staging cleanup', async () => {
    const query = vi.fn(async () => [bootstrapSessionQueryRow({ is_expired: true })]);
    const service = new SyncBootstrapService(loadSyncConfiguration({}));
    const dataSource = { query } as unknown as DataSource;

    await expect(service.page(dataSource, deviceId, sessionId, null, 100))
      .rejects.toMatchObject({ response: { code: 'SYNC_BOOTSTRAP_EXPIRED' } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('validates keyset cursor and page bounds before querying staging rows', async () => {
    const query = vi.fn(async () => [bootstrapSessionQueryRow()]);
    const service = new SyncBootstrapService(loadSyncConfiguration({ SYNC_BOOTSTRAP_PAGE_SIZE: '2' }));
    const dataSource = { query } as unknown as DataSource;

    await expect(service.page(dataSource, deviceId, sessionId, '01', 1))
      .rejects.toMatchObject({ response: { code: 'SYNC_BOOTSTRAP_CURSOR_INVALID' } });
    await expect(service.page(dataSource, deviceId, sessionId, null, 3))
      .rejects.toMatchObject({ response: { code: 'SYNC_BOOTSTRAP_LIMIT_INVALID' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('marks bootstrap completion idempotently without changing client cursor semantics', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "bootstrap_sessions"')) {
        return [bootstrapSessionQueryRow({ status: 'COMPLETED' })];
      }
      return [];
    });
    const service = new SyncBootstrapService(loadSyncConfiguration({}));
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      query,
      transaction: async <T>(callback: (transactionManager: EntityManager) => Promise<T>) =>
        callback(manager),
    } as unknown as DataSource;

    await expect(service.complete(dataSource, deviceId, sessionId)).resolves.toEqual({
      session_id: sessionId,
      status: 'COMPLETED',
    });
  });
});
