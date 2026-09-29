import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceIdentityService } from '../device/device-identity.service'
import type { DeviceConfigFileReader } from '../device/device-identity.service'
import { TenantDatabaseManager } from '../database/tenant-database-manager'
import type { SyncEngine } from '../sync/sync-engine'
import type { AuthenticatedSessionProvider } from '../sync/authenticated-http-client'
import { DesktopTenantRuntime } from './desktop-tenant-runtime'

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DEVICE_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const directories: string[] = []
const databases: Database.Database[] = []
const runtimes: DesktopTenantRuntime[] = []

class ConfigReader implements DeviceConfigFileReader {
  constructor(private readonly value: string | null) {}

  async readFile(): Promise<string> {
    if (this.value === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return this.value
  }
}

class TestRegistry {
  private engine: SyncEngine | null = null
  install(engine: SyncEngine): void {
    this.engine = engine
  }
  current(): SyncEngine | null {
    return this.engine
  }
  dispose(): void {
    this.engine?.dispose()
    this.engine = null
  }
}

const sessionProvider: AuthenticatedSessionProvider = {
  async accessToken() {
    return 'main-process-token'
  },
  async refreshAfterUnauthorized() {
    return false
  }
}

function createRuntime(config: string | null): DesktopTenantRuntime {
  const userDataPath = mkdtempSync(join(tmpdir(), 'textile-tenant-runtime-'))
  directories.push(userDataPath)
  const manager = new TenantDatabaseManager(userDataPath)
  const device = new DeviceIdentityService(userDataPath, new ConfigReader(config))
  const runtime = new DesktopTenantRuntime(manager, device, new TestRegistry(), () => sessionProvider)
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.clearTenant()))
  for (const database of databases.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('DesktopTenantRuntime', () => {
  it('keeps login/local tenant data available but blocks sync when device config is missing', async () => {
    const runtime = createRuntime(null)
    await runtime.openTenant(COMPANY_A)
    const database = runtime.activeDatabase()
    if (!database) throw new Error('tenant database did not open')
    databases.push(database)
    await runtime.startSync('https://atlas.example.test')

    expect(runtime.getSyncStatus('AUTHENTICATED')).toMatchObject({
      connectivity: 'DEVICE_NOT_CONFIGURED',
      errorCode: 'DEVICE_NOT_CONFIGURED'
    })
    expect(runtime.getSyncEngine()).toBeNull()
    expect(database.open).toBe(true)
    expect(runtime.getDeviceIdentityStatus().state).toBe('DEVICE_NOT_CONFIGURED')
  })

  it('creates the authenticated transport runtime only after a pre-provisioned device is validated', async () => {
    const runtime = createRuntime(JSON.stringify({ version: 1, device_id: DEVICE_A }))
    await runtime.openTenant(COMPANY_A, 'Asia/Tashkent')
    await runtime.startSync('https://atlas.example.test', null)

    expect(runtime.getDeviceIdentityStatus()).toEqual({ state: 'CONFIGURED', deviceId: DEVICE_A })
    expect(runtime.getSyncEngine()).not.toBeNull()
    expect(runtime.getSyncStatus('AUTHENTICATED').connectivity).toBe('OFFLINE')
    expect(runtime.tenantTimezone()).toBe('Asia/Tashkent')
    expect(await runtime.runSync('OFFLINE_SESSION_PENDING')).toMatchObject({ status: 'OFFLINE' })
  })

  it('does not invent a timezone when opening a legacy tenant session without cached trusted metadata', async () => {
    const runtime = createRuntime(null)
    await runtime.openTenant(COMPANY_A, null)

    expect(runtime.tenantTimezone()).toBeNull()
  })

  it('disposes sync and closes tenant DB on logout before any later tenant opens', async () => {
    const runtime = createRuntime(JSON.stringify({ version: 1, device_id: DEVICE_A }))
    await runtime.openTenant(COMPANY_A)
    await runtime.startSync('https://atlas.example.test')
    const databaseA = runtime.activeDatabase()
    if (!databaseA) throw new Error('tenant A database did not open')
    databases.push(databaseA)

    await runtime.clearTenant()

    expect(databaseA.open).toBe(false)
    expect(runtime.getSyncEngine()).toBeNull()
    expect(runtime.activeDatabase()).toBeNull()

    await runtime.openTenant(COMPANY_B)
    expect(runtime.activeCompanyId()).toBe(COMPANY_B)
    expect(runtime.activeDatabasePath()).toContain(`tenant-${COMPANY_B}.sqlite`)
  })
})
