import { createHmac } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { AUTH_CONFIGURATION } from './auth-configuration.js';
import type { AuthConfiguration } from './auth-configuration.js';
import type { LoginRateLimiter, LoginRateLimitRequest } from './login-rate-limiter.js';

interface RateLimitRow {
  attempt_count: number;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLocaleLowerCase('en-US');
}

function bucketTable(scope: LoginRateLimitRequest['scope']): string {
  return scope === 'platform' ? 'platform_login_rate_limits' : 'login_rate_limits';
}

function bucketHash(
  request: LoginRateLimitRequest,
  dimension: 'account' | 'ip',
  value: string,
  secret: string,
): string {
  const companyPart = request.scope === 'tenant' ? `${request.companyId}\0` : '';
  return createHmac('sha256', secret)
    .update(`${request.scope}\0${companyPart}${dimension}\0${value}`)
    .digest('hex');
}

function databaseUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'LOGIN_RATE_LIMIT_UNAVAILABLE',
    message: 'Kirish urinishlarini tekshirish xizmati vaqtincha ishlamayapti',
    details: {},
  });
}

@Injectable()
export class PostgresLoginRateLimiter implements LoginRateLimiter {
  constructor(
    @Inject(AUTH_CONFIGURATION) private readonly configuration: AuthConfiguration,
  ) {}

  async consume(dataSource: DataSource, request: LoginRateLimitRequest): Promise<void> {
    const normalizedIdentifier = normalizeIdentifier(request.identifier);
    const normalizedIpAddress = request.ipAddress.trim().toLowerCase() || 'unknown';
    const secret = this.configuration.loginRateLimit.hashSecret;
    const buckets = [
      bucketHash(request, 'account', normalizedIdentifier, secret),
      bucketHash(request, 'ip', normalizedIpAddress, secret),
    ].sort((left, right) => left.localeCompare(right));
    const table = bucketTable(request.scope);

    let attempts: RateLimitRow[];
    try {
      attempts = await dataSource.transaction(async (manager) => {
        await this.deleteExpiredBuckets(manager, table);
        const results: RateLimitRow[] = [];
        for (const bucket of buckets) {
          results.push(await this.incrementBucket(manager, table, bucket));
        }
        return results;
      });
    } catch {
      throw databaseUnavailable();
    }

    if (attempts.some(({ attempt_count }) => attempt_count > this.configuration.loginRateLimit.maxAttempts)) {
      throw new HttpException({
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
        message: 'Urinishlar soni oshib ketdi. Keyinroq qayta urinib ko‘ring',
        details: {},
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async deleteExpiredBuckets(manager: EntityManager, table: string): Promise<void> {
    await manager.query(`
      WITH expired AS (
        SELECT "bucket_hash"
        FROM "${table}"
        WHERE "expires_at" <= now()
        ORDER BY "expires_at"
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "${table}" AS rate_limit
      USING expired
      WHERE rate_limit."bucket_hash" = expired."bucket_hash"
    `);
  }

  private async incrementBucket(
    manager: EntityManager,
    table: string,
    hash: string,
  ): Promise<RateLimitRow> {
    const rows: RateLimitRow[] = await manager.query(
      `INSERT INTO "${table}" AS rate_limit (
         "bucket_hash", "window_started_at", "attempt_count", "expires_at"
       ) VALUES ($1, now(), 1, now() + ($2::integer * interval '1 second'))
       ON CONFLICT ("bucket_hash") DO UPDATE SET
         "window_started_at" = CASE
           WHEN rate_limit."expires_at" <= now() THEN now()
           ELSE rate_limit."window_started_at"
         END,
         "attempt_count" = CASE
           WHEN rate_limit."expires_at" <= now() THEN 1
           ELSE rate_limit."attempt_count" + 1
         END,
         "expires_at" = CASE
           WHEN rate_limit."expires_at" <= now()
             THEN now() + ($2::integer * interval '1 second')
           ELSE rate_limit."expires_at"
         END
       RETURNING "attempt_count"`,
      [hash, this.configuration.loginRateLimit.windowSeconds],
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Rate-limit counter update did not return its state');
    }
    return row;
  }
}
