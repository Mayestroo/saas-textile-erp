import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { BadgeLocalRepository } from './badge-local.repository'
import { ModelLocalRepository } from './model-local.repository'
import { OfflinePattaService } from './offline-patta.service'
import type { Clock, LocalSyncQueueWriter } from './offline-patta.service'
import { LocalDomainError } from './local-errors'
import { PattaLocalRepository } from './patta-local.repository'
import { PattaNumberBlockRepository } from './patta-number-block.repository'
import type { LocalBlockConsumption } from './patta-number-block.repository'
import { LocalUnitOfWork } from './local-unit-of-work'
import { SyncQueueRepository } from './sync-queue.repository'
import { SyncStateRepository } from './sync-state.repository'
import { WorkerLocalRepository } from './worker-local.repository'

const temporaryDirectories: string[] = []
const openDatabases: Database.Database[] = []
const instant = '2026-09-21T12:00:00.000Z'

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-offline-patta-'))
  temporaryDirectories.push(directory)
  const database = openSqliteDatabase(join(directory, 'desktop.sqlite'))
  openDatabases.push(database)
  return database
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function seedReferenceData(database: Database.Database): void {
  database
    .prepare(
      `
    INSERT INTO models (id, name, status, version, created_at, updated_at, server_sequence)
    VALUES ('model-1', 'Atlas Model', 'ACTIVE', '7', ?, ?, '77')
  `
    )
    .run(instant, instant)
  const insertOperation = database.prepare(`
    INSERT INTO model_operations (
      id, model_id, name, sort_order, status, version, created_at, updated_at, server_sequence
    ) VALUES (?, 'model-1', ?, ?, 'ACTIVE', ?, ?, ?, '77')
  `)
  insertOperation.run('operation-1', 'Sewing', 0, '3', instant, instant)
  insertOperation.run('operation-2', 'Finishing', 1, '4', instant, instant)
  database
    .prepare(
      `
    INSERT INTO model_operation_prices (
      id, operation_id, price, valid_from, valid_to, created_at, server_sequence
    ) VALUES ('price-1-old', 'operation-1', '10.00', '2026-01-01T00:00:00.000000Z', ?, ?, '60')
  `
    )
    .run('2026-09-20T00:00:00.000000Z', instant)
  database
    .prepare(
      `
    INSERT INTO model_operation_prices (
      id, operation_id, price, valid_from, valid_to, created_at, server_sequence
    ) VALUES ('price-1-current', 'operation-1', '12.50', '2026-09-20T00:00:00.000000Z', NULL, ?, '77')
  `
    )
    .run(instant)
  database
    .prepare(
      `
    INSERT INTO model_operation_prices (
      id, operation_id, price, valid_from, valid_to, created_at, server_sequence
    ) VALUES ('price-2-current', 'operation-2', '20.00', '2026-01-01T00:00:00.000000Z', NULL, ?, '77')
  `
    )
    .run(instant)
  database
    .prepare(
      `
    INSERT INTO patta_templates (
      id, name, model_id, konveyer, razmer, rang, status, version,
      created_at, updated_at, server_sequence
    ) VALUES ('template-1', 'Atlas Template', 'model-1', 'Line A', 'M', 'Navy',
      'ACTIVE', '2', ?, ?, '77')
  `
    )
    .run(instant, instant)
}

function seedBlock(
  database: Database.Database,
  input: {
    id: string
    rangeStart: string
    rangeEnd: string
    reportedUsedCount?: string
    localNextNumber?: string
    localConsumedCount?: string
    localRole?: 'CURRENT' | 'RESERVED' | 'AVAILABLE'
  }
): void {
  const reportedUsedCount = input.reportedUsedCount ?? '0'
  const localNextNumber =
    input.localNextNumber ?? String(BigInt(input.rangeStart) + BigInt(reportedUsedCount))
  const localConsumedCount = input.localConsumedCount ?? reportedUsedCount
  database
    .prepare(
      `
    INSERT INTO patta_number_blocks (
      id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
      local_next_number, local_consumed_count, local_role, server_sequence
    ) VALUES (?, 'device-1', ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, '77')
  `
    )
    .run(
      input.id,
      input.rangeStart,
      input.rangeEnd,
      reportedUsedCount,
      instant,
      localNextNumber,
      localConsumedCount,
      input.localRole ?? 'AVAILABLE'
    )
}

