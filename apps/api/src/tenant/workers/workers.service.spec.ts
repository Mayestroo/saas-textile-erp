import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import type { BadgeHistoryService } from '../badges/badge-history.service.js';
import { canonicalizeWorkerName } from './worker-name.js';
import { WorkersService } from './workers.service.js';

const actorUserId = '11111111-1111-4111-8111-111111111111';

interface WorkerRow {
  id: string;
  full_name: string;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: string;
  updated_at: string;
}

function workerRow(overrides: Partial<WorkerRow> = {}): WorkerRow {
  return {
    id: '9007199254740993',
    full_name: 'Abdullayeva Nodira',
    status: 'ACTIVE',
    version: '1',
    created_at: '2026-09-26T00:00:00.000000Z',
    updated_at: '2026-09-26T00:00:00.000000Z',
    ...overrides,
  };
}

function createHarness() {
  const manager = { query: vi.fn() };
  const dataSource = {
    query: vi.fn(),
    transaction: vi.fn(async (work: (transaction: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager)),
  };
  const auditService = { append: vi.fn(async () => undefined) };
  const badgeHistoryService = {
    closeOpenAssignmentsForWorker: vi.fn(async () => []),
  };
  return {
    manager,
    dataSource: dataSource as unknown as DataSource,
    query: dataSource.query,
    transaction: dataSource.transaction,
    auditService,
    badgeHistoryService,
    service: new WorkersService(
      auditService as unknown as AuditService,
      badgeHistoryService as unknown as BadgeHistoryService,
    ),
  };
}

describe('canonicalizeWorkerName', () => {
  it('trims/collapses ASCII whitespace and preserves the exact letter casing', () => {
    expect(canonicalizeWorkerName('  Abdullayeva\t  Nodira\r\n')).toBe('Abdullayeva Nodira');
    expect(canonicalizeWorkerName('Abdullayeva\u00a0\u00a0Nodira')).toBe('Abdullayeva Nodira');
    expect(canonicalizeWorkerName('aBDULLAYEVA nODIRA')).toBe('aBDULLAYEVA nODIRA');
  });
});

describe('WorkersService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('lists and gets workers with BIGINT values serialized as strings', async () => {
    harness.query.mockResolvedValue([workerRow()]);

    await expect(harness.service.list(harness.dataSource)).resolves.toEqual([workerRow()]);
    await expect(harness.service.getById(harness.dataSource, '9007199254740993'))
      .resolves.toEqual(workerRow());
    expect(harness.query).toHaveBeenCalledWith(expect.stringContaining('"id"::text'), ['ACTIVE']);
  });

  it('returns a structured not-found for an unknown worker', async () => {
    harness.query.mockResolvedValueOnce([]);

    await expect(harness.service.getById(harness.dataSource, '7'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a trimmed worker without changing casing and audits in the transaction', async () => {
    const created = workerRow();
    harness.manager.query.mockResolvedValueOnce([created]);

    await expect(harness.service.create(harness.dataSource, actorUserId, {
      full_name: '  Abdullayeva\t Nodira  ',
    })).resolves.toEqual(created);

    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO "workers"'),
      ['Abdullayeva Nodira', 'ACTIVE'],
    );
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId,
        entityType: 'worker',
        entityId: '9007199254740993',
        action: 'worker.create',
        before: null,
      }),
    );
  });

  it('rejects a blank name before starting a transaction', async () => {
    await expect(harness.service.create(harness.dataSource, actorUserId, { full_name: ' \t ' }))
      .rejects.toMatchObject({ response: { code: 'INVALID_WORKER_NAME' } });
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('locks the row, increments version and appends an update audit', async () => {
    const before = workerRow();
    const after = workerRow({ full_name: 'Nodira Abdullayeva', version: '2' });
    harness.manager.query
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([{ id: before.id }])
      .mockResolvedValueOnce([after]);

    await expect(harness.service.update(harness.dataSource, actorUserId, before.id, {
      full_name: ' Nodira   Abdullayeva ',
      expected_version: '1',
    })).resolves.toEqual(after);

    expect(harness.manager.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(harness.manager.query.mock.calls[1]?.[0]).toContain('"version" = "version" + 1');
    expect(harness.manager.query.mock.calls[2]?.[0]).toContain('SELECT');
    expect(harness.manager.query.mock.calls[1]?.[0]).not.toContain('DELETE');
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'worker.update', before, after }),
    );
  });

  it('rejects a stale expected_version before mutation or audit', async () => {
    harness.manager.query.mockResolvedValueOnce([workerRow({ version: '3' })]);

    await expect(harness.service.update(harness.dataSource, actorUserId, '9007199254740993', {
      full_name: 'Other Name',
      expected_version: '2',
    })).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect(harness.manager.query).toHaveBeenCalledOnce();
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('closes badge history at one DB transaction time when deactivating', async () => {
    const before = workerRow();
    const after = workerRow({ status: 'INACTIVE', version: '2' });
    harness.manager.query
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([{ effective_at: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ id: before.id }])
      .mockResolvedValueOnce([after]);

    await expect(harness.service.update(harness.dataSource, actorUserId, before.id, {
      status: 'INACTIVE',
      expected_version: '1',
    })).resolves.toEqual(after);

    expect(harness.badgeHistoryService.closeOpenAssignmentsForWorker).toHaveBeenCalledWith(
      expect.anything(),
      actorUserId,
      before.id,
      '2026-09-26T01:00:00.000000Z',
    );
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'worker.deactivate', before, after }),
    );
  });

  it('rejects an update with no mutable fields', async () => {
    await expect(harness.service.update(harness.dataSource, actorUserId, '7', {
      expected_version: '1',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('rejects expected versions outside the PostgreSQL BIGINT range', async () => {
    await expect(harness.service.update(harness.dataSource, actorUserId, '7', {
      full_name: 'Name',
      expected_version: '9223372036854775808',
    })).rejects.toMatchObject({ response: { code: 'INVALID_EXPECTED_VERSION' } });
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});
