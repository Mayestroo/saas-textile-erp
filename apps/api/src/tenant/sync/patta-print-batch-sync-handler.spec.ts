import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@textile/sync-protocol';
import { PattaPrintBatchesService } from '../patta/patta-print-batches.service.js';
import type { SyncApplyContext } from './sync-entity-handler.js';
import { PattaPrintBatchSyncHandler } from './patta-print-batch-sync-handler.js';

const event: SyncEvent = {
  event_id: '11111111-1111-4111-8111-111111111111',
  entity_type: 'patta_print_batch',
  entity_id: '22222222-2222-4222-8222-222222222222',
  operation: 'CREATE',
  base_version: '0',
  client_created_at: '2026-09-28T10:00:00.000Z',
  occurred_at: '2026-09-28T10:00:00.000Z',
  reference_cursor: '7',
  payload: {},
};

const batch = {
  id: event.entity_id,
  model_id: '33333333-3333-4333-8333-333333333333',
  model_name_snapshot: 'Atlas',
  partiya_number: '1',
  partiya_block_id: '44444444-4444-4444-8444-444444444444',
  ish_soni: 125,
  rang: 'Qora',
  status: 'ACTIVE' as const,
  version: '1',
  revision: 1,
  corrected_from_batch_id: null,
  created_by: '55555555-5555-4555-8555-555555555555',
  created_device_id: '66666666-6666-4666-8666-666666666666',
  created_at: '2026-09-28T10:00:00.000Z',
  updated_at: '2026-09-28T10:00:00.000Z',
  printed_at: null,
  size_distribution: [],
  pattas: [],
};

describe('PattaPrintBatchSyncHandler', () => {
  it('accepts aggregate CREATE and UPDATE events only', () => {
    const handler = new PattaPrintBatchSyncHandler({} as PattaPrintBatchesService);
    expect(handler.supports('patta_print_batch', 'CREATE')).toBe(true);
    expect(handler.supports('patta_print_batch', 'UPDATE')).toBe(true);
    expect(handler.supports('patta', 'CREATE')).toBe(false);
  });

  it('requires protocol v2 and returns the preserved batch projection and sequence', async () => {
    const registerOffline = vi.fn(async () => ({ batch, changeSequence: '12841' }));
    const handler = new PattaPrintBatchSyncHandler({ registerOfflineBatch: registerOffline } as unknown as PattaPrintBatchesService);
    const manager = { query: vi.fn() } as unknown as EntityManager;
    const context: SyncApplyContext = {
      actorUserId: '55555555-5555-4555-8555-555555555555',
      companyId: '77777777-7777-4777-8777-777777777777',
      validatedDeviceId: '66666666-6666-4666-8666-666666666666',
      protocolVersion: 2,
    };

    await expect(handler.apply(manager, context, event)).resolves.toMatchObject({
      entityVersion: '1',
      changeSequence: '12841',
      projection: {
        projection_version: 2,
        entity_type: 'patta_print_batches',
        entity_id: batch.id,
        data: { ish_soni: 125, partiya_number: '1' },
      },
    });
    expect(registerOffline).toHaveBeenCalledWith(manager, context.actorUserId, context.validatedDeviceId, event);

    await expect(handler.apply(manager, { ...context, protocolVersion: 1 }, event))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('applies correction UPDATE events through the batch correction transaction', async () => {
    const correctionEvent: SyncEvent = { ...event, operation: 'UPDATE', base_version: '1' };
    const result = { batch: { ...batch, version: '2', revision: 2 }, changeSequence: '12842' };
    const correctOffline = vi.fn(async () => result);
    const handler = new PattaPrintBatchSyncHandler({
      registerOfflineBatchCorrection: correctOffline,
    } as unknown as PattaPrintBatchesService);
    const manager = { query: vi.fn() } as unknown as EntityManager;
    const context: SyncApplyContext = {
      actorUserId: '55555555-5555-4555-8555-555555555555',
      companyId: '77777777-7777-4777-8777-777777777777',
      validatedDeviceId: '66666666-6666-4666-8666-666666666666',
      protocolVersion: 2,
    };

    await expect(handler.apply(manager, context, correctionEvent)).resolves.toMatchObject({
      entityVersion: '2',
      changeSequence: '12842',
      projection: { entity_version: '2', data: { revision: 2 } },
    });
    expect(correctOffline).toHaveBeenCalledWith(manager, context.actorUserId, context.validatedDeviceId, correctionEvent);
  });
});
