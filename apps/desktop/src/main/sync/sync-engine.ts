import type { SyncConflict, SyncPushResult } from '@textile/sync-protocol'
import type { BootstrapStagingRepository } from '../local/bootstrap-staging.repository'
import type { PattaNumberBlockRepository } from '../local/patta-number-block.repository'
import { LocalDomainError } from '../local/local-errors'
import { LocalUnitOfWork } from '../local/local-unit-of-work'
import type { ReferenceMirrorRepository } from '../local/reference-mirror.repository'
import type { SyncConflictRepository } from '../local/sync-conflict.repository'
import type { SyncQueueRepository } from '../local/sync-queue.repository'
import type { SyncStateRepository } from '../local/sync-state.repository'
import type { Clock } from '../local/offline-patta.service'
import { canonicalUtcTimestamp } from '../local/utc-timestamp'
import type { AuthenticatedSyncTransport } from './authenticated-sync-transport'
import { NetworkStatusService } from './network-status.service'
import type { SyncRetryPolicy } from './retry-policy'

export interface SyncEngineLimits {
  pushMaxEvents: number
  pullMaxChanges: number
  bootstrapPageSize: number
  syncedQueueRetentionDays?: number
}

export interface SyncCycleResult {
  status: 'COMPLETED' | 'OFFLINE' | 'AUTH_REQUIRED' | 'FAILED'
  bootstrapped: boolean
  pushed: number
  pulled: number
}

export interface SyncEngineDependencies {
  transport: AuthenticatedSyncTransport
  unitOfWork: LocalUnitOfWork
  queueRepository: Pick<
    SyncQueueRepository,
    | 'recoverStaleSyncing'
    | 'pendingBatch'
    | 'markSyncing'
    | 'attemptCount'
    | 'deferRetry'
    | 'markSynced'
    | 'markFailed'
    | 'cleanupSyncedOlderThan'
  >
  stateRepository: Pick<
    SyncStateRepository,
    'get' | 'set' | 'lastServerCursor' | 'lastCompletedBootstrapSessionId'
  >
  conflictRepository: Pick<SyncConflictRepository, 'persist'>
  stagingRepository: Pick<
    BootstrapStagingRepository,
    'beginSession' | 'persistPage' | 'currentSession' | 'discardSession'
  >
  mirrorRepository: Pick<ReferenceMirrorRepository, 'finalizeBootstrap' | 'applyPullPage'>
  blockRepository: Pick<
    PattaNumberBlockRepository,
    'pendingUsageReports' | 'shouldPrefetchNextBlock' | 'storeAllocatedBlock' | 'applyReportedUsage'
  >
  networkStatus: NetworkStatusService
  retryPolicy: SyncRetryPolicy
  clock: Clock
  limits: SyncEngineLimits
}

interface ErrorDetails {
  status: number | null
  code: string | null
  message: string
  details: Record<string, unknown>
  body: unknown
}

interface BootstrapProgress {
  bootstrapped: boolean
  sessionId: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errorDetails(error: unknown): ErrorDetails {
  const value = asRecord(error)
  const response = asRecord(value?.response)
  const body = value?.body ?? response?.data ?? response
  const bodyRecord = asRecord(body)
  const details = asRecord(bodyRecord?.details) ?? {}
  const statusValue = value?.status ?? response?.status
  const codeValue = value?.code ?? bodyRecord?.code
  const messageValue = bodyRecord?.message ?? (error instanceof Error ? error.message : undefined)
  return {
    status: typeof statusValue === 'number' && Number.isInteger(statusValue) ? statusValue : null,
    code: typeof codeValue === 'string' ? codeValue : null,
    message: typeof messageValue === 'string' ? messageValue : 'Sinxronlash so‘rovi bajarilmadi',
    details,
    body
  }
}

function failureCode(error: unknown, details: ErrorDetails): string {
  if (details.code) return details.code
  if (error instanceof LocalDomainError) return error.code
  return 'SYNC_REQUEST_FAILED'
}

function conflictForEvent(event: { payload: unknown }, info: ErrorDetails): SyncConflict {
  const serverPayload = info.details.server_payload ?? info.body ?? null
  return {
    code: info.code ?? 'VERSION_CONFLICT',
    message: info.message,
    details: info.details,
    local_payload: event.payload,
    server_payload: serverPayload
  }
}

export class SyncEngine {
  private activeRun: Promise<SyncCycleResult> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly dependencies: SyncEngineDependencies) {}

