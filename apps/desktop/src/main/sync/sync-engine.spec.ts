import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  OfflinePattaCreateEvent,
  PattaNumberBlockProjection,
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncChange,
  SyncConflict,
  SyncProjection,
  SyncPullRequest,
  SyncPushRequest,
  SyncPushResponse
} from '@textile/sync-protocol'
import { openSqliteDatabase } from '../database/sqlite-database'
import { BootstrapStagingRepository } from '../local/bootstrap-staging.repository'
import { LocalUnitOfWork } from '../local/local-unit-of-work'
import { PattaNumberBlockRepository } from '../local/patta-number-block.repository'
import { ReferenceMirrorRepository } from '../local/reference-mirror.repository'
import { SyncConflictRepository } from '../local/sync-conflict.repository'
import { SyncQueueRepository } from '../local/sync-queue.repository'
import { SyncStateRepository } from '../local/sync-state.repository'
import { NetworkStatusService } from './network-status.service'
import type { AuthenticatedSyncTransport } from './authenticated-sync-transport'
import { SyncRetryPolicy } from './retry-policy'
import { SyncEngine } from './sync-engine'

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REPLACEMENT_SESSION_ID = '99999999-9999-4999-8999-999999999999'
const MODEL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BLOCK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PATTA_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const EVENT_ID = '11111111-1111-4111-8111-111111111111'
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222'
const PRICE_ID = '33333333-3333-4333-8333-333333333333'
const LOCAL_TIME = '2026-09-27T09:00:00.000000Z'
const SERVER_TIME = '2026-09-27T09:00:01.000000Z'

const localEvent: OfflinePattaCreateEvent = {
  event_id: EVENT_ID,
  entity_type: 'patta',
  entity_id: PATTA_ID,
  operation: 'CREATE',
  base_version: '0',
  client_created_at: LOCAL_TIME,
  occurred_at: LOCAL_TIME,
  reference_cursor: '9',
  payload: {
    partiya_number: 'PARTIYA-1',
    patta_number: '100',
    model_id: MODEL_ID,
    model_name_snapshot: 'Model One',
    template_id: null,
    konveyer_snapshot: 'Line A',
    razmer: null,
    rang: null,
    block_id: BLOCK_ID,
    reference_versions: { model: '1', template: null, operations: { [OPERATION_ID]: '1' } },
    operations: [
      {
        id: SNAPSHOT_ID,
        operation_id: OPERATION_ID,
        operation_name_snapshot: 'Sewing',
        unit_price_snapshot: '12.50',
        sort_order: 0
      }
    ]
  }
}

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-sync-engine-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'desktop.sqlite'))
  databases.push(database)
  return database
}

const directories: string[] = []
const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeBootstrapProjections(): readonly SyncProjection[] {
  return [
    {
      projection_version: 1,
      entity_type: 'models',
      entity_id: MODEL_ID,
      entity_version: '1',
      data: {
        id: MODEL_ID,
        name: 'Model One',
        status: 'ACTIVE',
        version: '1',
        created_at: LOCAL_TIME,
        updated_at: LOCAL_TIME
      }
    },
    {
      projection_version: 1,
      entity_type: 'model_operations',
      entity_id: OPERATION_ID,
      entity_version: '1',
      data: {
        id: OPERATION_ID,
        model_id: MODEL_ID,
        name: 'Sewing',
        sort_order: 0,
        status: 'ACTIVE',
        version: '1',
        created_at: LOCAL_TIME,
        updated_at: LOCAL_TIME
      }
    },
    {
      projection_version: 1,
      entity_type: 'model_operation_prices',
      entity_id: PRICE_ID,
      entity_version: null,
      data: {
        id: PRICE_ID,
        operation_id: OPERATION_ID,
        price: '12.50',
        valid_from: '2026-01-01T00:00:00.000000Z',
        valid_to: null,
        created_at: LOCAL_TIME
      }
    },
    {
      projection_version: 1,
      entity_type: 'patta_number_blocks',
      entity_id: BLOCK_ID,
      entity_version: null,
      data: {
        id: BLOCK_ID,
        device_id: DEVICE_ID,
        range_start: '100',
        range_end: '199',
        reported_used_count: '0',
        status: 'ACTIVE',
        allocated_at: LOCAL_TIME,
        exhausted_at: null
      }
    }
  ]
}

