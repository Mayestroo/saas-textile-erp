import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@textile/sync-protocol';
import { PattaService } from '../patta/patta.service.js';
import type { SyncApplyContext } from './sync-entity-handler.js';
import { PattaSyncHandler } from './patta-sync-handler.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const pattaId = '22222222-2222-4222-8222-222222222222';
const actorUserId = '33333333-3333-4333-8333-333333333333';
const companyId = '44444444-4444-4444-8444-444444444444';
const deviceId = '55555555-5555-4555-8555-555555555555';

const event: SyncEvent = {
  event_id: eventId,
  entity_type: 'patta',
  entity_id: pattaId,
  operation: 'CREATE',
  base_version: '0',
  client_created_at: '2026-09-26T10:00:00.000Z',
  occurred_at: '2026-09-26T10:00:00.000Z',
  reference_cursor: '12',
  payload: { block_id: '66666666-6666-4666-8666-666666666666' },
};

const registered = {
  record: {
    id: pattaId,
    partiya_number: 'A-1',
    patta_number: '1000',
    model_id: '77777777-7777-4777-8777-777777777777',
    model_name_snapshot: 'Atlas',
    template_id: null,
    konveyer_snapshot: '1',
    razmer: null,
    rang: null,
    ish_soni: 1,
    created_at: '2026-09-26T10:00:00.000000Z',
    operations: [],
  },
  version: '1',
  changeSequence: '12841',
  projection: {
    projection_version: 1 as const,
    entity_type: 'patta_hisob' as const,
    entity_id: pattaId,
    entity_version: '1',
    data: {
      id: pattaId,
      partiya_number: 'A-1',
      patta_number: '1000',
      model_id: '77777777-7777-4777-8777-777777777777',
      model_name_snapshot: 'Atlas',
      template_id: null,
      konveyer_snapshot: '1',
      razmer: null,
      rang: null,
      ish_soni: 1,
      created_device_id: deviceId,
      created_from_block_id: '66666666-6666-4666-8666-666666666666',
      created_at: '2026-09-26T10:00:00.000000Z',
      client_created_at: event.client_created_at,
      occurred_at: event.occurred_at,
    },
  },
};

describe('PattaSyncHandler', () => {
  it('supports only Patta CREATE registration', () => {
    const handler = new PattaSyncHandler({} as PattaService);
    expect(handler.supports('patta', 'CREATE')).toBe(true);
    expect(handler.supports('patta', 'UPDATE')).toBe(false);
    expect(handler.supports('workers', 'CREATE')).toBe(false);
  });

  it('returns the authoritative preserved-ID projection and change sequence', async () => {
    const registerOffline = vi.fn(async () => registered);
    const handler = new PattaSyncHandler({ registerOffline } as unknown as PattaService);
    const manager = { query: vi.fn() } as unknown as EntityManager;
    const context: SyncApplyContext = { actorUserId, companyId, validatedDeviceId: deviceId };

    await expect(handler.apply(manager, context, event)).resolves.toEqual({
      entityVersion: '1',
      projection: registered.projection,
      changeSequence: '12841',
    });
    expect(registerOffline).toHaveBeenCalledWith(manager, actorUserId, deviceId, event);
  });
});
