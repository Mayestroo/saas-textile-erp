import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const blockService = {
  assertAllocatedNumber: vi.fn(async () => undefined),
} as unknown as PattaNumberBlocksService;

describe('PattaOfflineRegistrationValidator', () => {
  it('delegates number/device membership to the block service without status filtering', async () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const dataSource = {} as unknown as DataSource;
    const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const blockId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    await expect(validator.assertBlockMembership(dataSource, deviceId, blockId, 9007199254740993n))
      .resolves.toBeUndefined();
    expect(blockService.assertAllocatedNumber).toHaveBeenCalledWith(
      dataSource,
      deviceId,
      blockId,
      9007199254740993n,
    );
  });

  it('checks the canonical Patta business key while leaving the database unique constraint authoritative', async () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const query = vi.fn(async () => [{ exists: false }]);
    const dataSource = { query } as unknown as DataSource;
    await expect(validator.assertBusinessKeyAvailable(dataSource, ' 25/09-3 ', 1057n))
      .resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT EXISTS'), ['25/09-3', '1057']);

    query.mockImplementationOnce(async () => [{ exists: true }]);
    await expect(validator.assertBusinessKeyAvailable(dataSource, '25/09-3', 1057n))
      .rejects.toMatchObject({ response: { code: 'PATTA_ALREADY_EXISTS' } });
  });

  it('normalizes structural snapshot values and derives ish_soni', () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    expect(validator.validateSnapshotPayload({
      ish_soni: 1,
      operations: [{
        operation_id: operationId,
        operation_name_snapshot: '  Yeng\t tikish ',
        unit_price_snapshot: '1000',
        sort_order: 0,
      }],
    })).toEqual({
      ish_soni: 1,
      operations: [{
        operation_id: operationId,
        operation_name_snapshot: 'Yeng tikish',
        unit_price_snapshot: '1000.00',
        sort_order: 0,
      }],
    });
  });

  it('rejects duplicate operations, invalid price/order, and an inconsistent count', () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const operation = {
      operation_id: operationId,
      operation_name_snapshot: 'Tikish',
      unit_price_snapshot: '1.00',
      sort_order: 0,
    };
    expect(() => validator.validateSnapshotPayload({
      operations: [operation, operation],
    })).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'INVALID_OFFLINE_PATTA_SNAPSHOT' }) }));
    expect(() => validator.validateSnapshotPayload({
      operations: [{ ...operation, unit_price_snapshot: '-1.00' }],
    })).toThrowError();
    expect(() => validator.validateSnapshotPayload({
      operations: [{ ...operation, sort_order: -1 }],
    })).toThrowError();
    expect(() => validator.validateSnapshotPayload({ ish_soni: 2, operations: [operation] }))
      .toThrowError();
    expect(() => validator.validateSnapshotPayload(null)).toThrowError();
    expect(() => validator.validateSnapshotPayload({ operations: [null] })).toThrowError();
  });
});
