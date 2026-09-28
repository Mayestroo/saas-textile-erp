import { describe, expect, it, vi } from 'vitest'
import { authErrorMessage } from './auth-error-mapper'
import {
  normalizeTenantOrigin,
  TenantAuthApiClient,
  TenantAuthApiError
} from './tenant-auth-api-client'

const LOGIN_RESPONSE = {
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  token_type: 'Bearer',
  expires_in: 900,
  user: {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'operator@example.test',
    full_name: 'Operator One'
  },
  company: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    slug: 'atlas'
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('tenant auth API client', () => {
  it('normalizes a tenant hostname and HTTPS base URL', () => {
    expect(normalizeTenantOrigin(' atlas.example.test ')).toEqual({
      origin: 'https://atlas.example.test',
      tenantHost: 'atlas.example.test',
      tenantSlug: 'atlas'
    })
    expect(normalizeTenantOrigin('https://atlas.example.test:8443/')).toEqual({
      origin: 'https://atlas.example.test:8443',
      tenantHost: 'atlas.example.test',
      tenantSlug: 'atlas'
    })
  })

  it.each([
    'https://user:password@atlas.example.test',
    'https://atlas.example.test/path',
    'https://atlas.example.test/?company_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'http://atlas.example.test',
    'not a host'
  ])('rejects unsafe or malformed tenant origin %s', (tenantUrl) => {
    expect(() => normalizeTenantOrigin(tenantUrl)).toThrow()
  })

  it('permits HTTP only for loopback development origins', () => {
    expect(normalizeTenantOrigin('http://127.0.0.1:3000')).toEqual({
      origin: 'http://127.0.0.1:3000',
      tenantHost: '127.0.0.1',
      tenantSlug: '127'
    })
    expect(() => normalizeTenantOrigin('http://factory.example.test')).toThrow()
    expect(normalizeTenantOrigin('http://factory.localhost:3000').tenantSlug).toBe('factory')
  })

  it('sends only email and password to the hostname-resolved tenant login', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(LOGIN_RESPONSE))
    const client = new TenantAuthApiClient(fetcher)

    await expect(
      client.login('atlas.example.test', {
        email: ' operator@example.test ',
        password: ' password-value '
      })
    ).resolves.toMatchObject({
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      company: { id: LOGIN_RESPONSE.company.id, slug: 'atlas' }
    })

    const [url, request] = fetcher.mock.calls[0] ?? []
    expect(url).toBe('https://atlas.example.test/api/v1/auth/login')
    expect(JSON.parse(String(request?.body))).toEqual({
      email: 'operator@example.test',
      password: ' password-value '
    })
    expect(JSON.parse(String(request?.body))).not.toHaveProperty('tenant_id')
    expect(request).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    })
  })

  it('rejects malformed auth responses and response company/hostname mismatch', async () => {
    const malformed = new TenantAuthApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...LOGIN_RESPONSE, token_type: 'Basic' }))
    )
    await expect(
      malformed.login('atlas.example.test', { email: 'a@example.test', password: 'x' })
    ).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' })

    const wrongTenant = new TenantAuthApiClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ ...LOGIN_RESPONSE, company: { ...LOGIN_RESPONSE.company, slug: 'other' } })
      )
    )
    await expect(
      wrongTenant.login('atlas.example.test', { email: 'a@example.test', password: 'x' })
    ).rejects.toMatchObject({ code: 'AUTH_RESPONSE_INVALID' })
  })

  it('refreshes on the same tenant origin with only the refresh token', async () => {
    const pair = {
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      token_type: 'Bearer',
      expires_in: 900
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(pair))
    const client = new TenantAuthApiClient(fetcher)

    await expect(client.refresh('https://atlas.example.test', 'old-refresh-token')).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 900
    })
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://atlas.example.test/api/v1/auth/refresh')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      refresh_token: 'old-refresh-token'
    })
  })

  it('returns structured API codes without exposing raw backend messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ code: 'TOO_MANY_LOGIN_ATTEMPTS', message: 'backend private detail' }, 429)
    )
    const client = new TenantAuthApiClient(fetcher)

    await expect(
      client.login('atlas.example.test', { email: 'a@example.test', password: 'x' })
    ).rejects.toMatchObject({
      status: 429,
      code: 'TOO_MANY_LOGIN_ATTEMPTS',
      transient: false
    })
    try {
      await client.login('atlas.example.test', { email: 'a@example.test', password: 'x' })
    } catch (error) {
      expect(error).toBeInstanceOf(TenantAuthApiError)
      expect((error as Error).message).not.toContain('backend private detail')
    }
  })

  it('maps current and additive auth codes to safe Uzbek messages', () => {
    for (const code of ['INVALID_CREDENTIALS', 'USER_BLOCKED']) {
      expect(authErrorMessage(new TenantAuthApiError(401, code, false))).toBe(
        "Email yoki parol noto'g'ri"
      )
    }
    for (const code of ['TENANT_CONTEXT_MISMATCH', 'TENANT_NOT_FOUND', 'TENANT_INACTIVE']) {
      expect(authErrorMessage(new TenantAuthApiError(403, code, false))).toBe(
        'Korxona manzili topilmadi yoki faol emas'
      )
    }
    for (const code of ['TOO_MANY_LOGIN_ATTEMPTS', 'RATE_LIMITED']) {
      expect(authErrorMessage(new TenantAuthApiError(429, code, false))).toBe(
        'Urinishlar soni oshib ketdi. Keyinroq qayta urinib ko‘ring'
      )
    }
    for (const code of ['INVALID_REFRESH_TOKEN', 'SESSION_REVOKED']) {
      expect(authErrorMessage(new TenantAuthApiError(401, code, false))).toBe(
        'Sessiya muddati tugagan'
      )
    }
    expect(authErrorMessage(new TenantAuthApiError(null, 'NETWORK_ERROR', true))).toBe(
      'Internet bilan aloqa yo‘q'
    )
  })
})
