import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { BadgeResolutionService } from './badge-resolution.service.js';

const resolved = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  badge_number: '00125',
  worker_id: '18',
  full_name: 'Abdullayeva Nodira',
  valid_from: '2026-01-01T00:00:00.000000Z',
  valid_to: '2026-05-16T00:00:00.000000Z',
};

describe('BadgeResolutionService', () => {
  it('resolves by worker_id at the supplied half-open interval timestamp', async () => {
    const query = vi.fn(async () => [resolved]);
    const dataSource = { query } as unknown as DataSource;
    const service = new BadgeResolutionService();

    await expect(service.resolve(dataSource, ' 00125 ', '2026-05-15T23:59:59.999Z'))
      .resolves.toEqual({
        worker_id: '18',
        full_name: 'Abdullayeva Nodira',
        assignment: {
          id: resolved.id,
          badge_number: '00125',
          valid_from: resolved.valid_from,
          valid_to: resolved.valid_to,
        },
      });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('worker."id" = history."worker_id"'), [
      '00125',
      '2026-05-15T23:59:59.999Z',
    ]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('history."valid_from" <= $2::timestamptz');
    expect(sql).toContain('$2::timestamptz < history."valid_to"');
    expect(sql).not.toContain('GROUP BY worker."full_name"');
  });

  it('resolves current ownership using the database transaction timestamp', async () => {
    const query = vi.fn(async () => [resolved]);
    const dataSource = { query } as unknown as DataSource;

    await expect(new BadgeResolutionService().resolveCurrent(dataSource, '00125'))
      .resolves.toMatchObject({ worker_id: '18', assignment: { badge_number: '00125' } });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('history."valid_from" <= transaction_timestamp()'),
      ['00125'],
    );
  });

  it('rejects missing history and blank badge values', async () => {
    const query = vi.fn(async () => []);
    const dataSource = { query } as unknown as DataSource;
    const service = new BadgeResolutionService();

    await expect(service.resolve(dataSource, '125', '2026-06-01T00:00:00Z'))
      .rejects.toMatchObject({ response: { code: 'BADGE_ASSIGNMENT_NOT_FOUND' } });
    await expect(service.resolve(dataSource, '  ', '2026-06-01T00:00:00Z'))
      .rejects.toMatchObject({ response: { code: 'INVALID_BADGE_NUMBER' } });
  });

  it('rejects invalid timestamps instead of resolving an arbitrary interval', async () => {
    const query = vi.fn(async () => [resolved]);
    const service = new BadgeResolutionService();

    await expect(service.resolve({ query } as unknown as DataSource, '125', 'yesterday'))
      .rejects.toMatchObject({ response: { code: 'INVALID_BADGE_TIMESTAMP' } });
    expect(query).not.toHaveBeenCalled();
  });
});
