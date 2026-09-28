const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface TenantOrigin {
  origin: string
  tenantHost: string
  tenantSlug: string
}

export interface TenantLoginInput {
  email: string
  password: string
}

export interface TenantTokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface TenantLoginResult extends TenantTokenPair {
  user: { id: string; email: string; fullName: string }
  company: { id: string; slug: string }
}

export interface TenantAuthApi {
  login(tenantUrl: string, input: TenantLoginInput): Promise<TenantLoginResult>
  refresh(tenantOrigin: string, refreshToken: string): Promise<TenantTokenPair>
}

export class TenantAuthApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    readonly transient: boolean
  ) {
    super('Korxona autentifikatsiya so‘rovi bajarilmadi')
    this.name = 'TenantAuthApiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]'
  )
}

export function normalizeTenantOrigin(input: string): TenantOrigin {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.length > 2_048) {
    throw new Error('Korxona manzili yaroqsiz')
  }
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
  let url: URL
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    throw new Error('Korxona manzili yaroqsiz')
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const labels = hostname.split('.')
  const tenantSlug = labels[0] ?? ''
  const httpAllowed = url.protocol === 'http:' && isLoopbackHostname(hostname)
  if (
    (url.protocol !== 'https:' && !httpAllowed) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    labels.length < 2 ||
    !TENANT_SLUG_PATTERN.test(tenantSlug)
  ) {
    throw new Error('Korxona manzili yaroqsiz')
  }
  if (url.hostname !== hostname) url.hostname = hostname

  return { origin: url.origin, tenantHost: hostname, tenantSlug }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 502 || status === 503 || status === 504
}

function structuredCode(value: unknown): string | null {
  if (!isRecord(value) || typeof value.code !== 'string') return null
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code) ? value.code : null
}

function parseTokenPair(value: unknown): TenantTokenPair {
  if (
    !isRecord(value) ||
    !requiredString(value.access_token, 8_192) ||
    !requiredString(value.refresh_token, 8_192) ||
    value.token_type !== 'Bearer' ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) < 1
  ) {
    throw new TenantAuthApiError(200, 'AUTH_RESPONSE_INVALID', false)
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresIn: value.expires_in as number
  }
}

function parseLoginResult(value: unknown, tenantSlug: string): TenantLoginResult {
  const tokenPair = parseTokenPair(value)
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.company)) {
    throw new TenantAuthApiError(200, 'AUTH_RESPONSE_INVALID', false)
  }
  const { user, company } = value
  if (
    typeof user.id !== 'string' ||
    !UUID_PATTERN.test(user.id) ||
    !requiredString(user.email, 320) ||
    !EMAIL_PATTERN.test(user.email) ||
    !requiredString(user.full_name, 512) ||
    typeof company.id !== 'string' ||
    !UUID_PATTERN.test(company.id) ||
    !requiredString(company.slug, 63) ||
    !TENANT_SLUG_PATTERN.test(company.slug) ||
    company.slug.toLowerCase() !== tenantSlug
  ) {
    throw new TenantAuthApiError(200, 'AUTH_RESPONSE_INVALID', false)
  }
  return {
    ...tokenPair,
    user: { id: user.id.toLowerCase(), email: user.email, fullName: user.full_name },
    company: { id: company.id.toLowerCase(), slug: company.slug }
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export class TenantAuthApiClient implements TenantAuthApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async login(tenantUrl: string, input: TenantLoginInput): Promise<TenantLoginResult> {
    const tenant = normalizeTenantOrigin(tenantUrl)
    const email = input.email.trim()
    if (
      !EMAIL_PATTERN.test(email) ||
      email.length > 320 ||
      input.password.length < 1 ||
      input.password.length > 1_024
    ) {
      throw new TenantAuthApiError(400, 'LOGIN_INPUT_INVALID', false)
    }
    const body = await this.post(`${tenant.origin}/api/v1/auth/login`, { email, password: input.password })
    return parseLoginResult(body, tenant.tenantSlug)
  }

  async refresh(tenantOrigin: string, refreshToken: string): Promise<TenantTokenPair> {
    const tenant = normalizeTenantOrigin(tenantOrigin)
    if (!requiredString(refreshToken, 8_192)) {
      throw new TenantAuthApiError(400, 'REFRESH_INPUT_INVALID', false)
    }
    return parseTokenPair(
      await this.post(`${tenant.origin}/api/v1/auth/refresh`, { refresh_token: refreshToken })
    )
  }

  private async post(url: string, body: Record<string, string>): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      throw new TenantAuthApiError(null, 'NETWORK_ERROR', true)
    }

    let responseBody: unknown
    try {
      responseBody = await parseResponseBody(response)
    } catch {
      throw new TenantAuthApiError(null, 'NETWORK_ERROR', true)
    }
    if (!response.ok) {
      const statusFallback = response.status === 429 ? 'RATE_LIMITED' : 'AUTH_API_ERROR'
      throw new TenantAuthApiError(
        response.status,
        structuredCode(responseBody) ?? statusFallback,
        transientStatus(response.status)
      )
    }
    return responseBody
  }
}
