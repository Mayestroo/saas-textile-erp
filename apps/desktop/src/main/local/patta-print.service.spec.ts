import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { SyncProjectionV2, SyncPushResult } from '@textile/sync-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { LocalUnitOfWork } from './local-unit-of-work'
import { ModelLocalRepository } from './model-local.repository'
import { PattaNumberBlockRepository } from './patta-number-block.repository'
import { PattaPartiyaNumberBlockRepository } from './patta-partiya-number-block.repository'
import { PattaPrintBatchRepository } from './patta-print-batch.repository'
import { PattaPrintService } from './patta-print.service'
import type { PattaPrintQueueWriter } from './patta-print.service'
import { SyncQueueRepository } from './sync-queue.repository'
import { SyncStateRepository } from './sync-state.repository'

const directories: string[] = []
const databases: Database.Database[] = []
const instant = '2026-09-28T10:00:00.000Z'

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-print-batch-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'tenant.sqlite'))
  databases.push(database)
  return database
}

function seedReferenceData(database: Database.Database): void {
  database.prepare(`
    INSERT INTO models (id, name, status, version, created_at, updated_at, server_sequence)
    VALUES ('model-1', 'Atlas', 'ACTIVE', '4', ?, ?, '77')
  `).run(instant, instant)
  const insertOperation = database.prepare(`
    INSERT INTO model_operations (
      id, model_id, name, sort_order, status, version, created_at, updated_at, server_sequence
    ) VALUES (?, 'model-1', ?, ?, 'ACTIVE', '1', ?, ?, '77')
  `)
  insertOperation.run('operation-1', 'Tikish', 0, instant, instant)
  insertOperation.run('operation-2', 'Qadoqlash', 1, instant, instant)
  const insertPrice = database.prepare(`
    INSERT INTO model_operation_prices (id, operation_id, price, valid_from, created_at, server_sequence)
    VALUES (?, ?, ?, '2026-01-01T00:00:00.000000Z', ?, '77')
  `)
  insertPrice.run('price-1', 'operation-1', '1000.00', instant)
  insertPrice.run('price-2', 'operation-2', '250.00', instant)
  database.prepare(`
    INSERT INTO patta_number_blocks (
      id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
      local_next_number, local_consumed_count, local_role
    ) VALUES ('patta-block', 'device-1', '1', '10', '0', 'ACTIVE', ?, '1', '0', 'CURRENT')
  `).run(instant)
  database.prepare(`
    INSERT INTO patta_partiya_number_blocks (
      id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
      local_next_number, local_consumed_count, local_role
    ) VALUES ('partiya-block', 'device-1', '100', '110', '0', 'ACTIVE', ?, '100', '0', 'CURRENT')
  `).run(instant)
  new SyncStateRepository(database).setLastServerCursor('77', instant)
}

function createService(
  database: Database.Database,
  queue: PattaPrintQueueWriter = new SyncQueueRepository(database),
  idFactory = createIdFactory()
): PattaPrintService {
  return new PattaPrintService({
    unitOfWork: new LocalUnitOfWork(database),
    partiyaBlocks: new PattaPartiyaNumberBlockRepository(database, 'device-1'),
    pattaBlocks: new PattaNumberBlockRepository(database, 'device-1'),
    modelRepository: new ModelLocalRepository(database),
    batchRepository: new PattaPrintBatchRepository(database),
    queueRepository: queue,
    syncStateRepository: new SyncStateRepository(database),
    deviceId: 'device-1',
    clock: { nowIsoUtc: () => instant },
    idFactory
  })
}

