import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '@textile/sync-protocol';
import type { PattaSheetsService } from '../patta-sheets/patta-sheets.service.js';
import type { SyncApplyContext } from './sync-entity-handler.js';
import { PattaSheetSyncHandler } from './patta-sheet-sync-handler.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sheetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pattaId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const deviceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const snapshotId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const workerId = '7';

const context: SyncApplyContext = {
  actorUserId: actorId,
  companyId: '99999999-9999-4999-8999-999999999999',
  validatedDeviceId: deviceId,
  protocolVersion: 2,
  timezone: 'Asia/Tashkent',
};

function createEvent(operation: 'CREATE' | 'UPDATE', deletedAt: string | null = null): SyncEvent {
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    entity_type: 'patta_sheet',
    entity_id: sheetId,
    operation,
    base_version: operation === 'CREATE' ? '0' : '1',
    client_created_at: '2026-09-28T10:00:00.000Z',
    occurred_at: '2026-09-28T10:00:00.000Z',
    reference_cursor: '9',
    payload: {
      patta_hisob_id: pattaId,
      entered_at: '2026-09-28T10:00:00.000Z',
      business_date: '2026-09-28',
      conveyor_snapshot: null,
      deleted_at: deletedAt,
      deleted_by: deletedAt === null ? null : actorId,
      operation_snapshots: [{
        id: snapshotId,
        model_operation_id: operationId,
        source_type: 'PATTA',
        source_patta_operation_snapshot_id: '22222222-2222-4222-8222-222222222222',
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '37.00',
        sort_order: 0,
      }],
      rows: [{
        id: '33333333-3333-4333-8333-333333333333',
        patta_sheet_operation_snapshot_id: snapshotId,
        worker_id: workerId,
        quantity_snapshot: 125,
        nuqson: false,
        entered_badge_number: '0007',
        deleted_at: null,
        deleted_by: null,
      }],
      depends_on_event_ids: [],
    },
  };
}

const projection = {
  id: sheetId,
  patta_hisob_id: pattaId,
  entered_at: '2026-09-28T10:00:00.000000Z',
  business_date: '2026-09-28',
  conveyor_snapshot: null,
  version: '1',
  created_by: actorId,
  created_at: '2026-09-28T10:00:00.000000Z',
  updated_at: '2026-09-28T10:00:00.000000Z',
  deleted_at: null,
  deleted_by: null,
  operation_snapshots: [],
  rows: [],
};

describe('PattaSheetSyncHandler', () => {
  it('applies a v2 aggregate CREATE and returns the committed sheet projection', async () => {
    const created = vi.fn(async () => projection);
    const sequence = vi.fn(async () => '81');
    const handler = new PattaSheetSyncHandler({
      createInTransaction: created,
      latestChangeSequence: sequence,
    } as unknown as PattaSheetsService);
    const manager = { query: vi.fn(async () => [{ allowed: true }]) } as unknown as EntityManager;

    await expect(handler.apply(manager, context, createEvent('CREATE'))).resolves.toMatchObject({
      entityVersion: '1', changeSequence: '81',
      projection: { entity_type: 'patta_sheets', entity_id: sheetId, entity_version: '1' },
    });
    expect(created).toHaveBeenCalledWith(manager, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, expect.objectContaining({ id: sheetId, patta_hisob_id: pattaId, device_id: deviceId }));
  });

  it('requires a trusted timezone and enforces permission for a trashed-parent UPDATE', async () => {
    const trashed = { ...projection, version: '2', deleted_at: '2026-09-28T10:00:00.000000Z', deleted_by: actorId };
    const setTrashed = vi.fn(async () => trashed);
    const sequence = vi.fn(async () => '82');
    const service = {
      getProjection: vi.fn(async () => projection),
      setTrashedInTransaction: setTrashed,
      latestChangeSequence: sequence,
    };
    const handler = new PattaSheetSyncHandler(service as unknown as PattaSheetsService);
    const manager = { query: vi.fn(async () => [{ allowed: true }]) } as unknown as EntityManager;
    const trashEvent = createEvent('UPDATE', '2026-09-28T10:00:00.000Z');

    await expect(handler.apply(manager, context, trashEvent)).resolves.toMatchObject({
      entityVersion: '2', changeSequence: '82', projection: { entity_version: '2' },
    });
    expect(setTrashed).toHaveBeenCalledWith(
      manager, { actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent' },
      sheetId, '1', true, '2026-09-28T10:00:00.000Z',
    );

    await expect(handler.apply(manager, { ...context, timezone: undefined }, createEvent('CREATE')))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a null projection and final tombstone cursor after PURGE', async () => {
    const purge = vi.fn(async () => ({ id: sheetId, change_sequence: '93' }));
    const service = {
      getProjection: vi.fn(async () => ({ ...projection, deleted_at: '2026-09-28T10:00:00.000000Z' })),
      purgeInTransaction: purge,
    };
    const handler = new PattaSheetSyncHandler(service as unknown as PattaSheetsService);
    const manager = { query: vi.fn(async () => [{ allowed: true }]) } as unknown as EntityManager;
    const purgeEvent = { ...createEvent('UPDATE'), operation: 'DELETE' as const, base_version: '1' };

    await expect(handler.apply(manager, context, purgeEvent)).resolves.toEqual({
      entityVersion: null, projection: null, changeSequence: '93',
    });
    expect(purge).toHaveBeenCalledWith(
      manager, { actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent' }, sheetId, '1',
    );
  });
});
