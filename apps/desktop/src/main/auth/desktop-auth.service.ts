import type { AuthenticatedSessionProvider } from '../sync/authenticated-http-client'
import { LocalDomainError } from '../local/local-errors'
import { authErrorMessage } from './auth-error-mapper'
import { normalizeTenantOrigin } from './tenant-auth-api-client'
import type { TenantAuthApi, TenantLoginResult, TenantTokenPair } from './tenant-auth-api-client'
import { TenantAuthApiError } from './tenant-auth-api-client'
import type { SecureSessionPayload, SecureSessionStore } from './secure-session-store'
import { SecureSessionStoreError } from './secure-session-store'
import { sanitizeStructuredFields } from '../logging/sanitize-structured-fields'

export type DesktopAuthState =
  | 'SIGNED_OUT'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'REFRESHING'
  | 'OFFLINE_SESSION_PENDING'
  | 'ERROR'

export interface DesktopAuthStatus {
  state: DesktopAuthState
  errorCode: string | null
  message: string | null
}

export interface SafeDesktopSession {
  state: DesktopAuthState
  user: { id: string; email: string; full_name: string } | null
  company: { id: string; slug: string } | null
  tenant_host: string | null
}

export interface DesktopLoginInput {
  tenantUrl: string
  email: string
  password: string
}

export interface TenantSessionRuntime {
  openTenant(companyId: string): Promise<void>
  startSync(tenantOrigin: string): Promise<void>
  clearTenant(preserveLocalDatabase?: boolean): Promise<void>
}

export interface DesktopAuthLogger {
  warn(event: string, fields: unknown): void
}

const consoleAuthLogger: DesktopAuthLogger = {
  warn(event, fields) {
    console.warn(event, fields)
  }
}

const INVALID_REFRESH_CODES = new Set([
  'INVALID_REFRESH_TOKEN',
  'SESSION_REVOKED',
  'TENANT_CONTEXT_MISMATCH',
  'TENANT_NOT_FOUND',
  'TENANT_INACTIVE',
  'TENANT_HOST_INVALID',
  'AUTHENTICATION_REQUIRED',
  'AUTH_REQUIRED'
])

function errorCode(error: unknown): string {
  if (error instanceof TenantAuthApiError || error instanceof SecureSessionStoreError) {
    return error.code
  }
  if (error instanceof LocalDomainError) return error.code
  return 'AUTH_OPERATION_FAILED'
}

