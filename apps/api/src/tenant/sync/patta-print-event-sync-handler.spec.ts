import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@textile/sync-protocol';
import { PattaPrintBatchesService } from '../patta/patta-print-batches.service.js';
import type { SyncApplyContext } from './sync-entity-handler.js';
import { PattaPrintEventSyncHandler } from './patta-print-event-sync-handler.js';

const event: SyncEvent = {
  event_id: '11111111-1111-4111-8111-111111111111',
  entity_type: 'patta_print_event',
  entity_id: '22222222-2222-4222-8222-222222222222',
  operation: 'CREATE',
  base_version: '0',
  client_created_at: '2026-09-28T10:00:00.000Z',
  occurred_at: '2026-09-28T10:00:00.000Z',
  reference_cursor: '24',
  payload: {
    batch_id: '33333333-3333-4333-8333-333333333333',
    revision: 1,
    kind: 'INITIAL',
    outcome: 'SUCCEEDED',
    device_id: '44444444-4444-4444-8444-444444444444',
  },
};

describe('PattaPrintEventSyncHandler', () => {
  it('supports only print event CREATE', () => {
    const handler = new PattaPrintEventSyncHandler({} as PattaPrintBatchesService);
    expect(handler.supports('patta_print_event', 'CREATE')).toBe(true);
    expect(handler.supports('patta_print_event', 'UPDATE')).toBe(false);
  });

  it('preserves the print-event UUID and emits its v2 projection/change sequence', async () => {
    const projection = {
      projection_version: 2 as const,
      entity_type: 'patta_print_events' as const,
      entity_id: event.entity_id!,
      entity_version: null,
      data: {
        id: event.entity_id!,
        batch_id: '33333333-3333-4333-8333-333333333333',
        revision: 1,
        kind: 'INITIAL' as const,
        outcome: 'SUCCEEDED' as const,
        actor_user_id: '55555555-5555-4555-8555-555555555555',
        device_id: '44444444-4444-4444-8444-444444444444',
        created_at: '2026-09-28T10:00:00.000000Z',
        printed_at: '2026-09-28T10:00:00.000000Z',
      },
    };
    const register = vi.fn(async () => ({ projection, changeSequence: '25' }));
    const handler = new PattaPrintEventSyncHandler({ registerOfflinePrintEvent: register } as unknown as PattaPrintBatchesService);
    const manager = { query: vi.fn() } as unknown as EntityManager;
    const context: SyncApplyContext = {
      actorUserId: '55555555-5555-4555-8555-555555555555',
      companyId: '66666666-6666-4666-8666-666666666666',
      validatedDeviceId: '44444444-4444-4444-8444-444444444444',
      protocolVersion: 2,
    };

    await expect(handler.apply(manager, context, event)).resolves.toEqual({
      entityVersion: null,
      projection,
      changeSequence: '25',
    });
    expect(register).toHaveBeenCalledWith(manager, context.actorUserId, context.validatedDeviceId, event);
    await expect(handler.apply(manager, { ...context, protocolVersion: 1 }, event))
      .rejects.toBeInstanceOf(ConflictException);
  });
});
