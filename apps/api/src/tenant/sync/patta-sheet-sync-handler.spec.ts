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

function createStandaloneEvent(): SyncEvent {
  const modelId = '44444444-4444-4444-8444-444444444444';
  return {
    event_id: '77777777-7777-4777-8777-777777777777',
    entity_type: 'patta_sheet',
    entity_id: sheetId,
    operation: 'CREATE',
    base_version: '0',
    client_created_at: '2026-09-28T10:00:00.000Z',
    occurred_at: '2026-09-28T10:00:00.000Z',
    reference_cursor: '9',
    payload: {
      entry_kind: 'STANDALONE',
      patta_hisob_id: null,
      model_id: modelId,
      model_name_snapshot: 'Atlas',
      ish_soni: 95,
      partiya_number_snapshot: null,
      patta_number_snapshot: null,
      rang_snapshot: null,
      razmer_snapshot: null,
      entered_at: '2026-09-28T10:00:00.000Z',
      business_date: '2026-09-28',
      conveyor_snapshot: null,
      deleted_at: null,
      deleted_by: null,
      deleted_by_name_snapshot: null,
      operation_snapshots: [{
        id: snapshotId,
        model_operation_id: operationId,
        source_type: 'MODEL',
        source_patta_operation_snapshot_id: null,
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '37.00',
        sort_order: 0,
      }],
      rows: [{
        id: '33333333-3333-4333-8333-333333333333',
        patta_sheet_operation_snapshot_id: snapshotId,
        worker_id: workerId,
        quantity_snapshot: 95,
        nuqson: false,
        entered_badge_number: '0007',
        deleted_at: null,
        deleted_by: null,
      }],
      depends_on_event_ids: [],
      device_id: deviceId,
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
    }, expect.objectContaining({ id: sheetId, patta_hisob_id: pattaId, device_id: deviceId }), 2);
  });

  it('applies a V3 Standalone CREATE and returns a V3 projection', async () => {
    const modelId = '44444444-4444-4444-8444-444444444444';
    const standalone = {
      ...projection,
      entry_kind: 'STANDALONE' as const,
      patta_hisob_id: null,
      model_id: modelId,
      model_name_snapshot: 'Atlas',
      ish_soni: 95,
      partiya_number_snapshot: null,
      patta_number_snapshot: null,
      rang_snapshot: null,
      razmer_snapshot: null,
      deleted_by_name_snapshot: null,
      operation_snapshots: [{
        id: snapshotId, patta_sheet_id: sheetId, model_operation_id: operationId,
        source_type: 'MODEL' as const, source_patta_operation_snapshot_id: null,
        operation_name_snapshot: 'Tikish', unit_price_snapshot: '37.00', sort_order: 0,
        created_at: '2026-09-28T10:00:00.000000Z',
      }],
      rows: [{
        id: '33333333-3333-4333-8333-333333333333', patta_sheet_id: sheetId,
        patta_sheet_operation_snapshot_id: snapshotId, worker_id: workerId, quantity_snapshot: 95,
        nuqson: false, deleted_at: null, deleted_by: null,
        created_at: '2026-09-28T10:00:00.000000Z', updated_at: '2026-09-28T10:00:00.000000Z',
      }],
    };
    const create = vi.fn(async () => standalone);
    const handler = new PattaSheetSyncHandler({
      createV3InTransaction: create,
      latestChangeSequence: vi.fn(async () => '94'),
    } as unknown as PattaSheetsService);
    const manager = { query: vi.fn(async () => [{ allowed: true }]) } as unknown as EntityManager;
    const v3Context = { ...context, protocolVersion: 3 as const };

    await expect(handler.apply(manager, v3Context, createStandaloneEvent())).resolves.toMatchObject({
      entityVersion: '1',
      changeSequence: '94',
      projection: { projection_version: 3, entity_type: 'patta_sheets', data: { entry_kind: 'STANDALONE' } },
    });
    expect(create).toHaveBeenCalledWith(manager, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, expect.objectContaining({ entry_kind: 'STANDALONE', patta_hisob_id: null, ish_soni: 95 }));
  });

  it('accepts an old linked V2 event in a V3 envelope and records a V3 linked projection', async () => {
    const create = vi.fn(async () => projection);
    const handler = new PattaSheetSyncHandler({
      createInTransaction: create,
      latestChangeSequence: vi.fn(async () => '95'),
    } as unknown as PattaSheetsService);
    const manager = { query: vi.fn(async () => [{ allowed: true }]) } as unknown as EntityManager;

    await expect(handler.apply(manager, { ...context, protocolVersion: 3 }, createEvent('CREATE'))).resolves.toMatchObject({
      entityVersion: '1',
      projection: { projection_version: 2, entity_type: 'patta_sheets' },
    });
    expect(create).toHaveBeenCalledWith(manager, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, expect.objectContaining({ patta_hisob_id: pattaId }), 3);
  });

  it('requires a V3 client before accepting a Standalone mutation', async () => {
    const handler = new PattaSheetSyncHandler({} as unknown as PattaSheetsService);
    const manager = { query: vi.fn() } as unknown as EntityManager;
    await expect(handler.apply(manager, context, createStandaloneEvent()))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
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
      sheetId, '1', true, '2026-09-28T10:00:00.000Z', 2,
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
      manager, { actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent' }, sheetId, '1', 2,
    );
  });
});
