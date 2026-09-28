import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopAuthService } from './desktop-auth.service'
import { DesktopTenantRuntime } from './desktop-tenant-runtime'
import type { DesktopSyncEngineRegistry } from './desktop-tenant-runtime'
import { DeviceIdentityService } from '../device/device-identity.service'
import type { SecureSessionPayload, SecureSessionStore } from './secure-session-store'
import { normalizeTenantOrigin, TenantAuthApiClient } from './tenant-auth-api-client'
import { TenantDatabaseManager } from '../database/tenant-database-manager'
import type { SyncEngine } from '../sync/sync-engine'
import { FetchAuthenticatedHttpClient } from '../sync/authenticated-http-client'
import { RestSyncTransport } from '../sync/rest-sync-transport'

const SINGLE_TENANT_SETTINGS = [
  'DESKTOP_AUTH_TEST_TENANT_URL',
  'DESKTOP_AUTH_TEST_API_BASE_URL',
  'DESKTOP_AUTH_TEST_EMAIL',
  'DESKTOP_AUTH_TEST_PASSWORD',
  'DESKTOP_AUTH_TEST_DEVICE_ID',
  'DESKTOP_AUTH_TEST_MODEL_ID'
] as const

const SECOND_TENANT_SETTINGS = [
  'DESKTOP_AUTH_TEST_TENANT_B_URL',
  'DESKTOP_AUTH_TEST_EMAIL_B',
  'DESKTOP_AUTH_TEST_PASSWORD_B',
  'DESKTOP_AUTH_TEST_DEVICE_ID_B'
] as const

function hasSettings(settings: readonly string[]): boolean {
  return settings.every((name) => Boolean(process.env[name]?.trim()))
}

