import { describe, expect, it } from 'vitest'
import { SyncRetryPolicy } from './retry-policy'

describe('sync retry policy', () => {
  it('retries network failures and gateway/server timeouts only', () => {
    const policy = new SyncRetryPolicy(() => 0.5)
    expect(policy.classify(new TypeError('fetch failed'))).toBe('TRANSIENT')
    for (const status of [502, 503, 504]) {
      expect(policy.classify({ status })).toBe('TRANSIENT')
    }
    expect(policy.classify({ code: 'ETIMEDOUT' })).toBe('TRANSIENT')
    expect(policy.classify({ code: 'ECONNRESET' })).toBe('TRANSIENT')
  })

  it('delegates authorization and treats request/client conflicts as non-retryable', () => {
    const policy = new SyncRetryPolicy(() => 0.5)
    expect(policy.classify({ status: 400 })).toBe('PERMANENT')
    expect(policy.classify({ status: 401 })).toBe('AUTH_REQUIRED')
    expect(policy.classify({ status: 403 })).toBe('PERMANENT')
    expect(policy.classify({ status: 409 })).toBe('CONFLICT')
  })

  it('uses bounded 5/15/30/60 second delays with deterministic jitter bounds', () => {
    const lowJitter = new SyncRetryPolicy(() => 0)
    const middleJitter = new SyncRetryPolicy(() => 0.5)
    const highJitter = new SyncRetryPolicy(() => 0.999999)

    expect(middleJitter.delayMilliseconds(0)).toBe(5_000)
    expect(middleJitter.delayMilliseconds(1)).toBe(15_000)
    expect(middleJitter.delayMilliseconds(2)).toBe(30_000)
    expect(middleJitter.delayMilliseconds(3)).toBe(60_000)
    expect(middleJitter.delayMilliseconds(50)).toBe(60_000)
    expect(lowJitter.delayMilliseconds(0)).toBe(4_000)
    expect(highJitter.delayMilliseconds(0)).toBeLessThanOrEqual(6_000)
  })
})
