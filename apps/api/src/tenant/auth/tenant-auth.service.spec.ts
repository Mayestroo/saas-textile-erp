import { createHash } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { TenantJwtClaims } from '../../common/auth/jwt-token.service.js';
import type { LoginRateLimiter } from '../../common/auth/login-rate-limiter.js';
import type { PasswordPolicy } from '../../common/auth/password-policy.js';
import type { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import type { ResolvedTenantContext, TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';
import type { LockedTenantSession, TenantSessionRepository } from './tenant-session.repository.js';
import { TenantAuthService } from './tenant-auth.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
});

const company: ResolvedTenantContext = {
  companyId: '44444444-4444-4444-8444-444444444444',
  slug: 'atlas-textile',
  databaseName: 'tenant_44444444444444448444444444444444',
};

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
  full_name: 'Integration Owner',
  password_hash: '$argon2id$stored-test-hash',
  status: 'ACTIVE' as const,
};

function createService(options?: {
  userRows?: typeof user[];
  passwordMatches?: boolean;
  storedSession?: LockedTenantSession;
}) {
  const dataSource = {
    query: vi.fn(async () => options?.userRows ?? [user]),
    transaction: async <T>(callback: (manager: EntityManager) => Promise<T>) =>
      callback({} as EntityManager),
  } as unknown as DataSource;
  let activeSession = options?.storedSession ?? null;
  const repository = {
    create: vi.fn(async () => undefined),
    findForUpdate: vi.fn(async () => activeSession),
    rotate: vi.fn(async (_manager, _sessionId, refreshTokenHash, expiresAt) => {
      if (activeSession) {
        activeSession.refresh_token_hash = refreshTokenHash;
        activeSession.expires_at = expiresAt;
      }
    }),
    revoke: vi.fn(async () => {
      if (activeSession) {
        activeSession.revoked_at = new Date();
      }
    }),
  };
  const resolver = {
    resolveForLogin: vi.fn(async () => company),
    resolve: vi.fn(async () => company),
  };
  const connectionManager = { getDataSource: vi.fn(async () => dataSource) };
  const passwordPolicy = { verify: vi.fn(async () => options?.passwordMatches ?? true) };
  const rateLimiter = { consume: vi.fn(async () => undefined) };
  const service = new TenantAuthService(
    resolver as unknown as TenantResolverService,
    connectionManager as unknown as TenantConnectionManager,
    repository as unknown as TenantSessionRepository,
    passwordPolicy as unknown as PasswordPolicy,
    new JwtTokenService(),
    rateLimiter as unknown as LoginRateLimiter,
    authConfiguration,
  );
  return { service, dataSource, repository, resolver, connectionManager, passwordPolicy, rateLimiter };
}

function refreshClaims(overrides: Partial<TenantJwtClaims> = {}): TenantJwtClaims {
  return {
    sub: user.id,
    session_id: '22222222-2222-4222-8222-222222222222',
    jti: '33333333-3333-4333-8333-333333333333',
    scope: 'tenant',
    token_type: 'refresh',
    company_id: company.companyId,
    ...overrides,
  };
}

async function signedRefreshToken(
  claims = refreshClaims(),
  issuedAt?: Date,
): Promise<string> {
  const domain = authConfiguration.tenant;
  return new JwtTokenService().sign(claims, {
    secret: domain.refreshSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
    ...(issuedAt ? { issuedAt } : {}),
  });
}

