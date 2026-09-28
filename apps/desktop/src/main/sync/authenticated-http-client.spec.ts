import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedHttpRequest } from './authenticated-sync-transport'
import { AuthenticatedHttpError, FetchAuthenticatedHttpClient } from './authenticated-http-client'
import type { AuthenticatedSessionProvider } from './authenticated-http-client'

class TestSession implements AuthenticatedSessionProvider {
  accessTokenCalls = 0
  refreshCalls = 0

  constructor(
    private readonly tokens: readonly (string | null)[],
    private readonly refreshResult: boolean
  ) {}

  async accessToken(): Promise<string | null> {
    const token = this.tokens[this.accessTokenCalls] ?? null
    this.accessTokenCalls += 1
    return token
  }

  async refreshAfterUnauthorized(): Promise<boolean> {
    this.refreshCalls += 1
    return this.refreshResult
  }
}

function request(): AuthenticatedHttpRequest {
  return {
    method: 'POST',
    url: 'https://factory.example/api/v1/sync/push',
    body: { events: [] }
  }
}

describe('authenticated HTTP session boundary', () => {
  it('refreshes once after 401 and retries with a fresh bearer token', async () => {
    const session = new TestSession(['expired-token', 'fresh-token'], true)
    const authorizationHeaders: string[] = []
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers)
      authorizationHeaders.push(headers.get('Authorization') ?? '')
      return authorizationHeaders.length === 1
        ? new Response(JSON.stringify({ code: 'ACCESS_TOKEN_EXPIRED' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
          })
        : new Response(JSON.stringify({ accepted: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
    }
    const httpClient = new FetchAuthenticatedHttpClient(session, 'https://factory.example', fetcher)

    await expect(httpClient.request(request())).resolves.toEqual({ accepted: true })
    expect(authorizationHeaders).toEqual(['Bearer expired-token', 'Bearer fresh-token'])
    expect(session.refreshCalls).toBe(1)
    expect(session.accessTokenCalls).toBe(2)
  })

  it('surfaces an unrefreshed 401 and keeps authentication outside queue payloads', async () => {
    const session = new TestSession(['invalid-token'], false)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message: 'Tizimga kiring' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const httpClient = new FetchAuthenticatedHttpClient(session, 'https://factory.example', fetcher)

    await expect(httpClient.request(request())).rejects.toMatchObject<
      Partial<AuthenticatedHttpError>
    >({
      status: 401,
      body: { code: 'AUTH_REQUIRED' }
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects cross-origin URLs before requesting an access token', async () => {
    const session = new TestSession([], true)
    const httpClient = new FetchAuthenticatedHttpClient(
      session,
      'https://factory.example',
      async () => new Response(null, { status: 200 })
    )

    await expect(
      httpClient.request({
        ...request(),
        url: 'https://other-tenant.example/api/v1/sync/push'
      })
    ).rejects.toThrow('outside its configured tenant origin')
    expect(session.accessTokenCalls).toBe(0)
  })
})
