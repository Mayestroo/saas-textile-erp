import { describe, expect, it, vi } from 'vitest';
import type { DataSource, EntityManager } from 'typeorm';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pattaId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const blockId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const modelId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const snapshotId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
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

  it('keeps product quantity independent from the operation snapshot count', () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    expect(validator.validateSnapshotPayload({
      ish_soni: 125,
      operations: [{
        id: snapshotId,
        operation_id: operationId,
        operation_name_snapshot: '  Yeng\t tikish ',
        unit_price_snapshot: '1000',
        sort_order: 0,
      }],
    })).toEqual({
      ish_soni: 125,
      operation_count: 1,
      operations: [{
        id: snapshotId,
        operation_id: operationId,
        operation_name_snapshot: 'Yeng tikish',
        unit_price_snapshot: '1000.00',
        sort_order: 0,
      }],
    });
  });

  it('rejects duplicate operations, invalid price/order, and missing product quantity', () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const operation = {
      id: snapshotId,
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
    expect(validator.validateSnapshotPayload({ ish_soni: 125, operations: [operation] }))
      .toMatchObject({ ish_soni: 125, operation_count: 1 });
    expect(() => validator.validateSnapshotPayload({ operations: [operation] }))
      .toThrowError();
    expect(() => validator.validateSnapshotPayload(null)).toThrowError();
    expect(() => validator.validateSnapshotPayload({ operations: [null] })).toThrowError();
  });

  it('validates and canonicalizes a complete offline Patta registration while preserving supplied IDs', () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const event = {
      event_id: '11111111-1111-4111-8111-111111111111',
      entity_type: 'patta',
      entity_id: pattaId,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: '2026-09-26T10:00:00.000Z',
      occurred_at: '2026-09-26T10:00:00.000Z',
      reference_cursor: '12',
      payload: {
        partiya_number: ' A-1 ',
        patta_number: '1001',
        model_id: modelId,
        model_name_snapshot: ' Atlas model ',
        template_id: null,
        konveyer_snapshot: ' 1-konveyer ',
        razmer: null,
        rang: null,
        block_id: blockId,
        reference_versions: { model: '1', template: null, operations: { [operationId]: '1' } },
        ish_soni: 125,
        operations: [{
          id: snapshotId,
          operation_id: operationId,
          operation_name_snapshot: ' Yeng\t tikish ',
          unit_price_snapshot: '10',
          sort_order: 0,
        }],
      },
    };

    expect(validator.validateRegistration(event)).toEqual({
      id: pattaId,
      partiya_number: 'A-1',
      patta_number: 1001n,
      model_id: modelId,
      model_name_snapshot: 'Atlas model',
      template_id: null,
      konveyer_snapshot: '1-konveyer',
      razmer: null,
      rang: null,
      block_id: blockId,
      template_overrides: null,
      base_version: '0',
      client_created_at: '2026-09-26T10:00:00.000Z',
      occurred_at: '2026-09-26T10:00:00.000Z',
      reference_cursor: '12',
      reference_versions: { model: '1', template: null, operations: { [operationId]: '1' } },
      ish_soni: 125,
      operation_count: 1,
      operations: [{
        id: snapshotId,
        operation_id: operationId,
        operation_name_snapshot: 'Yeng tikish',
        unit_price_snapshot: '10.00',
        sort_order: 0,
      }],
    });

    expect(() => validator.validateRegistration({
      ...event,
      payload: { ...event.payload, ish_soni: undefined },
    })).toThrowError(expect.objectContaining({
      response: expect.objectContaining({ code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' }),
    }));

    const templateId = '99999999-9999-4999-8999-999999999999';
    expect(validator.validateRegistration({
      ...event,
      payload: {
        ...event.payload,
        template_id: templateId,
        konveyer_snapshot: '2-konveyer',
        template_overrides: { konveyer: ' 2-konveyer ', razmer: null },
        reference_versions: {
          ...event.payload.reference_versions,
          template: '2',
        },
      },
    })).toMatchObject({
      template_id: templateId,
      template_overrides: { konveyer: '2-konveyer', razmer: null },
    });
  });

  it('rejects client Patta identity/version and duplicate snapshot identities', () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const event = {
      event_id: '11111111-1111-4111-8111-111111111111',
      entity_type: 'patta',
      entity_id: pattaId,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: '2026-09-26T10:00:00.000Z',
      occurred_at: '2026-09-26T10:00:00.000Z',
      reference_cursor: '12',
      payload: {
        partiya_number: 'A-1', patta_number: '1001', model_id: modelId,
        model_name_snapshot: 'Atlas', template_id: null, konveyer_snapshot: '1',
        razmer: null, rang: null, block_id: blockId,
        ish_soni: 125,
        reference_versions: { model: '1', template: null, operations: { [operationId]: '1' } },
        operations: [
          { id: snapshotId, operation_id: operationId, operation_name_snapshot: 'Tikish', unit_price_snapshot: '10.00', sort_order: 0 },
          { id: snapshotId, operation_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', operation_name_snapshot: 'Kesish', unit_price_snapshot: '2.00', sort_order: 1 },
        ],
      },
    };

    expect(() => validator.validateRegistration({ ...event, base_version: '1' }))
      .toThrowError(expect.objectContaining({
        response: expect.objectContaining({ code: 'INVALID_OFFLINE_PATTA_EVENT' }),
      }));
    expect(() => validator.validateRegistration(event)).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'INVALID_OFFLINE_PATTA_SNAPSHOT' }),
      }),
    );
  });

  it('checks an existing client Patta UUID before the database primary key insert race', async () => {
    const validator = new PattaOfflineRegistrationValidator(blockService);
    const query = vi.fn(async () => [{ exists: false }]);
    const manager = { query } as unknown as EntityManager;

    await expect(validator.assertPattaIdAvailable(manager, pattaId)).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[1]).toEqual([pattaId]);
    query.mockImplementationOnce(async () => [{ exists: true }]);
    await expect(validator.assertPattaIdAvailable(manager, pattaId))
      .rejects.toMatchObject({ response: { code: 'PATTA_ALREADY_EXISTS' } });
  });
});
