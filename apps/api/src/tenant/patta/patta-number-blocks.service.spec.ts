import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import type { PattaConfiguration } from './patta.config.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';

const deviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const blockId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sequenceRow = { next_number: '1000' };
const blockRow = {
  id: blockId,
  device_id: deviceId,
  range_start: '1000',
  range_end: '1999',
  allocated_at: '2026-09-26T10:00:00.000000Z',
  exhausted_at: null,
  reported_used_count: '0',
  status: 'ACTIVE',
  created_by: actorId,
};

function createService(queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => queryHandler(sql, parameters));
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    query,
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) =>
      callback(manager)),
  } as unknown as DataSource;
  const auditService = { append: vi.fn(async () => undefined) };
  const service = new PattaNumberBlocksService(
    auditService as unknown as AuditService,
    {
      numberStart: 1n,
      blockSize: 1000n,
      maxActiveBlocksPerDevice: 2,
      maxBatchSize: 100,
    } satisfies PattaConfiguration,
  );
  return { service, dataSource, query, auditService };
}

describe('PattaNumberBlocksService', () => {
  it('allocates a block by locking and advancing the singleton BIGINT sequence', async () => {
    const { service, dataSource, query, auditService } = createService(async (sql) => {
      if (sql.includes('FROM "patta_number_sequence"')) return [sequenceRow];
      if (sql.includes('count(*)::text')) return [{ active_count: '0' }];
      if (sql.includes('INSERT INTO "patta_number_blocks"')) return [blockRow];
      return [];
    });

    await expect(service.allocate(dataSource, actorId, deviceId)).resolves.toMatchObject({
      range_start: '1000',
      range_end: '1999',
      reported_used_count: '0',
      status: 'ACTIVE',
    });
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(query.mock.calls.find(([sql]) => sql.includes('UPDATE "patta_number_sequence"'))?.[1])
      .toEqual(['2000']);
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'patta_number_block.allocate',
      after: expect.objectContaining({ device_id: deviceId, range_start: '1000', range_end: '1999' }),
    }));
  });

  it('enforces the configured active-block limit while holding the sequence lock', async () => {
    const { service, dataSource, query } = createService(async (sql) => {
      if (sql.includes('FROM "patta_number_sequence"')) return [sequenceRow];
      if (sql.includes('count(*)::text')) return [{ active_count: '2' }];
      return [];
    });

    await expect(service.allocate(dataSource, actorId, deviceId))
      .rejects.toMatchObject({ response: { code: 'PATTA_MAX_ACTIVE_BLOCKS_REACHED' } });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "patta_number_blocks"'))).toBe(false);
  });

  it('exhausts a full block and rejects usage reports that go backwards', async () => {
    const { service, dataSource } = createService(async (sql) => {
      if (sql.includes('FROM "patta_number_blocks"') && sql.includes('FOR UPDATE')) {
        return [{ ...blockRow, reported_used_count: '999' }];
      }
      if (sql.includes('UPDATE "patta_number_blocks"')) {
        return [[{ ...blockRow, reported_used_count: '1000', status: 'EXHAUSTED' }], 1];
      }
      return [];
    });

    await expect(service.reportUsage(dataSource, actorId, deviceId, blockId, 1000n))
      .resolves.toMatchObject({ reported_used_count: '1000', status: 'EXHAUSTED' });
    await expect(service.reportUsage(dataSource, actorId, deviceId, blockId, 998n))
      .rejects.toMatchObject({ response: { code: 'PATTA_BLOCK_USAGE_DECREASED' } });
  });

  it('allows historical membership checks for terminal ranges but rejects other devices/numbers', async () => {
    const { service, dataSource } = createService(async () => [{
      ...blockRow,
      status: 'CANCELLED',
      range_start: '9007199254740993',
      range_end: '9007199254741992',
    }]);

    await expect(service.assertAllocatedNumber(dataSource, deviceId, blockId, 9007199254740993n))
      .resolves.toBeUndefined();
    await expect(service.assertAllocatedNumber(
      dataSource,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      blockId,
      9007199254740993n,
    )).rejects.toMatchObject({ response: { code: 'PATTA_NUMBER_BLOCK_DEVICE_MISMATCH' } });
    await expect(service.assertAllocatedNumber(dataSource, deviceId, blockId, 9007199254741993n))
      .rejects.toMatchObject({ response: { code: 'PATTA_NUMBER_OUTSIDE_BLOCK' } });
  });
});
