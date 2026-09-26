import type { DataSource, EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { BadgeHistoryService } from './badge-history.service.js';

const actorUserId = '11111111-1111-4111-8111-111111111111';
const badgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface BadgeRow {
  id: string;
  badge_number: string;
  worker_id: string;
  full_name: string;
  valid_from: string;
  valid_to: string | null;
  created_by: string | null;
  created_at: string;
}

function assignment(overrides: Partial<BadgeRow> = {}): BadgeRow {
  return {
    id: badgeId,
    badge_number: '00125',
    worker_id: '18',
    full_name: 'Abdullayeva Nodira',
    valid_from: '2026-09-01T00:00:00.000000Z',
    valid_to: null,
    created_by: actorUserId,
    created_at: '2026-09-01T00:00:00.000000Z',
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
  return {
    manager,
    dataSource: dataSource as unknown as DataSource,
    auditService,
    service: new BadgeHistoryService(auditService as unknown as AuditService),
  };
}

describe('BadgeHistoryService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('assigns a trimmed string badge to an active worker and audits by history UUID', async () => {
    const inserted = assignment();
    harness.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ id: '18', full_name: 'Abdullayeva Nodira', status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ not_backdated: true, after_start: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([inserted]);

    await expect(harness.service.assign(harness.dataSource, actorUserId, '18', {
      badge_number: ' 00125 ',
    })).resolves.toEqual(inserted);

    expect(harness.manager.query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(harness.manager.query.mock.calls[4]?.[1]).toEqual(['00125']);
    expect(harness.manager.query.mock.calls[5]?.[1]).toEqual([
      '00125',
      '18',
      '2026-09-26T01:00:00.000000Z',
      actorUserId,
    ]);
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: 'badge',
        entityId: badgeId,
        action: 'badge.assign',
        before: null,
        after: inserted,
      }),
    );
  });

  it('refuses a backdated assignment using database time before worker/history writes', async () => {
    harness.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ id: '18', full_name: 'Abdullayeva Nodira', status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ not_backdated: false, after_start: true }]);

    await expect(harness.service.assign(harness.dataSource, actorUserId, '18', {
      badge_number: '125',
      effective_at: '2026-01-01T00:00:00Z',
    })).rejects.toMatchObject({ response: { code: 'BADGE_EFFECTIVE_AT_IN_PAST' } });
    expect(harness.manager.query).toHaveBeenCalledTimes(4);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects new assignment to an inactive worker', async () => {
    harness.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ id: '18', full_name: 'Old Worker', status: 'INACTIVE' }]);

    await expect(harness.service.assign(harness.dataSource, actorUserId, '18', {
      badge_number: '125',
    })).rejects.toMatchObject({ response: { code: 'WORKER_INACTIVE' } });
    expect(harness.manager.query).toHaveBeenCalledTimes(3);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('reassigns by closing the old interval and opening a new history row', async () => {
    const oldAssignment = assignment({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      valid_from: '2026-01-01T00:00:00.000000Z',
    });
    const closed = { ...oldAssignment, valid_to: '2026-10-01T00:00:00.000000Z' };
    const next = assignment({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      worker_id: '47',
      full_name: 'Worker Forty Seven',
      valid_from: '2026-10-01T00:00:00.000000Z',
    });
    harness.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ id: '47', full_name: 'Worker Forty Seven', status: 'ACTIVE' }])
      .mockResolvedValueOnce([oldAssignment])
      .mockResolvedValueOnce([{ not_backdated: true, after_start: true }])
      .mockResolvedValueOnce([{ id: oldAssignment.id }])
      .mockResolvedValueOnce([closed])
      .mockResolvedValueOnce([{ ...next, full_name: undefined }]);

    await expect(harness.service.reassign(harness.dataSource, actorUserId, '125', {
      worker_id: '47',
      effective_at: '2026-10-01T00:00:00Z',
    })).resolves.toEqual(next);

    expect(harness.manager.query.mock.calls[3]?.[0]).toContain('FOR UPDATE OF history');
    expect(harness.manager.query.mock.calls[5]?.[0]).toContain('SET "valid_to"');
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityId: next.id,
        action: 'badge.reassign',
        before: oldAssignment,
        after: { ...next, previous_assignment: closed },
      }),
    );
  });

  it('releases an open badge and audits the preserved closed interval', async () => {
    const open = assignment();
    const closed = { ...open, valid_to: '2026-09-26T01:00:00.000000Z' };
    harness.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([open])
      .mockResolvedValueOnce([{ not_backdated: true, after_start: true }])
      .mockResolvedValueOnce([{ id: open.id }])
      .mockResolvedValueOnce([closed]);

    await expect(harness.service.release(harness.dataSource, actorUserId, '00125', {}))
      .resolves.toEqual(closed);
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: badgeId, action: 'badge.release', before: open, after: closed }),
    );
  });

  it('closes all worker badge rows at the same database time and audits each close', async () => {
    const first = assignment({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', badge_number: '125' });
    const second = assignment({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', badge_number: 'A-125' });
    harness.manager.query
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([{ not_backdated: true, after_start: true }])
      .mockResolvedValueOnce([{ id: first.id }])
      .mockResolvedValueOnce([{ ...first, valid_to: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ not_backdated: true, after_start: true }])
      .mockResolvedValueOnce([{ id: second.id }])
      .mockResolvedValueOnce([{ ...second, valid_to: '2026-09-26T01:00:00.000000Z' }]);

    await expect(harness.service.closeOpenAssignmentsForWorker(
      harness.manager as unknown as EntityManager,
      actorUserId,
      '18',
      '2026-09-26T01:00:00.000000Z',
    )).resolves.toHaveLength(2);

    expect(harness.manager.query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF history');
    expect(harness.manager.query.mock.calls[2]?.[1]).toEqual([first.id, '2026-09-26T01:00:00.000000Z']);
    expect(harness.manager.query.mock.calls[5]?.[1]).toEqual([second.id, '2026-09-26T01:00:00.000000Z']);
    expect(harness.auditService.append).toHaveBeenCalledTimes(2);
    expect(harness.auditService.append).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ action: 'badge.close', entityId: first.id }),
    );
  });

  it('maps PostgreSQL exclusion violations to a structured badge conflict', async () => {
    const overlap = Object.assign(new Error('postgres detail'), {
      driverError: { code: '23P01', constraint: 'ex_worker_badge_history_no_overlap' },
    });
    harness.manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ value: '2026-09-26T01:00:00.000000Z' }])
      .mockResolvedValueOnce([{ id: '18', full_name: 'Nodira', status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ not_backdated: true, after_start: true }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(overlap);

    await expect(harness.service.assign(harness.dataSource, actorUserId, '18', {
      badge_number: '125',
    })).rejects.toMatchObject({ response: { code: 'CONFLICT_BADGE_ASSIGNMENT' } });
  });
});
