import { describe, expect, it } from 'vitest';
import { loadSyncConfiguration } from './sync.config.js';

describe('sync configuration', () => {
  it('uses bounded sync defaults', () => {
    expect(loadSyncConfiguration({})).toEqual({
      pushMaxEvents: 100,
      pullMaxChanges: 500,
      bootstrapPageSize: 250,
      bootstrapSessionTtlMinutes: 30,
      bootstrapMaxActiveSessionsPerDevice: 1,
      bootstrapCleanupBatchSize: 100,
      bootstrapTerminalRetentionHours: 24,
      maxFutureSkewSeconds: 300,
    });
  });

  it('loads positive integer overrides and caps the page size', () => {
    expect(loadSyncConfiguration({
      SYNC_PUSH_MAX_EVENTS: '80',
      SYNC_PULL_MAX_CHANGES: '400',
      SYNC_BOOTSTRAP_PAGE_SIZE: '500',
      SYNC_BOOTSTRAP_SESSION_TTL_MINUTES: '60',
      SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE: '1',
      SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE: '50',
      SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS: '48',
      SYNC_MAX_FUTURE_SKEW_SECONDS: '300',
    })).toEqual({
      pushMaxEvents: 80,
      pullMaxChanges: 400,
      bootstrapPageSize: 500,
      bootstrapSessionTtlMinutes: 60,
      bootstrapMaxActiveSessionsPerDevice: 1,
      bootstrapCleanupBatchSize: 50,
      bootstrapTerminalRetentionHours: 48,
      maxFutureSkewSeconds: 300,
    });
  });

  it.each([
    ['SYNC_PUSH_MAX_EVENTS', ' '],
    ['SYNC_PUSH_MAX_EVENTS', '0'],
    ['SYNC_PULL_MAX_CHANGES', '-1'],
    ['SYNC_BOOTSTRAP_PAGE_SIZE', '501'],
    ['SYNC_BOOTSTRAP_PAGE_SIZE', '1.5'],
    ['SYNC_BOOTSTRAP_SESSION_TTL_MINUTES', '1e2'],
    ['SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE', '9007199254740992'],
    ['SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE', '2'],
    ['SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE', '2.5'],
    ['SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE', '1001'],
    ['SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS', 'NaN'],
    ['SYNC_MAX_FUTURE_SKEW_SECONDS', '-5'],
    ['SYNC_MAX_FUTURE_SKEW_SECONDS', '301'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadSyncConfiguration({ [key]: value })).toThrow(key);
  });

  it('does not echo an invalid configuration value in its error', () => {
    let error: unknown;
    try {
      loadSyncConfiguration({ SYNC_PUSH_MAX_EVENTS: 'top-secret-invalid-value' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('SYNC_PUSH_MAX_EVENTS');
    expect(message).not.toContain('top-secret-invalid-value');
  });
});
