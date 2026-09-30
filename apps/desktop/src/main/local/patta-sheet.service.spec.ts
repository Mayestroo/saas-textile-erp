import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { LocalUnitOfWork } from './local-unit-of-work'
import { BadgeLocalRepository } from './badge-local.repository'
import { PattaLocalRepository } from './patta-local.repository'
import { PattaSheetRepository } from './patta-sheet.repository'
import { PattaSheetService } from './patta-sheet.service'
import { PattaSheetCustomOperationRepository } from './patta-sheet-custom-operation.repository'
import { SyncQueueRepository } from './sync-queue.repository'
import { SyncStateRepository } from './sync-state.repository'
import { ModelLocalRepository } from './model-local.repository'

const timestamp = '2026-09-27T20:00:00.000000Z'
const databases: Database.Database[] = []
const directories: string[] = []
const pattaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const workerId = '7'
const secondWorkerId = '8'
const actorId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function createDatabase(options: { actualQuantity?: number | null; timezone?: string | null; badgeFrom?: string } = {}): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-entry-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'tenant.sqlite'))
  databases.push(database)
  database.prepare(`
    INSERT INTO models (id, name, status, version, created_at, updated_at)
    VALUES ('model-1', 'Atlas', 'ACTIVE', '1', ?, ?)
  `).run(timestamp, timestamp)
  database.prepare(`
    INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
    VALUES (?, 'model-1', 'Tikish', 0, 'ACTIVE', '1', ?, ?)
  `).run(operationId, timestamp, timestamp)
  database.prepare(`
    INSERT INTO patta_hisob (
      id, partiya_number, patta_number, model_id, model_name_snapshot, template_id, konveyer_snapshot,
      razmer, rang, ish_soni, legacy_operation_count, status, print_batch_id, created_device_id,
      created_from_block_id, created_at, client_created_at, occurred_at, version, ownership_state
    ) VALUES (?, '1', '10', 'model-1', 'Atlas', NULL, NULL, 'S', 'Qora', ?, NULL, 'ACTIVE', NULL,
      'device-1', NULL, ?, NULL, NULL, '1', 'SERVER_SYNCED')
  `).run(pattaId, options.actualQuantity === undefined ? 125 : options.actualQuantity, timestamp)
  database.prepare(`
    INSERT INTO patta_operation_snapshots (
      id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order,
      created_at, ownership_state, server_sequence
    ) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ?, ?, 'Tikish', '37.00', 0, ?, 'SERVER_SYNCED', '8')
  `).run(pattaId, operationId, timestamp)
  database.prepare(`
    INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
    VALUES (?, 'Nodira', 'ACTIVE', '1', ?, ?)
  `).run(workerId, timestamp, timestamp)
  database.prepare(`
    INSERT INTO worker_badge_history (id, badge_number, worker_id, valid_from, valid_to, created_at, server_sequence)
    VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '0007', ?, ?, NULL, ?, '8')
  `).run(workerId, options.badgeFrom ?? '2026-09-27T19:00:00.000Z', timestamp)
  const state = new SyncStateRepository(database)
  state.setLastServerCursor('9', timestamp)
  if (options.timezone) state.setTenantTimezone(options.timezone, timestamp)
  return database
}

