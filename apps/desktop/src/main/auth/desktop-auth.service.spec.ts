import { describe, expect, it } from 'vitest'
import type { SecureSessionPayload, SecureSessionStore } from './secure-session-store'
import { SecureSessionStoreError } from './secure-session-store'
import {
  DesktopAuthService,
  type TenantSessionRuntime
} from './desktop-auth.service'
import type {
  TenantAuthApi,
  TenantLoginResult,
  TenantTokenPair
} from './tenant-auth-api-client'
import { TenantAuthApiError } from './tenant-auth-api-client'

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMPANY_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const LOGIN_RESULT: TenantLoginResult = {
  accessToken: 'access-A-1',
  refreshToken: 'refresh-A-1',
  expiresIn: 900,
  user: { id: USER_A, email: 'operator-a@example.test', fullName: 'Operator A' },
  company: { id: COMPANY_A, slug: 'atlas', timezone: 'Asia/Tashkent' }
}

const SESSION_A: SecureSessionPayload = {
  version: 2,
  refreshToken: 'refresh-A-1',
  tenantOrigin: 'https://atlas.example.test',
  tenantHost: 'atlas.example.test',
  companyId: COMPANY_A,
  companySlug: 'atlas',
  userId: USER_A,
  email: 'operator-a@example.test',
  fullName: 'Operator A',
  timezone: 'Asia/Tashkent'
}

const PAIR_B: TenantTokenPair = {
  accessToken: 'access-A-2',
  refreshToken: 'refresh-A-2',
  expiresIn: 900,
  tenantTimezone: 'Asia/Tashkent'
}

class MemoryStore implements SecureSessionStore {
  value: SecureSessionPayload | null = null
  failSave = false
  loadError: unknown = null
  saveStarted: (() => void) | null = null
  saveGate: Promise<void> | null = null
  readonly events: string[] = []

  async load(): Promise<SecureSessionPayload | null> {
    this.events.push('store:load')
    if (this.loadError) throw this.loadError
    return this.value ? { ...this.value } : null
  }

  async save(session: SecureSessionPayload): Promise<void> {
    this.events.push(`store:save:${session.refreshToken}`)
    this.saveStarted?.()
    if (this.saveGate) await this.saveGate
    if (this.failSave) throw new Error('disk write failed')
    this.value = { ...session }
  }

  async clear(): Promise<void> {
    this.events.push('store:clear')
    this.value = null
  }
}

class TestAuthApi implements TenantAuthApi {
  loginResult: TenantLoginResult = LOGIN_RESULT
  loginError: unknown = null
  refreshResult: TenantTokenPair = PAIR_B
  refreshError: unknown = null
  readonly loginCalls: Array<{ tenantUrl: string; email: string; password: string }> = []
  readonly refreshCalls: Array<{ tenantOrigin: string; refreshToken: string }> = []
  refreshGate: Promise<void> | null = null
  refreshStarted: (() => void) | null = null

  async login(tenantUrl: string, input: { email: string; password: string }): Promise<TenantLoginResult> {
    this.loginCalls.push({ tenantUrl, ...input })
    if (this.loginError) throw this.loginError
    return this.loginResult
  }

  async refresh(tenantOrigin: string, refreshToken: string): Promise<TenantTokenPair> {
    this.refreshCalls.push({ tenantOrigin, refreshToken })
    this.refreshStarted?.()
    if (this.refreshGate) await this.refreshGate
    if (this.refreshError) throw this.refreshError
    return this.refreshResult
  }
}

class TestRuntime implements TenantSessionRuntime {
  readonly events: string[] = []
  openedCompanyIds: string[] = []
  startedOrigins: string[] = []
  openedTimezones: Array<string | null> = []
  startedTimezones: Array<string | null> = []

  async openTenant(companyId: string, timezone: string | null): Promise<void> {
    this.events.push(`runtime:open:${companyId}`)
    this.openedCompanyIds.push(companyId)
    this.openedTimezones.push(timezone)
  }

  async startSync(tenantOrigin: string, timezone: string | null): Promise<void> {
    this.events.push(`runtime:start:${tenantOrigin}`)
    this.startedOrigins.push(tenantOrigin)
    this.startedTimezones.push(timezone)
  }

  async clearTenant(): Promise<void> {
    this.events.push('runtime:clear')
  }
}

function createService(): {
  service: DesktopAuthService
  store: MemoryStore
  api: TestAuthApi
  runtime: TestRuntime
} {
  const store = new MemoryStore()
  const api = new TestAuthApi()
  const runtime = new TestRuntime()
  const service = new DesktopAuthService(api, store, runtime)
  return { service, store, api, runtime }
}