describe('TenantAuthService', () => {
  it('resolves tenant by hostname, authenticates its active user, and issues tenant claims', async () => {
    const setup = createService();
    const result = await setup.service.login(
      'atlas-textile.erp.example.test',
      { email: ' OWNER@Example.Test ', password: 'test-only-password' },
      '203.0.113.8',
    );

    expect(setup.resolver.resolveForLogin).toHaveBeenCalledWith({
      hostname: 'atlas-textile.erp.example.test',
    });
    expect(setup.connectionManager.getDataSource).toHaveBeenCalledWith(company.companyId);
    expect(setup.rateLimiter.consume).toHaveBeenCalledWith(setup.dataSource, {
      scope: 'tenant',
      companyId: company.companyId,
      identifier: 'owner@example.test',
      ipAddress: '203.0.113.8',
    });
    expect(result.company).toEqual({ id: company.companyId, slug: company.slug });

    const claims = await new JwtTokenService().verify(result.access_token, {
      secret: authConfiguration.tenant.accessSecret,
      issuer: authConfiguration.tenant.issuer,
      audience: authConfiguration.tenant.audience,
      scope: 'tenant',
      tokenType: 'access',
    });
    expect(claims).toMatchObject({ scope: 'tenant', company_id: company.companyId, sub: user.id });
  });

  it('returns generic invalid credentials for wrong password and blocked tenant users', async () => {
    const wrongPassword = createService({ passwordMatches: false });
    const blockedUser = createService({
      userRows: [{ ...user, status: 'BLOCKED' }],
      passwordMatches: true,
    });

    await expect(wrongPassword.service.login('atlas-textile.erp.example.test', {
      email: user.email,
      password: 'wrong-password',
    }, '203.0.113.9')).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS', message: "Email yoki parol noto'g'ri" },
    });
    await expect(blockedUser.service.login('atlas-textile.erp.example.test', {
      email: user.email,
      password: 'correct-password',
    }, '203.0.113.9')).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS', message: "Email yoki parol noto'g'ri" },
    });
  });

  it('uses hostname and verified company ID to deny wrong-tenant refresh', async () => {
    const resolver = {
      resolve: vi.fn(async () => { throw new ForbiddenException({ code: 'TENANT_CONTEXT_MISMATCH' }); }),
      resolveForLogin: vi.fn(async () => company),
    };
    const setup = createService();
    const service = new TenantAuthService(
      resolver as unknown as TenantResolverService,
      setup.connectionManager as unknown as TenantConnectionManager,
      setup.repository as unknown as TenantSessionRepository,
      setup.passwordPolicy as unknown as PasswordPolicy,
      new JwtTokenService(),
      setup.rateLimiter as unknown as LoginRateLimiter,
      authConfiguration,
    );

    await expect(service.refresh('another.erp.example.test', await signedRefreshToken()))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(setup.connectionManager.getDataSource).not.toHaveBeenCalled();
  });

  it('rotates tenant refresh tokens and revokes the session on reuse', async () => {
    const oldToken = await signedRefreshToken();
    const session: LockedTenantSession = {
      id: refreshClaims().session_id,
      user_id: user.id,
      refresh_token_hash: createHash('sha256').update(oldToken).digest('hex'),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
      user_status: 'ACTIVE',
    };
    const setup = createService({ storedSession: session });

    const result = await setup.service.refresh('atlas-textile.erp.example.test', oldToken);
    expect(result.refresh_token).not.toBe(oldToken);
    expect(session.refresh_token_hash).toBe(createHash('sha256').update(result.refresh_token).digest('hex'));

    await expect(setup.service.refresh('atlas-textile.erp.example.test', oldToken)).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    expect(setup.repository.revoke).toHaveBeenCalledOnce();
  });

  it('rejects a platform refresh token in tenant auth', async () => {
    const platformDomain = authConfiguration.platform;
    const platformToken = await new JwtTokenService().sign({
      sub: user.id,
      session_id: '22222222-2222-4222-8222-222222222222',
      jti: '33333333-3333-4333-8333-333333333333',
      scope: 'platform',
      token_type: 'refresh',
    }, {
      secret: platformDomain.refreshSecret,
      issuer: platformDomain.issuer,
      audience: platformDomain.audience,
      expiresInSeconds: 60,
    });
    const setup = createService();

    await expect(setup.service.refresh('atlas-textile.erp.example.test', platformToken))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects revoked sessions, expired sessions, and expired tenant refresh tokens', async () => {
    const refreshToken = await signedRefreshToken();
    const revokedSession = createService({
      storedSession: {
        id: refreshClaims().session_id,
        user_id: user.id,
        refresh_token_hash: createHash('sha256').update(refreshToken).digest('hex'),
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: new Date(),
        user_status: 'ACTIVE',
      },
    });
    const expiredSession = createService({
      storedSession: {
        id: refreshClaims().session_id,
        user_id: user.id,
        refresh_token_hash: createHash('sha256').update(refreshToken).digest('hex'),
        expires_at: new Date(Date.now() - 1_000),
        revoked_at: null,
        user_status: 'ACTIVE',
      },
    });

    await expect(revokedSession.service.refresh('atlas-textile.erp.example.test', refreshToken))
      .rejects.toMatchObject({ response: { code: 'INVALID_REFRESH_TOKEN' } });
    await expect(expiredSession.service.refresh('atlas-textile.erp.example.test', refreshToken))
      .rejects.toMatchObject({ response: { code: 'INVALID_REFRESH_TOKEN' } });
    await expect(createService().service.refresh(
      'atlas-textile.erp.example.test',
      await signedRefreshToken(refreshClaims(), new Date(Date.now() - 120_000)),
    )).rejects.toMatchObject({ response: { code: 'INVALID_REFRESH_TOKEN' } });
  });
});