function makeServerPattaProjection(): Extract<SyncProjection, { entity_type: 'patta_hisob' }> {
  return {
    projection_version: 1,
    entity_type: 'patta_hisob',
    entity_id: PATTA_ID,
    entity_version: '1',
    data: {
      id: PATTA_ID,
      partiya_number: 'PARTIYA-1',
      patta_number: '100',
      model_id: MODEL_ID,
      model_name_snapshot: 'Model One',
      template_id: null,
      konveyer_snapshot: 'Line A',
      razmer: null,
      rang: null,
      ish_soni: 1,
      created_device_id: DEVICE_ID,
      created_from_block_id: BLOCK_ID,
      created_at: SERVER_TIME,
      client_created_at: LOCAL_TIME,
      occurred_at: LOCAL_TIME
    }
  }
}

class FakeTransport implements AuthenticatedSyncTransport {
  readonly calls: string[] = []
  pushWait: Promise<void> | null = null
  pushStarted: (() => void) | null = null
  pushResponse: SyncPushResponse = { results: [] }
  pushError: unknown = null
  allocatedBlock: PattaNumberBlockProjection | null = null

  deviceId(): string {
    return DEVICE_ID
  }

  async push(request: Omit<SyncPushRequest, 'device_id'>): Promise<SyncPushResponse> {
    this.calls.push(`push:${request.events.length}`)
    this.pushStarted?.()
    if (this.pushWait) await this.pushWait
    if (this.pushError !== null) throw this.pushError
    return this.pushResponse
  }

  async pull(
    request: Omit<SyncPullRequest, 'device_id'>
  ): Promise<ReturnType<AuthenticatedSyncTransport['pull']> extends Promise<infer T> ? T : never> {
    this.calls.push(`pull:${request.cursor}`)
    return { changes: [], next_cursor: request.cursor, has_more: false }
  }

  async createBootstrap(): Promise<SyncBootstrapSession> {
    this.calls.push('bootstrap:create')
    return {
      id: SESSION_ID,
      device_id: DEVICE_ID,
      watermark: '10',
      status: 'ACTIVE',
      expires_at: '2026-09-27T10:00:00.000000Z'
    }
  }

  async bootstrapPage(
    sessionId: string,
    after: string | null,
    limit: number
  ): Promise<SyncBootstrapPage> {
    this.calls.push(`bootstrap:page:${after ?? 'start'}`)
    const projections = makeBootstrapProjections()
    const firstOrder = after === null ? 1 : Number(after) + 1
    const remaining = projections.slice(firstOrder - 1, firstOrder - 1 + limit)
    const hasMore = firstOrder - 1 + remaining.length < projections.length
    return {
      session_id: sessionId,
      watermark: '10',
      items: remaining.map((projection, index) => ({
        order_key: String(firstOrder + index),
        projection
      })),
      next_order_key: remaining.length === 0 ? null : String(firstOrder + remaining.length - 1),
      has_more: hasMore
    }
  }

  async completeBootstrap(sessionId: string): Promise<void> {
    this.calls.push(`bootstrap:complete:${sessionId}`)
  }

  async allocatePattaNumberBlock(): Promise<PattaNumberBlockProjection> {
    this.calls.push('block:allocate')
    if (!this.allocatedBlock) throw new Error('unexpected block allocation')
    return this.allocatedBlock
  }

  async reportPattaBlockUsage(
    blockId: string,
    reportedUsedCount: string
  ): Promise<PattaNumberBlockProjection> {
    this.calls.push(`block:usage:${blockId}:${reportedUsedCount}`)
    return {
      id: blockId,
      device_id: DEVICE_ID,
      range_start: '100',
      range_end: '199',
      reported_used_count: reportedUsedCount,
      status: 'ACTIVE',
      allocated_at: LOCAL_TIME,
      exhausted_at: null
    }
  }
}

