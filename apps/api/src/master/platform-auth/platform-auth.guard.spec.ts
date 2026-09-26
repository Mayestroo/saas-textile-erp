import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import type { PlatformAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import { PlatformAuthGuard } from './platform-auth.guard.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
});

function executionContext(request: PlatformAuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

async function accessToken(scope: 'platform' | 'tenant'): Promise<string> {
  const domain = authConfiguration[scope];
  return new JwtTokenService().sign(scope === 'platform' ? {
    sub: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    jti: '33333333-3333-4333-8333-333333333333',
    scope,
    token_type: 'access',
  } : {
    sub: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    jti: '33333333-3333-4333-8333-333333333333',
    scope,
    token_type: 'access',
    company_id: '44444444-4444-4444-8444-444444444444',
  }, {
    secret: domain.accessSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
  });
}

describe('PlatformAuthGuard', () => {
  it('verifies Master session and attaches only the platform principal', async () => {
    const token = await accessToken('platform');
    const query = vi.fn(async () => [{ id: '22222222-2222-4222-8222-222222222222' }]);
    const request = { headers: { authorization: `Bearer ${token}` } } as PlatformAuthenticatedRequest;
    const guard = new PlatformAuthGuard(
      { query } as unknown as DataSource,
      new JwtTokenService(),
      authConfiguration,
    );

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(request.platformUser).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(query.mock.calls[0]?.[0]).toContain('"platform_auth_sessions"');
    expect(query.mock.calls[0]?.[0]).toContain("user_account.\"status\" = 'ACTIVE'");
  });

  it('rejects tenant tokens and missing platform sessions', async () => {
    const tenantToken = await accessToken('tenant');
    const query = vi.fn(async () => []);
    const guard = new PlatformAuthGuard(
      { query } as unknown as DataSource,
      new JwtTokenService(),
      authConfiguration,
    );
    const tenantRequest = {
      headers: { authorization: `Bearer ${tenantToken}` },
    } as PlatformAuthenticatedRequest;
    const missingSessionRequest = {
      headers: { authorization: `Bearer ${await accessToken('platform')}` },
    } as PlatformAuthenticatedRequest;

    await expect(guard.canActivate(executionContext(tenantRequest)))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(executionContext(missingSessionRequest)))
      .rejects.toMatchObject({ response: { code: 'INVALID_ACCESS_TOKEN' } });
  });
});
