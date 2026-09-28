import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedHttpRequest } from './authenticated-sync-transport'
import { AuthenticatedHttpError, FetchAuthenticatedHttpClient } from './authenticated-http-client'
import type { AuthenticatedSessionProvider } from './authenticated-http-client'
import type { SecureSessionPayload, SecureSessionStore } from '../auth/secure-session-store'
import { DesktopAuthService } from '../auth/desktop-auth.service'
import type { TenantAuthApi, TenantLoginResult, TenantTokenPair } from '../auth/tenant-auth-api-client'

const LOGIN_RESULT: TenantLoginResult = {
  accessToken: 'expired-token',
  refreshToken: 'refresh-token-1',
  expiresIn: 900,
  user: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'operator@example.test',
    fullName: 'Operator One'
  },
  company: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'factory' }
}

class AuthTestStore implements SecureSessionStore {
  value: SecureSessionPayload | null = null

  async load(): Promise<SecureSessionPayload | null> {
    return this.value
  }

  async save(session: SecureSessionPayload): Promise<void> {
    this.value = { ...session }
  }

  async clear(): Promise<void> {
    this.value = null
  }
}

class AuthTestApi implements TenantAuthApi {
  refreshCalls = 0
  refreshStarted: (() => void) | null = null
  refreshGate: Promise<void> | null = null

  async login(): Promise<TenantLoginResult> {
    return LOGIN_RESULT
  }

  async refresh(): Promise<TenantTokenPair> {
    this.refreshCalls += 1
    this.refreshStarted?.()
    if (this.refreshGate) await this.refreshGate
    return { accessToken: 'fresh-token', refreshToken: 'refresh-token-2', expiresIn: 900 }
  }
}

async function createAuthenticatedService(api: AuthTestApi): Promise<DesktopAuthService> {
  const service = new DesktopAuthService(api, new AuthTestStore(), {
    openTenant: async () => undefined,
    startSync: async () => undefined,
    clearTenant: async () => undefined
  })
  await service.login({
    tenantUrl: 'https://factory.example.test',
    email: 'operator@example.test',
    password: 'one-time-password'
  })
  return service
}

class TestSession implements AuthenticatedSessionProvider {
  accessTokenCalls = 0
  refreshCalls = 0
  rejectedTokens: Array<string | undefined> = []
  refreshError: unknown = null

  constructor(
    private readonly tokens: readonly (string | null)[],
    private readonly refreshResult: boolean
  ) {}

  async accessToken(): Promise<string | null> {
    const token = this.tokens[this.accessTokenCalls] ?? null
    this.accessTokenCalls += 1
    return token
  }

  async refreshAfterUnauthorized(rejectedAccessToken?: string): Promise<boolean> {
    this.refreshCalls += 1
    this.rejectedTokens.push(rejectedAccessToken)
    if (this.refreshError) throw this.refreshError
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

function authRequest(): AuthenticatedHttpRequest {
  return {
    method: 'POST',
    url: 'https://factory.example.test/api/v1/sync/push',
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
    expect(session.rejectedTokens).toEqual(['expired-token'])
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

  it('propagates transient refresh failures instead of converting them to AUTH_REQUIRED', async () => {
    const session = new TestSession(['expired-token'], false)
    session.refreshError = new TypeError('fetch failed')
    const fetcher: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 'INVALID_ACCESS_TOKEN' }), { status: 401 })
    const httpClient = new FetchAuthenticatedHttpClient(session, 'https://factory.example', fetcher)

    await expect(httpClient.request(request())).rejects.toMatchObject({ name: 'TypeError' })
    expect(session.rejectedTokens).toEqual(['expired-token'])
  })

  it('shares one production auth refresh across ten concurrent 401 responses', async () => {
    const authApi = new AuthTestApi()
    let releaseRefresh: () => void = () => undefined
    let markRefreshStarted: (() => void) | null = null
    authApi.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    authApi.refreshStarted = () => markRefreshStarted?.()
    const auth = await createAuthenticatedService(authApi)
    const sentAuthorization: string[] = []
    const fetcher: typeof fetch = async (_input, init) => {
      sentAuthorization.push(new Headers(init?.headers).get('Authorization') ?? '')
      const status = sentAuthorization.length <= 10 ? 401 : 200
      return new Response(JSON.stringify({ accepted: true }), { status })
    }
    const client = new FetchAuthenticatedHttpClient(auth, 'https://factory.example.test', fetcher)

    const requests = Array.from({ length: 10 }, () => client.request(authRequest()))
    await refreshStarted
    expect(authApi.refreshCalls).toBe(1)
    releaseRefresh()
    await expect(Promise.all(requests)).resolves.toHaveLength(10)

    expect(authApi.refreshCalls).toBe(1)
    expect(sentAuthorization.slice(0, 10)).toEqual(Array(10).fill('Bearer expired-token'))
    expect(sentAuthorization.slice(10)).toEqual(Array(10).fill('Bearer fresh-token'))
  })

  it('reuses a rotated token for a delayed 401 from its older generation', async () => {
    const authApi = new AuthTestApi()
    const auth = await createAuthenticatedService(authApi)
    let releaseFirst401: () => void = () => undefined
    let markFirstRequestStarted: (() => void) | null = null
    const first401Gate = new Promise<void>((resolve) => {
      releaseFirst401 = resolve
    })
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve
    })
    let fetchCount = 0
    const fetcher: typeof fetch = async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        markFirstRequestStarted?.()
        await first401Gate
        return new Response(JSON.stringify({ code: 'INVALID_ACCESS_TOKEN' }), { status: 401 })
      }
      if (fetchCount === 2) {
        return new Response(JSON.stringify({ code: 'INVALID_ACCESS_TOKEN' }), { status: 401 })
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 200 })
    }
    const client = new FetchAuthenticatedHttpClient(auth, 'https://factory.example.test', fetcher)

    const delayed = client.request(authRequest())
    await firstRequestStarted
    await expect(client.request(authRequest())).resolves.toEqual({ accepted: true })
    expect(authApi.refreshCalls).toBe(1)
    releaseFirst401()
    await expect(delayed).resolves.toEqual({ accepted: true })
    expect(authApi.refreshCalls).toBe(1)
    expect(fetchCount).toBe(4)
  })
})
