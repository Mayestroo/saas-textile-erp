import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { BadgeResolutionService } from '../badges/badge-resolution.service.js';
import type { OperationPriceService } from '../operations/operation-price.service.js';
import type { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { PattaSheetsService } from './patta-sheets.service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pattaId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sheetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const operationSnapshotId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const modelOperationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const rowId = '11111111-1111-4111-8111-111111111111';
const enteredAt = '2026-09-27T20:00:00.000Z';
const transactionTime = '2026-09-28T10:00:00.000000Z';

function createService(queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>) {
  const query = vi.fn(queryHandler);
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    query,
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) => callback(manager)),
  } as unknown as DataSource;
  const audit = { append: vi.fn(async () => undefined) };
  const badges = { resolve: vi.fn(async () => ({ worker_id: '7', full_name: 'Nodira', assignment: {
    id: '22222222-2222-4222-8222-222222222222', badge_number: '0012',
    valid_from: '2026-01-01T00:00:00.000000Z', valid_to: null,
  } })) };
  const prices = { resolvePrice: vi.fn(async () => '37.00') };
  const changes = { record: vi.fn(async () => ({ sequenceId: '81' })) };
  const service = new PattaSheetsService(
    audit as unknown as AuditService,
    badges as unknown as BadgeResolutionService,
    prices as unknown as OperationPriceService,
    changes as unknown as SyncChangeRecorder,
  );
  return { service, dataSource, query, audit, badges, prices, changes };
}

function createInput() {
  return {
    id: sheetId,
    patta_hisob_id: pattaId,
    entered_at: enteredAt,
    business_date: '2026-09-28',
    conveyor_snapshot: null,
    device_id: deviceId,
    operation_snapshots: [{
      id: operationSnapshotId,
      model_operation_id: modelOperationId,
      source_type: 'PATTA' as const,
      source_patta_operation_snapshot_id: '33333333-3333-4333-8333-333333333333',
      operation_name_snapshot: 'Tikish',
      unit_price_snapshot: '37.00',
      sort_order: 0,
    }],
    rows: [{
      id: rowId,
      patta_sheet_operation_snapshot_id: operationSnapshotId,
      worker_id: '7',
      quantity_snapshot: 125,
      nuqson: false,
      entered_badge_number: '0012',
    }],
    depends_on_event_ids: [],
  };
}

function successfulCreateQuery(sql: string): Promise<unknown> {
  if (sql.includes('FROM "patta_hisob" WHERE "id" = $1 FOR UPDATE')) return Promise.resolve([{
    id: pattaId, model_id: '44444444-4444-4444-8444-444444444444', partiya_number: '9',
    patta_number: '22', model_name_snapshot: 'Atlas', ish_soni: 125, status: 'ACTIVE',
  }]);
  if (sql.includes('FROM "patta_sheets" WHERE "patta_hisob_id" = $1 FOR UPDATE')) return Promise.resolve([]);
  if (sql.includes('AT TIME ZONE $2::text')) return Promise.resolve([{ business_date: '2026-09-28' }]);
  if (sql.includes('FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1')) return Promise.resolve([{
    id: '33333333-3333-4333-8333-333333333333', operation_id: modelOperationId,
    operation_name_snapshot: 'Tikish', unit_price_snapshot: '37.00', sort_order: 0,
  }]);
  if (sql.includes('FROM "worker_badge_history"')) return Promise.resolve([{
    id: '22222222-2222-4222-8222-222222222222', badge_number: '0012', worker_id: '7',
    full_name: 'Nodira', valid_from: '2026-01-01T00:00:00.000000Z', valid_to: null,
  }]);
  if (sql.includes('transaction_timestamp()::text')) return Promise.resolve([{ transaction_time: transactionTime }]);
  if (sql.includes('FROM "patta_sheets" WHERE "id" = $1')) return Promise.resolve([{
    id: sheetId, entry_kind: 'PATTA_LINKED', patta_hisob_id: pattaId,
    model_id: '44444444-4444-4444-8444-444444444444', model_name_snapshot: 'Atlas', ish_soni: 125,
    partiya_number_snapshot: '9', patta_number_snapshot: '22', rang_snapshot: null, razmer_snapshot: 'S',
    deleted_by_name_snapshot: null, entered_at: '2026-09-27T20:00:00.000000Z',
    business_date: '2026-09-28', conveyor_snapshot: null, version: '1', created_by: actorId,
    created_at: transactionTime, updated_at: transactionTime, deleted_at: null, deleted_by: null,
  }]);
  if (sql.includes('FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1')) return Promise.resolve([{
    id: operationSnapshotId, patta_sheet_id: sheetId, model_operation_id: modelOperationId,
    source_type: 'PATTA', source_patta_operation_snapshot_id: '33333333-3333-4333-8333-333333333333',
    operation_name_snapshot: 'Tikish', unit_price_snapshot: '37.00', sort_order: 0, created_at: transactionTime,
  }]);
  if (sql.includes('FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1')) return Promise.resolve([{
    id: rowId, patta_sheet_id: sheetId, patta_sheet_operation_snapshot_id: operationSnapshotId,
    worker_id: '7', quantity_snapshot: 125, nuqson: false, deleted_at: null, deleted_by: null,
    created_at: transactionTime, updated_at: transactionTime,
  }]);
  return Promise.resolve([]);
}

