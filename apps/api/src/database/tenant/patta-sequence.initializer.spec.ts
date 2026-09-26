import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { PattaSequenceInitializer } from './patta-sequence.initializer.js';

describe('PattaSequenceInitializer', () => {
  it('inserts the configured start only when the singleton row is absent', async () => {
    const query = vi.fn(async () => []);
    const dataSource = { query } as unknown as DataSource;

    await new PattaSequenceInitializer().initialize(dataSource, 9007199254740993n);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(query.mock.calls[0]?.[1]).toEqual(['9007199254740993']);
  });

  it('uses an idempotent insert under concurrent initialization attempts', async () => {
    const query = vi.fn(async () => []);
    const dataSource = { query } as unknown as DataSource;
    const initializer = new PattaSequenceInitializer();

    await Promise.all([
      initializer.initialize(dataSource, 1000n),
      initializer.initialize(dataSource, 2000n),
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => String(sql).includes('DO NOTHING'))).toBe(true);
  });

  it('rejects a start outside PostgreSQL BIGINT before issuing SQL', async () => {
    const query = vi.fn(async () => []);
    const dataSource = { query } as unknown as DataSource;
    await expect(new PattaSequenceInitializer().initialize(
      dataSource,
      9_223_372_036_854_775_808n,
    )).rejects.toThrow(/PostgreSQL BIGINT/);
    expect(query).not.toHaveBeenCalled();
  });
});
