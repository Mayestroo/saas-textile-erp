import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_CHANGE_LOCK_KEY,
  SyncChangeRecorder,
} from './sync-change-recorder.js';

describe('SyncChangeRecorder', () => {
  it('takes the shared transaction lock before allocating the sequence', async () => {
    const sequenceId = '9007199254740993';
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('INSERT INTO "server_change_log"')) {
        return [{ sequence_id: sequenceId }];
      }
      return [];
    });
    const recorder = new SyncChangeRecorder();

    await expect(
      recorder.record({ query } as unknown as EntityManager, {
        entityType: 'models',
        entityId: '11111111-1111-4111-8111-111111111111',
        operation: 'UPSERT',
        entityVersion: '2',
        projectionVersion: 1,
        payload: {
          projection_version: 1,
          entity_type: 'models',
          entity_id: '11111111-1111-4111-8111-111111111111',
          data: { id: '11111111-1111-4111-8111-111111111111', version: '2' },
        },
      }),
    ).resolves.toEqual({ sequenceId });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[0]?.[1]).toEqual([SYNC_CHANGE_LOCK_KEY]);
    expect(query.mock.calls[1]?.[0]).toContain(
      'INSERT INTO "server_change_log"',
    );
    expect(query.mock.calls[1]?.[1]?.[4]).toBe(1);
    expect(query.mock.calls[1]?.[1]?.[5]).toBe(
      JSON.stringify({
        projection_version: 1,
        entity_type: 'models',
        entity_id: '11111111-1111-4111-8111-111111111111',
        data: { id: '11111111-1111-4111-8111-111111111111', version: '2' },
      }),
    );
  });

  it('rejects invalid projections before acquiring the lock', async () => {
    const query = vi.fn(async () => []);
    const recorder = new SyncChangeRecorder();

    await expect(
      recorder.record({ query } as unknown as EntityManager, {
        entityType: 'models',
        entityId: 'model-1',
        operation: 'UPSERT',
        entityVersion: '1',
        projectionVersion: 1,
        payload: null,
      }),
    ).rejects.toThrow('UPSERT change requires a projection');
    expect(query).not.toHaveBeenCalled();
  });

  it('fails when PostgreSQL does not return the allocated sequence', async () => {
    const query = vi.fn(async () => []);
    const recorder = new SyncChangeRecorder();

    await expect(
      recorder.record({ query } as unknown as EntityManager, {
        entityType: 'models',
        entityId: 'model-1',
        operation: 'DELETE',
        entityVersion: '2',
        projectionVersion: 1,
        payload: null,
      }),
    ).rejects.toThrow('did not return a change sequence');
  });
});
