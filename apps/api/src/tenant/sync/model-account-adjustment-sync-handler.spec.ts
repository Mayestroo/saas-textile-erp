import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@textile/sync-protocol';
import type { ModelAccountAdjustmentsService } from '../patta-sheets/model-account-adjustments.service.js';
import type { SyncApplyContext } from './sync-entity-handler.js';
import { ModelAccountAdjustmentSyncHandler } from './model-account-adjustment-sync-handler.js';

const adjustmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const modelId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workerId = '17';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deviceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const context: SyncApplyContext = {
  actorUserId: actorId,
  companyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  validatedDeviceId: deviceId,
  protocolVersion: 3,
  timezone: 'Asia/Tashkent'
};

function event(operation: 'CREATE' | 'UPDATE' = 'CREATE'): SyncEvent {
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    entity_type: 'model_account_adjustment',
    entity_id: adjustmentId,
    operation,
    base_version: operation === 'CREATE' ? '0' : '1',
    client_created_at: '2026-09-28T10:00:00.000Z',
    occurred_at: '2026-09-28T10:00:00.000Z',
    reference_cursor: '10',
    payload: {
      model_id: modelId,
      model_operation_id: operationId,
      worker_id: workerId,
      quantity: 20,
      unit_price_snapshot: '21.50',
      entered_at: '2026-09-28T10:00:00.000Z',
      business_date: '2026-09-28',
      deleted_at: null,
      deleted_by: null,
      depends_on_event_ids: []
    }
  };
}

const projection = {
  id: adjustmentId,
  model_id: modelId,
  model_operation_id: operationId,
  worker_id: workerId,
  quantity: 20,
  unit_price_snapshot: '21.50',
  entered_at: '2026-09-28T10:00:00.000000Z',
  business_date: '2026-09-28',
  version: '1',
  created_by: actorId,
  created_device_id: deviceId,
  created_at: '2026-09-28T10:00:00.000000Z',
  updated_at: '2026-09-28T10:00:00.000000Z',
  deleted_at: null,
  deleted_by: null
};

describe('ModelAccountAdjustmentSyncHandler', () => {
  it('applies a V3 CREATE with the server-validated tenant permission and projection', async () => {
    const create = vi.fn(async () => projection);
    const handler = new ModelAccountAdjustmentSyncHandler({
      createInTransaction: create,
      latestChangeSequence: vi.fn(async () => '22')
    } as unknown as ModelAccountAdjustmentsService);
    const manager = { query: vi.fn(async () => [{ allowed: true }]) } as unknown as EntityManager;

    await expect(handler.apply(manager, context, event())).resolves.toMatchObject({
      entityVersion: '1',
      changeSequence: '22',
      projection: {
        projection_version: 3,
        entity_type: 'model_account_adjustments',
        data: { quantity: 20, unit_price_snapshot: '21.50' }
      }
    });
    expect(create).toHaveBeenCalledWith(manager, actorId, deviceId, 'Asia/Tashkent', adjustmentId,
      expect.objectContaining({ model_id: modelId, quantity: 20 }));
  });

  it('fails closed when the manual manage permission is missing', async () => {
    const create = vi.fn();
    const handler = new ModelAccountAdjustmentSyncHandler({ createInTransaction: create } as unknown as ModelAccountAdjustmentsService);
    const manager = { query: vi.fn(async () => [{ allowed: false }]) } as unknown as EntityManager;

    await expect(handler.apply(manager, context, event()))
      .rejects.toBeInstanceOf(ConflictException);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects manual adjustment events from a V2 client', async () => {
    const handler = new ModelAccountAdjustmentSyncHandler({} as unknown as ModelAccountAdjustmentsService);
    await expect(handler.apply({ query: vi.fn() } as unknown as EntityManager,
      { ...context, protocolVersion: 2 }, event())).rejects.toMatchObject({
      response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' }
    });
  });
});