function isTransient(error: unknown): boolean {
  return error instanceof TenantAuthApiError
    ? error.transient
    : error instanceof TypeError ||
        (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
}

function isInvalidRefresh(error: unknown): boolean {
  return (
    error instanceof TenantAuthApiError &&
    (INVALID_REFRESH_CODES.has(error.code) || error.status === 401 || error.status === 403)
  )
}

function payloadFromLogin(
  tenantUrl: string,
  result: TenantLoginResult
): SecureSessionPayload {
  const tenant = normalizeTenantOrigin(tenantUrl)
  return {
    version: 1,
    refreshToken: result.refreshToken,
    tenantOrigin: tenant.origin,
    tenantHost: tenant.tenantHost,
    companyId: result.company.id,
    companySlug: result.company.slug,
    userId: result.user.id,
    email: result.user.email,
    fullName: result.user.fullName
  }
}

export class DesktopAuthService implements AuthenticatedSessionProvider {
  private authState: DesktopAuthState = 'SIGNED_OUT'
  private currentErrorCode: string | null = null
  private accessTokenValue: string | null = null
  private sessionPayload: SecureSessionPayload | null = null
  private refreshInFlight: Promise<boolean> | null = null
  private restoreInFlight: Promise<DesktopAuthStatus> | null = null
  private loginInProgress = false
  private operationGeneration = 0
  private transitionTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly api: TenantAuthApi,
    private readonly secureStore: SecureSessionStore,
    private readonly runtime: TenantSessionRuntime,
    private readonly logger: DesktopAuthLogger = consoleAuthLogger
  ) {}

  status(): DesktopAuthStatus {
    return {
      state: this.authState,
      errorCode: this.currentErrorCode,
      message: this.currentErrorCode
        ? authErrorMessage(
            new TenantAuthApiError(
              null,
              this.currentErrorCode,
              this.authState === 'OFFLINE_SESSION_PENDING'
            )
          )
        : null
    }
  }

  currentSession(): SafeDesktopSession {
    const payload = this.sessionPayload
    return {
      state: this.authState,
      user: payload
        ? { id: payload.userId, email: payload.email, full_name: payload.fullName }
        : null,
      company: payload ? { id: payload.companyId, slug: payload.companySlug } : null,
      tenant_host: payload?.tenantHost ?? null
    }
  }

  async login(input: DesktopLoginInput): Promise<DesktopAuthStatus> {
    if (this.loginInProgress) return this.status()
    this.loginInProgress = true
    const generation = ++this.operationGeneration
    this.refreshInFlight = null
    this.restoreInFlight = null
    this.authState = 'AUTHENTICATING'
    this.currentErrorCode = null
    this.accessTokenValue = null
    this.sessionPayload = null

    try {
      const tenant = normalizeTenantOrigin(input.tenantUrl)
      await this.runTransition(async () => {
        if (generation !== this.operationGeneration) return
        await this.clearLocalSession()
      })
      if (generation !== this.operationGeneration) return this.status()
      const result = await this.api.login(tenant.origin, {
        email: input.email,
        password: input.password
      })
      if (generation !== this.operationGeneration) return this.status()
      const payload = payloadFromLogin(input.tenantUrl, result)
      return await this.runTransition(async () => {
        if (generation !== this.operationGeneration) return this.status()
        await this.runtime.openTenant(payload.companyId)
        if (generation !== this.operationGeneration) return this.status()
        try {
          await this.secureStore.save(payload)
        } catch {
          await this.clearLocalSession()
          return this.setError('SECURE_STORAGE_WRITE_FAILED')
        }
        if (generation !== this.operationGeneration) {
          await this.clearLocalSession()
          return this.status()
        }

        this.sessionPayload = payload
        this.accessTokenValue = result.accessToken
        this.authState = 'AUTHENTICATED'
        this.currentErrorCode = null
        await this.runtime.startSync(payload.tenantOrigin)
        return this.status()
      })
    } catch (error) {
      if (generation !== this.operationGeneration) return this.status()
      this.logFailure('login', error)
      return this.runTransition(async () => {
        if (generation !== this.operationGeneration) return this.status()
        try {
          await this.clearLocalSession()
        } catch (clearError) {
          return this.setError(errorCode(clearError))
        }
        return this.setError(errorCode(error))
      })
    } finally {
      this.loginInProgress = false
    }
  }

  restoreSession(): Promise<DesktopAuthStatus> {
    if (this.restoreInFlight) return this.restoreInFlight
    if (this.loginInProgress) return Promise.resolve(this.status())
    if (this.authState === 'AUTHENTICATED') return Promise.resolve(this.status())
    if (this.authState === 'OFFLINE_SESSION_PENDING') {
      return this.refreshAccessToken()
        .then(() => this.status())
        .catch(() => this.status())
    }

    const generation = ++this.operationGeneration
    const operation = this.restoreStoredSession(generation)
    this.restoreInFlight = operation
    void operation.then(
      () => {
        if (this.restoreInFlight === operation) this.restoreInFlight = null
      },
      () => {
        if (this.restoreInFlight === operation) this.restoreInFlight = null
      }
    )
    return operation
  }

  async refreshAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight
    if (!this.sessionPayload) return false

    const operation = this.rotateSession()
    this.refreshInFlight = operation
    void operation.then(
      () => {
        if (this.refreshInFlight === operation) this.refreshInFlight = null
      },
      () => {
        if (this.refreshInFlight === operation) this.refreshInFlight = null
      }
    )
    return operation
  }

  async accessToken(): Promise<string | null> {
    if (this.authState === 'OFFLINE_SESSION_PENDING' && this.sessionPayload) {
      const refreshed = await this.refreshAccessToken()
      return refreshed ? this.accessTokenValue : null
    }
    return this.accessTokenValue
  }

  async refreshAfterUnauthorized(rejectedAccessToken?: string): Promise<boolean> {
    if (
      this.accessTokenValue &&
      rejectedAccessToken !== undefined &&
      rejectedAccessToken !== this.accessTokenValue
    ) {
      return true
    }
    return this.refreshAccessToken()
  }

  async logout(): Promise<DesktopAuthStatus> {
    const generation = ++this.operationGeneration
    this.refreshInFlight = null
    this.restoreInFlight = null
    this.accessTokenValue = null
    this.sessionPayload = null
    this.currentErrorCode = null
    this.authState = 'SIGNED_OUT'
    return this.runTransition(async () => {
      try {
        await this.clearLocalSession()
        return this.status()
      } catch (error) {
        return generation === this.operationGeneration ? this.setError(errorCode(error)) : this.status()
      }
    })
  }

  prepareForShutdown(): void {
    this.operationGeneration += 1
    this.refreshInFlight = null
    this.restoreInFlight = null
    this.accessTokenValue = null
    this.sessionPayload = null
    this.authState = 'SIGNED_OUT'
    this.currentErrorCode = null
  }

  private async restoreStoredSession(generation: number): Promise<DesktopAuthStatus> {
    this.authState = 'REFRESHING'
    this.currentErrorCode = null
    this.accessTokenValue = null
    let payload: SecureSessionPayload | null = null
    try {
      payload = await this.runTransition(async () => {
        if (generation !== this.operationGeneration) return null
        const stored = await this.secureStore.load()
        if (generation !== this.operationGeneration) return null
        if (!stored) {
          await this.runtime.clearTenant()
          return null
        }
        this.sessionPayload = stored
        await this.runtime.openTenant(stored.companyId)
        return generation === this.operationGeneration ? stored : null
      })
    } catch (error) {
      if (generation !== this.operationGeneration) return this.status()
      this.logFailure('restore', error)
      return this.runTransition(async () => {
        if (generation !== this.operationGeneration) return this.status()
        try {
          await this.clearLocalSession()
        } catch (clearError) {
          return this.setError(errorCode(clearError))
        }
        return this.setError(errorCode(error))
      })
    }
    if (!payload) {
      if (generation === this.operationGeneration && this.authState === 'REFRESHING') {
        this.authState = 'SIGNED_OUT'
        this.currentErrorCode = null
      }
      return this.status()
    }

    if (generation !== this.operationGeneration) return this.status()
    try {
      const tokens = await this.api.refresh(payload.tenantOrigin, payload.refreshToken)
      if (generation !== this.operationGeneration) return this.status()
      return await this.activateRotatedSession(payload, tokens, generation)
    } catch (error) {
      if (generation !== this.operationGeneration) return this.status()
      this.logFailure('restore', error)
      if (isTransient(error)) {
        this.authState = 'OFFLINE_SESSION_PENDING'
        this.currentErrorCode = errorCode(error)
        return this.status()
      }
      return this.runTransition(async () => {
        if (generation !== this.operationGeneration) return this.status()
        try {
          await this.clearLocalSession()
        } catch (clearError) {
          return this.setError(errorCode(clearError))
        }
        if (isInvalidRefresh(error)) return this.setSignedOut('SESSION_EXPIRED')
        return this.setError(errorCode(error))
      })
    }
  }

  private async rotateSession(): Promise<boolean> {
    const payload = this.sessionPayload
    if (!payload) return false
    const generation = this.operationGeneration
    const previousState = this.authState
    this.authState = 'REFRESHING'
    this.currentErrorCode = null
    try {
      const tokens = await this.api.refresh(payload.tenantOrigin, payload.refreshToken)
      if (generation !== this.operationGeneration) return false
      const status = await this.activateRotatedSession(payload, tokens, generation)
      return status.state === 'AUTHENTICATED'
    } catch (error) {
      if (generation !== this.operationGeneration) return false
      this.logFailure('refresh', error)
      if (isTransient(error)) {
        this.authState = 'OFFLINE_SESSION_PENDING'
        this.currentErrorCode = errorCode(error)
        throw error
      }
      return this.runTransition(async () => {
        if (generation !== this.operationGeneration) return false
        try {
          await this.clearLocalSession(true)
        } catch (clearError) {
          this.setError(errorCode(clearError))
          return false
        }
        if (isInvalidRefresh(error)) {
          this.setSignedOut('SESSION_EXPIRED')
          return false
        }
        this.authState = previousState === 'OFFLINE_SESSION_PENDING' ? 'ERROR' : 'SIGNED_OUT'
        this.currentErrorCode = errorCode(error)
        return false
      })
    }
  }

  private async activateRotatedSession(
    payload: SecureSessionPayload,
    tokens: TenantTokenPair,
    generation: number
  ): Promise<DesktopAuthStatus> {
    const updatedPayload: SecureSessionPayload = { ...payload, refreshToken: tokens.refreshToken }
    return this.runTransition(async () => {
      if (generation !== this.operationGeneration) return this.status()
      try {
        await this.secureStore.save(updatedPayload)
      } catch {
        try {
          await this.clearLocalSession(true)
        } catch (clearError) {
          return this.setError(errorCode(clearError))
        }
        return this.setError('SECURE_STORAGE_WRITE_FAILED')
      }
      if (generation !== this.operationGeneration) {
        await this.clearLocalSession()
        return this.status()
      }

      this.sessionPayload = updatedPayload
      this.accessTokenValue = tokens.accessToken
      this.authState = 'AUTHENTICATED'
      this.currentErrorCode = null
      await this.runtime.startSync(updatedPayload.tenantOrigin)
      return this.status()
    })
  }

  private async clearLocalSession(preserveLocalDatabase = false): Promise<void> {
    this.accessTokenValue = null
    this.sessionPayload = null
    let failure: unknown = null
    try {
      await this.secureStore.clear()
    } catch (error) {
      failure = error
    }
    try {
      await this.runtime.clearTenant(preserveLocalDatabase)
    } catch (error) {
      failure ??= error
    }
    if (failure) throw failure
  }

  private runTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitionTail.then(operation, operation)
    this.transitionTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private logFailure(operation: 'login' | 'restore' | 'refresh', error: unknown): void {
    this.logger.warn(
      'desktop.auth.operation_failed',
      sanitizeStructuredFields({ operation, error_code: errorCode(error) })
    )
  }

  private setSignedOut(errorCode: string): DesktopAuthStatus {
    this.accessTokenValue = null
    this.sessionPayload = null
    this.authState = 'SIGNED_OUT'
    this.currentErrorCode = errorCode
    return this.status()
  }

  private setError(errorCode: string): DesktopAuthStatus {
    this.accessTokenValue = null
    this.authState = 'ERROR'
    this.currentErrorCode = errorCode
    return this.status()
  }
}
