import { ServiceUnavailableException } from '@nestjs/common';
import type { EntityManager, DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { loadAuthConfiguration } from './auth-configuration.js';
import { PostgresLoginRateLimiter } from './postgres-login-rate-limiter.js';

const configuration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
  AUTH_LOGIN_MAX_ATTEMPTS: '2',
  AUTH_LOGIN_WINDOW_SECONDS: '60',
});

type QueryHandler = (sql: string, parameters: unknown[]) => Promise<unknown>;

function createDataSource(handler: QueryHandler): {
  dataSource: DataSource;
  queries: Array<{ sql: string; parameters: unknown[] }>;
} {
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const manager = {
    query: async (sql: string, parameters?: unknown[]) => {
      const safeParameters = parameters ?? [];
      queries.push({ sql, parameters: safeParameters });
      return handler(sql, safeParameters);
    },
  };
  const dataSource = {
    transaction: async <T>(operation: (transactionManager: EntityManager) => Promise<T>) =>
      operation(manager as unknown as EntityManager),
  } as unknown as DataSource;
  return { dataSource, queries };
}

function request() {
  return {
    scope: 'platform' as const,
    identifier: 'Owner@Example.Test',
    ipAddress: '192.0.2.10',
  };
}

describe('PostgresLoginRateLimiter', () => {
  it('works without Redis and atomically updates hashed account and IP buckets', async () => {
    const { dataSource, queries } = createDataSource(async (sql) =>
      sql.includes('INSERT INTO') ? [{ attempt_count: 1 }] : [],
    );
    const limiter = new PostgresLoginRateLimiter(configuration);

    await limiter.consume(dataSource, request());

    const updates = queries.filter(({ sql }) => sql.includes('INSERT INTO'));
    expect(updates).toHaveLength(2);
    expect(updates.every(({ sql }) => sql.includes('"platform_login_rate_limits" AS rate_limit')))
      .toBe(true);
    expect(updates.every(({ sql }) => sql.includes('ON CONFLICT') && sql.includes('RETURNING "attempt_count"')))
      .toBe(true);
    expect(updates.flatMap(({ parameters }) => parameters)).not.toContain('Owner@Example.Test');
    expect(updates.flatMap(({ parameters }) => parameters)).not.toContain('192.0.2.10');
    expect(updates.every(({ parameters }) => parameters[1] === 60)).toBe(true);
  });

  it('rejects only after the configured attempt count and persists the denied attempt', async () => {
    const counts = new Map<string, number>();
    const { dataSource } = createDataSource(async (sql, parameters) => {
      if (!sql.includes('INSERT INTO')) {
        return [];
      }
      const key = String(parameters[0]);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return [{ attempt_count: count }];
    });
    const limiter = new PostgresLoginRateLimiter(configuration);

    await limiter.consume(dataSource, request());
    await limiter.consume(dataSource, request());
    await expect(limiter.consume(dataSource, request())).rejects.toMatchObject({
      response: {
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
      },
    });
    expect([...counts.values()]).toEqual([3, 3]);
  });

  it('uses case-insensitive normalized identifiers and tenant-specific HMAC buckets', async () => {
    const { dataSource, queries } = createDataSource(async (sql) =>
      sql.includes('INSERT INTO') ? [{ attempt_count: 1 }] : [],
    );
    const limiter = new PostgresLoginRateLimiter(configuration);

    await limiter.consume(dataSource, request());
    await limiter.consume(dataSource, { ...request(), identifier: ' owner@example.test ' });
    const platformHashes = queries
      .filter(({ sql }) => sql.includes('INSERT INTO'))
      .map(({ parameters }) => String(parameters[0]));
    expect(platformHashes.slice(0, 2).sort()).toEqual(platformHashes.slice(2, 4).sort());

    const tenantQueries: Array<{ sql: string; parameters: unknown[] }> = [];
    const tenantSource = createDataSource(async (sql, parameters) => {
      tenantQueries.push({ sql, parameters });
      return sql.includes('INSERT INTO') ? [{ attempt_count: 1 }] : [];
    });
    await limiter.consume(tenantSource.dataSource, {
      scope: 'tenant',
      companyId: '33333333-3333-4333-8333-333333333333',
      identifier: 'owner@example.test',
      ipAddress: '192.0.2.10',
    });
    expect(tenantQueries.filter(({ sql }) => sql.includes('INSERT INTO'))
      .every(({ sql }) => sql.includes('"login_rate_limits" AS rate_limit'))).toBe(true);
    expect(tenantQueries.filter(({ sql }) => sql.includes('INSERT INTO'))
      .map(({ parameters }) => parameters[0])).not.toEqual(platformHashes.slice(0, 2));
  });

  it('cleans expired buckets in bounded batches before incrementing', async () => {
    const { dataSource, queries } = createDataSource(async (sql) =>
      sql.includes('INSERT INTO') ? [{ attempt_count: 1 }] : [],
    );
    const limiter = new PostgresLoginRateLimiter(configuration);

    await limiter.consume(dataSource, request());

    expect(queries[0]?.sql).toContain('"expires_at" <= now()');
    expect(queries[0]?.sql).toContain('LIMIT 100');
    expect(queries[0]?.sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('fails closed with a structured 503 when PostgreSQL is unavailable', async () => {
    const { dataSource } = createDataSource(async () => {
      throw new Error('connection password=must-not-leak');
    });
    const limiter = new PostgresLoginRateLimiter(configuration);

    await expect(limiter.consume(dataSource, request())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(limiter.consume(dataSource, request())).rejects.toMatchObject({
      response: {
        code: 'LOGIN_RATE_LIMIT_UNAVAILABLE',
      },
    });
  });

  it('retains the authoritative window when the limiter is recreated', async () => {
    const counts = new Map<string, number>();
    const { dataSource } = createDataSource(async (sql, parameters) => {
      if (!sql.includes('INSERT INTO')) {
        return [];
      }
      const hash = String(parameters[0]);
      const count = (counts.get(hash) ?? 0) + 1;
      counts.set(hash, count);
      return [{ attempt_count: count }];
    });

    await new PostgresLoginRateLimiter(configuration).consume(dataSource, request());
    await new PostgresLoginRateLimiter(configuration).consume(dataSource, request());
    await expect(
      new PostgresLoginRateLimiter(configuration).consume(dataSource, request()),
    ).rejects.toMatchObject({ response: { code: 'TOO_MANY_LOGIN_ATTEMPTS' } });
    expect([...counts.values()]).toEqual([3, 3]);
  });
});
