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
  it('retries the same offline event ID after response loss and makes the Patta available offline on PC-2', async () => {
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
    clientPc1.loseFirstPushResponse = true
    const transportPc1 = new RestSyncTransport(clientPc1, devicePc1, apiBaseUrl)
    const transportPc2 = new RestSyncTransport(clientPc2, devicePc2, apiBaseUrl)
    let pc1ClockMilliseconds = Date.now()
    const clockPc1: Clock = { nowIsoUtc: () => new Date(pc1ClockMilliseconds).toISOString() }
    const runtimePc1 = createDesktopSyncRuntime(databasePc1, transportPc1, undefined, clockPc1)
    const runtimePc2 = createDesktopSyncRuntime(databasePc2, transportPc2)

    const baselinePc1 = await runtimePc1.syncEngine.runOnce()
    const baselinePc2 = await runtimePc2.syncEngine.runOnce()
    expect(baselinePc1).toMatchObject({ status: 'COMPLETED', bootstrapped: true })
    expect(baselinePc2).toMatchObject({ status: 'COMPLETED', bootstrapped: true })

    const requestsBeforeCreate = clientPc1.pushEventIds.length
    const localPatta = runtimePc1.offlinePattaService.create({
      partiya_number: `TWO-PC-${randomUUID()}`,
      model_id: requiredSetting('SYNC_TEST_MODEL_ID'),
      konveyer: 'Sinov liniyasi',
      occurred_at: clockPc1.nowIsoUtc()
    })
    const queuedEvent = runtimePc1.repositories.queue.pendingBatch(10, clockPc1.nowIsoUtc())[0]
    if (!queuedEvent) throw new Error('PC-1 local Patta was not queued')
    expect(localPatta.patta.ownership_state).toBe('LOCAL_PENDING')
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
        .prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?')
        .get(localPatta.patta.id)
    ).toEqual({ ownership_state: 'SERVER_SYNCED' })

    const pc2Catchup = await runtimePc2.syncEngine.runOnce()
    expect(pc2Catchup.status).toBe('COMPLETED')
    clientPc2.offline = true
    expect((await runtimePc2.syncEngine.runOnce()).status).toBe('OFFLINE')
    expect(
      runtimePc2.repositories.pattas.findByBusinessKey(
        localPatta.patta.partiya_number,
        localPatta.patta.patta_number
      )
    ).toMatchObject({
      id: localPatta.patta.id,
      ownership_state: 'SERVER_SYNCED',
      operations: localPatta.patta.operations
    })
    expect(
      databasePc2
        .prepare('SELECT COUNT(*) AS count FROM patta_hisob WHERE id = ?')
        .get(localPatta.patta.id)
    ).toEqual({ count: 1 })

    runtimePc1.syncEngine.dispose()
    runtimePc2.syncEngine.dispose()
  })
})
