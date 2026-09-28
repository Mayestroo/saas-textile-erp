import type { SyncConflictRepository } from '../local/sync-conflict.repository'
import type { SyncQueueRepository } from '../local/sync-queue.repository'

export type SyncConnectivity = 'ONLINE' | 'OFFLINE' | 'AUTH_REQUIRED'

export interface SyncStatusSnapshot {
  connectivity: SyncConnectivity
  unsyncedCount: number
  conflictCount: number
  lastSuccessfulSyncAt: string | null
  errorCode: string | null
}

export class NetworkStatusService {
  private connectivity: SyncConnectivity = 'OFFLINE'
  private lastSuccessfulSyncAt: string | null = null
  private errorCode: string | null = null

  constructor(
    private readonly queueRepository: Pick<SyncQueueRepository, 'countByStatus'>,
    private readonly conflictRepository: Pick<SyncConflictRepository, 'countOpen'>
  ) {}

  reportOnline(syncedAt: string): void {
    this.connectivity = 'ONLINE'
    this.lastSuccessfulSyncAt = syncedAt
    this.errorCode = null
  }

  reportOffline(): void {
    this.connectivity = 'OFFLINE'
    this.errorCode = 'NETWORK_ERROR'
  }

  reportAuthenticationRequired(): void {
    this.connectivity = 'AUTH_REQUIRED'
    this.errorCode = 'AUTH_REQUIRED'
  }

  reportFailure(errorCode: string): void {
    this.errorCode = errorCode
  }

  snapshot(): SyncStatusSnapshot {
    return {
      connectivity: this.connectivity,
      unsyncedCount:
        this.queueRepository.countByStatus('PENDING') +
        this.queueRepository.countByStatus('SYNCING') +
        this.queueRepository.countByStatus('FAILED'),
      conflictCount: this.conflictRepository.countOpen(),
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      errorCode: this.errorCode
    }
  }
}
