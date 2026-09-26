import { describe, expect, it } from 'vitest';
import { loadAuthConfiguration } from './auth-configuration.js';

const validEnvironment = {
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
};

describe('loadAuthConfiguration', () => {
  it('loads isolated token keys and safe default lifetimes and rate limits', () => {
    const config = loadAuthConfiguration(validEnvironment);

    expect(config.platform.accessSecret).not.toBe(config.platform.refreshSecret);
    expect(config.tenant.accessSecret).not.toBe(config.tenant.refreshSecret);
    expect(config.platform.accessSecret).not.toBe(config.tenant.accessSecret);
    expect(config.tenant.refreshSecret).not.toBe(config.platform.refreshSecret);
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.refreshTokenTtlSeconds).toBe(2_592_000);
    expect(config.loginRateLimit).toEqual({
      hashSecret: validEnvironment.AUTH_LOGIN_BUCKET_HASH_SECRET,
      maxAttempts: 5,
      windowSeconds: 900,
    });
  });

  it('rejects missing or weak JWT secrets without including values in the error', () => {
    expect(() => loadAuthConfiguration({ ...validEnvironment, TENANT_JWT_ACCESS_SECRET: '' }))
      .toThrow('Missing or invalid authentication environment variable: TENANT_JWT_ACCESS_SECRET');
    expect(() => loadAuthConfiguration({ ...validEnvironment, TENANT_JWT_ACCESS_SECRET: 'short-secret' }))
      .toThrow('Missing or invalid authentication environment variable: TENANT_JWT_ACCESS_SECRET');
  });

  it('rejects shared keys across security domains or token types', () => {
    expect(() => loadAuthConfiguration({
      ...validEnvironment,
      TENANT_JWT_ACCESS_SECRET: validEnvironment.PLATFORM_JWT_ACCESS_SECRET,
    })).toThrow('Authentication secrets must be distinct');
  });

  it('rejects invalid token lifetimes and rate-limit values', () => {
    expect(() => loadAuthConfiguration({
      ...validEnvironment,
      AUTH_ACCESS_TOKEN_TTL_SECONDS: '0',
    })).toThrow('AUTH_ACCESS_TOKEN_TTL_SECONDS must be a positive integer');
    expect(() => loadAuthConfiguration({
      ...validEnvironment,
      AUTH_LOGIN_MAX_ATTEMPTS: 'many',
    })).toThrow('AUTH_LOGIN_MAX_ATTEMPTS must be a positive integer');
  });
});