  runOnce(): Promise<SyncCycleResult> {
    if (this.disposed) {
      return Promise.reject(new Error('SyncEngine has been disposed'))
    }
    if (this.activeRun) return this.activeRun
    this.clearRetryTimer()
    const run = this.runCycle()
    const settled = run.finally(() => {
      if (this.activeRun === settled) this.activeRun = null
    })
    this.activeRun = settled
    return settled
  }

  dispose(): void {
    this.disposed = true
    this.clearRetryTimer()
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  start(pollIntervalMilliseconds = 60_000): void {
    if (this.disposed) throw new Error('SyncEngine has been disposed')
    if (!Number.isSafeInteger(pollIntervalMilliseconds) || pollIntervalMilliseconds < 1_000) {
      throw new Error('Sync poll interval must be at least one second')
    }
    if (this.pollTimer !== null) return
    void this.runScheduledCycle()
    this.pollTimer = setInterval(() => void this.runScheduledCycle(), pollIntervalMilliseconds)
    this.pollTimer.unref?.()
  }

  private async runCycle(): Promise<SyncCycleResult> {
    const result: SyncCycleResult = {
      status: 'COMPLETED',
      bootstrapped: false,
      pushed: 0,
      pulled: 0
    }

    try {
      this.dependencies.queueRepository.recoverStaleSyncing(this.dependencies.clock.nowIsoUtc())
      await this.retryBootstrapCompletion()

      if (
        this.dependencies.stateRepository.lastServerCursor() === null ||
        this.dependencies.stagingRepository.currentSession() !== null
      ) {
        await this.establishBootstrap()
        result.bootstrapped = true
      }

      const queuedEvents = this.claimPendingBatch()
      if (queuedEvents.length > 0) {
        let response
        try {
          response = await this.dependencies.transport.push({ events: queuedEvents })
        } catch (error) {
          return this.handleRequestFailure(error, queuedEvents, result)
        }
        try {
          this.dependencies.unitOfWork.transaction(() => {
            this.applyPushResults(
              queuedEvents,
              response.results,
              this.dependencies.clock.nowIsoUtc()
            )
          })
          result.pushed = queuedEvents.length
        } catch (error) {
          return this.handleRequestFailure(error, queuedEvents, result)
        }
      }

      let hasMore = true
      let expiredCursorRecovered = false
      while (hasMore) {
        const cursor = this.dependencies.stateRepository.lastServerCursor()
        if (cursor === null) {
          throw new LocalDomainError(
            'SYNC_BOOTSTRAP_REQUIRED',
            'Sinxronlashdan oldin ma’lumotnomalarni yuklang'
          )
        }
        let page
        try {
          page = await this.dependencies.transport.pull({
            cursor,
            limit: this.dependencies.limits.pullMaxChanges
          })
        } catch (error) {
          if (errorDetails(error).code === 'SYNC_CURSOR_EXPIRED' && !expiredCursorRecovered) {
            await this.establishBootstrap()
            result.bootstrapped = true
            expiredCursorRecovered = true
            continue
          }
          throw error
        }
        this.dependencies.mirrorRepository.applyPullPage(
          page.changes,
          page.next_cursor,
          this.dependencies.clock.nowIsoUtc()
        )
        result.pulled += page.changes.length
        hasMore = page.has_more
      }

      await this.synchronizeNumberBlocks()
      this.cleanupSyncedQueue(this.dependencies.clock.nowIsoUtc())
      await this.retryBootstrapCompletion()
      this.dependencies.networkStatus.reportOnline(this.dependencies.clock.nowIsoUtc())
      return result
    } catch (error) {
      return this.handleRequestFailure(error, [], result)
    }
  }

  private claimPendingBatch(): ReturnType<SyncQueueRepository['pendingBatch']> {
    return this.dependencies.unitOfWork.transaction(() => {
      const now = this.dependencies.clock.nowIsoUtc()
      const events = this.dependencies.queueRepository.pendingBatch(
        this.dependencies.limits.pushMaxEvents,
        now
      )
      if (events.length === 0) return events
      const marked = this.dependencies.queueRepository.markSyncing(
        events.map(({ event_id }) => event_id),
        now
      )
      if (marked !== events.length) {
        throw new Error('Unable to atomically claim every pending sync event')
      }
      return events
    })
  }

  private applyPushResults(
    events: ReturnType<SyncQueueRepository['pendingBatch']>,
    results: readonly SyncPushResult[],
    appliedAt: string
  ): void {
    if (results.length !== events.length) {
      throw new Error('Sync server returned a different number of results than submitted events')
    }
    const eventById = new Map(events.map((event) => [event.event_id, event]))
    const handledIds = new Set<string>()

    results.forEach((result, index) => {
      const eventId = result.event_id ?? events[index]?.event_id
      if (!eventId || !eventById.has(eventId) || handledIds.has(eventId)) {
        throw new Error('Sync server result does not map to one submitted event')
      }
      handledIds.add(eventId)
      if (result.status === 'SYNCED') {
        if (!this.dependencies.queueRepository.markSynced(eventId, result, appliedAt)) {
          throw new Error('Synced event is no longer in the claimed queue state')
        }
      } else if (result.status === 'CONFLICT') {
        const event = eventById.get(eventId)
        if (!event) throw new Error('Conflicting event is not in the submitted batch')
        this.dependencies.conflictRepository.persist(eventId, result.conflict, appliedAt)
      } else if (
        !this.dependencies.queueRepository.markFailed(
          eventId,
          result.error.code,
          result.error.message,
          appliedAt
        )
      ) {
        throw new Error('Failed event is no longer in the claimed queue state')
      }
    })
  }

  private async establishBootstrap(): Promise<BootstrapProgress> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let sessionId: string
      let watermark: string
      let local = this.dependencies.stagingRepository.currentSession()

      if (local) {
        sessionId = local.session_id
        watermark = local.watermark
      } else {
        const session = await this.dependencies.transport.createBootstrap()
        if (
          session.device_id.toLowerCase() !== this.dependencies.transport.deviceId().toLowerCase()
        ) {
          throw new LocalDomainError(
            'SYNC_BOOTSTRAP_DEVICE_MISMATCH',
            'Sinxronlash sessiyasi boshqa qurilmaga tegishli'
          )
        }
        sessionId = session.id
        watermark = session.watermark
        this.dependencies.stagingRepository.beginSession(
          session,
          this.dependencies.clock.nowIsoUtc()
        )
        local = this.dependencies.stagingRepository.currentSession()
      }

      try {
        while (local?.status === 'ACTIVE') {
          const after = local.next_order_key === '0' ? null : local.next_order_key
          const page = await this.dependencies.transport.bootstrapPage(
            sessionId,
            after,
            this.dependencies.limits.bootstrapPageSize
          )
          this.dependencies.stagingRepository.persistPage(page, this.dependencies.clock.nowIsoUtc())
          local = this.dependencies.stagingRepository.currentSession()
          if (!page.has_more) break
        }
        const ready = this.dependencies.stagingRepository.currentSession()
        if (!ready || ready.session_id !== sessionId || ready.status !== 'READY_TO_APPLY') {
          throw new Error('Bootstrap did not reach its locally staged completion state')
        }
        this.dependencies.mirrorRepository.finalizeBootstrap(
          sessionId,
          watermark,
          this.dependencies.clock.nowIsoUtc()
        )
        await this.retryBootstrapCompletion()
        return { bootstrapped: true, sessionId }
      } catch (error) {
        if (errorDetails(error).code === 'SYNC_BOOTSTRAP_EXPIRED' && attempt === 0) {
          this.dependencies.stagingRepository.discardSession(sessionId)
          continue
        }
        throw error
      }
    }
    throw new Error('Unable to establish a fresh sync bootstrap session')
  }

  private async retryBootstrapCompletion(): Promise<void> {
    const completedSessionId = this.dependencies.stateRepository.lastCompletedBootstrapSessionId()
    const acknowledgedSessionId = this.dependencies.stateRepository.get(
      'last_server_completed_bootstrap_session_id'
    )
    if (!completedSessionId || completedSessionId === acknowledgedSessionId) return

    try {
      await this.dependencies.transport.completeBootstrap(completedSessionId)
      this.dependencies.unitOfWork.transaction(() => {
        this.dependencies.stateRepository.set(
          'last_server_completed_bootstrap_session_id',
          completedSessionId,
          this.dependencies.clock.nowIsoUtc()
        )
      })
    } catch (error) {
      this.recordNetworkStatus(error)
      if (this.dependencies.retryPolicy.classify(error) === 'TRANSIENT') {
        this.scheduleRetry(this.dependencies.retryPolicy.delayMilliseconds(0))
      }
    }
  }

  private async synchronizeNumberBlocks(): Promise<void> {
    for (const report of this.dependencies.blockRepository.pendingUsageReports()) {
      const updated = await this.dependencies.transport.reportPattaBlockUsage(
        report.blockId,
        report.reportedUsedCount
      )
      this.dependencies.unitOfWork.transaction(() => {
        this.dependencies.blockRepository.applyReportedUsage(updated)
      })
    }

    if (this.dependencies.blockRepository.shouldPrefetchNextBlock()) {
      const allocated = await this.dependencies.transport.allocatePattaNumberBlock()
      this.dependencies.unitOfWork.transaction(() => {
        this.dependencies.blockRepository.storeAllocatedBlock(allocated)
      })
    }
  }

  private cleanupSyncedQueue(now: string): void {
    const retentionDays = this.dependencies.limits.syncedQueueRetentionDays ?? 30
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new Error('Synced queue retention must be a positive whole number of days')
    }
    const nowMilliseconds = Date.parse(now)
    if (!Number.isFinite(nowMilliseconds))
      throw new Error('Sync clock returned an invalid timestamp')
    const cutoff = canonicalUtcTimestamp(
      new Date(nowMilliseconds - retentionDays * 24 * 60 * 60 * 1_000).toISOString(),
      'Synced queue retention cutoff'
    )
    this.dependencies.unitOfWork.transaction(() => {
      this.dependencies.queueRepository.cleanupSyncedOlderThan(cutoff)
    })
  }

  private handleRequestFailure(
    error: unknown,
    events: ReturnType<SyncQueueRepository['pendingBatch']>,
    current: SyncCycleResult
  ): SyncCycleResult {
    const classification = this.dependencies.retryPolicy.classify(error)
    const info = errorDetails(error)
    const now = this.dependencies.clock.nowIsoUtc()

    if (events.length > 0) {
      this.dependencies.unitOfWork.transaction(() => {
        for (const event of events) {
          if (classification === 'TRANSIENT') {
            const attempt = this.dependencies.queueRepository.attemptCount(event.event_id)
            const retryAt = this.dependencies.retryPolicy.nextAttemptAt(now, attempt)
            this.dependencies.queueRepository.deferRetry(
              event.event_id,
              retryAt,
              info.code ?? 'SYNC_NETWORK_ERROR',
              'Internet bilan vaqtinchalik aloqa yo‘q',
              now
            )
          } else if (classification === 'AUTH_REQUIRED') {
            this.dependencies.queueRepository.deferRetry(
              event.event_id,
              now,
              'AUTH_REQUIRED',
              'Sinxronlash uchun tizimga qayta kiring',
              now
            )
          } else if (classification === 'CONFLICT') {
            this.dependencies.conflictRepository.persist(
              event.event_id,
              conflictForEvent(event, info),
              now
            )
          } else {
            this.dependencies.queueRepository.markFailed(
              event.event_id,
              failureCode(error, info),
              info.message,
              now
            )
          }
        }
      })
    }

    this.recordNetworkStatus(error)
    if (classification === 'TRANSIENT') {
      const retryDelay =
        events.length === 0
          ? this.dependencies.retryPolicy.delayMilliseconds(0)
          : Math.min(
              ...events.map((event) =>
                this.dependencies.retryPolicy.delayMilliseconds(
                  this.dependencies.queueRepository.attemptCount(event.event_id) - 1
                )
              )
            )
      this.scheduleRetry(retryDelay)
      return { ...current, status: 'OFFLINE' }
    }
    if (classification === 'AUTH_REQUIRED') return { ...current, status: 'AUTH_REQUIRED' }
    if (classification === 'CONFLICT') {
      this.dependencies.networkStatus.reportOnline(now)
      return { ...current, status: 'COMPLETED' }
    }
    if (info.status !== null) this.dependencies.networkStatus.reportOnline(now)
    return { ...current, status: 'FAILED' }
  }

  private recordNetworkStatus(error: unknown): void {
    const classification = this.dependencies.retryPolicy.classify(error)
    if (classification === 'TRANSIENT') {
      this.dependencies.networkStatus.reportOffline()
    } else if (classification === 'AUTH_REQUIRED') {
      this.dependencies.networkStatus.reportAuthenticationRequired()
    }
  }

  private scheduleRetry(delayMilliseconds: number): void {
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.disposed) void this.runOnce()
    }, delayMilliseconds)
    this.retryTimer.unref?.()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private async runScheduledCycle(): Promise<void> {
    try {
      await this.runOnce()
    } catch (error) {
      this.recordNetworkStatus(error)
    }
  }
}
