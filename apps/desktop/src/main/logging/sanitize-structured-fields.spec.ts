import { describe, expect, it } from 'vitest'
import { sanitizeStructuredFields } from './sanitize-structured-fields'

describe('sanitizeStructuredFields', () => {
  it('redacts sensitive fields recursively without removing useful status metadata', () => {
    const input = {
      status: 401,
      company_id: 'company-safe-id',
      headers: { Authorization: 'Bearer access-secret' },
      refresh_token: 'refresh-secret',
      login: { password: 'password-secret', email: 'operator@example.test' }
    }

    const sanitized = sanitizeStructuredFields(input)

    expect(sanitized).toEqual({
      status: 401,
      company_id: 'company-safe-id',
      headers: { Authorization: '[REDACTED]' },
      refresh_token: '[REDACTED]',
      login: { password: '[REDACTED]', email: 'operator@example.test' }
    })
    expect(JSON.stringify(sanitized)).not.toMatch(/access-secret|refresh-secret|password-secret/)
    expect(input.login.password).toBe('password-secret')
  })

  it('redacts token-bearing aliases and handles cyclic structures', () => {
    const input: Record<string, unknown> = {
      accessToken: 'access-secret',
      token: 'token-secret',
      session: { refreshToken: 'refresh-secret' }
    }
    input.circular = input

    expect(sanitizeStructuredFields(input)).toEqual({
      accessToken: '[REDACTED]',
      token: '[REDACTED]',
      session: { refreshToken: '[REDACTED]' },
      circular: '[CIRCULAR]'
    })
  })
})
