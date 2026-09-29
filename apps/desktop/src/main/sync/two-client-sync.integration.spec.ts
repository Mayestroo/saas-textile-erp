import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import type {
  AuthenticatedHttpClient,
  AuthenticatedHttpRequest,
  DeviceIdentity
} from './authenticated-sync-transport'
import { FetchAuthenticatedHttpClient } from './authenticated-http-client'
import type { AuthenticatedSessionProvider } from './authenticated-http-client'
import { RestSyncTransport } from './rest-sync-transport'
import { createDesktopSyncRuntime } from './create-sync-runtime'
import type { Clock } from '../local/offline-patta.service'
import { openSqliteDatabase } from '../database/sqlite-database'

const REQUIRED_ENVIRONMENT = [
  'SYNC_TEST_API_BASE_URL',
  'SYNC_TEST_TENANT_HOST',
  'SYNC_TEST_TENANT_TOKEN',
  'SYNC_TEST_DEVICE_PC1',
  'SYNC_TEST_DEVICE_PC2',
  'SYNC_TEST_MODEL_ID',
  'SYNC_TEST_WORKER_PC1',
  'SYNC_TEST_WORKER_PC2',
  'SYNC_TEST_BADGE_PC1',
  'SYNC_TEST_BADGE_PC2',
  'SYNC_TEST_USER_ID',
  'SYNC_TEST_TENANT_TIMEZONE',
  'SYNC_TEST_LOCAL_DATA_DIR'
] as const

const isConfigured = REQUIRED_ENVIRONMENT.every((key) => Boolean(process.env[key]?.trim()))
const acceptanceDescribe = isConfigured ? describe : describe.skip
const databases: Database.Database[] = []

