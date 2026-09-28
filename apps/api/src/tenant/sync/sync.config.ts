export const SYNC_CONFIGURATION = Symbol('SYNC_CONFIGURATION');

export interface SyncConfiguration {
  pushMaxEvents: number;
  pullMaxChanges: number;
  bootstrapPageSize: number;
  bootstrapSessionTtlMinutes: number;
  bootstrapMaxActiveSessionsPerDevice: number;
  bootstrapCleanupBatchSize: number;
  bootstrapTerminalRetentionHours: number;
  maxFutureSkewSeconds: number;
}

const DEFAULTS = {
  SYNC_PUSH_MAX_EVENTS: '100',
  SYNC_PULL_MAX_CHANGES: '500',
  SYNC_BOOTSTRAP_PAGE_SIZE: '250',
  SYNC_BOOTSTRAP_SESSION_TTL_MINUTES: '30',
  SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE: '1',
  SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE: '100',
  SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS: '24',
  SYNC_MAX_FUTURE_SKEW_SECONDS: '300',
} as const;

type SyncSetting = keyof typeof DEFAULTS;

const LIMITS: Readonly<Record<SyncSetting, number>> = {
  SYNC_PUSH_MAX_EVENTS: 1_000,
  SYNC_PULL_MAX_CHANGES: 5_000,
  SYNC_BOOTSTRAP_PAGE_SIZE: 500,
  SYNC_BOOTSTRAP_SESSION_TTL_MINUTES: 1_440,
  SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE: 1,
  SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE: 1_000,
  SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS: 168,
  SYNC_MAX_FUTURE_SKEW_SECONDS: 300,
};

function positiveInteger(
  config: Record<string, unknown>,
  key: SyncSetting,
): number {
  const raw = config[key] ?? DEFAULTS[key];
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${key} must be a positive integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > LIMITS[key]) {
    throw new Error(`${key} exceeds its supported range`);
  }
  return value;
}

export function loadSyncConfiguration(
  config: Record<string, unknown>,
): SyncConfiguration {
  return {
    pushMaxEvents: positiveInteger(config, 'SYNC_PUSH_MAX_EVENTS'),
    pullMaxChanges: positiveInteger(config, 'SYNC_PULL_MAX_CHANGES'),
    bootstrapPageSize: positiveInteger(config, 'SYNC_BOOTSTRAP_PAGE_SIZE'),
    bootstrapSessionTtlMinutes: positiveInteger(config, 'SYNC_BOOTSTRAP_SESSION_TTL_MINUTES'),
    bootstrapMaxActiveSessionsPerDevice: positiveInteger(
      config,
      'SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE',
    ),
    bootstrapCleanupBatchSize: positiveInteger(config, 'SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE'),
    bootstrapTerminalRetentionHours: positiveInteger(
      config,
      'SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS',
    ),
    maxFutureSkewSeconds: positiveInteger(config, 'SYNC_MAX_FUTURE_SKEW_SECONDS'),
  };
}
