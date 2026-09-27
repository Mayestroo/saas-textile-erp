import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  OfflinePattaCreateEvent,
  SyncConflict,
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncProjection
} from '@textile/sync-protocol'
import { openSqliteDatabase } from '../database/sqlite-database'
import { BootstrapStagingRepository } from './bootstrap-staging.repository'
import { LocalUnitOfWork } from './local-unit-of-work'
import { ReferenceMirrorRepository } from './reference-mirror.repository'
import { SyncConflictRepository } from './sync-conflict.repository'
import { SyncQueueRepository } from './sync-queue.repository'
import { SyncStateRepository } from './sync-state.repository'

const temporaryDirectories: string[] = []
const openDatabases: Database.Database[] = []
const timestamp = '2026-09-27T09:00:00.000Z'

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-repositories-'))
  temporaryDirectories.push(directory)
  const database = openSqliteDatabase(join(directory, 'desktop.sqlite'))
  openDatabases.push(database)
  return database
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makePattaEvent(): OfflinePattaCreateEvent {
  return {
    event_id: 'event-1',
    entity_type: 'patta',
    entity_id: 'patta-local',
    operation: 'CREATE',
    base_version: '0',
    client_created_at: timestamp,
    occurred_at: timestamp,
    reference_cursor: '7',
    payload: {
      partiya_number: 'PARTIYA-1',
      patta_number: '100',
      model_id: 'model-1',
      model_name_snapshot: 'Model 1',
      template_id: null,
      konveyer_snapshot: 'Konveyer 1',
      razmer: null,
      rang: null,
      block_id: 'block-1',
      reference_versions: { model: '1', template: null, operations: {} },
      operations: []
    }
  }
}

