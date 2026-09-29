import type Database from 'better-sqlite3'
import { DeviceIdentityService } from '../device/device-identity.service'
import type { DeviceIdentityStatus } from '../device/device-identity.service'
import { LocalDomainError } from '../local/local-errors'
import { PattaLocalRepository } from '../local/patta-local.repository'
import { SyncConflictRepository } from '../local/sync-conflict.repository'
import { SyncQueueRepository } from '../local/sync-queue.repository'
import { SyncStateRepository } from '../local/sync-state.repository'
import { TenantDatabaseManager } from '../database/tenant-database-manager'
import type { DesktopSyncRunResult, DesktopSyncStatus } from '../../preload/erp-api'
import { FetchAuthenticatedHttpClient } from '../sync/authenticated-http-client'
import type { AuthenticatedSessionProvider } from '../sync/authenticated-http-client'
import type { AuthenticatedSyncTransport } from '../sync/authenticated-sync-transport'
import { RestSyncTransport } from '../sync/rest-sync-transport'
import { createDesktopSyncRuntime } from '../sync/create-sync-runtime'
import type { DesktopSyncRuntime } from '../sync/create-sync-runtime'
import { desktopSyncEngineRegistry } from '../sync/sync-engine-registry'
import type { SyncEngine } from '../sync/sync-engine'
import { NetworkStatusService } from '../sync/network-status.service'
import { isValidTenantTimezone } from './tenant-timezone'
import type { TenantSessionRuntime } from './desktop-auth.service'
import type { DesktopAuthState } from './desktop-auth.service'

const ZERO_SYNC_COUNTS = {
  unsyncedCount: 0,
  conflictCount: 0,
  lastSuccessfulSyncAt: null,
  errorCode: null
} as const

export interface DesktopSyncEngineRegistry {
  current(): SyncEngine | null
  install(engine: SyncEngine): void
  dispose(): void
}

export class DesktopTenantRuntime implements TenantSessionRuntime {
  private syncRuntime: DesktopSyncRuntime | null = null
  private pattaRepository: PattaLocalRepository | null = null
  private networkStatus: NetworkStatusService | null = null
  private identityStatus: DeviceIdentityStatus = {
    state: 'DEVICE_NOT_CONFIGURED',
    reason: 'MISSING'
  }
  private sessionProvider: AuthenticatedSessionProvider | null = null