function makeIds(): () => string {
  let next = 1
  return () => {
    const id = `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`
    next += 1
    return id
  }
}

function createService(
  database: Database.Database,
  queue: LocalSyncQueueWriter = new SyncQueueRepository(database),
  clock: Clock = { nowIsoUtc: () => instant },
  idFactory: () => string = makeIds()
): OfflinePattaService {
  return new OfflinePattaService({
    unitOfWork: new LocalUnitOfWork(database),
    blockRepository: new PattaNumberBlockRepository(database, 'device-1'),
    modelRepository: new ModelLocalRepository(database),
    pattaRepository: new PattaLocalRepository(database),
    syncQueueRepository: queue,
    syncStateRepository: new SyncStateRepository(database),
    deviceId: 'device-1',
    clock,
    idFactory
  })
}

describe('local reference repositories', () => {
  it('resolves a badge assignment by its effective timestamp and returns the permanent worker ID', () => {
    const database = createDatabase()
    const insertWorker = database.prepare(`
      INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
      VALUES (?, ?, 'ACTIVE', '1', ?, ?)
    `)
    insertWorker.run('worker-old', 'Old Worker', instant, instant)
    insertWorker.run('worker-new', 'New Worker', instant, instant)
    const insertBadge = database.prepare(`
      INSERT INTO worker_badge_history (
        id, badge_number, worker_id, valid_from, valid_to, created_at
      ) VALUES (?, '00125', ?, ?, ?, ?)
    `)
    insertBadge.run(
      'badge-old',
      'worker-old',
      '2026-01-01T00:00:00.000000Z',
      '2026-09-10T00:00:00.000000Z',
      instant
    )
    insertBadge.run('badge-new', 'worker-new', '2026-09-10T00:00:00.000000Z', null, instant)

    const badges = new BadgeLocalRepository(database)
    expect(badges.resolveWorker('00125', '2026-09-09T23:59:59.999Z')).toMatchObject({
      worker_id: 'worker-old',
      full_name: 'Old Worker'
    })
    expect(badges.resolveWorker('00125', '2026-09-10T00:00:00.000Z')).toMatchObject({
      worker_id: 'worker-new',
      full_name: 'New Worker'
    })
    expect(badges.resolveWorker('MISSING', instant)).toBeNull()
    expect(new WorkerLocalRepository(database).getById('worker-old')).toMatchObject({
      id: 'worker-old',
      full_name: 'Old Worker'
    })
  })

  it('resolves historical decimal prices from effective intervals without reading mutable operation prices', () => {
    const database = createDatabase()
    seedReferenceData(database)
    const models = new ModelLocalRepository(database)
    const beforeChange = models.snapshotAt({
      model_id: 'model-1',
      konveyer: 'Line A',
      occurred_at: '2026-09-19T23:59:59.999Z'
    })
    const atChange = models.snapshotAt({
      model_id: 'model-1',
      konveyer: 'Line A',
      occurred_at: '2026-09-20T00:00:00.000Z'
    })

    expect(beforeChange.operations.map(({ unit_price }) => unit_price)).toEqual(['10.00', '20.00'])
    expect(atChange.operations.map(({ unit_price }) => unit_price)).toEqual(['12.50', '20.00'])
    expect(atChange.reference_versions).toEqual({
      model: '7',
      template: null,
      operations: { 'operation-1': '3', 'operation-2': '4' }
    })
    expect(database.prepare(`PRAGMA table_info('model_operations')`).all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'price' })])
    )
  })

  it('promotes reserved blocks, exhausts inclusive ranges, and leaves server usage untouched', () => {
    const database = createDatabase()
    seedBlock(database, {
      id: 'block-current',
      rangeStart: '10',
      rangeEnd: '14',
      localRole: 'CURRENT'
    })
    seedBlock(database, {
      id: 'block-reserved',
      rangeStart: '100',
      rangeEnd: '102',
      localRole: 'RESERVED'
    })
    const unitOfWork = new LocalUnitOfWork(database)
    const blocks = new PattaNumberBlockRepository(database, 'device-1')
    const consume = (): LocalBlockConsumption => unitOfWork.transaction(() => blocks.consumeNext())

    expect(consume()).toMatchObject({
      blockId: 'block-current',
      pattaNumber: '10',
      shouldPrefetch: false
    })
    expect(consume()).toMatchObject({
      blockId: 'block-current',
      pattaNumber: '11',
      shouldPrefetch: false
    })
    expect(consume()).toMatchObject({
      blockId: 'block-current',
      pattaNumber: '12',
      shouldPrefetch: false
    })
    expect(consume()).toMatchObject({
      blockId: 'block-current',
      pattaNumber: '13',
      shouldPrefetch: true
    })
    expect(consume()).toMatchObject({
      blockId: 'block-current',
      pattaNumber: '14',
      shouldPrefetch: true
    })
    expect(consume()).toMatchObject({ blockId: 'block-reserved', pattaNumber: '100' })
    expect(consume()).toMatchObject({ blockId: 'block-reserved', pattaNumber: '101' })
    expect(consume()).toMatchObject({
      blockId: 'block-reserved',
      pattaNumber: '102',
      shouldPrefetch: true
    })
    let exhaustionError: unknown
    try {
      consume()
    } catch (error) {
      exhaustionError = error
    }
    expect(exhaustionError).toBeInstanceOf(LocalDomainError)
    expect(exhaustionError).toMatchObject({ code: 'PATTA_NUMBER_BLOCKS_EXHAUSTED' })
    expect(
      database.prepare(`SELECT reported_used_count FROM patta_number_blocks ORDER BY id`).all()
    ).toEqual([{ reported_used_count: '0' }, { reported_used_count: '0' }])
  })

  it('never moves an advanced local next number backwards when server usage is lower', () => {
    const database = createDatabase()
    seedBlock(database, {
      id: 'block-progress',
      rangeStart: '20',
      rangeEnd: '24',
      reportedUsedCount: '1',
      localNextNumber: '23',
      localConsumedCount: '3',
      localRole: 'CURRENT'
    })
    const unitOfWork = new LocalUnitOfWork(database)
    const blocks = new PattaNumberBlockRepository(database, 'device-1')

    expect(unitOfWork.transaction(() => blocks.consumeNext())).toEqual({
      blockId: 'block-progress',
      pattaNumber: '23',
      shouldPrefetch: true
    })
    expect(
      database
        .prepare(
          `
      SELECT local_next_number, local_consumed_count, reported_used_count
      FROM patta_number_blocks WHERE id = 'block-progress'
    `
        )
        .get()
    ).toEqual({
      local_next_number: '24',
      local_consumed_count: '4',
      reported_used_count: '1'
    })
  })

  it('allocates unique numbers from a shared SQLite file across independent connections', async () => {
    const firstDatabase = createDatabase()
    const directory = temporaryDirectories.at(-1)
    if (!directory) throw new Error('Expected a temporary database directory')
    const secondDatabase = openSqliteDatabase(join(directory, 'desktop.sqlite'))
    openDatabases.push(secondDatabase)
    seedBlock(firstDatabase, {
      id: 'block-shared',
      rangeStart: '1000',
      rangeEnd: '1050',
      localRole: 'CURRENT'
    })
    const allocators = [firstDatabase, secondDatabase].map((database) => {
      const unitOfWork = new LocalUnitOfWork(database)
      const blockRepository = new PattaNumberBlockRepository(database, 'device-1')
      return () => unitOfWork.transaction(() => blockRepository.consumeNext().pattaNumber)
    })

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() => allocators[index % allocators.length]?.())
      )
    )
    expect(new Set(results).size).toBe(20)
    expect(
      results.every(
        (value) => value !== undefined && BigInt(value) >= 1000n && BigInt(value) <= 1050n
      )
    ).toBe(true)
  })
})