describe('PattaSheetsService', () => {
  it('creates a single Entry and resolves each worker at the immutable entered_at in tenant time', async () => {
    const setup = createService(successfulCreateQuery);
    const result = await setup.service.create(setup.dataSource, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, createInput());

    expect(result).toMatchObject({
      id: sheetId, patta_hisob_id: pattaId, entered_at: '2026-09-27T20:00:00.000000Z',
      business_date: '2026-09-28', version: '1', rows: [{ worker_id: '7', quantity_snapshot: 125 }],
    });
    expect(setup.badges.resolve).toHaveBeenCalledWith(expect.anything(), '0012', enteredAt);
    expect(setup.query.mock.calls.find(([sql]) => String(sql).includes('AT TIME ZONE $2::text'))?.[1])
      .toEqual([enteredAt, 'Asia/Tashkent']);
    expect(setup.audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_sheet', action: 'patta_sheet.create', entityId: sheetId,
    }));
    expect(setup.changes.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_sheets', projectionVersion: 2,
    }));
  });

  it('updates worker assignment by stable worker ID while preserving entered_at and Patta quantity', async () => {
    const currentTime = '2026-09-28T10:00:00.000000Z';
    const sourceId = '33333333-3333-4333-8333-333333333333';
    const { service, dataSource, query, audit } = createService(async (sql) => {
      if (sql.includes('FROM "patta_sheets" WHERE "id" = $1 FOR UPDATE')) return [{
        id: sheetId, entry_kind: 'PATTA_LINKED', patta_hisob_id: pattaId,
        model_id: '44444444-4444-4444-8444-444444444444', model_name_snapshot: 'Atlas', ish_soni: 125,
        partiya_number_snapshot: '9', patta_number_snapshot: '22', rang_snapshot: null, razmer_snapshot: 'S',
        deleted_by_name_snapshot: null, entered_at: '2026-09-27T20:00:00.000000Z',
        business_date: '2026-09-28', conveyor_snapshot: null, version: '1', created_by: actorId,
        created_at: currentTime, updated_at: currentTime, deleted_at: null, deleted_by: null,
      }];
      if (sql.includes('AS "timestamp_value"')) return [{ timestamp_value: '2026-09-27T20:00:00.000000Z' }];
      if (sql.includes('FROM "patta_hisob" WHERE "id" = $1 FOR UPDATE')) return [{
        id: pattaId, model_id: '44444444-4444-4444-8444-444444444444', partiya_number: '9',
        patta_number: '22', model_name_snapshot: 'Atlas', ish_soni: 125, status: 'ACTIVE',
      }];
      if (sql.includes('FROM "patta_operation_snapshots" WHERE "patta_hisob_id" = $1')) return [{
        id: sourceId, operation_id: modelOperationId, operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '37.00', sort_order: 0,
      }];
      if (sql.includes('FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1')) return [{
        id: operationSnapshotId, patta_sheet_id: sheetId, model_operation_id: modelOperationId,
        source_type: 'PATTA', source_patta_operation_snapshot_id: sourceId,
        operation_name_snapshot: 'Tikish', unit_price_snapshot: '37.00', sort_order: 0, created_at: currentTime,
      }];
      if (sql.includes('FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1 FOR UPDATE')) return [{
        id: rowId, patta_sheet_operation_snapshot_id: operationSnapshotId,
        deleted_at: null, deleted_by: null,
      }];
      if (sql.includes('FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1')) return [{
        id: rowId, patta_sheet_id: sheetId, patta_sheet_operation_snapshot_id: operationSnapshotId,
        worker_id: '7', quantity_snapshot: 125, nuqson: true, deleted_at: null, deleted_by: null,
        created_at: currentTime, updated_at: currentTime,
      }];
      if (sql.includes('FROM "patta_sheets" WHERE "id" = $1')) return [{
        id: sheetId, entry_kind: 'PATTA_LINKED', patta_hisob_id: pattaId,
        model_id: '44444444-4444-4444-8444-444444444444', model_name_snapshot: 'Atlas', ish_soni: 125,
        partiya_number_snapshot: '9', patta_number_snapshot: '22', rang_snapshot: null, razmer_snapshot: 'S',
        deleted_by_name_snapshot: null, entered_at: '2026-09-27T20:00:00.000000Z',
        business_date: '2026-09-28', conveyor_snapshot: '1-konveyer', version: '2', created_by: actorId,
        created_at: currentTime, updated_at: currentTime, deleted_at: null, deleted_by: null,
      }];
      return [];
    });

    const result = await service.update(dataSource, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, sheetId, {
      ...createInput(),
      id: sheetId,
      expected_version: '1',
      conveyor_snapshot: '1-konveyer',
      operation_snapshots: [{
        id: operationSnapshotId, model_operation_id: modelOperationId, source_type: 'PATTA',
        source_patta_operation_snapshot_id: sourceId, operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '37.00', sort_order: 0,
      }],
      rows: [{
        id: rowId, patta_sheet_operation_snapshot_id: operationSnapshotId,
        worker_id: '7', quantity_snapshot: 125, nuqson: true, entered_badge_number: '0012',
      }],
    });

    expect(result).toMatchObject({
      id: sheetId, version: '2', entered_at: '2026-09-27T20:00:00.000000Z',
      conveyor_snapshot: '1-konveyer', rows: [{ worker_id: '7', quantity_snapshot: 125, nuqson: true }],
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "patta_sheet_rows" SET "patta_sheet_operation_snapshot_id"'))).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'patta_sheet.update' }));
  });

  it('blocks unknown historical quantity and badge-to-worker mismatch before business writes', async () => {
    const unknownQuantity = createService(async (sql) => {
      if (sql.includes('FROM "patta_hisob"')) return [{
        id: pattaId, model_id: '44444444-4444-4444-8444-444444444444', partiya_number: '9',
        patta_number: '22', model_name_snapshot: 'Atlas', ish_soni: null, status: 'ACTIVE',
      }];
      return [];
    });
    await expect(unknownQuantity.service.create(unknownQuantity.dataSource, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, createInput())).rejects.toMatchObject({ response: { code: 'PATTA_QUANTITY_UNKNOWN' } });
    expect(unknownQuantity.audit.append).not.toHaveBeenCalled();

    const mismatch = createService(successfulCreateQuery);
    mismatch.badges.resolve.mockResolvedValue({
      worker_id: '8', full_name: 'Other Worker', assignment: {
        id: '22222222-2222-4222-8222-222222222222', badge_number: '0012',
        valid_from: '2026-01-01T00:00:00.000000Z', valid_to: null,
      },
    });
    await expect(mismatch.service.create(mismatch.dataSource, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, createInput())).rejects.toMatchObject({ response: { code: 'CONFLICT_BADGE_ASSIGNMENT' } });
    expect(mismatch.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "patta_sheets"'))).toBe(false);
    expect(mismatch.audit.append).not.toHaveBeenCalled();
  });

  it('creates a standalone aggregate with authoritative model and effective operation-price snapshots', async () => {
    const modelId = '44444444-4444-4444-8444-444444444444';
    const standaloneId = '55555555-5555-4555-8555-555555555555';
    const standaloneSnapshotId = '66666666-6666-4666-8666-666666666666';
    const { service, dataSource, query, audit, changes, prices } = createService(async (sql) => {
      if (sql.includes('SELECT "id"::text AS "id" FROM "patta_sheets" WHERE "id" = $1 FOR UPDATE')) return [];
      if (sql.includes('FROM "models" WHERE "id" = $1 FOR SHARE')) {
        return [{ id: modelId, name: 'Atlas', status: 'ACTIVE' }];
      }
      if (sql.includes('FROM "model_operations" WHERE "id" = $1 FOR SHARE')) {
        return [{ model_id: modelId, name: 'Tikish', status: 'ACTIVE' }];
      }
      if (sql.includes('AT TIME ZONE $2::text')) return [{ business_date: '2026-09-28' }];
      if (sql.includes('FROM "worker_badge_history"')) return [{
        id: '22222222-2222-4222-8222-222222222222', badge_number: '0012', worker_id: '7',
        full_name: 'Nodira', valid_from: '2026-01-01T00:00:00.000000Z', valid_to: null,
      }];
      if (sql.includes('transaction_timestamp()::text')) return [{ transaction_time: transactionTime }];
      if (sql.includes('FROM "patta_sheets" WHERE "id" = $1')) return [{
        id: standaloneId, entry_kind: 'STANDALONE', patta_hisob_id: null, model_id: modelId,
        model_name_snapshot: 'Atlas', ish_soni: 95, partiya_number_snapshot: null,
        patta_number_snapshot: null, rang_snapshot: 'Qora', razmer_snapshot: 'M',
        entered_at: '2026-09-27T20:00:00.000000Z', business_date: '2026-09-28',
        conveyor_snapshot: null, version: '1', created_by: actorId,
        created_at: transactionTime, updated_at: transactionTime,
        deleted_at: null, deleted_by: null, deleted_by_name_snapshot: null,
      }];
      if (sql.includes('FROM "patta_sheet_operation_snapshots" WHERE "patta_sheet_id" = $1')) return [{
        id: standaloneSnapshotId, patta_sheet_id: standaloneId, model_operation_id: modelOperationId,
        source_type: 'MODEL', source_patta_operation_snapshot_id: null,
        operation_name_snapshot: 'Tikish', unit_price_snapshot: '37.00', sort_order: 0,
        created_at: transactionTime,
      }];
      if (sql.includes('FROM "patta_sheet_rows" WHERE "patta_sheet_id" = $1')) return [{
        id: rowId, patta_sheet_id: standaloneId, patta_sheet_operation_snapshot_id: standaloneSnapshotId,
        worker_id: '7', quantity_snapshot: 95, nuqson: false, deleted_at: null, deleted_by: null,
        created_at: transactionTime, updated_at: transactionTime,
      }];
      return [];
    });

    const result = await service.createV3(dataSource, {
      actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent',
    }, {
      id: standaloneId,
      entry_kind: 'STANDALONE',
      patta_hisob_id: null,
      model_id: modelId,
      model_name_snapshot: 'Atlas',
      ish_soni: 95,
      partiya_number_snapshot: null,
      patta_number_snapshot: null,
      rang_snapshot: 'Qora',
      razmer_snapshot: 'M',
      entered_at: enteredAt,
      business_date: '2026-09-28',
      conveyor_snapshot: null,
      deleted_at: null,
      deleted_by: null,
      deleted_by_name_snapshot: null,
      operation_snapshots: [{
        id: standaloneSnapshotId,
        model_operation_id: modelOperationId,
        source_type: 'MODEL',
        source_patta_operation_snapshot_id: null,
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '37.00',
        sort_order: 0,
      }],
      rows: [{
        id: rowId,
        patta_sheet_operation_snapshot_id: standaloneSnapshotId,
        worker_id: '7',
        quantity_snapshot: 95,
        nuqson: false,
        entered_badge_number: '0012',
      }],
      depends_on_event_ids: [],
      device_id: deviceId,
    });

    expect(result).toMatchObject({
      entry_kind: 'STANDALONE', patta_hisob_id: null, model_id: modelId,
      model_name_snapshot: 'Atlas', ish_soni: 95,
      operation_snapshots: [{ source_type: 'MODEL', unit_price_snapshot: '37.00' }],
      rows: [{ quantity_snapshot: 95, worker_id: '7' }],
    });
    expect(prices.resolvePrice).toHaveBeenCalledWith(modelOperationId, enteredAt, expect.anything());
    expect(query.mock.calls.some(([sql, parameters]) => String(sql).includes('INSERT INTO "patta_sheets"') &&
      parameters?.[1] === modelId && String(sql).includes("'STANDALONE', NULL"))).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_sheet', action: 'patta_sheet.create', entityId: standaloneId,
    }));
    expect(changes.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_sheets', projectionVersion: 3,
    }));
  });

  it('uses optimistic versions for Korzinka trash and restore without replacing Entry identity', async () => {
    let version = '1';
    let deleted = false;
    const createdAt = transactionTime;
    const { service, dataSource, query, audit, changes } = createService(async (sql, parameters) => {
      if (sql.includes('SELECT "full_name" FROM "users"')) return [{ full_name: 'Admin User' }];
      if (sql.includes('FROM "patta_sheets" WHERE "id" = $1 FOR UPDATE')) return [{
        id: sheetId, entry_kind: 'PATTA_LINKED', patta_hisob_id: pattaId,
        model_id: '44444444-4444-4444-8444-444444444444', model_name_snapshot: 'Atlas', ish_soni: 125,
        partiya_number_snapshot: '9', patta_number_snapshot: '22', rang_snapshot: null, razmer_snapshot: 'S',
        deleted_by_name_snapshot: null, entered_at: '2026-09-27T20:00:00.000000Z',
        business_date: '2026-09-28', conveyor_snapshot: null, version,
        created_by: actorId, created_at: createdAt, updated_at: createdAt,
        deleted_at: deleted ? createdAt : null, deleted_by: deleted ? actorId : null,
      }];
      if (sql.includes('UPDATE "patta_sheets" SET "deleted_at"')) {
        deleted = parameters?.[0] === true;
        version = String(parameters?.[2]);
        return [];
      }
      if (sql.includes('FROM "patta_sheets" WHERE "id" = $1')) return [{
        id: sheetId, entry_kind: 'PATTA_LINKED', patta_hisob_id: pattaId,
        model_id: '44444444-4444-4444-8444-444444444444', model_name_snapshot: 'Atlas', ish_soni: 125,
        partiya_number_snapshot: '9', patta_number_snapshot: '22', rang_snapshot: null, razmer_snapshot: 'S',
        deleted_by_name_snapshot: deleted ? 'Admin User' : null, entered_at: '2026-09-27T20:00:00.000000Z',
        business_date: '2026-09-28', conveyor_snapshot: null, version,
        created_by: actorId, created_at: createdAt, updated_at: createdAt,
        deleted_at: deleted ? createdAt : null, deleted_by: deleted ? actorId : null,
      }];
      return [];
    });
    const context = { actorUserId: actorId, validatedDeviceId: deviceId, timezone: 'Asia/Tashkent' };

    const trashed = await service.trash(dataSource, context, sheetId, '1');
    expect(trashed).toMatchObject({ id: sheetId, version: '2', deleted_by: actorId });
    expect(query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "patta_sheets" SET "deleted_at"'))?.[1])
      .toContain('Admin User');
    await expect(service.restore(dataSource, context, sheetId, '1'))
      .rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    const restored = await service.restore(dataSource, context, sheetId, '2');
    expect(restored).toMatchObject({ id: sheetId, version: '3', deleted_at: null, deleted_by: null });
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ action: 'patta_sheet.trash' }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ action: 'patta_sheet.restore' }));
    expect(changes.record).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM "patta_sheets"'))).toBe(false);
  });
});
