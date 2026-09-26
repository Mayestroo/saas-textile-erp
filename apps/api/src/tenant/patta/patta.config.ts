import { Module } from '@nestjs/common';

export const PATTA_CONFIGURATION = Symbol('PATTA_CONFIGURATION');

export interface PattaConfiguration {
  numberStart: bigint;
  blockSize: bigint;
  maxActiveBlocksPerDevice: number;
  maxBatchSize: number;
}

const DEFAULTS = {
  PATTA_NUMBER_START: '1',
  PATTA_NUMBER_BLOCK_SIZE: '1000',
  PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE: '2',
  PATTA_MAX_BATCH_SIZE: '100',
} as const;

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const POSITIVE_DECIMAL_PATTERN = /^[0-9]+$/;

function environmentValue(
  config: Record<string, unknown>,
  key: keyof typeof DEFAULTS,
): string {
  const raw = config[key] ?? DEFAULTS[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${key} must be a positive integer`);
  }
  return raw.trim();
}

function positiveBigInt(config: Record<string, unknown>, key: keyof Pick<
  typeof DEFAULTS,
  'PATTA_NUMBER_START' | 'PATTA_NUMBER_BLOCK_SIZE'
>): bigint {
  const raw = environmentValue(config, key);
  if (!POSITIVE_DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${key} must be a positive decimal integer`);
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n || parsed > MAX_POSTGRES_BIGINT) {
    throw new Error(`${key} must be between 1 and PostgreSQL BIGINT maximum`);
  }
  return parsed;
}

function positiveSafeInteger(config: Record<string, unknown>, key: keyof Pick<
  typeof DEFAULTS,
  'PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE' | 'PATTA_MAX_BATCH_SIZE'
>): number {
  const raw = environmentValue(config, key);
  if (!POSITIVE_DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  return parsed;
}

export function loadPattaConfiguration(config: Record<string, unknown>): PattaConfiguration {
  return {
    numberStart: positiveBigInt(config, 'PATTA_NUMBER_START'),
    blockSize: positiveBigInt(config, 'PATTA_NUMBER_BLOCK_SIZE'),
    maxActiveBlocksPerDevice: positiveSafeInteger(config, 'PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE'),
    maxBatchSize: positiveSafeInteger(config, 'PATTA_MAX_BATCH_SIZE'),
  };
}

@Module({
  providers: [
    {
      provide: PATTA_CONFIGURATION,
      useFactory: (): PattaConfiguration => loadPattaConfiguration(process.env),
    },
  ],
  exports: [PATTA_CONFIGURATION],
})
export class PattaConfigurationModule {}