function seedLocalPendingPatta(database: Database.Database): void {
  database
    .prepare(
      `
    INSERT INTO models (id, name, status, version, created_at, updated_at)
    VALUES (?, 'Model One', 'ACTIVE', '1', ?, ?)
  `
    )
    .run(MODEL_ID, LOCAL_TIME, LOCAL_TIME)
  database
    .prepare(
      `
    INSERT INTO model_operations (
      id, model_id, name, sort_order, status, version, created_at, updated_at
    ) VALUES (?, ?, 'Sewing', 0, 'ACTIVE', '1', ?, ?)
  `
    )
    .run(OPERATION_ID, MODEL_ID, LOCAL_TIME, LOCAL_TIME)
  database
    .prepare(
      `
    INSERT INTO patta_number_blocks (
      id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
      local_next_number, local_consumed_count, local_role
    ) VALUES (?, ?, '100', '199', '0', 'ACTIVE', ?, '101', '1', 'CURRENT')
  `
    )
    .run(BLOCK_ID, DEVICE_ID, LOCAL_TIME)
  database
    .prepare(
      `
    INSERT INTO patta_hisob (
      id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
      konveyer_snapshot, razmer, rang, ish_soni, created_device_id, created_from_block_id,
      created_at, client_created_at, occurred_at, version, ownership_state
    ) VALUES (?, 'PARTIYA-1', '100', ?, 'Model One', NULL, 'Line A', NULL, NULL,
      1, ?, ?, ?, ?, ?, '0', 'LOCAL_PENDING')
  `
    )
    .run(PATTA_ID, MODEL_ID, DEVICE_ID, BLOCK_ID, LOCAL_TIME, LOCAL_TIME, LOCAL_TIME)
  database
    .prepare(
      `
    INSERT INTO patta_operation_snapshots (
      id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
      sort_order, created_at, ownership_state
    ) VALUES (?, ?, ?, 'Sewing', '12.50', 0, ?, 'LOCAL_PENDING')
  `
    )
    .run(SNAPSHOT_ID, PATTA_ID, OPERATION_ID, LOCAL_TIME)
}

function makeEngine(
  database: Database.Database,
  transport: FakeTransport
): {
  engine: SyncEngine
  queueRepository: SyncQueueRepository
  stateRepository: SyncStateRepository
  conflictRepository: SyncConflictRepository
  networkStatus: NetworkStatusService
} {
  const unitOfWork = new LocalUnitOfWork(database)
  const queueRepository = new SyncQueueRepository(database)
  const stateRepository = new SyncStateRepository(database)
  const conflictRepository = new SyncConflictRepository(database)
  const stagingRepository = new BootstrapStagingRepository(database, unitOfWork)
  const mirrorRepository = new ReferenceMirrorRepository(
    unitOfWork,
    stagingRepository,
    stateRepository
  )
  const blockRepository = new PattaNumberBlockRepository(database, DEVICE_ID)
  const networkStatus = new NetworkStatusService(queueRepository, conflictRepository)
  const engine = new SyncEngine({
    transport,
    unitOfWork,
    queueRepository,
    stateRepository,
    conflictRepository,
    stagingRepository,
    mirrorRepository,
    blockRepository,
    networkStatus,
    retryPolicy: new SyncRetryPolicy(() => 0.5),
    clock: { nowIsoUtc: () => LOCAL_TIME },
    limits: { pushMaxEvents: 100, pullMaxChanges: 500, bootstrapPageSize: 250 }
  })
  return { engine, queueRepository, stateRepository, conflictRepository, networkStatus }
}

