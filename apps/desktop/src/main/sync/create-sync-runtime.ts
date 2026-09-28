import type Database from 'better-sqlite3'
import { BadgeLocalRepository } from '../local/badge-local.repository'
import { BootstrapStagingRepository } from '../local/bootstrap-staging.repository'
import { LocalUnitOfWork } from '../local/local-unit-of-work'
import { ModelLocalRepository } from '../local/model-local.repository'
import { OfflinePattaService } from '../local/offline-patta.service'
import { PattaLocalRepository } from '../local/patta-local.repository'
import { PattaNumberBlockRepository } from '../local/patta-number-block.repository'
import { ReferenceMirrorRepository } from '../local/reference-mirror.repository'
import { SyncConflictRepository } from '../local/sync-conflict.repository'
import { SyncQueueRepository } from '../local/sync-queue.repository'
import { SyncStateRepository } from '../local/sync-state.repository'
import { WorkerLocalRepository } from '../local/worker-local.repository'
import type { AuthenticatedSyncTransport } from './authenticated-sync-transport'
import { NetworkStatusService } from './network-status.service'
import { SyncEngine } from './sync-engine'
import type { SyncEngineLimits } from './sync-engine'
import { SyncRetryPolicy } from './retry-policy'
import type { Clock } from '../local/offline-patta.service'

export interface DesktopSyncRuntime {
  syncEngine: SyncEngine
  offlinePattaService: OfflinePattaService
  networkStatus: NetworkStatusService
  repositories: {
    unitOfWork: LocalUnitOfWork
    workers: WorkerLocalRepository
    badges: BadgeLocalRepository
    models: ModelLocalRepository
    pattas: PattaLocalRepository
    numberBlocks: PattaNumberBlockRepository
    queue: SyncQueueRepository
    state: SyncStateRepository
    conflicts: SyncConflictRepository
    bootstrap: BootstrapStagingRepository
    mirrors: ReferenceMirrorRepository
  }
}

const DEFAULT_SYNC_LIMITS: SyncEngineLimits = {
  pushMaxEvents: 100,
  pullMaxChanges: 500,
  bootstrapPageSize: 250,
  syncedQueueRetentionDays: 30
}

export function createDesktopSyncRuntime(
  database: Database.Database,
  transport: AuthenticatedSyncTransport,
  limits: SyncEngineLimits = DEFAULT_SYNC_LIMITS,
  clock: Clock = { nowIsoUtc: () => new Date().toISOString() }
): DesktopSyncRuntime {
  const unitOfWork = new LocalUnitOfWork(database)
  const workers = new WorkerLocalRepository(database)
  const badges = new BadgeLocalRepository(database)
  const models = new ModelLocalRepository(database)
  const pattas = new PattaLocalRepository(database)
  const numberBlocks = new PattaNumberBlockRepository(database, transport.deviceId())
  const queue = new SyncQueueRepository(database)
  const state = new SyncStateRepository(database)
  const conflicts = new SyncConflictRepository(database)
  const bootstrap = new BootstrapStagingRepository(database, unitOfWork)
  const mirrors = new ReferenceMirrorRepository(unitOfWork, bootstrap, state)
  const networkStatus = new NetworkStatusService(queue, conflicts)
  const syncEngine = new SyncEngine({
    transport,
    unitOfWork,
    queueRepository: queue,
    stateRepository: state,
    conflictRepository: conflicts,
    stagingRepository: bootstrap,
    mirrorRepository: mirrors,
    blockRepository: numberBlocks,
    networkStatus,
    retryPolicy: new SyncRetryPolicy(),
    clock,
    limits
  })
  const offlinePattaService = new OfflinePattaService({
    unitOfWork,
    blockRepository: numberBlocks,
    modelRepository: models,
    pattaRepository: pattas,
    syncQueueRepository: queue,
    syncStateRepository: state,
    deviceId: transport.deviceId(),
    clock
  })

  return {
    syncEngine,
    offlinePattaService,
    networkStatus,
    repositories: {
      unitOfWork,
      workers,
      badges,
      models,
      pattas,
      numberBlocks,
      queue,
      state,
      conflicts,
      bootstrap,
      mirrors
    }
  }
}