function requiredSetting(key: (typeof REQUIRED_ENVIRONMENT)[number]): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing desktop acceptance setting: ${key}`)
  return value
}

class TestNetworkClient implements AuthenticatedHttpClient {
  readonly pushEventIds: string[] = []
  offline = false
  loseFirstPushResponse = false
  private didLosePushResponse = false

  constructor(private readonly inner: AuthenticatedHttpClient) {}

  async request(request: AuthenticatedHttpRequest): Promise<unknown> {
    if (this.offline) throw new TypeError('Simulated workstation network loss')
    const isPushRequest = request.url.endsWith('/api/v1/sync/push')
    if (isPushRequest && typeof request.body === 'object' && request.body !== null) {
      const events = Reflect.get(request.body, 'events')
      if (Array.isArray(events)) {
        for (const event of events) {
          if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
            const eventId = Reflect.get(event, 'event_id')
            if (typeof eventId === 'string') this.pushEventIds.push(eventId)
          }
        }
      }
    }

    const response = await this.inner.request(request)
    if (isPushRequest && this.loseFirstPushResponse && !this.didLosePushResponse) {
      this.didLosePushResponse = true
      throw new TypeError('Simulated loss of the successful push response')
    }
    return response
  }
}

function openTestDatabase(path: string): Database.Database {
  const database = openSqliteDatabase(path)
  databases.push(database)
  return database
}

afterAll(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close()
  }
  const dataDirectory = process.env.SYNC_TEST_LOCAL_DATA_DIR
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true })
})

acceptanceDescribe('two-client offline sync acceptance', () => {
  it('syncs print, Entry correction and lifecycle/accounting changes across two PCs', async () => {
    const dataDirectory = requiredSetting('SYNC_TEST_LOCAL_DATA_DIR')
    const databasePc1 = openTestDatabase(join(dataDirectory, `pc1-${randomUUID()}.sqlite`))
    const databasePc2 = openTestDatabase(join(dataDirectory, `pc2-${randomUUID()}.sqlite`))
    const apiBaseUrl = requiredSetting('SYNC_TEST_API_BASE_URL')
    const session: AuthenticatedSessionProvider = {
      accessToken: async () => requiredSetting('SYNC_TEST_TENANT_TOKEN'),
      refreshAfterUnauthorized: async () => false
    }
    const devicePc1: DeviceIdentity = { deviceId: () => requiredSetting('SYNC_TEST_DEVICE_PC1') }
    const devicePc2: DeviceIdentity = { deviceId: () => requiredSetting('SYNC_TEST_DEVICE_PC2') }
    const clientPc1 = new TestNetworkClient(new FetchAuthenticatedHttpClient(session, apiBaseUrl))
    const clientPc2 = new TestNetworkClient(new FetchAuthenticatedHttpClient(session, apiBaseUrl))
    const transportPc1 = new RestSyncTransport(clientPc1, devicePc1, apiBaseUrl)
    const transportPc2 = new RestSyncTransport(clientPc2, devicePc2, apiBaseUrl)
    let pc1ClockMilliseconds = Date.now()
    const clockPc1: Clock = { nowIsoUtc: () => new Date(pc1ClockMilliseconds).toISOString() }
    const runtimePc1 = createDesktopSyncRuntime(databasePc1, transportPc1, undefined, clockPc1)
    const runtimePc2 = createDesktopSyncRuntime(databasePc2, transportPc2)

    const baselinePc1 = await runtimePc1.syncEngine.runOnce()
    const baselinePc2 = await runtimePc2.syncEngine.runOnce()
    expect(baselinePc1, JSON.stringify(runtimePc1.networkStatus.snapshot()))
      .toMatchObject({ status: 'COMPLETED', bootstrapped: true })
    expect(baselinePc2, JSON.stringify(runtimePc2.networkStatus.snapshot()))
      .toMatchObject({ status: 'COMPLETED', bootstrapped: true })

    const pattaBlockPc1 = await transportPc1.allocatePattaNumberBlock()
    const partiyaBlockPc1 = await transportPc1.allocatePattaPartiyaNumberBlock()
    runtimePc1.repositories.unitOfWork.transaction(() => {
      runtimePc1.repositories.numberBlocks.storeAllocatedBlock(pattaBlockPc1)
      runtimePc1.repositories.partiyaNumberBlocks.storeAllocatedBlock(partiyaBlockPc1)
    })
    expect((await runtimePc1.syncEngine.runOnce()).status).toBe('COMPLETED')
    clientPc1.loseFirstPushResponse = true

    const requestsBeforeCreate = clientPc1.pushEventIds.length
    const localBatch = runtimePc1.pattaPrintService.createBatch({
      ish_soni: 125,
      model_id: requiredSetting('SYNC_TEST_MODEL_ID'),
      rang: 'Qora',
      size_distribution: [
        { razmer: 'XS', patta_count: 1, sort_order: 0 },
        { razmer: 'S', patta_count: 1, sort_order: 1 }
      ]
    })
    const queuedEvent = runtimePc1.repositories.queue.pendingBatch(10, clockPc1.nowIsoUtc())[0]
    if (!queuedEvent) throw new Error('PC-1 offline print batch was not queued')
    expect(databasePc1.prepare('SELECT ownership_state FROM patta_print_batches WHERE id = ?')
      .get(localBatch.batch.id)).toEqual({ ownership_state: 'LOCAL_PENDING' })
    expect(clientPc1.pushEventIds).toHaveLength(requestsBeforeCreate)

    const lostResponse = await runtimePc1.syncEngine.runOnce()
    expect(lostResponse.status).toBe('OFFLINE')
    expect(clientPc1.pushEventIds).toEqual([queuedEvent.event_id])
    expect(
      databasePc1
        .prepare('SELECT event_id, status FROM sync_queue WHERE event_id = ?')
        .get(queuedEvent.event_id)
    ).toEqual({ event_id: queuedEvent.event_id, status: 'PENDING' })

    pc1ClockMilliseconds += 10_000
    const retryResult = await runtimePc1.syncEngine.runOnce()
    expect(retryResult.status).toBe('COMPLETED')
    expect(clientPc1.pushEventIds).toEqual([queuedEvent.event_id, queuedEvent.event_id])
    expect(runtimePc1.repositories.queue.countByStatus('SYNCED')).toBe(1)
    expect(
      databasePc1
        .prepare('SELECT ownership_state FROM patta_print_batches WHERE id = ?')
        .get(localBatch.batch.id)
    ).toEqual({ ownership_state: 'SERVER_SYNCED' })

    const pc2Catchup = await runtimePc2.syncEngine.runOnce()
    expect(pc2Catchup.status).toBe('COMPLETED')
    clientPc2.offline = true
    expect((await runtimePc2.syncEngine.runOnce()).status).toBe('OFFLINE')
    expect(runtimePc2.repositories.printBatches.getById(localBatch.batch.id)).toMatchObject({
      id: localBatch.batch.id,
      partiya_number: localBatch.batch.partiya_number,
      ish_soni: 125,
      size_distribution: localBatch.batch.size_distribution,
      pattas: localBatch.batch.pattas.map((patta) => ({
        id: patta.id,
        patta_number: patta.patta_number,
        ish_soni: patta.ish_soni,
        status: patta.status,
        operations: patta.operations.map((operation) => ({
          id: operation.id,
          operation_id: operation.operation_id,
          unit_price_snapshot: operation.unit_price_snapshot
        }))
      }))
    })
    expect(
      databasePc2
        .prepare('SELECT COUNT(*) AS count FROM patta_hisob WHERE print_batch_id = ?')
        .get(localBatch.batch.id)
    ).toEqual({ count: 2 })

    clientPc2.offline = false
    const tenantTimezone = requiredSetting('SYNC_TEST_TENANT_TIMEZONE')
    runtimePc1.repositories.state.setTenantTimezone(tenantTimezone, clockPc1.nowIsoUtc())
    runtimePc2.repositories.state.setTenantTimezone(tenantTimezone, new Date().toISOString())
    const patta = localBatch.batch.pattas[0]
    const pattaOperation = patta?.operations[0]
    if (!patta || !pattaOperation) throw new Error('Printed Patta operation snapshot is unavailable')
    const initialEntry = runtimePc1.pattaSheetService.create({
      partiya_number: patta.partiya_number,
      patta_number: patta.patta_number,
      conveyor_snapshot: '1-konveyer',
      assignments: [{
        model_operation_id: pattaOperation.operation_id,
        badge_number: requiredSetting('SYNC_TEST_BADGE_PC1'),
        nuqson: false
      }]
    })
    expect(initialEntry).toMatchObject({
      entered_at: expect.any(String),
      rows: [{ worker_id: requiredSetting('SYNC_TEST_WORKER_PC1'), quantity_snapshot: 125 }]
    })
    const entryCreatePush = await runtimePc1.syncEngine.runOnce()
    const entrySyncDiagnostic = databasePc1.prepare(`
      SELECT status, last_error_code, last_error_message FROM sync_queue
      WHERE entity_type = 'patta_sheet' AND entity_id = ?
    `).get(initialEntry.id)
    expect(entryCreatePush, JSON.stringify({ network: runtimePc1.networkStatus.snapshot(), queue: entrySyncDiagnostic }))
      .toMatchObject({ status: 'COMPLETED', pushed: 1 })
    await expect(runtimePc2.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })
    const accountAfterCreate = runtimePc2.repositories.modelAccount.getModelAccountSheet(requiredSetting('SYNC_TEST_MODEL_ID'))
    expect(accountAfterCreate.rows).toEqual([{
      worker_id: requiredSetting('SYNC_TEST_WORKER_PC1'),
      worker_name: expect.any(String),
      model_operation_id: pattaOperation.operation_id,
      quantity: '125'
    }])

    const syncedEntryPc1 = runtimePc1.repositories.sheets.findByPatta(patta.id)
    if (!syncedEntryPc1) throw new Error('PC-1 did not retain the synced Entry')
    runtimePc1.pattaSheetService.update({
      sheet_id: syncedEntryPc1.id,
      expected_version: syncedEntryPc1.version,
      conveyor_snapshot: '2-konveyer',
      assignments: [{
        model_operation_id: pattaOperation.operation_id,
        badge_number: requiredSetting('SYNC_TEST_BADGE_PC2'),
        nuqson: true
      }]
    }, requiredSetting('SYNC_TEST_USER_ID'))
    await expect(runtimePc1.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED', pushed: 1 })
    await expect(runtimePc2.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(runtimePc2.repositories.modelAccount.getModelAccountSheet(requiredSetting('SYNC_TEST_MODEL_ID')).rows)
      .toEqual([{
        worker_id: requiredSetting('SYNC_TEST_WORKER_PC2'),
        worker_name: expect.any(String),
        model_operation_id: pattaOperation.operation_id,
        quantity: '125'
      }])

    const editEntryPc1 = runtimePc1.repositories.sheets.findByPatta(patta.id)
    if (!editEntryPc1) throw new Error('PC-1 Entry disappeared after worker correction')
    runtimePc1.pattaSheetService.trash(editEntryPc1.id, editEntryPc1.version, requiredSetting('SYNC_TEST_USER_ID'))
    await expect(runtimePc1.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED', pushed: 1 })
    await expect(runtimePc2.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(runtimePc2.repositories.modelAccount.getModelAccountSheet(requiredSetting('SYNC_TEST_MODEL_ID')).rows)
      .toEqual([])
    expect(runtimePc2.repositories.sheets.listForModel(requiredSetting('SYNC_TEST_MODEL_ID'), true))
      .toEqual([expect.objectContaining({ id: editEntryPc1.id, deleted_at: expect.any(String) })])

    const trashedEntryPc1 = runtimePc1.repositories.sheets.findByPatta(patta.id)
    if (!trashedEntryPc1) throw new Error('Trashed Entry disappeared before restore')
    runtimePc1.pattaSheetService.restore(trashedEntryPc1.id, trashedEntryPc1.version, requiredSetting('SYNC_TEST_USER_ID'))
    await expect(runtimePc1.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED', pushed: 1 })
    await expect(runtimePc2.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(runtimePc2.repositories.modelAccount.getModelAccountSheet(requiredSetting('SYNC_TEST_MODEL_ID')).rows)
      .toMatchObject([{ worker_id: requiredSetting('SYNC_TEST_WORKER_PC2'), quantity: '125' }])

    const restoredEntryPc1 = runtimePc1.repositories.sheets.findByPatta(patta.id)
    if (!restoredEntryPc1) throw new Error('Restored Entry is unavailable for purge')
    runtimePc1.pattaSheetService.trash(restoredEntryPc1.id, restoredEntryPc1.version, requiredSetting('SYNC_TEST_USER_ID'))
    await expect(runtimePc1.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED', pushed: 1 })
    await expect(runtimePc2.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })
    const finalTrashedEntryPc1 = runtimePc1.repositories.sheets.findByPatta(patta.id)
    if (!finalTrashedEntryPc1) throw new Error('Trashed Entry is unavailable for purge')
    runtimePc1.pattaSheetService.purge(finalTrashedEntryPc1.id, finalTrashedEntryPc1.version)
    await expect(runtimePc1.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED', pushed: 1 })
    await expect(runtimePc2.syncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })
    expect(runtimePc2.repositories.sheets.findByPatta(patta.id)).toBeNull()
    expect(runtimePc2.repositories.pattas.getById(patta.id)).not.toBeNull()
    expect(runtimePc2.repositories.modelAccount.getModelAccountSheet(requiredSetting('SYNC_TEST_MODEL_ID')).rows)
      .toEqual([])

    runtimePc1.syncEngine.dispose()
    runtimePc2.syncEngine.dispose()
  })
})