  constructor(
    private readonly databaseManager: TenantDatabaseManager,
    private readonly deviceIdentity: DeviceIdentityService,
    private readonly registry: DesktopSyncEngineRegistry = desktopSyncEngineRegistry,
    private readonly getSessionProvider: () => AuthenticatedSessionProvider | null = () =>
      this.sessionProvider,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  setSessionProvider(provider: AuthenticatedSessionProvider): void {
    this.sessionProvider = provider
  }

  async openTenant(companyId: string, timezone: string | null = null): Promise<void> {
    if (
      this.databaseManager.activeCompanyId() !== null &&
      this.databaseManager.activeCompanyId() !== companyId.toLowerCase()
    ) {
      await this.clearTenant()
    }
    const database = this.databaseManager.activate(companyId)
    const state = new SyncStateRepository(database)
    if (isValidTenantTimezone(timezone)) {
      state.setTenantTimezone(timezone, new Date().toISOString())
    }
    this.pattaRepository = new PattaLocalRepository(database)
    const queue = new SyncQueueRepository(database)
    const conflicts = new SyncConflictRepository(database)
    this.networkStatus = new NetworkStatusService(queue, conflicts)
    this.identityStatus = await this.deviceIdentity.load()
  }

  async startSync(tenantOrigin: string, timezone: string | null = null): Promise<void> {
    const database = this.databaseManager.activeDatabase()
    if (!database) {
      throw new LocalDomainError('TENANT_DATABASE_REQUIRED', 'Korxona ma’lumotlar bazasi ochilmagan')
    }
    if (isValidTenantTimezone(timezone)) {
      new SyncStateRepository(database).setTenantTimezone(timezone, new Date().toISOString())
    }
    this.identityStatus = await this.deviceIdentity.load()
    if (this.identityStatus.state !== 'CONFIGURED') return

    const session = this.getSessionProvider()
    if (!session) throw new LocalDomainError('AUTH_REQUIRED', 'Sinxronlash uchun tizimga kiring')

    const httpClient = new FetchAuthenticatedHttpClient(session, tenantOrigin, this.fetcher)
    const transport: AuthenticatedSyncTransport = new RestSyncTransport(
      httpClient,
      this.deviceIdentity,
      tenantOrigin
    )
    this.syncRuntime = createDesktopSyncRuntime(database, transport)
    this.networkStatus = this.syncRuntime.networkStatus
    this.registry.install(this.syncRuntime.syncEngine)
  }

  async clearTenant(preserveLocalDatabase = false): Promise<void> {
    const activeEngine = this.registry.current()
    this.registry.dispose()
    this.syncRuntime = null
    if (preserveLocalDatabase) return

    await activeEngine?.waitUntilIdle()

    this.pattaRepository = null
    this.networkStatus = null
    this.identityStatus = { state: 'DEVICE_NOT_CONFIGURED', reason: 'MISSING' }
    this.databaseManager.closeActive()
  }

  activeDatabase(): Database.Database | null {
    return this.databaseManager.activeDatabase()
  }

  activeCompanyId(): string | null {
    return this.databaseManager.activeCompanyId()
  }

  activeDatabasePath(): string | null {
    return this.databaseManager.activeDatabasePath()
  }

  activePattaRepository(): Pick<PattaLocalRepository, 'findByBusinessKey'> | null {
    return this.pattaRepository
  }

  activeSyncRuntime(): DesktopSyncRuntime | null {
    return this.syncRuntime
  }

  tenantTimezone(): string | null {
    const database = this.databaseManager.activeDatabase()
    if (!database) return null
    const timezone = new SyncStateRepository(database).tenantTimezone()
    return isValidTenantTimezone(timezone) ? timezone : null
  }

  getSyncEngine(): Pick<SyncEngine, 'runOnce'> | null {
    const engine = this.registry.current()
    return engine ? { runOnce: () => engine.runOnce() } : null
  }

  getDeviceIdentityStatus(): DeviceIdentityStatus {
    return this.identityStatus
  }

  getNetworkStatus(): NetworkStatusService | null {
    return this.networkStatus
  }

  getSyncStatus(authState: DesktopAuthState): DesktopSyncStatus {
    const identityConfigured = this.identityStatus.state === 'CONFIGURED'
    if (authState !== 'AUTHENTICATED' && authState !== 'OFFLINE_SESSION_PENDING') {
      return { connectivity: 'AUTH_REQUIRED', ...ZERO_SYNC_COUNTS, errorCode: 'AUTH_REQUIRED' }
    }

    const snapshot = this.networkStatus?.snapshot()
    const counts = snapshot
      ? {
          unsyncedCount: snapshot.unsyncedCount,
          conflictCount: snapshot.conflictCount,
          lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt
        }
      : ZERO_SYNC_COUNTS
    if (!identityConfigured) {
      return {
        connectivity: 'DEVICE_NOT_CONFIGURED',
        ...counts,
        errorCode: 'DEVICE_NOT_CONFIGURED'
      }
    }
    if (authState === 'OFFLINE_SESSION_PENDING') {
      return { connectivity: 'OFFLINE', ...counts, errorCode: snapshot?.errorCode ?? 'NETWORK_ERROR' }
    }
    return {
      connectivity: snapshot?.connectivity ?? 'OFFLINE',
      ...counts,
      errorCode: snapshot?.errorCode ?? null
    }
  }

  async runSync(authState: DesktopAuthState): Promise<DesktopSyncRunResult> {
    if (authState === 'OFFLINE_SESSION_PENDING') {
      return { status: 'OFFLINE', bootstrapped: false, pushed: 0, pulled: 0 }
    }
    if (authState !== 'AUTHENTICATED') {
      return { status: 'AUTH_REQUIRED', bootstrapped: false, pushed: 0, pulled: 0 }
    }
    if (this.identityStatus.state !== 'CONFIGURED') {
      return {
        status: 'DEVICE_NOT_CONFIGURED',
        bootstrapped: false,
        pushed: 0,
        pulled: 0,
        errorCode: 'DEVICE_NOT_CONFIGURED'
      }
    }

    const engine = this.registry.current()
    if (!engine) return { status: 'FAILED', bootstrapped: false, pushed: 0, pulled: 0 }
    try {
      const result = await engine.runOnce()
      return { ...result, errorCode: this.networkStatus?.snapshot().errorCode ?? null }
    } catch {
      return { status: 'FAILED', bootstrapped: false, pushed: 0, pulled: 0 }
    }
  }
}
