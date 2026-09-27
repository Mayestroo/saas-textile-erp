import { canonicalUtcTimestamp } from '../local/utc-timestamp'

export type RetryClassification = 'TRANSIENT' | 'AUTH_REQUIRED' | 'CONFLICT' | 'PERMANENT'

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export class SyncRetryPolicy {
  constructor(private readonly random: () => number = Math.random) {}

  classify(error: unknown): RetryClassification {
    const value = record(error)
    const response = record(value?.response)
    const status = value?.status ?? response?.status
    if (typeof status === 'number' && Number.isInteger(status)) {
      if (status === 401) return 'AUTH_REQUIRED'
      if (status === 409) return 'CONFLICT'
      if (status === 408 || status === 502 || status === 503 || status === 504) {
        return 'TRANSIENT'
      }
      return 'PERMANENT'
    }

    const code = value?.code ?? response?.code
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return 'TRANSIENT'
    if (value?.name === 'AbortError' || value?.name === 'TimeoutError') return 'TRANSIENT'
    if (error instanceof TypeError) return 'TRANSIENT'
    return 'PERMANENT'
  }

  delayMilliseconds(attemptCount: number): number {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) {
      throw new Error('Sync retry attempt count must be a non-negative safe integer')
    }
    const baseDelay = RETRY_DELAYS_MS[Math.min(attemptCount, RETRY_DELAYS_MS.length - 1)]
    const sample = this.random()
    const boundedSample = Number.isFinite(sample) ? Math.min(0.999999, Math.max(0, sample)) : 0.5
    return Math.round(baseDelay * (0.8 + boundedSample * 0.4))
  }

  nextAttemptAt(now: string, attemptCount: number): string {
    const nowMilliseconds = Date.parse(now)
    if (!Number.isFinite(nowMilliseconds))
      throw new Error('Sync retry clock returned an invalid timestamp')
    const retryTime = new Date(nowMilliseconds + this.delayMilliseconds(attemptCount)).toISOString()
    return canonicalUtcTimestamp(retryTime, 'Next sync retry time')
  }
}
