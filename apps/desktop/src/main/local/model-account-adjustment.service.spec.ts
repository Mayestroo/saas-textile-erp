import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { LocalUnitOfWork } from './local-unit-of-work'
import { ModelLocalRepository } from './model-local.repository'
import { ModelAccountRepository } from './model-account.repository'
import { ModelAccountAdjustmentRepository } from './model-account-adjustment.repository'
import { ModelAccountAdjustmentService } from './model-account-adjustment.service'
import { WorkerLocalRepository } from './worker-local.repository'
import { SyncQueueRepository } from './sync-queue.repository'
import { SyncStateRepository } from './sync-state.repository'

const timestamp = '2026-09-27T20:00:00.000000Z'
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const modelId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const workerId = '17'
const databases: Database.Database[] = []
const directories: string[] = []

function createRuntime(): {
  database: Database.Database
  service: ModelAccountAdjustmentService
  queue: SyncQueueRepository
  adjustmentRepository: ModelAccountAdjustmentRepository
} {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-manual-adjustment-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'tenant.sqlite'))
  databases.push(database)
  database.prepare(`
    INSERT INTO models (id, name, status, version, created_at, updated_at)
    VALUES (?, 'Atlas', 'ACTIVE', '1', ?, ?)
  `).run(modelId, timestamp, timestamp)
  database.prepare(`
    INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
    VALUES (?, ?, 'Tikish', 0, 'ACTIVE', '1', ?, ?)
  `).run(operationId, modelId, timestamp, timestamp)
  database.prepare(`
    INSERT INTO model_operation_prices (id, operation_id, price, valid_from, valid_to, created_at)
    VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', ?, '21.50', '2026-01-01T00:00:00.000Z', NULL, ?)
  `).run(operationId, timestamp)
  database.prepare(`
    INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
    VALUES (?, 'Nodira', 'ACTIVE', '1', ?, ?)
  `).run(workerId, timestamp, timestamp)
  const syncState = new SyncStateRepository(database)
  syncState.setLastServerCursor('9', timestamp)
  syncState.setTenantTimezone('Asia/Tashkent', timestamp)
  const queue = new SyncQueueRepository(database)
  const adjustmentRepository = new ModelAccountAdjustmentRepository(database)
  let id = 1
  const service = new ModelAccountAdjustmentService({
    unitOfWork: new LocalUnitOfWork(database),
    modelRepository: new ModelLocalRepository(database),
    workerRepository: new WorkerLocalRepository(database),
    adjustmentRepository,
    queueRepository: queue,
    syncStateRepository: syncState,
    deviceId: 'device-1',
    clock: { nowIsoUtc: () => timestamp },
    idFactory: () => `eeeeeeee-eeee-4eee-8eee-${String(id++).padStart(12, '0')}`
  })
  return { database, service, queue, adjustmentRepository }
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ModelAccountAdjustmentService', () => {
  it('atomically creates a manual contribution with the effective historical price and one stable V3 event', () => {
    const { database, service, queue, adjustmentRepository } = createRuntime()
    const adjustment = service.create({
      model_id: modelId,
      model_operation_id: operationId,
      worker_id: workerId,
      quantity: 20
    }, actorId)
    const event = queue.pendingBatch(10, timestamp)[0]

    expect(adjustment).toMatchObject({
      id: 'eeeeeeee-eeee-4eee-8eee-000000000001',
      model_id: modelId,
      model_operation_id: operationId,
      worker_id: workerId,
      quantity: 20,
      unit_price_snapshot: '21.50',
      entered_at: timestamp,
      business_date: '2026-09-28',
      version: '0',
      created_by: actorId,
      created_device_id: 'device-1',
      deleted_at: null
    })
    expect(event).toMatchObject({
      entity_type: 'model_account_adjustment',
      operation: 'CREATE',
      base_version: '0',
      payload: { quantity: 20, unit_price_snapshot: '21.50', depends_on_event_ids: [] }
    })
    expect(adjustmentRepository.getById(adjustment.id)).toMatchObject({ ownership_state: 'LOCAL_PENDING' })
    expect(database.prepare('SELECT count(*) AS count FROM model_account_adjustments').get()).toEqual({ count: 1 })
    expect(new ModelAccountRepository(database).getModelAccountSheetV3(modelId, timestamp)).toMatchObject({
      operations: [{
        model_operation_id: operationId, current_price: '21.50',
        status: 'ACTIVE',
        quantity: '20', patta_quantity: '0', standalone_quantity: '0', manual_quantity: '20',
        gross_amount: '430.00', patta_amount: '0.00', standalone_amount: '0.00', manual_amount: '430.00'
      }],
      rows: [{
        worker_id: workerId, model_operation_id: operationId,
        patta_quantity: '0', standalone_quantity: '0', manual_quantity: '20', total_quantity: '20',
        patta_amount: '0.00', standalone_amount: '0.00', manual_amount: '430.00', gross_amount: '430.00'
      }]
    })
    if (!event) throw new Error('Manual adjustment event was not present in queue')
    queue.markSyncing([event.event_id], timestamp)
    expect(queue.markSynced(event.event_id, {
      event_id: event.event_id,
      status: 'SYNCED',
      entity_version: '1',
      projection: {
        projection_version: 3,
        entity_type: 'model_account_adjustments',
        entity_id: adjustment.id,
        entity_version: '1',
        data: { ...adjustment, version: '1', created_at: timestamp, updated_at: timestamp }
      },
      change_sequence: '12'
    }, timestamp)).toBe(true)
    expect(adjustmentRepository.getById(adjustment.id)).toMatchObject({
      version: '1', ownership_state: 'SERVER_SYNCED', server_sequence: '12'
    })
  })

  it('coalesces edits and trash/restore without changing the original price snapshot or event ID', () => {
    const { database, service, queue } = createRuntime()
    const created = service.create({ model_id: modelId, model_operation_id: operationId, worker_id: workerId, quantity: 20 }, actorId)
    const firstEvent = queue.pendingBatch(10, timestamp)[0]
    if (!firstEvent) throw new Error('Manual adjustment event was not queued')
    expect(() => service.update(created.id, '1', 27)).toThrow(/boshqa foydalanuvchi/)

    const modelRepository = new ModelLocalRepository(database)
    new LocalUnitOfWork(database).transaction(() => modelRepository.applyOnlinePriceChange({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      operation_id: operationId,
      price: '30.00',
      valid_from: '2026-09-27T20:00:01.000000Z',
      valid_to: null,
      created_by: actorId,
      created_at: timestamp,
      operation_version: '2'
    }))

    const updated = service.update(created.id, '0', 27)
    const trashed = service.trash(created.id, '0', actorId)
    const restored = service.restore(created.id, '0')
    const coalesced = queue.pendingBatch(10, timestamp)[0]

    expect(updated).toMatchObject({ quantity: 27, unit_price_snapshot: '21.50', version: '0' })
    expect(trashed).toMatchObject({ deleted_at: timestamp, deleted_by: actorId, unit_price_snapshot: '21.50' })
    expect(restored).toMatchObject({ deleted_at: null, deleted_by: null, unit_price_snapshot: '21.50' })
    expect(coalesced).toMatchObject({
      event_id: firstEvent.event_id,
      operation: 'CREATE',
      payload: { quantity: 27, unit_price_snapshot: '21.50', deleted_at: null, deleted_by: null }
    })
    expect(database.prepare('SELECT unit_price_snapshot, quantity, deleted_at FROM model_account_adjustments WHERE id = ?')
      .get(created.id)).toEqual({ unit_price_snapshot: '21.50', quantity: 27, deleted_at: null })
    expect(new ModelAccountRepository(database).getModelAccountSheetV3(modelId, '2026-09-27T20:00:02.000000Z'))
      .toMatchObject({ operations: [{ current_price: '30.00', quantity: '27', patta_quantity: '0',
        standalone_quantity: '0', manual_quantity: '27', manual_amount: '580.50', gross_amount: '580.50' }] })
  })

  it('rolls back when the selected operation is not effective at the Entry timestamp', () => {
    const { database, service, queue } = createRuntime()
    expect(() => service.create({
      model_id: modelId,
      model_operation_id: '11111111-1111-4111-8111-111111111111',
      worker_id: workerId,
      quantity: 20
    }, actorId)).toThrow()
    expect(database.prepare('SELECT count(*) AS count FROM model_account_adjustments').get()).toEqual({ count: 0 })
    expect(queue.pendingBatch(10, timestamp)).toEqual([])
  })
})
