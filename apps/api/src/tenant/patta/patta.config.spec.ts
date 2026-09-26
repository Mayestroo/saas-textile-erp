import { describe, expect, it } from 'vitest';
import { loadPattaConfiguration } from './patta.config.js';

describe('Patta configuration', () => {
  it('uses validated defaults', () => {
    expect(loadPattaConfiguration({})).toEqual({
      numberStart: 1n,
      blockSize: 1000n,
      maxActiveBlocksPerDevice: 2,
      maxBatchSize: 100,
    });
  });

  it('preserves BIGINT config values without Number conversion', () => {
    const config = loadPattaConfiguration({
      PATTA_NUMBER_START: '9007199254740993',
      PATTA_NUMBER_BLOCK_SIZE: '9007199254740994',
      PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE: '3',
      PATTA_MAX_BATCH_SIZE: '250',
    });

    expect(config).toEqual({
      numberStart: 9_007_199_254_740_993n,
      blockSize: 9_007_199_254_740_994n,
      maxActiveBlocksPerDevice: 3,
      maxBatchSize: 250,
    });
  });

  it.each([
    ['PATTA_NUMBER_START', '0'],
    ['PATTA_NUMBER_START', '-1'],
    ['PATTA_NUMBER_START', '1.5'],
    ['PATTA_NUMBER_START', '9223372036854775808'],
    ['PATTA_NUMBER_BLOCK_SIZE', '0'],
    ['PATTA_NUMBER_BLOCK_SIZE', '1e3'],
    ['PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE', '0'],
    ['PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE', '9007199254740992'],
    ['PATTA_MAX_BATCH_SIZE', '-1'],
    ['PATTA_MAX_BATCH_SIZE', '100.5'],
  ])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadPattaConfiguration({ [key]: value })).toThrow();
  });
});
