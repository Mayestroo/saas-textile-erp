import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { PattaPartiyaNumberBlocksService } from './patta-partiya-number-blocks.service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const blockId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const block = {
  id: blockId,
  device_id: deviceId,
  range_start: '1',
  range_end: '1000',
  allocated_at: '2026-09-28T10:00:00.000000Z',
  exhausted_at: null,
  reported_used_count: '0',
  status: 'ACTIVE' as const,
  created_by: actorId,
};

function createService(queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>) {
  const query = vi.fn(queryHandler);
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) => callback(manager)),
  } as unknown as DataSource;
  const auditService = { append: vi.fn(async () => undefined) };
  const syncChangeRecorder = { record: vi.fn(async () => ({ sequenceId: '1' })) };
  const service = new PattaPartiyaNumberBlocksService(
    auditService as unknown as AuditService,
    { numberStart: 1n, partiyaNumberStart: 1n, blockSize: 1000n, maxActiveBlocksPerDevice: 2, maxBatchSize: 100 },
    syncChangeRecorder as unknown as SyncChangeRecorder,
  );
  return { service, dataSource, query, auditService, syncChangeRecorder };
}

describe('PattaPartiyaNumberBlocksService', () => {
  it('allocates a disjoint range through the locked tenant-global Partiya sequence', async () => {
    const { service, dataSource, query, auditService, syncChangeRecorder } = createService(async (sql) => {
      if (sql.includes('FROM "patta_partiya_number_sequence"')) return [{ next_number: '1' }];
      if (sql.includes('count(*)::text')) return [{ active_count: '0' }];
      if (sql.includes('INSERT INTO "patta_partiya_number_blocks"')) return [block];
      return [];
    });

    await expect(service.allocate(dataSource, actorId, deviceId)).resolves.toMatchObject({
      range_start: '1', range_end: '1000', device_id: deviceId, status: 'ACTIVE',
    });
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "patta_partiya_number_sequence"'))?.[1]).toEqual(['1001']);
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_partiya_number_block', action: 'patta_partiya_number_block.allocate',
    }));
    expect(syncChangeRecorder.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_partiya_number_blocks', projectionVersion: 2,
    }));
  });

  it('rejects a decreasing usage report and does not update the block', async () => {
    const usedBlock = { ...block, reported_used_count: '12' };
    const { service, dataSource, query } = createService(async (sql) => {
      if (sql.includes('FROM "patta_partiya_number_blocks"')) return [usedBlock];
      return [];
    });

    await expect(service.reportUsage(dataSource, deviceId, blockId, 11n))
      .rejects.toMatchObject({ response: { code: 'PARTIYA_BLOCK_USAGE_INVALID' } });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });
});
