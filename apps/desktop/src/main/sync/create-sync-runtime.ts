import type Database from 'better-sqlite3'
import { BadgeLocalRepository } from '../local/badge-local.repository'
import { BootstrapStagingRepository } from '../local/bootstrap-staging.repository'
import { LocalUnitOfWork } from '../local/local-unit-of-work'
import { ModelLocalRepository } from '../local/model-local.repository'
import { ModelAccountRepository } from '../local/model-account.repository'
import { OfflinePattaService } from '../local/offline-patta.service'
import { PattaPrintService } from '../local/patta-print.service'
import { PattaPrintBatchRepository } from '../local/patta-print-batch.repository'
import { PattaSheetRepository } from '../local/patta-sheet.repository'
import { PattaSheetCustomOperationRepository } from '../local/patta-sheet-custom-operation.repository'
import { PattaSheetService } from '../local/patta-sheet.service'
import { PattaLocalRepository } from '../local/patta-local.repository'
import { PattaNumberBlockRepository } from '../local/patta-number-block.repository'
import { PattaPartiyaNumberBlockRepository } from '../local/patta-partiya-number-block.repository'
import { ReferenceMirrorRepository } from '../local/reference-mirror.repository'
import { SyncConflictRepository } from '../local/sync-conflict.repository'
import { SyncQueueRepository } from '../local/sync-queue.repository'
import { SyncStateRepository } from '../local/sync-state.repository'
import { WorkerLocalRepository } from '../local/worker-local.repository'
import type { AuthenticatedSyncTransport } from './authenticated-sync-transport'
import type { PattaV2LookupMirror } from '@textile/sync-protocol'
import { NetworkStatusService } from './network-status.service'
import { SyncEngine } from './sync-engine'
import type { SyncEngineLimits } from './sync-engine'
import { SyncRetryPolicy } from './retry-policy'
import type { Clock } from '../local/offline-patta.service'

export interface DesktopSyncRuntime {
  syncEngine: SyncEngine
  offlinePattaService: OfflinePattaService
  pattaPrintService: PattaPrintService
  pattaSheetService: PattaSheetService
  lookupPattaV2(partiyaNumber: string, pattaNumber: string): Promise<PattaV2LookupMirror>
  networkStatus: NetworkStatusService
  repositories: {
    unitOfWork: LocalUnitOfWork
    workers: WorkerLocalRepository
    badges: BadgeLocalRepository
    models: ModelLocalRepository
    modelAccount: ModelAccountRepository
    pattas: PattaLocalRepository
    numberBlocks: PattaNumberBlockRepository
    partiyaNumberBlocks: PattaPartiyaNumberBlockRepository
    printBatches: PattaPrintBatchRepository
    sheets: PattaSheetRepository
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
  const modelAccount = new ModelAccountRepository(database)
  const pattas = new PattaLocalRepository(database)
  const numberBlocks = new PattaNumberBlockRepository(database, transport.deviceId())
  const partiyaNumberBlocks = new PattaPartiyaNumberBlockRepository(database, transport.deviceId())
  const printBatches = new PattaPrintBatchRepository(database)
  const sheets = new PattaSheetRepository(database)
  const customOperations = new PattaSheetCustomOperationRepository(database)
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
    partiyaBlockRepository: partiyaNumberBlocks,
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
  const pattaPrintService = new PattaPrintService({
    unitOfWork,
    partiyaBlocks: partiyaNumberBlocks,
    pattaBlocks: numberBlocks,
    modelRepository: models,
    batchRepository: printBatches,
    queueRepository: queue,
    syncStateRepository: state,
    deviceId: transport.deviceId(),
    clock
  })
  const pattaSheetService = new PattaSheetService({
    unitOfWork,
    pattaRepository: pattas,
    sheetRepository: sheets,
    customOperationRepository: customOperations,
    badgeRepository: badges,
    queueRepository: queue,
    syncStateRepository: state,
    deviceId: transport.deviceId(),
    clock,
  })

  const lookupPattaV2 = async (partiyaNumber: string, pattaNumber: string): Promise<PattaV2LookupMirror> => {
    if (!transport.lookupPattaV2) {
      throw new Error('Patta v2 qidiruv xizmati mavjud emas')
    }
    const mirror = await transport.lookupPattaV2(partiyaNumber, pattaNumber)
    mirrors.applyPattaV2LookupMirror(mirror)
    return mirror
  }

  return {
    syncEngine,
    offlinePattaService,
    pattaPrintService,
    pattaSheetService,
    lookupPattaV2,
    networkStatus,
    repositories: {
      unitOfWork,
      workers,
      badges,
      models,
      modelAccount,
      pattas,
      numberBlocks,
      partiyaNumberBlocks,
      printBatches,
      sheets,
      queue,
      state,
      conflicts,
      bootstrap,
      mirrors
    }
  }
}