function setting(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing desktop auth acceptance setting: ${name}`)
  return value
}

const authAcceptance = hasSettings(SINGLE_TENANT_SETTINGS) ? describe : describe.skip
const twoTenantIt = hasSettings([...SINGLE_TENANT_SETTINGS, ...SECOND_TENANT_SETTINGS]) ? it : it.skip
const roots: string[] = []
const services: DesktopAuthService[] = []
const runtimes: DesktopTenantRuntime[] = []

class InMemorySecureSessionStore implements SecureSessionStore {
  private session: SecureSessionPayload | null = null

  async load(): Promise<SecureSessionPayload | null> {
    return this.session ? { ...this.session } : null
  }

  async save(session: SecureSessionPayload): Promise<void> {
    this.session = { ...session }
  }

  async clear(): Promise<void> {
    this.session = null
  }
}

class RunningSyncRegistry implements DesktopSyncEngineRegistry {
  private engine: SyncEngine | null = null

  current(): SyncEngine | null {
    return this.engine
  }

  install(engine: SyncEngine): void {
    this.engine?.dispose()
    this.engine = engine
    engine.start(60_000)
  }

  dispose(): void {
    this.engine?.dispose()
    this.engine = null
  }
}

interface DesktopAuthAcceptanceFixture {
  auth: DesktopAuthService
  runtime: DesktopTenantRuntime
  userDataPath: string
  localStore: InMemorySecureSessionStore
}

function createLoopbackFetcher(apiBaseUrl: string): typeof fetch {
  return async (input, init) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.toString())
    const loopbackUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiBaseUrl)
    const headers = new Headers(init?.headers)
    headers.set('x-test-tenant-host', requestUrl.host)
    return fetch(loopbackUrl, { ...init, headers })
  }
}

function createFixture(fetcher: typeof fetch): DesktopAuthAcceptanceFixture {
  const userDataPath = mkdtempSync(join(tmpdir(), 'textile-desktop-auth-acceptance-'))
  roots.push(userDataPath)
  writeFileSync(
    join(userDataPath, 'device-config.json'),
    JSON.stringify({ version: 1, device_id: setting('DESKTOP_AUTH_TEST_DEVICE_ID') })
  )
  const deviceIdentity = new DeviceIdentityService(userDataPath)
  const runtime = new DesktopTenantRuntime(
    new TenantDatabaseManager(userDataPath),
    deviceIdentity,
    new RunningSyncRegistry(),
    undefined,
    fetcher
  )
  const localStore = new InMemorySecureSessionStore()
  const auth = new DesktopAuthService(new TenantAuthApiClient(fetcher), localStore, runtime)
  runtime.setSessionProvider(auth)
  runtimes.push(runtime)
  services.push(auth)
  return { auth, runtime, userDataPath, localStore }
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.logout()
  for (const runtime of runtimes.splice(0)) await runtime.clearTenant()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

authAcceptance('desktop tenant auth and authenticated sync acceptance', () => {
  it('logs in, bootstraps, pushes, and pulls through the production session provider', async () => {
    const fetcher = createLoopbackFetcher(setting('DESKTOP_AUTH_TEST_API_BASE_URL'))
    const { auth, runtime, userDataPath } = createFixture(fetcher)
    const tenantUrl = setting('DESKTOP_AUTH_TEST_TENANT_URL')
    const login = await auth.login({
      tenantUrl,
      email: setting('DESKTOP_AUTH_TEST_EMAIL'),
      password: setting('DESKTOP_AUTH_TEST_PASSWORD')
    })
    expect(login.state).toBe('AUTHENTICATED')
    expect(auth.currentSession().company?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )

    const engine = runtime.getSyncEngine()
    if (!engine) throw new Error('Authenticated sync runtime was not installed')
    const baseline = await engine.runOnce()
    expect(baseline).toMatchObject({ status: 'COMPLETED', bootstrapped: true })

    const database = runtime.activeDatabase()
    const syncRuntime = runtime.activeSyncRuntime()
    if (!database || !syncRuntime) throw new Error('Tenant-local sync runtime was not opened')
    const companyId = auth.currentSession().company?.id
    if (!companyId) throw new Error('Server login omitted the trusted company identity')

    const configuredDevice = new DeviceIdentityService(userDataPath)
    await configuredDevice.load()
    const apiOrigin = normalizeTenantOrigin(tenantUrl).origin
    const httpClient = new FetchAuthenticatedHttpClient(auth, apiOrigin, fetcher)
    const transport = new RestSyncTransport(
      httpClient,
      configuredDevice,
      apiOrigin
    )

    const block = await transport.allocatePattaNumberBlock()
    syncRuntime.repositories.unitOfWork.transaction(() => {
      syncRuntime.repositories.numberBlocks.storeAllocatedBlock(block)
    })
    const model = database
      .prepare('SELECT id FROM models WHERE id = ? AND status = \'ACTIVE\'')
      .get(setting('DESKTOP_AUTH_TEST_MODEL_ID'))
    expect(model).toEqual({ id: setting('DESKTOP_AUTH_TEST_MODEL_ID') })

    const local = syncRuntime.offlinePattaService.create({
      partiya_number: `AUTH-${randomUUID()}`,
      model_id: setting('DESKTOP_AUTH_TEST_MODEL_ID'),
      konveyer: 'Sinov liniyasi',
      occurred_at: new Date().toISOString()
    })
    const cycle = await engine.runOnce()
    expect(cycle).toMatchObject({ status: 'COMPLETED', pushed: 1 })
    expect(cycle.pulled).toBeGreaterThan(0)
    expect(
      database.prepare('SELECT ownership_state FROM patta_hisob WHERE id = ?').get(local.patta.id)
    ).toEqual({ ownership_state: 'SERVER_SYNCED' })
    expect(runtime.activeCompanyId()).toBe(companyId)
  })

  twoTenantIt('keeps tenant A data out of B and lets the API reject A device under B', async () => {
    const fetcher = createLoopbackFetcher(setting('DESKTOP_AUTH_TEST_API_BASE_URL'))
    const { auth, runtime, userDataPath } = createFixture(fetcher)
    const firstLogin = await auth.login({
      tenantUrl: setting('DESKTOP_AUTH_TEST_TENANT_URL'),
      email: setting('DESKTOP_AUTH_TEST_EMAIL'),
      password: setting('DESKTOP_AUTH_TEST_PASSWORD')
    })
    expect(firstLogin.state).toBe('AUTHENTICATED')
    const firstCompanyId = auth.currentSession().company?.id
    const databaseA = runtime.activeDatabase()
    if (!firstCompanyId || !databaseA) throw new Error('Tenant A session/database is unavailable')
    databaseA
      .prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('tenant-isolation-marker', 'tenant-A-only', new Date().toISOString())

    writeFileSync(
      join(userDataPath, 'device-config.json'),
      JSON.stringify({ version: 1, device_id: setting('DESKTOP_AUTH_TEST_DEVICE_ID_B') })
    )
    const secondLogin = await auth.login({
      tenantUrl: setting('DESKTOP_AUTH_TEST_TENANT_B_URL'),
      email: setting('DESKTOP_AUTH_TEST_EMAIL_B'),
      password: setting('DESKTOP_AUTH_TEST_PASSWORD_B')
    })
    expect(secondLogin.state).toBe('AUTHENTICATED')
    const secondCompanyId = auth.currentSession().company?.id
    const databaseB = runtime.activeDatabase()
    expect(firstCompanyId).not.toBe(secondCompanyId)
    expect(databaseA.open).toBe(false)
    if (!databaseB) throw new Error('Tenant B database is unavailable')
    expect(runtime.activeDatabasePath()).toContain(`tenant-${secondCompanyId}.sqlite`)
    expect(
      databaseB.prepare('SELECT value FROM sync_state WHERE key = ?').get('tenant-isolation-marker')
    ).toBeUndefined()

    const validDeviceSyncEngine = runtime.getSyncEngine()
    if (!validDeviceSyncEngine) throw new Error('Tenant B sync runtime was not installed')
    await expect(validDeviceSyncEngine.runOnce()).resolves.toMatchObject({ status: 'COMPLETED' })

    writeFileSync(
      join(userDataPath, 'device-config.json'),
      JSON.stringify({ version: 1, device_id: setting('DESKTOP_AUTH_TEST_DEVICE_ID') })
    )
    await runtime.clearTenant(true)
    await runtime.startSync(normalizeTenantOrigin(setting('DESKTOP_AUTH_TEST_TENANT_B_URL')).origin)
    const engine = runtime.getSyncEngine()
    if (!engine) throw new Error('Tenant B sync runtime was not installed')
    await engine.runOnce()
    expect(runtime.getNetworkStatus()?.snapshot().errorCode).toBe('DEVICE_TENANT_MISMATCH')
  })
})
