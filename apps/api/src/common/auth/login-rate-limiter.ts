import type { DataSource } from 'typeorm';

export type LoginRateLimitRequest =
  | { scope: 'platform'; identifier: string; ipAddress: string }
  | { scope: 'tenant'; companyId: string; identifier: string; ipAddress: string };

export interface LoginRateLimiter {
  consume(dataSource: DataSource, request: LoginRateLimitRequest): Promise<void>;
}
