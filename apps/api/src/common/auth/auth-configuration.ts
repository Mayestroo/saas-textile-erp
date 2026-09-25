export interface AuthDomainConfiguration {
  issuer: string;
  audience: string;
  accessSecret: string;
  refreshSecret: string;
}

export interface AuthConfiguration {
  platform: AuthDomainConfiguration;
  tenant: AuthDomainConfiguration;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  loginRateLimit: {
    hashSecret: string;
    maxAttempts: number;
    windowSeconds: number;
  };
}

export const AUTH_CONFIGURATION = Symbol('AUTH_CONFIGURATION');

type AuthEnvironment = Record<string, string | undefined>;

function requiredSecret(environment: AuthEnvironment, name: string): string {
  const value = environment[name];
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`Missing or invalid authentication environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(
  environment: AuthEnvironment,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer not greater than ${maximum}`);
  }
  return parsed;
}

export function loadAuthConfiguration(environment: AuthEnvironment = process.env): AuthConfiguration {
  const platformAccessSecret = requiredSecret(environment, 'PLATFORM_JWT_ACCESS_SECRET');
  const platformRefreshSecret = requiredSecret(environment, 'PLATFORM_JWT_REFRESH_SECRET');
  const tenantAccessSecret = requiredSecret(environment, 'TENANT_JWT_ACCESS_SECRET');
  const tenantRefreshSecret = requiredSecret(environment, 'TENANT_JWT_REFRESH_SECRET');
  const loginBucketHashSecret = requiredSecret(environment, 'AUTH_LOGIN_BUCKET_HASH_SECRET');
  const secrets = [
    platformAccessSecret,
    platformRefreshSecret,
    tenantAccessSecret,
    tenantRefreshSecret,
    loginBucketHashSecret,
  ];
  if (new Set(secrets).size !== secrets.length) {
    throw new Error('Authentication secrets must be distinct');
  }

  return {
    platform: {
      issuer: 'textile-erp-platform',
      audience: 'textile-erp-platform-api',
      accessSecret: platformAccessSecret,
      refreshSecret: platformRefreshSecret,
    },
    tenant: {
      issuer: 'textile-erp-tenant',
      audience: 'textile-erp-tenant-api',
      accessSecret: tenantAccessSecret,
      refreshSecret: tenantRefreshSecret,
    },
    accessTokenTtlSeconds: positiveInteger(
      environment,
      'AUTH_ACCESS_TOKEN_TTL_SECONDS',
      900,
      3_600,
    ),
    refreshTokenTtlSeconds: positiveInteger(
      environment,
      'AUTH_REFRESH_TOKEN_TTL_SECONDS',
      2_592_000,
      7_776_000,
    ),
    loginRateLimit: {
      hashSecret: loginBucketHashSecret,
      maxAttempts: positiveInteger(environment, 'AUTH_LOGIN_MAX_ATTEMPTS', 5, 100),
      windowSeconds: positiveInteger(environment, 'AUTH_LOGIN_WINDOW_SECONDS', 900, 86_400),
    },
  };
}
