import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@textile/sync-protocol';
import type { OperationsService } from '../operations/operations.service.js';
import type { SyncApplyContext } from './sync-entity-handler.js';
import { ModelOperationSyncHandler } from './model-operation-sync-handler.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const modelId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const deviceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const event: SyncEvent = {
  event_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  entity_type: 'model_operation',
  entity_id: operationId,
  operation: 'CREATE',
  base_version: '0',
  client_created_at: '2026-09-28T10:00:00.000Z',
  occurred_at: '2026-09-28T10:00:00.000Z',
  reference_cursor: '9',
  payload: {
    id: operationId,
    model_id: modelId,
    name: 'Custom tikish',
    initial_price: '37.00',
    sort_order: 4,
    effective_from: '2026-09-28T10:00:00.000Z',
  },
};

describe('ModelOperationSyncHandler', () => {
  it('persists the client UUID and entry-effective initial price through OperationsService', async () => {
    const operation = {
      id: operationId, model_id: modelId, name: 'Custom tikish', price: '37.00',
      sort_order: 4, status: 'ACTIVE' as const, version: '1',
      created_at: '2026-09-28T10:00:00.000000Z', updated_at: '2026-09-28T10:00:00.000000Z',
    };
    const create = vi.fn(async () => operation);
    const query = vi.fn(async () => [{ sequence_id: '81' }]);
    const handler = new ModelOperationSyncHandler({
      createForPattaSheetInTransaction: create,
    } as unknown as OperationsService);
    const manager = { query } as unknown as EntityManager;
    const context: SyncApplyContext = {
      actorUserId: actorId, companyId: '99999999-9999-4999-8999-999999999999',
      validatedDeviceId: deviceId, protocolVersion: 2,
    };

    await expect(handler.apply(manager, context, event)).resolves.toMatchObject({
      entityVersion: '1', changeSequence: '81',
      projection: { projection_version: 1, entity_type: 'model_operations', entity_id: operationId },
    });
    expect(create).toHaveBeenCalledWith(manager, modelId, actorId, deviceId, expect.objectContaining({
      id: operationId, effective_from: '2026-09-28T10:00:00.000Z',
    }));
  });

  it('rejects a server-canonical operation UUID different from the offline stable ID', async () => {
    const handler = new ModelOperationSyncHandler({
      createForPattaSheetInTransaction: vi.fn(async () => ({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', model_id: modelId, name: 'Custom tikish',
        price: '37.00', sort_order: 4, status: 'ACTIVE', version: '1',
        created_at: '2026-09-28T10:00:00.000000Z', updated_at: '2026-09-28T10:00:00.000000Z',
      })),
    } as unknown as OperationsService);
    const manager = { query: vi.fn(async () => [{ sequence_id: '81' }]) } as unknown as EntityManager;
    const context: SyncApplyContext = {
      actorUserId: actorId, companyId: '99999999-9999-4999-8999-999999999999',
      validatedDeviceId: deviceId, protocolVersion: 2,
    };

    await expect(handler.apply(manager, context, event)).rejects.toMatchObject({
      response: { code: 'MODEL_OPERATION_CANONICAL_NAME_CONFLICT' },
    });
  });
});