function createIdFactory(): () => string {
  let value = 1
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PattaPrintService', () => {
  it('writes Partiya, Pattas, product quantity, snapshots and one stable v2 event atomically offline', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const service = createService(database)

    const result = service.createBatch({
      model_id: 'model-1',
      ish_soni: 125,
      rang: ' Qora  rang ',
      size_distribution: [
        { razmer: 'S', patta_count: 1, sort_order: 1 },
        { razmer: 'XS', patta_count: 1, sort_order: 0 }
      ]
    })

    expect(result.batch).toMatchObject({
      partiya_number: '100',
      partiya_block_id: 'partiya-block',
      ish_soni: 125,
      rang: 'Qora rang',
      status: 'ACTIVE',
      printed_at: null
    })
    expect(result.batch.size_distribution.map(({ razmer }) => razmer)).toEqual(['XS', 'S'])
    expect(result.batch.pattas.map(({ patta_number, ish_soni, legacy_operation_count }) =>
      [patta_number, ish_soni, legacy_operation_count])).toEqual([
      ['1', 125, null],
      ['2', 125, null]
    ])
    expect(result.batch.pattas.every(({ operations }) => operations.length === 2)).toBe(true)
    const event = new SyncQueueRepository(database).pendingBatch(10, instant)[0]
    expect(event).toMatchObject({
      entity_type: 'patta_print_batch',
      operation: 'CREATE',
      base_version: '0',
      reference_cursor: '77',
      payload: {
        model_id: 'model-1',
        model_name_snapshot: 'Atlas',
        ish_soni: 125,
        partiya_number: '100',
        size_distribution: [{ razmer: 'XS', patta_count: 1 }, { razmer: 'S', patta_count: 1 }],
        pattas: [{ patta_number: '1', block_id: 'patta-block' }, { patta_number: '2', block_id: 'patta-block' }]
      }
    })
    expect(new PattaPrintBatchRepository(database).getById(result.batch.id)).toMatchObject(result.batch)
    expect(database.prepare(`
      SELECT ish_soni, legacy_operation_count FROM patta_hisob ORDER BY patta_number
    `).all()).toEqual([
      { ish_soni: 125, legacy_operation_count: null },
      { ish_soni: 125, legacy_operation_count: null }
    ])
    if (!event || event.entity_type !== 'patta_print_batch') throw new Error('Expected a v2 batch queue event')
    const queue = new SyncQueueRepository(database)
    expect(queue.markSyncing([event.event_id], instant)).toBe(1)
    const serverBatch = { ...result.batch, version: '1', created_by: 'server-user' }
    const projection: SyncProjectionV2 = {
      projection_version: 2,
      entity_type: 'patta_print_batches',
      entity_id: serverBatch.id,
      entity_version: '1',
      data: serverBatch
    }
    const pushResult: Extract<SyncPushResult, { status: 'SYNCED' }> = {
      event_id: event.event_id,
      status: 'SYNCED',
      entity_version: '1',
      projection,
      change_sequence: '88'
    }
    expect(queue.markSynced(event.event_id, pushResult, instant)).toBe(true)
    expect(database.prepare('SELECT ownership_state, version, server_sequence FROM patta_print_batches WHERE id = ?')
      .get(result.batch.id)).toEqual({ ownership_state: 'SERVER_SYNCED', version: '1', server_sequence: '88' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_hisob WHERE print_batch_id = ? AND ownership_state = ?')
      .get(result.batch.id, 'SERVER_SYNCED')).toEqual({ count: 2 })
  })

  it('retains correction reason and block identity in a v2 UPDATE queue event', () => {
    const database = createDatabase()
    seedReferenceData(database)
    createService(database).createBatch({
      model_id: 'model-1', ish_soni: 125, rang: 'Qora',
      size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }]
    })
    const queue = new SyncQueueRepository(database)
    const original = queue.pendingBatch(10, instant)[0]
    if (!original || original.entity_type !== 'patta_print_batch') throw new Error('Expected queued print batch')
    const correction = {
      ...original,
      event_id: '77777777-7777-4777-8777-777777777777',
      operation: 'UPDATE' as const,
      base_version: '1',
      payload: { ...original.payload, correction_reason: 'Razmer taqsimoti aniqlandi' }
    }

    expect(() => queue.enqueue(correction)).not.toThrow()
    expect(queue.pendingBatch(10, instant).find(({ event_id }) => event_id === correction.event_id)).toMatchObject({
      operation: 'UPDATE',
      base_version: '1',
      payload: {
        correction_reason: 'Razmer taqsimoti aniqlandi',
        pattas: [{ block_id: 'patta-block' }]
      }
    })
    expect(() => queue.enqueue({
      ...correction,
      event_id: '88888888-8888-4888-8888-888888888888',
      payload: { ...correction.payload, correction_reason: undefined }
    })).toThrow(/correction reason/)
  })

  it('coalesces corrections made before the initial batch has ever been sent', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const service = createService(database)
    const queue = new SyncQueueRepository(database)
    const created = service.createBatch({
      model_id: 'model-1', ish_soni: 125, rang: 'Qora',
      size_distribution: [
        { razmer: 'XS', patta_count: 1, sort_order: 0 },
        { razmer: 'S', patta_count: 1, sort_order: 1 }
      ]
    })
    const originalEvent = queue.pendingBatch(10, instant)[0]
    if (!originalEvent || originalEvent.entity_type !== 'patta_print_batch') throw new Error('Expected initial batch event')

    const corrected = service.correctBatch({
      batch_id: created.batch.id,
      expected_version: '0',
      correction_reason: 'Razmer qayta tekshirildi',
      ish_soni: 125,
      rang: 'Qora',
      size_distribution: [{ razmer: 'S', patta_count: 3, sort_order: 0 }]
    })
    const pending = queue.pendingBatch(10, instant)

    expect(corrected.batch).toMatchObject({ version: '0', revision: 1 })
    expect(corrected.batch.pattas.map(({ patta_number, razmer, status }) => [patta_number, razmer, status])).toEqual([
      ['1', 'S', 'ACTIVE'], ['2', 'S', 'ACTIVE'], ['3', 'S', 'ACTIVE']
    ])
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ event_id: originalEvent.event_id, operation: 'CREATE', base_version: '0' })
    if (!pending[0] || pending[0].entity_type !== 'patta_print_batch') throw new Error('Expected coalesced CREATE event')
    expect(pending[0].payload.correction_reason).toBeUndefined()
    expect(pending[0].payload.pattas.map(({ patta_number }) => patta_number)).toEqual(['1', '2', '3'])
    expect(database.prepare('SELECT local_next_number FROM patta_number_blocks WHERE id = ?').get('patta-block'))
      .toEqual({ local_next_number: '4' })
  })

  it('retains VOID numbers and coalesces unsent offline corrections into one versioned UPDATE', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const service = createService(database)
    const queue = new SyncQueueRepository(database)
    const created = service.createBatch({
      model_id: 'model-1', ish_soni: 125, rang: 'Qora',
      size_distribution: [
        { razmer: 'XS', patta_count: 1, sort_order: 0 },
        { razmer: 'S', patta_count: 1, sort_order: 1 }
      ]
    })
    database.prepare(`
      UPDATE sync_queue SET status = 'SYNCED' WHERE entity_type = 'patta_print_batch' AND entity_id = ?
    `).run(created.batch.id)
    database.prepare(`
      UPDATE patta_print_batches SET version = '1', ownership_state = 'SERVER_SYNCED'
      WHERE id = ?
    `).run(created.batch.id)
    database.prepare(`
      UPDATE patta_hisob SET version = '1', ownership_state = 'SERVER_SYNCED'
      WHERE print_batch_id = ?
    `).run(created.batch.id)
    database.prepare(`
      UPDATE patta_print_batch_sizes SET ownership_state = 'SERVER_SYNCED' WHERE print_batch_id = ?
    `).run(created.batch.id)
    database.prepare(`
      UPDATE patta_operation_snapshots SET ownership_state = 'SERVER_SYNCED'
      WHERE patta_hisob_id IN (SELECT id FROM patta_hisob WHERE print_batch_id = ?)
    `).run(created.batch.id)

    const firstCorrection = service.correctBatch({
      batch_id: created.batch.id,
      expected_version: '1',
      correction_reason: 'XS taqsimoti olib tashlandi',
      ish_soni: 125,
      rang: 'Qora',
      size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }]
    })
    const firstVoid = firstCorrection.batch.pattas.find(({ patta_number }) => patta_number === '1')
    expect(firstVoid?.status).toBe('VOID')
    const firstPending = queue.pendingBatch(10, instant)[0]
    if (!firstPending || firstPending.entity_type !== 'patta_print_batch') throw new Error('Expected correction UPDATE')

    const secondCorrection = service.correctBatch({
      batch_id: created.batch.id,
      expected_version: '2',
      correction_reason: 'S soni oshirildi',
      ish_soni: 125,
      rang: 'Qora',
      size_distribution: [{ razmer: 'S', patta_count: 2, sort_order: 0 }]
    })
    const secondPending = queue.pendingBatch(10, instant)
    const newPatta = secondCorrection.batch.pattas.find(({ patta_number }) => patta_number === '3')

    expect(secondCorrection.batch).toMatchObject({ version: '2', revision: 2 })
    expect(newPatta).toMatchObject({ status: 'ACTIVE', created_from_block_id: 'patta-block' })
    expect(secondCorrection.batch.pattas.find(({ patta_number }) => patta_number === '1')?.status).toBe('VOID')
    expect(secondPending).toHaveLength(1)
    expect(secondPending[0]?.event_id).toBe(firstPending.event_id)
    expect(secondPending[0]?.base_version).toBe('1')
    const coalescedCorrection = secondPending[0]
    if (!coalescedCorrection || coalescedCorrection.entity_type !== 'patta_print_batch') {
      throw new Error('Expected a coalesced print batch correction')
    }
    expect(coalescedCorrection.payload.correction_reason).toBe('S soni oshirildi')
    expect(database.prepare('SELECT local_next_number FROM patta_number_blocks WHERE id = ?').get('patta-block'))
      .toEqual({ local_next_number: '4' })
    expect(queue.markSyncing([coalescedCorrection.event_id], instant)).toBe(1)
    const serverBatch = { ...secondCorrection.batch, created_by: 'server-user' }
    const result: Extract<SyncPushResult, { status: 'SYNCED' }> = {
      event_id: coalescedCorrection.event_id,
      status: 'SYNCED',
      entity_version: serverBatch.version,
      projection: {
        projection_version: 2,
        entity_type: 'patta_print_batches',
        entity_id: serverBatch.id,
        entity_version: serverBatch.version,
        data: serverBatch
      },
      change_sequence: '88'
    }
    expect(queue.markSynced(coalescedCorrection.event_id, result, instant)).toBe(true)
    expect(database.prepare(`
      SELECT id, status, version, ownership_state FROM patta_hisob WHERE print_batch_id = ? ORDER BY patta_number
    `).all(created.batch.id)).toEqual([
      { id: secondCorrection.batch.pattas.find(({ patta_number }) => patta_number === '1')?.id, status: 'VOID', version: '2', ownership_state: 'SERVER_SYNCED' },
      { id: secondCorrection.batch.pattas.find(({ patta_number }) => patta_number === '2')?.id, status: 'ACTIVE', version: '2', ownership_state: 'SERVER_SYNCED' },
      { id: newPatta?.id, status: 'ACTIVE', version: '1', ownership_state: 'SERVER_SYNCED' }
    ])
  })

  it('rolls back both number blocks and all batch rows when queue persistence fails', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const failingQueue = { enqueue: () => { throw new Error('injected queue failure') } }
    const service = createService(database, failingQueue)

    expect(() => service.createBatch({
      model_id: 'model-1',
      ish_soni: 20,
      rang: 'Navy',
      size_distribution: [{ razmer: 'M', patta_count: 1, sort_order: 0 }]
    })).toThrow('injected queue failure')
    expect(database.prepare('SELECT id FROM patta_print_batches').all()).toEqual([])
    expect(database.prepare('SELECT id FROM patta_hisob').all()).toEqual([])
    expect(database.prepare('SELECT local_next_number FROM patta_number_blocks WHERE id = ?').get('patta-block'))
      .toEqual({ local_next_number: '1' })
    expect(database.prepare('SELECT local_next_number FROM patta_partiya_number_blocks WHERE id = ?').get('partiya-block'))
      .toEqual({ local_next_number: '100' })
  })

  it('stores append-only print-attempt events and preserves the first successful printed_at', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const service = createService(database)
    const created = service.createBatch({
      model_id: 'model-1', ish_soni: 12, rang: 'Navy',
      size_distribution: [{ razmer: 'M', patta_count: 1, sort_order: 0 }]
    })

    const requested = service.recordPrintEvent({
      batch_id: created.batch.id, revision: 1, kind: 'INITIAL', outcome: 'REQUESTED'
    })
    const firstSuccess = service.recordPrintEvent({
      batch_id: created.batch.id, revision: 1, kind: 'INITIAL', outcome: 'SUCCEEDED'
    })
    const reprintFailure = service.recordPrintEvent({
      batch_id: created.batch.id, revision: 1, kind: 'REPRINT', outcome: 'FAILED'
    })

    expect(requested.printed_at).toBeNull()
    expect(firstSuccess.printed_at).toBe(instant)
    expect(reprintFailure.printed_at).toBe(instant)
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_print_events WHERE batch_id = ?')
      .get(created.batch.id)).toEqual({ count: 3 })
    expect(database.prepare('SELECT printed_at FROM patta_print_batches WHERE id = ?')
      .get(created.batch.id)).toEqual({ printed_at: instant })
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_hisob WHERE print_batch_id = ?')
      .get(created.batch.id)).toEqual({ count: 1 })
    const queuedEvents = new SyncQueueRepository(database).pendingBatch(10, instant)
    expect(queuedEvents.map((event) => event.entity_type)).toEqual([
      'patta_print_batch', 'patta_print_event', 'patta_print_event', 'patta_print_event'
    ])
    expect(new Set(queuedEvents.map(({ event_id }) => event_id)).size).toBe(4)
  })

  it('rejects invalid product quantities and duplicate sizes before allocating any offline numbers', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const service = createService(database)

    expect(() => service.createBatch({
      model_id: 'model-1', ish_soni: 0, rang: 'Qora',
      size_distribution: [{ razmer: 'S', patta_count: 1, sort_order: 0 }]
    })).toThrow(/Ish soni/)
    expect(() => service.createBatch({
      model_id: 'model-1', ish_soni: 125, rang: 'Qora',
      size_distribution: [
        { razmer: 'S', patta_count: 1, sort_order: 0 },
        { razmer: ' S ', patta_count: 1, sort_order: 1 }
      ]
    })).toThrow(/Razmer taqsimoti/)
    expect(database.prepare('SELECT id FROM patta_print_batches').all()).toEqual([])
    expect(database.prepare('SELECT local_next_number FROM patta_number_blocks WHERE id = ?').get('patta-block'))
      .toEqual({ local_next_number: '1' })
  })
})
