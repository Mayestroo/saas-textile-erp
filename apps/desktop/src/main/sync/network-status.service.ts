import type { SyncConflictRepository } from '../local/sync-conflict.repository'
import type { SyncQueueRepository } from '../local/sync-queue.repository'

export type SyncConnectivity = 'ONLINE' | 'OFFLINE' | 'AUTH_REQUIRED'

export interface SyncStatusSnapshot {
  connectivity: SyncConnectivity
  unsyncedCount: number
  conflictCount: number
  lastSuccessfulSyncAt: string | null
}

export class NetworkStatusService {
  private connectivity: SyncConnectivity = 'OFFLINE'
  private lastSuccessfulSyncAt: string | null = null

  constructor(
    private readonly queueRepository: Pick<SyncQueueRepository, 'countByStatus'>,
    private readonly conflictRepository: Pick<SyncConflictRepository, 'countOpen'>
  ) {}

  reportOnline(syncedAt: string): void {
    this.connectivity = 'ONLINE'
    this.lastSuccessfulSyncAt = syncedAt
  }

  reportOffline(): void {
    this.connectivity = 'OFFLINE'
  }

  reportAuthenticationRequired(): void {
    this.connectivity = 'AUTH_REQUIRED'
  }

  snapshot(): SyncStatusSnapshot {
    return {
      connectivity: this.connectivity,
      unsyncedCount:
        this.queueRepository.countByStatus('PENDING') +
        this.queueRepository.countByStatus('SYNCING') +
        this.queueRepository.countByStatus('FAILED'),
      conflictCount: this.conflictRepository.countOpen(),
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt
    }
  }
}