describe('SyncEngine', () => {
  it('bootstraps before push, stores outcomes, then pulls and commits the cursor', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    const unitOfWork = new LocalUnitOfWork(database)
    const queueRepository = new SyncQueueRepository(database)
    unitOfWork.transaction(() => queueRepository.enqueue(localEvent))
    const transport = new FakeTransport()
    const serverPattaProjection = makeServerPattaProjection()
    transport.pushResponse = {
      results: [
        {
          event_id: EVENT_ID,
          status: 'SYNCED',
          entity_version: '1',
          projection: serverPattaProjection,
          change_sequence: '11'
        }
      ]
    }
    const serverSnapshotProjection: SyncProjection = {
      projection_version: 1,
      entity_type: 'patta_operation_snapshots',
      entity_id: SNAPSHOT_ID,
      entity_version: null,
      data: {
        id: SNAPSHOT_ID,
        patta_hisob_id: PATTA_ID,
        operation_id: OPERATION_ID,
        operation_name_snapshot: 'Sewing',
        unit_price_snapshot: '12.50',
        sort_order: 0,
        created_at: SERVER_TIME
      }
    }
    const serverChange: SyncChange = {
      sequence_id: '12',
      entity_type: 'patta_operation_snapshots',
      entity_id: SNAPSHOT_ID,
      operation: 'UPSERT',
      entity_version: null,
      projection_version: 1,
      payload: serverSnapshotProjection,
      changed_at: SERVER_TIME
    }
    const parentEcho: SyncChange = {
      sequence_id: '11',
      entity_type: 'patta_hisob',
      entity_id: PATTA_ID,
      operation: 'UPSERT',
      entity_version: '1',
      projection_version: 1,
      payload: serverPattaProjection,
      changed_at: SERVER_TIME
    }
    let pullCalls = 0
    transport.pull = async (request) => {
      transport.calls.push(`pull:${request.cursor}`)
      pullCalls += 1
      return pullCalls === 1
        ? { changes: [parentEcho, serverChange], next_cursor: '12', has_more: false }
        : { changes: [], next_cursor: request.cursor, has_more: false }
    }
    const { engine, stateRepository, networkStatus } = makeEngine(database, transport)

    const result = await engine.runOnce()

    expect(result.status).toBe('COMPLETED')
    expect(transport.calls).toEqual([
      'bootstrap:create',
      'bootstrap:page:start',
      `bootstrap:complete:${SESSION_ID}`,
      'push:1',
      'pull:10',
      `block:usage:${BLOCK_ID}:1`
    ])
    expect(stateRepository.lastServerCursor()).toBe('12')
    expect(queueRepository.countByStatus('SYNCED')).toBe(1)
    expect(
      database
        .prepare('SELECT ownership_state, server_sequence FROM patta_hisob WHERE id = ?')
        .get(PATTA_ID)
    ).toEqual({ ownership_state: 'SERVER_SYNCED', server_sequence: '11' })
    expect(
      database
        .prepare(
          'SELECT ownership_state, server_sequence, created_at FROM patta_operation_snapshots WHERE id = ?'
        )
        .get(SNAPSHOT_ID)
    ).toEqual({
      ownership_state: 'SERVER_SYNCED',
      server_sequence: '12',
      created_at: SERVER_TIME
    })
    expect(networkStatus.snapshot().connectivity).toBe('ONLINE')
    engine.dispose()
  })

  it('shares an in-flight sync cycle instead of overlapping pushes', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    const unitOfWork = new LocalUnitOfWork(database)
    const queueRepository = new SyncQueueRepository(database)
    unitOfWork.transaction(() => queueRepository.enqueue(localEvent))
    const transport = new FakeTransport()
    let releasePush: (() => void) | undefined
    let markPushStarted: (() => void) | undefined
    const pushGate = new Promise<void>((resolve) => {
      releasePush = resolve
    })
    const pushStarted = new Promise<void>((resolve) => {
      markPushStarted = resolve
    })
    transport.pushWait = pushGate
    transport.pushStarted = () => markPushStarted?.()
    const projection = makeServerPattaProjection()
    transport.pushResponse = {
      results: [
        {
          event_id: EVENT_ID,
          status: 'SYNCED',
          entity_version: '1',
          projection,
          change_sequence: '11'
        }
      ]
    }
    const { engine } = makeEngine(database, transport)

    const firstRun = engine.runOnce()
    await pushStarted
    const secondRun = engine.runOnce()
    expect(secondRun).toBe(firstRun)
    releasePush?.()
    await Promise.all([firstRun, secondRun])
    expect(transport.calls.filter((call) => call.startsWith('push:'))).toHaveLength(1)
    engine.dispose()
  })

  it('returns transiently failed queue events to PENDING with the same event ID and backoff', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    const unitOfWork = new LocalUnitOfWork(database)
    const queueRepository = new SyncQueueRepository(database)
    unitOfWork.transaction(() => queueRepository.enqueue(localEvent))
    const transport = new FakeTransport()
    transport.pushError = new TypeError('fetch failed')
    const { engine, networkStatus } = makeEngine(database, transport)

    const result = await engine.runOnce()
    const queueRow = database
      .prepare(
        `
      SELECT event_id, status, attempt_count, next_attempt_at FROM sync_queue
    `
      )
      .get()

    expect(result.status).toBe('OFFLINE')
    expect(queueRow).toEqual({
      event_id: EVENT_ID,
      status: 'PENDING',
      attempt_count: 1,
      next_attempt_at: '2026-09-27T09:00:05.000000Z'
    })
    expect(networkStatus.snapshot().connectivity).toBe('OFFLINE')
    engine.dispose()
  })

  it('replaces an expired server pull cursor with a staged bootstrap without deleting local work', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    const stateRepository = new SyncStateRepository(database)
    stateRepository.setLastServerCursor('5', LOCAL_TIME)
    const transport = new FakeTransport()
    let pulls = 0
    transport.pull = async (request) => {
      transport.calls.push(`pull:${request.cursor}`)
      pulls += 1
      if (pulls === 1) {
        throw {
          status: 409,
          body: { code: 'SYNC_CURSOR_EXPIRED', message: 'Cursor tugagan', details: {} }
        }
      }
      return { changes: [], next_cursor: request.cursor, has_more: false }
    }
    const { engine } = makeEngine(database, transport)

    const result = await engine.runOnce()

    expect(result).toMatchObject({ status: 'COMPLETED', bootstrapped: true })
    expect(stateRepository.lastServerCursor()).toBe('10')
    expect(
      database.prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?').get(PATTA_ID)
    ).toEqual({ ownership_state: 'LOCAL_PENDING' })
    expect(transport.calls).toContain('bootstrap:create')
    expect(transport.calls).toContain('pull:5')
    expect(transport.calls).toContain('pull:10')
    engine.dispose()
  })

  it('discards only expired bootstrap staging and retries with a replacement session', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    const stateRepository = new SyncStateRepository(database)
    stateRepository.setLastServerCursor('5', LOCAL_TIME)
    const transport = new FakeTransport()
    let pullCount = 0
    transport.pull = async (request) => {
      transport.calls.push(`pull:${request.cursor}`)
      pullCount += 1
      if (pullCount === 1) {
        throw { status: 409, body: { code: 'SYNC_CURSOR_EXPIRED' } }
      }
      return { changes: [], next_cursor: request.cursor, has_more: false }
    }
    let createCalls = 0
    transport.createBootstrap = async () => {
      createCalls += 1
      transport.calls.push(`bootstrap:create:${createCalls}`)
      return {
        id: createCalls === 1 ? SESSION_ID : REPLACEMENT_SESSION_ID,
        device_id: DEVICE_ID,
        watermark: '10',
        status: 'ACTIVE',
        expires_at: '2026-09-27T10:00:00.000000Z'
      }
    }
    let firstSessionPages = 0
    transport.bootstrapPage = async (sessionId, after, limit) => {
      transport.calls.push(`bootstrap:page:${sessionId}:${after ?? 'start'}`)
      if (sessionId === SESSION_ID) {
        firstSessionPages += 1
        if (firstSessionPages === 1) {
          const projections = makeBootstrapProjections().slice(0, 2)
          return {
            session_id: SESSION_ID,
            watermark: '10',
            items: projections.map((projection, index) => ({
              order_key: String(index + 1),
              projection
            })),
            next_order_key: '2',
            has_more: true
          }
        }
        throw { status: 409, body: { code: 'SYNC_BOOTSTRAP_EXPIRED' } }
      }
      const projections = makeBootstrapProjections()
      return {
        session_id: REPLACEMENT_SESSION_ID,
        watermark: '10',
        items: projections.slice(0, limit).map((projection, index) => ({
          order_key: String(index + 1),
          projection
        })),
        next_order_key: String(projections.length),
        has_more: false
      }
    }
    const { engine } = makeEngine(database, transport)

    const result = await engine.runOnce()

    expect(result).toMatchObject({ status: 'COMPLETED', bootstrapped: true })
    expect(createCalls).toBe(2)
    expect(stateRepository.lastServerCursor()).toBe('10')
    expect(
      database.prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?').get(PATTA_ID)
    ).toEqual({ ownership_state: 'LOCAL_PENDING' })
    expect(database.prepare('SELECT COUNT(*) AS count FROM bootstrap_items').get()).toEqual({
      count: 0
    })
    expect(transport.calls).toContain(`bootstrap:complete:${REPLACEMENT_SESSION_ID}`)
    engine.dispose()
  })

  it('persists per-event conflicts and keeps them out of transient network retry', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    const unitOfWork = new LocalUnitOfWork(database)
    const queueRepository = new SyncQueueRepository(database)
    unitOfWork.transaction(() => queueRepository.enqueue(localEvent))
    const transport = new FakeTransport()
    const conflict: SyncConflict = {
      code: 'PATTA_ALREADY_EXISTS',
      message: 'Patta already exists',
      details: {},
      local_payload: localEvent.payload,
      server_payload: null
    }
    transport.pushResponse = {
      results: [{ event_id: EVENT_ID, status: 'CONFLICT', conflict }]
    }
    const { engine, conflictRepository } = makeEngine(database, transport)

    const result = await engine.runOnce()

    expect(result.status).toBe('COMPLETED')
    expect(queueRepository.countByStatus('CONFLICT')).toBe(1)
    expect(queueRepository.countByStatus('PENDING')).toBe(0)
    expect(conflictRepository.countOpen()).toBe(1)
    expect(
      database.prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?').get(PATTA_ID)
    ).toEqual({ ownership_state: 'CONFLICT' })
    engine.dispose()
  })

  it('reports local block use and prefetches one reserved block after the 80% threshold', async () => {
    const database = createDatabase()
    seedLocalPendingPatta(database)
    database
      .prepare(
        `
      UPDATE patta_number_blocks SET local_next_number = '180', local_consumed_count = '80'
      WHERE id = ?
    `
      )
      .run(BLOCK_ID)
    const transport = new FakeTransport()
    transport.allocatedBlock = {
      id: '44444444-4444-4444-8444-444444444444',
      device_id: DEVICE_ID,
      range_start: '200',
      range_end: '299',
      reported_used_count: '0',
      status: 'ACTIVE',
      allocated_at: SERVER_TIME,
      exhausted_at: null
    }
    const { engine } = makeEngine(database, transport)

    const result = await engine.runOnce()

    expect(result.status).toBe('COMPLETED')
    expect(transport.calls).toContain(`block:usage:${BLOCK_ID}:80`)
    expect(transport.calls).toContain('block:allocate')
    expect(
      database
        .prepare(
          `
      SELECT local_role, local_next_number, reported_used_count
      FROM patta_number_blocks WHERE id = ?
    `
        )
        .get(transport.allocatedBlock.id)
    ).toEqual({
      local_role: 'RESERVED',
      local_next_number: '200',
      reported_used_count: '0'
    })
    engine.dispose()
  })
})
