import type {
  AuthenticatedHttpClient,
  AuthenticatedHttpRequest
} from './authenticated-sync-transport'
import { fetchWithLocalTenantFallback } from '../auth/local-tenant-host'

export interface AuthenticatedSessionProvider {
  accessToken(): Promise<string | null>
  refreshAfterUnauthorized(rejectedAccessToken?: string): Promise<boolean>
}

export class AuthenticatedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string
  ) {
    super(message)
    this.name = 'AuthenticatedHttpError'
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: 'Server javobi JSON formatida emas' }
  }
}

function responseMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const message = Reflect.get(body, 'message')
    if (typeof message === 'string') return message
  }
  return 'Autentifikatsiyalangan so‘rov bajarilmadi'
}

export class FetchAuthenticatedHttpClient implements AuthenticatedHttpClient {
  private readonly allowedOrigin: string

  constructor(
    private readonly session: AuthenticatedSessionProvider,
    allowedApiBaseUrl: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    const parsed = new URL(allowedApiBaseUrl)
    const isLoopbackHttp =
      parsed.protocol === 'http:' &&
      (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
        parsed.hostname.endsWith('.localhost'))
    if (parsed.protocol !== 'https:' && !isLoopbackHttp) {
      throw new Error('Authenticated API URL must use HTTPS outside loopback testing')
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new Error('Authenticated API URL cannot contain credentials')
    }
    this.allowedOrigin = parsed.origin
  }

  async request(request: AuthenticatedHttpRequest): Promise<unknown> {
    const url = new URL(request.url)
    if (url.origin !== this.allowedOrigin || url.username !== '' || url.password !== '') {
      throw new Error(
        'Authenticated HTTP client rejected a URL outside its configured tenant origin'
      )
    }

    let token = await this.session.accessToken()
    if (!token) {
      throw new AuthenticatedHttpError(401, { code: 'AUTH_REQUIRED' }, 'Tizimga kiring')
    }
    let response = await this.send(request, token)
    if (response.status === 401) {
      const firstBody = await responseBody(response)
      const refreshed = await this.session.refreshAfterUnauthorized(token)
      if (!refreshed) {
        throw new AuthenticatedHttpError(401, firstBody, responseMessage(firstBody))
      }
      token = await this.session.accessToken()
      if (!token) {
        throw new AuthenticatedHttpError(401, firstBody, 'Tizimga qayta kiring')
      }
      response = await this.send(request, token)
    }

    const body = await responseBody(response)
    if (!response.ok) {
      throw new AuthenticatedHttpError(response.status, body, responseMessage(body))
    }
    return body
  }

  private async send(request: AuthenticatedHttpRequest, accessToken: string): Promise<Response> {
    const options: RequestInit = {
      method: request.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    }
    return fetchWithLocalTenantFallback(this.fetcher, request.url, options)
  }
}