function createService(database: Database.Database): {
  service: PattaSheetService
  queue: SyncQueueRepository
  sheets: PattaSheetRepository
  pattas: PattaLocalRepository
} {
  const queue = new SyncQueueRepository(database)
  const sheets = new PattaSheetRepository(database)
  const pattas = new PattaLocalRepository(database)
  const service = new PattaSheetService({
    unitOfWork: new LocalUnitOfWork(database),
    pattaRepository: pattas,
    modelRepository: new ModelLocalRepository(database),
    sheetRepository: sheets,
    customOperationRepository: new PattaSheetCustomOperationRepository(database),
    badgeRepository: new BadgeLocalRepository(database),
    queueRepository: queue,
    syncStateRepository: new SyncStateRepository(database),
    deviceId: 'device-1',
    clock: { nowIsoUtc: () => timestamp },
    idFactory: (() => {
      let next = 1
      return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
    })()
  })
  return { service, queue, sheets, pattas }
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PattaSheetService', () => {
  it('previews a Jeton against the requested historical timestamp without writing business rows', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service } = createService(database)

    expect(service.resolveBadge('0007')).toEqual({ worker_id: workerId, full_name: 'Nodira' })
    expect(service.resolveBadge('missing')).toBeNull()
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_sheets').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM sync_queue').get()).toEqual({ count: 0 })
  })

  it('writes final Enter once with tenant-local date, historical worker ID, Patta quantity and one aggregate event', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue, sheets } = createService(database)
    const created = service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: '  1-konveyer ',
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: true }]
    })

    expect(created).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      patta_hisob_id: pattaId,
      entered_at: timestamp,
      business_date: '2026-09-28',
      conveyor_snapshot: '1-konveyer',
      version: '0',
      operation_snapshots: [{
        model_operation_id: operationId, source_type: 'PATTA', unit_price_snapshot: '37.00'
      }],
      rows: [{ worker_id: workerId, quantity_snapshot: 125, nuqson: true, deleted_at: null }]
    })
    expect(sheets.findByPatta(pattaId)).toMatchObject(created)
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      event_id: '00000000-0000-4000-8000-000000000002',
      entity_type: 'patta_sheet',
      operation: 'CREATE',
      base_version: '0',
      occurred_at: timestamp,
      payload: {
        patta_hisob_id: pattaId,
        business_date: '2026-09-28',
        rows: [{ entered_badge_number: '0007', worker_id: workerId, quantity_snapshot: 125 }]
      }
    }])
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_sheets').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_sheet_rows WHERE quantity_snapshot = 125').get())
      .toEqual({ count: 1 })
  })

  it('creates Standalone Entry without looking up or creating a Patta and queues the model price snapshots atomically', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue, sheets, pattas } = createService(database)
    const standaloneModelId = '11111111-1111-4111-8111-111111111111'
    const standaloneOperationId = '22222222-2222-4222-8222-222222222222'
    database.prepare(`
      INSERT INTO models (id, name, status, version, created_at, updated_at)
      VALUES (?, 'Mustaqil model', 'ACTIVE', '1', ?, ?)
    `).run(standaloneModelId, timestamp, timestamp)
    database.prepare(`
      INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
      VALUES (?, ?, 'Tikish', 0, 'ACTIVE', '3', ?, ?)
    `).run(standaloneOperationId, standaloneModelId, timestamp, timestamp)
    database.prepare(`
      INSERT INTO model_operation_prices (id, operation_id, price, valid_from, valid_to, created_at)
      VALUES ('33333333-3333-4333-8333-333333333333', ?, '21.50', '2026-01-01T00:00:00.000Z', NULL, ?)
    `).run(standaloneOperationId, timestamp)
    const pattaLookup = vi.spyOn(pattas, 'findByBusinessKey')

    const created = service.create({
      entry_kind: 'STANDALONE',
      entered_at: timestamp,
      model_id: standaloneModelId,
      ish_soni: 95,
      partiya_number_snapshot: null,
      patta_number_snapshot: null,
      rang_snapshot: 'Ko‘k',
      razmer_snapshot: 'M',
      conveyor_snapshot: null,
      assignments: [{ model_operation_id: standaloneOperationId, badge_number: '0007', nuqson: false }]
    }, actorId)

    expect(created).toMatchObject({
      entry_kind: 'STANDALONE',
      patta_hisob_id: null,
      model_id: standaloneModelId,
      ish_soni: 95,
      operation_snapshots: [{ source_type: 'MODEL', source_patta_operation_snapshot_id: null, unit_price_snapshot: '21.50' }],
      rows: [{ worker_id: workerId, quantity_snapshot: 95 }]
    })
    expect(pattaLookup).not.toHaveBeenCalled()
    expect(sheets.findByPatta(pattaId)).toBeNull()
    expect(pattas.getById(pattaId)).not.toBeNull()
    expect(database.prepare(`
      SELECT patta_hisob_id, entry_kind, ish_soni FROM patta_sheets WHERE id = ?
    `).get(created.id)).toEqual({ patta_hisob_id: null, entry_kind: 'STANDALONE', ish_soni: 95 })
    const createdEvent = queue.pendingBatch(10, timestamp)[0]
    expect(createdEvent).toMatchObject({
      entity_type: 'patta_sheet', operation: 'CREATE', payload: {
        entry_kind: 'STANDALONE', patta_hisob_id: null, ish_soni: 95,
        operation_snapshots: [{ source_type: 'MODEL', unit_price_snapshot: '21.50' }]
      }
    })
    if (!createdEvent) throw new Error('Standalone sync event was not enqueued')
    const updated = service.update({
      sheet_id: created.id,
      expected_version: '0',
      conveyor_snapshot: '1-konveyer',
      assignments: [{ model_operation_id: standaloneOperationId, badge_number: '0007', nuqson: true }]
    }, actorId)
    expect(updated).toMatchObject({
      entry_kind: 'STANDALONE', patta_hisob_id: null, ish_soni: 95,
      conveyor_snapshot: '1-konveyer',
      operation_snapshots: [{ unit_price_snapshot: '21.50' }],
      rows: [{ quantity_snapshot: 95, nuqson: true }]
    })
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      event_id: createdEvent.event_id,
      operation: 'CREATE',
      payload: { entry_kind: 'STANDALONE', ish_soni: 95, conveyor_snapshot: '1-konveyer' }
    }])
  })

  it('creates custom operations atomically and blocks their dependent Entry until the operation syncs', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue } = createService(database)
    const customOperationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const created = service.create({
      partiya_number: '1',
      patta_number: '10',
      conveyor_snapshot: null,
      custom_operations: [{ id: customOperationId, name: 'Qadoqlash', initial_price: '500.00' }],
      assignments: [
        { model_operation_id: operationId, badge_number: '0007', nuqson: false },
        { model_operation_id: customOperationId, badge_number: '0007', nuqson: false }
      ]
    })

    expect(created.operation_snapshots).toHaveLength(2)
    expect(created.operation_snapshots[1]).toMatchObject({
      model_operation_id: customOperationId,
      source_type: 'CUSTOM',
      source_patta_operation_snapshot_id: null,
      operation_name_snapshot: 'Qadoqlash',
      unit_price_snapshot: '500.00'
    })
    expect(database.prepare('SELECT id, status FROM model_operations WHERE id = ?').get(customOperationId))
      .toEqual({ id: customOperationId, status: 'ACTIVE' })
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      event_id: customOperationId,
      entity_type: 'model_operation',
      payload: { model_id: 'model-1', name: 'Qadoqlash', initial_price: '500.00', effective_from: timestamp }
    }])
    expect(queue.pendingBatch(10, timestamp)).toHaveLength(1)
    expect(database.prepare(`
      SELECT event_id, prerequisite_event_id FROM sync_event_dependencies
      WHERE event_id = (SELECT event_id FROM sync_queue WHERE entity_type = 'patta_sheet' AND entity_id = ?)
    `).get(created.id)).toMatchObject({
      prerequisite_event_id: customOperationId
    })

    expect(queue.markSyncing([customOperationId], timestamp)).toBe(1)
    expect(queue.markSynced(customOperationId, {
      event_id: customOperationId,
      status: 'SYNCED',
      entity_version: '1',
      change_sequence: '10',
      projection: {
        projection_version: 1,
        entity_type: 'model_operations',
        entity_id: customOperationId,
        entity_version: '1',
        data: {
          id: customOperationId,
          model_id: 'model-1',
          name: 'Qadoqlash',
          sort_order: 1,
          status: 'ACTIVE',
          version: '1',
          created_at: timestamp,
          updated_at: timestamp
        }
      }
    }, timestamp)).toBe(true)
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      entity_type: 'patta_sheet',
      entity_id: created.id,
      payload: { depends_on_event_ids: [customOperationId] }
    }])
  })

  it('blocks unknown legacy quantity and missing trusted timezone without creating an Entry or queue event', () => {
    const unknownQuantityDb = createDatabase({ actualQuantity: null, timezone: 'Asia/Tashkent' })
    const unknownQuantity = createService(unknownQuantityDb)
    expect(() => unknownQuantity.service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })).toThrowError(expect.objectContaining({ code: 'PATTA_QUANTITY_UNKNOWN' }))
    expect(unknownQuantityDb.prepare('SELECT COUNT(*) AS count FROM patta_sheets').get()).toEqual({ count: 0 })

    const noTimezoneDb = createDatabase()
    const noTimezone = createService(noTimezoneDb)
    expect(() => noTimezone.service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })).toThrowError(expect.objectContaining({ code: 'TENANT_TIMEZONE_UNAVAILABLE' }))
    expect(noTimezone.queue.pendingBatch(10, timestamp)).toEqual([])
  })

  it('rejects a badge that was not assigned at final Enter time', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent', badgeFrom: '2026-09-27T21:00:00.000Z' })
    const { service } = createService(database)

    expect(() => service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })).toThrowError(expect.objectContaining({ code: 'BADGE_NOT_FOUND' }))
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_sheets').get()).toEqual({ count: 0 })
  })

  it('edits a worker by badge at the immutable entry time and keeps Patta quantity fixed', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue, sheets } = createService(database)
    const created = service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })
    database.prepare(`
      INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
      VALUES (?, 'Malika', 'ACTIVE', '1', ?, ?)
    `).run(secondWorkerId, timestamp, timestamp)
    database.prepare(`
      INSERT INTO worker_badge_history (id, badge_number, worker_id, valid_from, valid_to, created_at, server_sequence)
      VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff', '0008', ?, '2026-09-27T19:00:00.000Z', NULL, ?, '8')
    `).run(secondWorkerId, timestamp)

    const updated = service.update({
      sheet_id: created.id,
      expected_version: '0',
      conveyor_snapshot: '2-konveyer',
      assignments: [{ model_operation_id: operationId, badge_number: '0008', nuqson: true }]
    }, actorId)

    expect(updated).toMatchObject({
      version: '0',
      entered_at: timestamp,
      conveyor_snapshot: '2-konveyer',
      rows: [{ id: created.rows[0]?.id, worker_id: secondWorkerId, quantity_snapshot: 125, nuqson: true }]
    })
    expect(sheets.badgeEvidence(created.id).get(created.rows[0]?.id ?? '')).toBe('0008')
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'CREATE',
      payload: { rows: [{ worker_id: secondWorkerId, quantity_snapshot: 125, entered_badge_number: '0008' }] }
    }])
  })

  it('soft-deletes a cleared assignment inside the pending CREATE instead of dropping its history', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue, sheets } = createService(database)
    const created = service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })

    const updated = service.update({
      sheet_id: created.id,
      expected_version: '0',
      conveyor_snapshot: null,
      assignments: [],
      clear_operation_ids: [operationId]
    }, actorId)

    expect(updated.rows).toHaveLength(1)
    expect(updated.rows[0]).toMatchObject({ worker_id: workerId, deleted_at: timestamp, deleted_by: actorId })
    expect(sheets.findByPatta(pattaId)?.rows[0]?.deleted_at).toBe(timestamp)
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'CREATE',
      payload: { rows: [{ worker_id: workerId, deleted_at: timestamp, deleted_by: actorId }] }
    }])
  })

  it('coalesces offline trash and restore into a never-sent CREATE and cancels it on local purge', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue, sheets } = createService(database)
    const created = service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })

    const trashed = service.trash(created.id, '0', actorId, 'Operator One')
    expect(trashed).toMatchObject({ version: '0', deleted_at: timestamp, deleted_by: actorId })
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'CREATE', payload: { deleted_at: timestamp, deleted_by: actorId }
    }])

    const restored = service.restore(created.id, '0', actorId)
    expect(restored).toMatchObject({ version: '0', deleted_at: null, deleted_by: null })
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'CREATE', payload: { deleted_at: null, deleted_by: null }
    }])

    service.trash(created.id, '0', actorId, 'Operator One')
    service.purge(created.id, '0')
    expect(sheets.getById(created.id)).toBeNull()
    expect(queue.pendingBatch(10, timestamp)).toEqual([])
    expect(database.prepare('SELECT id FROM patta_hisob WHERE id = ?').get(pattaId)).toEqual({ id: pattaId })
  })

  it('trashes, restores, and purges a server-synced Entry without deleting the original Patta', () => {
    const database = createDatabase({ timezone: 'Asia/Tashkent' })
    const { service, queue, sheets } = createService(database)
    const created = service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })
    const markServerSynced = (version: string, sequence: string): void => {
      database.prepare(`
        UPDATE patta_sheets SET ownership_state = 'SERVER_SYNCED', server_sequence = ?, version = ? WHERE id = ?
      `).run(sequence, version, created.id)
      database.prepare(`
        UPDATE patta_sheet_operation_snapshots SET ownership_state = 'SERVER_SYNCED', server_sequence = ?
        WHERE patta_sheet_id = ?
      `).run(sequence, created.id)
      database.prepare(`
        UPDATE patta_sheet_rows SET ownership_state = 'SERVER_SYNCED', server_sequence = ? WHERE patta_sheet_id = ?
      `).run(sequence, created.id)
      database.prepare("DELETE FROM sync_queue WHERE entity_type = 'patta_sheet' AND entity_id = ?").run(created.id)
    }
    markServerSynced('1', '10')

    const trashed = service.trash(created.id, '1', actorId, 'Operator One')
    expect(trashed).toMatchObject({ version: '2', deleted_at: timestamp, deleted_by: actorId })
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'UPDATE', base_version: '1', payload: { deleted_at: timestamp, deleted_by: actorId }
    }])

    markServerSynced('2', '11')
    const restored = service.restore(created.id, '2', actorId)
    expect(restored).toMatchObject({ version: '3', deleted_at: null, deleted_by: null })
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'UPDATE', base_version: '2', payload: { deleted_at: null, deleted_by: null }
    }])

    markServerSynced('3', '12')
    service.trash(created.id, '3', actorId, 'Operator One')
    markServerSynced('4', '13')
    service.purge(created.id, '4')

    expect(sheets.getById(created.id)).toBeNull()
    expect(database.prepare('SELECT id FROM patta_hisob WHERE id = ?').get(pattaId)).toEqual({ id: pattaId })
    expect(database.prepare(`
      SELECT entity_type FROM sync_tombstones WHERE entity_id IN (?, ?, ?)
      ORDER BY entity_type
    `).all(created.id, created.operation_snapshots[0]?.id, created.rows[0]?.id)).toHaveLength(3)
    expect(queue.pendingBatch(10, timestamp)).toMatchObject([{
      operation: 'DELETE', base_version: '4', entity_id: created.id
    }])
  })
})