describe('offline Patta creation', () => {
  it('commits a local Patta, immutable snapshots, and stable queue event atomically', () => {
    const database = createDatabase()
    seedReferenceData(database)
    seedBlock(database, {
      id: 'block-1',
      rangeStart: '100',
      rangeEnd: '109',
      localRole: 'CURRENT'
    })
    const state = new SyncStateRepository(database)
    state.setLastServerCursor('77', instant)
    const service = createService(database)

    const result = service.create({
      partiya_number: '  PARTY   1  ',
      template_id: 'template-1',
      konveyer: 'Line B',
      razmer: null,
      occurred_at: instant
    })

    expect(result.should_prefetch).toBe(false)
    expect(result.patta).toMatchObject({
      partiya_number: 'PARTY 1',
      patta_number: '100',
      model_id: 'model-1',
      model_name_snapshot: 'Atlas Model',
      template_id: 'template-1',
      konveyer_snapshot: 'Line B',
      razmer: null,
      rang: 'Navy',
      created_device_id: 'device-1',
      ownership_state: 'LOCAL_PENDING'
    })
    expect(result.patta.operations.map(({ unit_price_snapshot }) => unit_price_snapshot)).toEqual([
      '12.50',
      '20.00'
    ])
    const event = new SyncQueueRepository(database).pendingBatch(10, instant)[0]
    expect(event).toMatchObject({
      entity_type: 'patta',
      entity_id: result.patta.id,
      base_version: '0',
      reference_cursor: '77',
      payload: {
        block_id: 'block-1',
        template_overrides: { konveyer: 'Line B', razmer: null },
        reference_versions: {
          model: '7',
          template: '2',
          operations: { 'operation-1': '3', 'operation-2': '4' }
        },
        operations: result.patta.operations
      }
    })
    expect(
      database
        .prepare(
          `
      SELECT local_next_number, local_consumed_count, reported_used_count
      FROM patta_number_blocks WHERE id = 'block-1'
    `
        )
        .get()
    ).toEqual({
      local_next_number: '101',
      local_consumed_count: '1',
      reported_used_count: '0'
    })
  })

  it('rolls back the Patta and local block consumption when queue persistence fails', () => {
    const database = createDatabase()
    seedReferenceData(database)
    seedBlock(database, {
      id: 'block-1',
      rangeStart: '100',
      rangeEnd: '109',
      localRole: 'CURRENT'
    })
    new SyncStateRepository(database).setLastServerCursor('77', instant)
    const failingQueue: LocalSyncQueueWriter = {
      enqueue: () => {
        throw new Error('injected queue persistence failure')
      }
    }
    const service = createService(database, failingQueue)

    expect(() =>
      service.create({
        partiya_number: 'PARTY-1',
        model_id: 'model-1',
        konveyer: 'Line A',
        occurred_at: instant
      })
    ).toThrow('injected queue persistence failure')
    expect(database.prepare('SELECT id FROM patta_hisob').all()).toEqual([])
    expect(database.prepare('SELECT id FROM patta_operation_snapshots').all()).toEqual([])
    expect(
      database
        .prepare(
          `
      SELECT local_next_number, local_consumed_count
      FROM patta_number_blocks WHERE id = 'block-1'
    `
        )
        .get()
    ).toEqual({ local_next_number: '100', local_consumed_count: '0' })
    expect(database.prepare('SELECT event_id FROM sync_queue').all()).toEqual([])
  })
})
