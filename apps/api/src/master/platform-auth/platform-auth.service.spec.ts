import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { PlatformJwtClaims } from '../../common/auth/jwt-token.service.js';
import type { LoginRateLimiter } from '../../common/auth/login-rate-limiter.js';
import type { PasswordPolicy } from '../../common/auth/password-policy.js';
import type { PlatformSessionRepository } from './platform-session.repository.js';
import type { LockedPlatformSession } from './platform-session.repository.js';
import { PlatformAuthService } from './platform-auth.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
});

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
  password_hash: '$argon2id$stored-test-hash',
  status: 'ACTIVE' as const,
};

function createService(options?: {
  userRows?: typeof user[];
  passwordMatches?: boolean;
  storedSession?: LockedPlatformSession;
}) {
  const dataSource = {
    query: vi.fn(async () => options?.userRows ?? [user]),
    transaction: async <T>(callback: (manager: EntityManager) => Promise<T>) =>
      callback({} as EntityManager),
  } as unknown as DataSource;
  const createdSessions: Array<{
    id: string;
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }> = [];
  let activeSession = options?.storedSession ?? null;
  const repository = {
    create: vi.fn(async (session) => {
      createdSessions.push(session);
      activeSession = {
        id: session.id,
        user_id: session.userId,
        refresh_token_hash: session.refreshTokenHash,
        expires_at: session.expiresAt,
        revoked_at: null,
        user_status: 'ACTIVE',
      };
    }),
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
  const passwordPolicy = {
    verify: vi.fn(async () => options?.passwordMatches ?? true),
  };
  const rateLimiter = { consume: vi.fn(async () => undefined) };
  const service = new PlatformAuthService(
    dataSource,
    repository as unknown as PlatformSessionRepository,
    passwordPolicy as unknown as PasswordPolicy,
    new JwtTokenService(),
    rateLimiter as unknown as LoginRateLimiter,
    authConfiguration,
  );
  return {
    service,
    dataSource,
    repository,
    passwordPolicy,
    rateLimiter,
    createdSessions,
  };
}

function refreshClaims(overrides: Partial<PlatformJwtClaims> = {}): PlatformJwtClaims {
  return {
    sub: user.id,
    session_id: '22222222-2222-4222-8222-222222222222',
    jti: '33333333-3333-4333-8333-333333333333',
    scope: 'platform',
    token_type: 'refresh',
    ...overrides,
  };
}

async function signedRefreshToken(claims = refreshClaims(), expired = false): Promise<string> {
  const domain = authConfiguration.platform;
  return new JwtTokenService().sign(claims, {
    secret: domain.refreshSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
    ...(expired ? { issuedAt: new Date(Date.now() - 120_000) } : {}),
  });
}

describe('PlatformAuthService', () => {
  it('authenticates a platform user and stores only a refresh-token hash', async () => {
    const setup = createService();
    const result = await setup.service.login(
      { email: ' OWNER@Example.Test ', password: 'test-only-password' },
      '203.0.113.4',
    );

    expect(result.user).toEqual({ id: user.id, email: user.email });
    expect(result.refresh_token).not.toBe(result.access_token);
    expect(setup.rateLimiter.consume).toHaveBeenCalledWith(setup.dataSource, {
      scope: 'platform',
      identifier: 'owner@example.test',
      ipAddress: '203.0.113.4',
    });
    expect(setup.passwordPolicy.verify).toHaveBeenCalledWith(user.password_hash, 'test-only-password');
    expect(setup.createdSessions).toHaveLength(1);
    expect(setup.createdSessions[0]?.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.createdSessions[0]?.refreshTokenHash).not.toBe(result.refresh_token);

    const access = await new JwtTokenService().verify(result.access_token, {
      secret: authConfiguration.platform.accessSecret,
      issuer: authConfiguration.platform.issuer,
      audience: authConfiguration.platform.audience,
      scope: 'platform',
      tokenType: 'access',
    });
    expect(access).toMatchObject({ sub: user.id, scope: 'platform' });
    expect(access).not.toHaveProperty('company_id');
  });

  it('returns identical generic credentials errors for unknown, wrong-password, and blocked users', async () => {
    const scenarios = [
      createService({ userRows: [], passwordMatches: false }),
      createService({ passwordMatches: false }),
      createService({ userRows: [{ ...user, status: 'BLOCKED' }], passwordMatches: true }),
    ];
    const errors: unknown[] = [];
    for (const scenario of scenarios) {
      try {
        await scenario.service.login({ email: 'owner@example.test', password: 'wrong-password' }, '203.0.113.5');
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: "Email yoki parol noto'g'ri",
      });
    }
    expect(scenarios[0]?.passwordPolicy.verify).toHaveBeenCalledWith(null, 'wrong-password');
    expect(scenarios[2]?.createdSessions).toHaveLength(0);
  });

  it('rotates a valid refresh token and changes the stored token hash', async () => {
    const oldRefreshToken = await signedRefreshToken();
    const oldHash = createHash('sha256').update(oldRefreshToken).digest('hex');
    const session = {
      id: refreshClaims().session_id,
      user_id: user.id,
      refresh_token_hash: oldHash,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
      user_status: 'ACTIVE',
    } satisfies LockedPlatformSession;
    const setup = createService({ storedSession: session });

    const rotated = await setup.service.refresh(oldRefreshToken);

    expect(rotated.refresh_token).not.toBe(oldRefreshToken);
    expect(setup.repository.rotate).toHaveBeenCalledOnce();
    expect(session.refresh_token_hash).toBe(
      createHash('sha256').update(rotated.refresh_token).digest('hex'),
    );
  });

  it('revokes an active platform session when a valid old refresh token is reused', async () => {
    const oldRefreshToken = await signedRefreshToken();
    const session = {
      id: refreshClaims().session_id,
      user_id: user.id,
      refresh_token_hash: createHash('sha256').update('different-current-refresh').digest('hex'),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
      user_status: 'ACTIVE',
    } satisfies LockedPlatformSession;
    const setup = createService({ storedSession: session });

    await expect(setup.service.refresh(oldRefreshToken)).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    expect(setup.repository.revoke).toHaveBeenCalledOnce();
    expect(session.revoked_at).toBeInstanceOf(Date);
  });

  it('rejects revoked and expired refresh sessions and expired refresh JWTs', async () => {
    const refreshToken = await signedRefreshToken();
    const revoked = createService({
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

    await expect(revoked.service.refresh(refreshToken)).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    await expect(expiredSession.service.refresh(refreshToken)).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    await expect(setupExpiredJwt()).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
  });
});

async function setupExpiredJwt(): Promise<unknown> {
  const setup = createService();
  return setup.service.refresh(await signedRefreshToken(refreshClaims(), true));
}