describe('DesktopAuthService', () => {
  it('persists the refresh session before exposing the access token', async () => {
    const { service, store, api, runtime } = createService()
    let releaseSave: () => void = () => undefined
    let markSaveStarted: (() => void) | null = null
    store.saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve
    })
    store.saveStarted = () => markSaveStarted?.()

    const login = service.login({
      tenantUrl: 'https://atlas.example.test',
      email: 'operator@example.test',
      password: 'one-time-password'
    })
    await saveStarted
    await expect(service.accessToken()).resolves.toBeNull()
    expect(api.loginCalls[0]?.password).toBe('one-time-password')
    expect(store.value).toBeNull()
    releaseSave()

    await expect(login).resolves.toMatchObject({ state: 'AUTHENTICATED' })
    await expect(service.accessToken()).resolves.toBe('access-A-1')
    expect(store.value).toMatchObject({ refreshToken: 'refresh-A-1', companyId: COMPANY_A })
    expect(runtime.events).toEqual([
      'runtime:clear',
      `runtime:open:${COMPANY_A}`,
      'runtime:start:https://atlas.example.test'
    ])
    expect(service.currentSession()).toEqual({
      state: 'AUTHENTICATED',
      user: { id: USER_A, email: 'operator-a@example.test', full_name: 'Operator A' },
      company: { id: COMPANY_A, slug: 'atlas', timezone: 'Asia/Tashkent' },
      tenant_host: 'atlas.example.test'
    })
    expect(service.currentSession()).not.toHaveProperty('accessToken')
    expect(service.currentSession()).not.toHaveProperty('refreshToken')
  })

  it.each([
    ['wrong password', 'INVALID_CREDENTIALS', "Email yoki parol noto'g'ri"],
    ['blocked account', 'USER_BLOCKED', "Email yoki parol noto'g'ri"],
    ['tenant unavailable', 'TENANT_CONTEXT_MISMATCH', 'Korxona manzili topilmadi yoki faol emas'],
    ['rate limited', 'TOO_MANY_LOGIN_ATTEMPTS', 'Urinishlar soni oshib ketdi. Keyinroq qayta urinib ko‘ring']
  ])('maps %s to a safe sign-in error', async (_label, code, message) => {
    const { service, store, api } = createService()
    api.loginError = new TenantAuthApiError(code === 'TOO_MANY_LOGIN_ATTEMPTS' ? 429 : 401, code, false)

    await expect(
      service.login({
        tenantUrl: 'https://atlas.example.test',
        email: 'operator@example.test',
        password: 'secret'
      })
    ).resolves.toMatchObject({ state: 'ERROR', errorCode: code, message })
    expect(store.value).toBeNull()
    expect(service.currentSession().user).toBeNull()
  })

  it('restores a session by rotating and saving refresh before activating access', async () => {
    const { service, store, api, runtime } = createService()
    store.value = { ...SESSION_A }

    await expect(service.restoreSession()).resolves.toMatchObject({ state: 'AUTHENTICATED' })
    expect(api.refreshCalls).toEqual([
      { tenantOrigin: SESSION_A.tenantOrigin, refreshToken: 'refresh-A-1' }
    ])
    expect(store.value?.refreshToken).toBe('refresh-A-2')
    await expect(service.accessToken()).resolves.toBe('access-A-2')
    expect(runtime.openedCompanyIds).toEqual([COMPANY_A])
    expect(runtime.openedTimezones).toEqual(['Asia/Tashkent'])
    expect(runtime.startedOrigins).toEqual([SESSION_A.tenantOrigin])
    expect(runtime.startedTimezones).toEqual(['Asia/Tashkent'])
  })

  it.each(['INVALID_REFRESH_TOKEN', 'SESSION_REVOKED'])('clears an expired or %s session', async (code) => {
    const { service, store, api, runtime } = createService()
    store.value = { ...SESSION_A }
    api.refreshError = new TenantAuthApiError(401, code, false)

    await expect(service.restoreSession()).resolves.toMatchObject({
      state: 'SIGNED_OUT',
      errorCode: 'SESSION_EXPIRED',
      message: 'Sessiya muddati tugagan'
    })
    expect(store.value).toBeNull()
    expect(runtime.events).toContain('runtime:clear')
    await expect(service.accessToken()).resolves.toBeNull()
  })

  it('keeps a refresh credential and local company DB when restore is temporarily offline', async () => {
    const { service, store, api, runtime } = createService()
    store.value = { ...SESSION_A }
    api.refreshError = new TenantAuthApiError(503, 'AUTHENTICATION_UNAVAILABLE', true)

    await expect(service.restoreSession()).resolves.toMatchObject({
      state: 'OFFLINE_SESSION_PENDING',
      message: 'Internet bilan aloqa yo‘q'
    })
    expect(store.value?.refreshToken).toBe('refresh-A-1')
    expect(runtime.openedCompanyIds).toEqual([COMPANY_A])
    expect(runtime.openedTimezones).toEqual(['Asia/Tashkent'])
    expect(runtime.startedOrigins).toEqual([SESSION_A.tenantOrigin])
    await expect(service.accessToken()).rejects.toMatchObject({ code: 'AUTHENTICATION_UNAVAILABLE' })
  })

  it('rejects and clears a corrupt secure session envelope on startup', async () => {
    const { service, store, runtime } = createService()
    store.value = { ...SESSION_A }
    store.loadError = new SecureSessionStoreError(
      'SECURE_SESSION_CORRUPT',
      'corrupt'
    )

    await expect(service.restoreSession()).resolves.toMatchObject({ state: 'ERROR' })
    expect(store.value).toBeNull()
    expect(runtime.events).toContain('runtime:clear')
    await expect(service.accessToken()).resolves.toBeNull()
  })

  it('clears session and closes tenant runtime if a rotated refresh token cannot be stored', async () => {
    const { service, store, runtime } = createService()
    store.value = { ...SESSION_A }
    store.failSave = true

    await expect(service.restoreSession()).resolves.toMatchObject({
      state: 'ERROR',
      errorCode: 'SECURE_STORAGE_WRITE_FAILED'
    })
    expect(store.value).toBeNull()
    await expect(service.accessToken()).resolves.toBeNull()
    expect(runtime.events.at(-1)).toBe('runtime:clear')
  })

  it('clears A before authenticating and opening tenant B', async () => {
    const { service, store, api, runtime } = createService()
    store.value = { ...SESSION_A }
    await service.restoreSession()
    runtime.events.length = 0
    api.loginResult = {
      accessToken: 'access-B-1',
      refreshToken: 'refresh-B-1',
      expiresIn: 900,
      user: { id: USER_B, email: 'operator-b@example.test', fullName: 'Operator B' },
      company: { id: COMPANY_B, slug: 'bravo', timezone: 'Europe/London' }
    }

    await expect(
      service.login({
        tenantUrl: 'https://bravo.example.test',
        email: 'operator-b@example.test',
        password: 'password-b'
      })
    ).resolves.toMatchObject({ state: 'AUTHENTICATED' })

    expect(runtime.events[0]).toBe('runtime:clear')
    expect(runtime.openedCompanyIds.at(-1)).toBe(COMPANY_B)
    expect(store.value).toMatchObject({ companyId: COMPANY_B, refreshToken: 'refresh-B-1' })
    expect(service.currentSession().company).toEqual({ id: COMPANY_B, slug: 'bravo', timezone: 'Europe/London' })
  })

  it('performs local logout while offline and clears active session state', async () => {
    const { service, store, runtime } = createService()
    store.value = { ...SESSION_A }
    await service.restoreSession()
    runtime.events.length = 0

    await service.logout()

    expect(service.status()).toMatchObject({ state: 'SIGNED_OUT' })
    expect(service.currentSession()).toEqual({
      state: 'SIGNED_OUT',
      user: null,
      company: null,
      tenant_host: null
    })
    expect(store.value).toBeNull()
    expect(runtime.events).toEqual(['runtime:clear'])
  })

  it('emits only sanitized structured auth failure metadata', async () => {
    const store = new MemoryStore()
    const api = new TestAuthApi()
    const runtime = new TestRuntime()
    const logs: Array<{ event: string; fields: unknown }> = []
    const service = new DesktopAuthService(api, store, runtime, {
      warn: (event, fields) => logs.push({ event, fields })
    })
    api.loginError = Object.assign(
      new TenantAuthApiError(401, 'INVALID_CREDENTIALS', false),
      { password: 'do-not-log', refresh_token: 'refresh-do-not-log' }
    )

    await service.login({
      tenantUrl: 'https://atlas.example.test',
      email: 'operator@example.test',
      password: 'do-not-log'
    })

    expect(logs).toEqual([
      {
        event: 'desktop.auth.operation_failed',
        fields: { operation: 'login', error_code: 'INVALID_CREDENTIALS' }
      }
    ])
    expect(JSON.stringify(logs)).not.toMatch(/do-not-log|refresh-do-not-log/)
  })

  it('does not reactivate a session when logout overlaps an in-flight startup refresh', async () => {
    const { service, store, api, runtime } = createService()
    store.value = { ...SESSION_A }
    let releaseRefresh: () => void = () => undefined
    let markRefreshStarted: (() => void) | null = null
    api.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    api.refreshStarted = () => markRefreshStarted?.()

    const restore = service.restoreSession()
    await refreshStarted
    await expect(service.logout()).resolves.toMatchObject({ state: 'SIGNED_OUT' })
    expect(store.value).toBeNull()
    expect(runtime.events.at(-1)).toBe('runtime:clear')

    releaseRefresh()
    await expect(restore).resolves.toMatchObject({ state: 'SIGNED_OUT' })
    expect(store.value).toBeNull()
    expect(service.currentSession().company).toBeNull()
  })

  it('drops process-memory credentials for shutdown without deleting the persisted session', async () => {
    const { service, store } = createService()
    store.value = { ...SESSION_A }
    await service.restoreSession()

    service.prepareForShutdown()

    expect(service.status().state).toBe('SIGNED_OUT')
    expect(service.currentSession().company).toBeNull()
    expect(store.value?.refreshToken).toBe('refresh-A-2')
    await expect(service.accessToken()).resolves.toBeNull()
  })

  it('does not retain credentials when no secure session exists after startup', async () => {
    const { service, api, runtime } = createService()

    await expect(service.restoreSession()).resolves.toMatchObject({ state: 'SIGNED_OUT' })
    expect(api.refreshCalls).toHaveLength(0)
    expect(runtime.openedCompanyIds).toHaveLength(0)
    expect(await service.accessToken()).toBeNull()
  })
})