function makeProjections(): readonly SyncProjection[] {
  return [
    {
      projection_version: 1,
      entity_type: 'workers',
      entity_id: 'worker-1',
      entity_version: '1',
      data: {
        id: 'worker-1',
        full_name: 'Worker One',
        status: 'ACTIVE',
        version: '1',
        created_at: timestamp,
        updated_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'worker_badge_history',
      entity_id: 'badge-history-1',
      entity_version: null,
      data: {
        id: 'badge-history-1',
        badge_number: 'B-1',
        worker_id: 'worker-1',
        valid_from: timestamp,
        valid_to: null,
        created_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'models',
      entity_id: 'model-server',
      entity_version: '3',
      data: {
        id: 'model-server',
        name: 'Server Model',
        status: 'ACTIVE',
        version: '3',
        created_at: timestamp,
        updated_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'model_operations',
      entity_id: 'operation-server',
      entity_version: '2',
      data: {
        id: 'operation-server',
        model_id: 'model-server',
        name: 'Sewing',
        sort_order: 0,
        status: 'ACTIVE',
        version: '2',
        created_at: timestamp,
        updated_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'model_operation_prices',
      entity_id: 'price-server',
      entity_version: null,
      data: {
        id: 'price-server',
        operation_id: 'operation-server',
        price: '12.50',
        valid_from: timestamp,
        valid_to: null,
        created_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'patta_templates',
      entity_id: 'template-server',
      entity_version: '1',
      data: {
        id: 'template-server',
        name: 'Template',
        model_id: 'model-server',
        konveyer: 'Line 1',
        razmer: null,
        rang: null,
        status: 'ACTIVE',
        version: '1',
        created_at: timestamp,
        updated_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'patta_hisob',
      entity_id: 'patta-server',
      entity_version: '1',
      data: {
        id: 'patta-server',
        partiya_number: 'PARTIYA-SERVER',
        patta_number: '200',
        model_id: 'model-server',
        model_name_snapshot: 'Server Model',
        template_id: 'template-server',
        konveyer_snapshot: 'Line 1',
        razmer: null,
        rang: null,
        ish_soni: 1,
        created_device_id: 'device-1',
        created_from_block_id: 'block-existing',
        created_at: timestamp,
        client_created_at: timestamp,
        occurred_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'patta_operation_snapshots',
      entity_id: 'snapshot-server',
      entity_version: null,
      data: {
        id: 'snapshot-server',
        patta_hisob_id: 'patta-server',
        operation_id: 'operation-server',
        operation_name_snapshot: 'Sewing',
        unit_price_snapshot: '12.50',
        sort_order: 0,
        created_at: timestamp
      }
    },
    {
      projection_version: 1,
      entity_type: 'patta_number_blocks',
      entity_id: 'block-existing',
      entity_version: null,
      data: {
        id: 'block-existing',
        device_id: 'device-1',
        range_start: '100',
        range_end: '109',
        reported_used_count: '2',
        status: 'ACTIVE',
        allocated_at: timestamp,
        exhausted_at: null
      }
    },
    {
      projection_version: 1,
      entity_type: 'patta_number_blocks',
      entity_id: 'block-new',
      entity_version: null,
      data: {
        id: 'block-new',
        device_id: 'device-1',
        range_start: '200',
        range_end: '209',
        reported_used_count: '3',
        status: 'ACTIVE',
        allocated_at: timestamp,
        exhausted_at: null
      }
    }
  ]
}

function makeSession(watermark = '12'): SyncBootstrapSession {
  return {
    id: 'bootstrap-session-1',
    device_id: 'device-1',
    watermark,
    status: 'ACTIVE',
    expires_at: '2026-09-27T10:00:00.000Z'
  }
}

function makePage(
  sessionId: string,
  watermark: string,
  projections: readonly SyncProjection[],
  firstOrderKey: number,
  hasMore: boolean
): SyncBootstrapPage {
  const items = projections.map((projection, index) => ({
    order_key: String(firstOrderKey + index),
    projection
  }))
  return {
    session_id: sessionId,
    watermark,
    items,
    next_order_key: items.at(-1)?.order_key ?? null,
    has_more: hasMore
  }
}

function seedExistingMirrors(database: ReturnType<typeof openSqliteDatabase>): void {
  database
    .prepare(
      `
    INSERT INTO models (id, name, status, version, created_at, updated_at, server_sequence)
    VALUES ('model-server', 'Old Server Model', 'ACTIVE', '1', ?, ?, '8')
  `
    )
    .run(timestamp, timestamp)
  database
    .prepare(
      `
    INSERT INTO models (id, name, status, version, created_at, updated_at, server_sequence)
    VALUES ('model-local', 'Local Historical Model', 'ACTIVE', '1', ?, ?, '8')
  `
    )
    .run(timestamp, timestamp)
  database
    .prepare(
      `
    INSERT INTO models (id, name, status, version, created_at, updated_at, server_sequence)
    VALUES ('model-stale', 'Removed Model', 'ACTIVE', '1', ?, ?, '8')
  `
    )
    .run(timestamp, timestamp)
  database
    .prepare(
      `
    INSERT INTO model_operations
      (id, model_id, name, sort_order, status, version, created_at, updated_at, server_sequence)
    VALUES ('operation-local', 'model-local', 'Local Operation', 0, 'ACTIVE', '1', ?, ?, '8')
  `
    )
    .run(timestamp, timestamp)
  database
    .prepare(
      `
    INSERT INTO patta_number_blocks (
      id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
      local_next_number, local_consumed_count, local_role, server_sequence
    ) VALUES ('block-existing', 'device-1', '100', '109', '1', 'ACTIVE', ?, '108', '8', 'CURRENT', '8')
  `
    )
    .run(timestamp)
  database
    .prepare(
      `
    INSERT INTO patta_hisob (
      id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
      konveyer_snapshot, razmer, rang, ish_soni, created_device_id, created_from_block_id,
      created_at, client_created_at, occurred_at, version, ownership_state, server_sequence
    ) VALUES (
      'patta-stale', 'PARTIYA-STALE', '300', 'model-server', 'Server Model', NULL,
      'Line 1', NULL, NULL, 1, 'device-1', 'block-existing',
      ?, ?, ?, '1', 'SERVER_SYNCED', '8'
    )
  `
    )
    .run(timestamp, timestamp, timestamp)

  const insertLocalPatta = database.prepare(`
    INSERT INTO patta_hisob (
      id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
      konveyer_snapshot, razmer, rang, ish_soni, created_device_id, created_from_block_id,
      created_at, client_created_at, occurred_at, version, ownership_state
    ) VALUES (?, ?, ?, 'model-local', 'Local Historical Model', NULL, 'Line 2', NULL, NULL,
      1, 'device-1', NULL, ?, ?, ?, '0', ?)
  `)
  const insertLocalSnapshot = database.prepare(`
    INSERT INTO patta_operation_snapshots (
      id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
      sort_order, created_at, ownership_state
    ) VALUES (?, ?, 'operation-local', 'Local Operation', '5.00', 0, ?, ?)
  `)
  for (const [id, state] of [
    ['patta-pending', 'LOCAL_PENDING'],
    ['patta-conflict', 'CONFLICT'],
    ['patta-failed', 'FAILED']
  ] as const) {
    insertLocalPatta.run(
      id,
      `PARTIYA-${id}`,
      id === 'patta-pending' ? '401' : id === 'patta-conflict' ? '402' : '403',
      timestamp,
      timestamp,
      timestamp,
      state
    )
    insertLocalSnapshot.run(`snapshot-${id}`, id, timestamp, state)
  }
}

function repositories(database: Database.Database): {
  unitOfWork: LocalUnitOfWork
  stateRepository: SyncStateRepository
  stagingRepository: BootstrapStagingRepository
  mirrorRepository: ReferenceMirrorRepository
} {
  const unitOfWork = new LocalUnitOfWork(database)
  const stateRepository = new SyncStateRepository(database)
  const stagingRepository = new BootstrapStagingRepository(database, unitOfWork)
  const mirrorRepository = new ReferenceMirrorRepository(
    unitOfWork,
    stagingRepository,
    stateRepository
  )
  return { unitOfWork, stateRepository, stagingRepository, mirrorRepository }
}

describe('local sync repositories', () => {
  it('rolls back the business row and queue insertion together', () => {
    const database = createDatabase()
    const unitOfWork = new LocalUnitOfWork(database)
    const queueRepository = new SyncQueueRepository(database)
    const event = makePattaEvent()
    const insertLocalPatta = (connection: Database.Database): void => {
      connection
        .prepare(
          `
        INSERT INTO models (id, name, status, version, created_at, updated_at)
        VALUES ('model-1', 'Model 1', 'ACTIVE', '1', ?, ?)
      `
        )
        .run(timestamp, timestamp)
      connection
        .prepare(
          `
        INSERT INTO patta_number_blocks (
          id, device_id, range_start, range_end, reported_used_count,
          status, allocated_at, local_next_number, local_consumed_count, local_role
        ) VALUES ('block-1', 'device-1', '100', '109', '0', 'ACTIVE', ?, '100', '0', 'CURRENT')
      `
        )
        .run(timestamp)
      connection
        .prepare(
          `
        INSERT INTO patta_hisob (
          id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
          konveyer_snapshot, razmer, rang, ish_soni, created_device_id,
          created_from_block_id, created_at, client_created_at, occurred_at,
          version, ownership_state
        ) VALUES (
          ?, 'PARTIYA-1', '100', 'model-1', 'Model 1', NULL, 'Konveyer 1',
          NULL, NULL, 1, 'device-1', 'block-1', ?, ?, ?, '0', 'LOCAL_PENDING'
        )
      `
        )
        .run(event.entity_id, timestamp, timestamp, timestamp)
    }

    expect(() =>
      unitOfWork.transaction((connection) => {
        insertLocalPatta(connection)
        queueRepository.enqueue(event)
        throw new Error('injected local write failure')
      })
    ).toThrow('injected local write failure')

    expect(database.prepare('SELECT id FROM models').all()).toEqual([])
    expect(database.prepare('SELECT id FROM patta_number_blocks').all()).toEqual([])
    expect(database.prepare('SELECT id FROM patta_hisob').all()).toEqual([])
    expect(database.prepare('SELECT event_id FROM sync_queue').all()).toEqual([])

    unitOfWork.transaction((connection) => {
      insertLocalPatta(connection)
      queueRepository.enqueue(event)
    })
    unitOfWork.transaction(() => queueRepository.enqueue(event))
    expect(database.prepare('SELECT id FROM patta_hisob').all()).toEqual([{ id: event.entity_id }])
    expect(database.prepare('SELECT event_id FROM sync_queue').all()).toEqual([
      { event_id: event.event_id }
    ])
    expect(queueRepository.pendingBatch(10, timestamp)).toEqual([event])
    expect(queueRepository.markSyncing([event.event_id], timestamp)).toBe(1)
    expect(queueRepository.recoverStaleSyncing(timestamp)).toBe(1)
    expect(queueRepository.pendingBatch(10, timestamp)).toEqual([event])
    expect(
      database.prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?').get(event.entity_id)
    ).toEqual({ ownership_state: 'LOCAL_PENDING' })
    expect(() =>
      queueRepository.enqueue({
        ...event,
        payload: { ...event.payload, partiya_number: 'DIFFERENT-PARTIYA' }
      })
    ).toThrow('event_id is already bound to a different local event')
  })

  it('persists conflicts against their queue event and keeps resolved history', () => {
    const database = createDatabase()
    const unitOfWork = new LocalUnitOfWork(database)
    const queueRepository = new SyncQueueRepository(database)
    const conflictRepository = new SyncConflictRepository(database)
    const event = makePattaEvent()
    const conflict: SyncConflict = {
      code: 'PATTA_ALREADY_EXISTS',
      message: 'Patta already exists',
      details: { patta_number: '100' },
      local_payload: event.payload,
      server_payload: { id: event.entity_id }
    }
    unitOfWork.transaction(() => {
      queueRepository.enqueue(event)
      conflictRepository.persist(event.event_id, conflict, timestamp)
    })

    expect(conflictRepository.open()).toEqual([
      expect.objectContaining({
        event_id: event.event_id,
        code: conflict.code,
        local_payload: conflict.local_payload,
        server_payload: conflict.server_payload,
        resolution_state: 'OPEN'
      })
    ])
    expect(queueRepository.countByStatus('CONFLICT')).toBe(1)
    expect(conflictRepository.resolve(event.event_id, timestamp)).toBe(true)
    expect(conflictRepository.open()).toEqual([])
    expect(
      database
        .prepare('SELECT resolution_state FROM sync_conflicts WHERE event_id = ?')
        .get(event.event_id)
    ).toEqual({ resolution_state: 'RESOLVED' })
  })

  it('stages pages idempotently without changing the live mirror or cursor', () => {
    const database = createDatabase()
    const { stateRepository, stagingRepository } = repositories(database)
    const session = makeSession('9')
    const model = makeProjections()[2]
    if (!model || model.entity_type !== 'models') throw new Error('Expected a model projection')

    stateRepository.setLastServerCursor('8', timestamp)
    stagingRepository.beginSession(session, timestamp)
    const page = makePage(session.id, session.watermark, [model], 1, true)
    stagingRepository.persistPage(page, timestamp)
    stagingRepository.persistPage(page, timestamp)

    expect(database.prepare('SELECT COUNT(*) AS count FROM bootstrap_items').get()).toEqual({
      count: 1
    })
    expect(database.prepare('SELECT id FROM models').all()).toEqual([])
    expect(stateRepository.lastServerCursor()).toBe('8')

    const differentModel: SyncProjection = {
      ...model,
      entity_id: 'model-different',
      data: { ...model.data, id: 'model-different', name: 'Different Model' }
    }
    const conflictingReplay = makePage(session.id, session.watermark, [differentModel], 1, true)
    expect(() => stagingRepository.persistPage(conflictingReplay, timestamp)).toThrow(
      'bootstrap order key is already staged with different data'
    )
    expect(database.prepare('SELECT COUNT(*) AS count FROM bootstrap_items').get()).toEqual({
      count: 1
    })
    expect(stagingRepository.currentSession()?.next_order_key).toBe('1')
    expect(stateRepository.lastServerCursor()).toBe('8')
  })

  it('finalizes all nine mirror types atomically and preserves local ownership and block progress', () => {
    const database = createDatabase()
    seedExistingMirrors(database)
    const { stateRepository, stagingRepository, mirrorRepository } = repositories(database)
    const session = makeSession()
    const projections = makeProjections()
    stateRepository.setLastServerCursor('8', timestamp)
    stagingRepository.beginSession(session, timestamp)
    stagingRepository.persistPage(
      makePage(session.id, session.watermark, projections.slice(0, 5), 1, true),
      timestamp
    )
    stagingRepository.persistPage(
      makePage(session.id, session.watermark, projections.slice(5), 6, false),
      timestamp
    )

    expect(mirrorRepository.finalizeBootstrap(session.id, session.watermark, timestamp)).toEqual({
      session_id: session.id,
      status: 'COMPLETED',
      already_completed: false
    })

    expect(database.prepare('SELECT name FROM models WHERE id = ?').get('model-server')).toEqual({
      name: 'Server Model'
    })
    expect(database.prepare('SELECT id FROM worker_badge_history').all()).toEqual([
      { id: 'badge-history-1' }
    ])
    expect(database.prepare('SELECT price FROM model_operation_prices').get()).toEqual({
      price: '12.50'
    })
    expect(database.prepare('SELECT id FROM patta_templates').all()).toEqual([
      { id: 'template-server' }
    ])
    expect(
      database.prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?').get('patta-server')
    ).toEqual({ ownership_state: 'SERVER_SYNCED' })
    expect(
      database
        .prepare('SELECT ownership_state FROM patta_operation_snapshots WHERE id = ?')
        .get('snapshot-server')
    ).toEqual({ ownership_state: 'SERVER_SYNCED' })

    const localPattaStates = database
      .prepare(`SELECT id, ownership_state FROM patta_hisob WHERE id LIKE 'patta-%' ORDER BY id`)
      .all()
    expect(localPattaStates).toEqual([
      { id: 'patta-conflict', ownership_state: 'CONFLICT' },
      { id: 'patta-failed', ownership_state: 'FAILED' },
      { id: 'patta-pending', ownership_state: 'LOCAL_PENDING' },
      { id: 'patta-server', ownership_state: 'SERVER_SYNCED' },
      { id: 'patta-stale', ownership_state: 'SERVER_SYNCED' }
    ])
    expect(
      database
        .prepare(
          `SELECT patta_hisob_id, ownership_state FROM patta_operation_snapshots ORDER BY patta_hisob_id`
        )
        .all()
    ).toEqual([
      { patta_hisob_id: 'patta-conflict', ownership_state: 'CONFLICT' },
      { patta_hisob_id: 'patta-failed', ownership_state: 'FAILED' },
      { patta_hisob_id: 'patta-pending', ownership_state: 'LOCAL_PENDING' },
      { patta_hisob_id: 'patta-server', ownership_state: 'SERVER_SYNCED' }
    ])

    expect(
      database
        .prepare(
          'SELECT local_next_number, local_consumed_count, local_role FROM patta_number_blocks WHERE id = ?'
        )
        .get('block-existing')
    ).toEqual({ local_next_number: '108', local_consumed_count: '8', local_role: 'CURRENT' })
    expect(
      database
        .prepare(
          'SELECT local_next_number, local_consumed_count FROM patta_number_blocks WHERE id = ?'
        )
        .get('block-new')
    ).toEqual({ local_next_number: '203', local_consumed_count: '3' })
    expect(stateRepository.lastServerCursor()).toBe(session.watermark)
    expect(stateRepository.lastCompletedBootstrapSessionId()).toBe(session.id)
    expect(stagingRepository.currentSession()).toBeNull()
    expect(
      database
        .prepare(
          'SELECT entity_type, entity_id FROM sync_tombstones ORDER BY entity_type, entity_id'
        )
        .all()
    ).toEqual(
      expect.arrayContaining([
        { entity_type: 'models', entity_id: 'model-local' },
        { entity_type: 'models', entity_id: 'model-stale' },
        { entity_type: 'patta_hisob', entity_id: 'patta-stale' }
      ])
    )

    expect(mirrorRepository.finalizeBootstrap(session.id, session.watermark, timestamp)).toEqual({
      session_id: session.id,
      status: 'COMPLETED',
      already_completed: true
    })
    expect(database.prepare('SELECT COUNT(*) AS count FROM patta_hisob').get()).toEqual({
      count: 5
    })
  })

  it('rolls back mirror reconciliation and cursor when a staged projection violates a schema constraint', () => {
    const database = createDatabase()
    const { stateRepository, stagingRepository, mirrorRepository } = repositories(database)
    const session = makeSession('10')
    const projections = makeProjections()
    const page = makePage(session.id, session.watermark, projections.slice(0, 3), 1, false)
    stateRepository.setLastServerCursor('8', timestamp)
    stagingRepository.beginSession(session, timestamp)
    stagingRepository.persistPage(page, timestamp)
    database
      .prepare(
        `
      UPDATE bootstrap_items
      SET projection_json = replace(projection_json, '"status":"ACTIVE"', '"status":"INVALID"')
      WHERE entity_type = 'models'
    `
      )
      .run()

    expect(() =>
      mirrorRepository.finalizeBootstrap(session.id, session.watermark, timestamp)
    ).toThrow()
    expect(database.prepare('SELECT id FROM workers').all()).toEqual([])
    expect(database.prepare('SELECT id FROM models').all()).toEqual([])
    expect(stateRepository.lastServerCursor()).toBe('8')
    expect(stagingRepository.currentSession()?.status).toBe('READY_TO_APPLY')
    expect(database.prepare('SELECT COUNT(*) AS count FROM bootstrap_items').get()).toEqual({
      count: 3
    })
  })
})
