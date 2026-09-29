import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import type { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaService } from './patta.service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const modelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function createService(
  queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>,
  options: { price?: string } = {},
) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => queryHandler(sql, parameters));
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    query,
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) =>
      callback(manager)),
  } as unknown as DataSource;
  const auditService = { append: vi.fn(async () => undefined) };
  const syncChangeRecorder = {
    record: vi.fn(async () => ({ sequenceId: '1' })),
  };
  const priceService = {
    resolvePrice: vi.fn(async () => options.price ?? '1000.00'),
  };
  return {
    service: new PattaService(
      auditService as unknown as AuditService,
      priceService as unknown as OperationPriceService,
      syncChangeRecorder as unknown as SyncChangeRecorder,
      {} as PattaOfflineRegistrationValidator,
    ),
    dataSource,
    query,
    auditService,
    priceService,
    syncChangeRecorder,
  };
}

describe('PattaService', () => {
  it('does not serve the old Patta quantity semantics from the v1 generation API', async () => {
    const { service, dataSource } = createService(async () => []);
    await expect(service.generate(dataSource, actorId, deviceId, {
      partiya_number: 'A-1',
      model_id: modelId,
      konveyer: '1',
      count: 1,
    })).rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('requires the v2 Patta lookup/list contract instead of mislabeling legacy operation counts', async () => {
    const query = vi.fn(async () => []);
    const dataSource = { query } as unknown as DataSource;
    const { service } = createService(async () => []);

    await expect(service.lookup(dataSource, 'A-1', '1'))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    await expect(service.list(dataSource, { page: 1, limit: 50 }))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
    expect(query).not.toHaveBeenCalled();
  });

});
