import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';
import { TenantPermissionGuard } from './tenant-permission.guard.js';

function executionContext(request: TenantAuthenticatedRequest): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('TenantPermissionGuard', () => {
  function authenticatedRequest(): TenantAuthenticatedRequest {
    return {
      headers: {},
      tenantUser: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        companyId: '44444444-4444-4444-8444-444444444444',
      },
      companyContext: {
        companyId: '44444444-4444-4444-8444-444444444444',
        slug: 'atlas-textile',
        databaseName: 'tenant_44444444444444448444444444444444',
      },
      tenantDataSource: { query: vi.fn() } as unknown as DataSource,
    } as TenantAuthenticatedRequest;
  }

  it('uses the current tenant DataSource for permission authorization', async () => {
    const required = ['workers.view'];
    const reflector = {
      getAllAndOverride: vi.fn(() => required),
    } as unknown as Reflector;
    const rbac = {
      hasAllPermissions: vi.fn(async () => true),
    } as unknown as TenantRbacService;
    const request = authenticatedRequest();
    const guard = new TenantPermissionGuard(reflector, rbac);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(rbac.hasAllPermissions).toHaveBeenCalledWith(
      request.tenantDataSource,
      request.tenantUser?.userId,
      required,
    );
  });

  it('denies absent permissions and refuses missing metadata', async () => {
    const reflector = {
      getAllAndOverride: vi.fn(() => ['workers.manage']),
    } as unknown as Reflector;
    const guard = new TenantPermissionGuard(
      reflector,
      { hasAllPermissions: vi.fn(async () => false) } as unknown as TenantRbacService,
    );
    const request = authenticatedRequest();

    await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    vi.mocked(reflector.getAllAndOverride).mockReturnValue(undefined);
    await expect(guard.canActivate(executionContext(request))).rejects.toMatchObject({
      response: { code: 'TENANT_PERMISSION_NOT_CONFIGURED' },
    });
  });
});
