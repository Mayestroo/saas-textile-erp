import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import type { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import type { TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
});

const companyContext = {
  companyId: '44444444-4444-4444-8444-444444444444',
  slug: 'atlas-textile',
  databaseName: 'tenant_44444444444444448444444444444444',
};

function executionContext(request: TenantAuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

async function token(scope: 'platform' | 'tenant'): Promise<string> {
  const domain = authConfiguration[scope];
  const claims = scope === 'platform' ? {
    sub: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    jti: '33333333-3333-4333-8333-333333333333',
    scope,
    token_type: 'access' as const,
  } : {
    sub: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    jti: '33333333-3333-4333-8333-333333333333',
    scope,
    token_type: 'access' as const,
    company_id: companyContext.companyId,
  };
  return new JwtTokenService().sign(claims, {
    secret: domain.accessSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
  });
}

describe('TenantAuthGuard', () => {
  it('verifies tenant hostname, session, and user before attaching tenant context', async () => {
    const dataSource = { query: vi.fn(async () => [{ id: 'session' }]) } as unknown as DataSource;
    const resolver = { resolve: vi.fn(async () => companyContext) };
    const connections = { getDataSource: vi.fn(async () => dataSource) };
    const request = {
      hostname: 'atlas-textile.erp.example.test',
      headers: { authorization: `Bearer ${await token('tenant')}` },
    } as TenantAuthenticatedRequest;
    const guard = new TenantAuthGuard(
      resolver as unknown as TenantResolverService,
      connections as unknown as TenantConnectionManager,
      new JwtTokenService(),
      authConfiguration,
    );

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(resolver.resolve).toHaveBeenCalledWith({
      hostname: request.hostname,
      authenticatedCompanyId: companyContext.companyId,
    });
    expect(connections.getDataSource).toHaveBeenCalledWith(companyContext.companyId);
    expect(request.tenantUser).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      companyId: companyContext.companyId,
    });
    expect(request.companyContext).toEqual(companyContext);
    expect(request.tenantDataSource).toBe(dataSource);
  });

  it('rejects platform tokens and does not resolve a tenant database', async () => {
    const resolver = { resolve: vi.fn(async () => companyContext) };
    const connections = { getDataSource: vi.fn(async () => ({ query: vi.fn() })) };
    const request = {
      hostname: 'atlas-textile.erp.example.test',
      headers: { authorization: `Bearer ${await token('platform')}` },
    } as TenantAuthenticatedRequest;
    const guard = new TenantAuthGuard(
      resolver as unknown as TenantResolverService,
      connections as unknown as TenantConnectionManager,
      new JwtTokenService(),
      authConfiguration,
    );

    await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(connections.getDataSource).not.toHaveBeenCalled();
  });

  it('rejects a Tenant A token on a Tenant B hostname before opening a connection', async () => {
    const resolver = {
      resolve: vi.fn(async () => { throw new Error('slug/company mismatch'); }),
    };
    const connections = { getDataSource: vi.fn(async () => ({ query: vi.fn() })) };
    const request = {
      hostname: 'tenant-b.erp.example.test',
      headers: { authorization: `Bearer ${await token('tenant')}` },
    } as TenantAuthenticatedRequest;
    const guard = new TenantAuthGuard(
      resolver as unknown as TenantResolverService,
      connections as unknown as TenantConnectionManager,
      new JwtTokenService(),
      authConfiguration,
    );

    await expect(guard.canActivate(executionContext(request))).rejects.toThrow('slug/company mismatch');
    expect(connections.getDataSource).not.toHaveBeenCalled();
  });
});
