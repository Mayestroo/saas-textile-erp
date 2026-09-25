import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { PlatformRbacService } from '../platform-rbac/platform-rbac.service.js';
import { describe, expect, it, vi } from 'vitest';
import { PlatformPermissionGuard } from './platform-permission.guard.js';

function executionContext(request: PlatformAuthenticatedRequest): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('PlatformPermissionGuard', () => {
  it('allows a platform principal with every required Master permission', async () => {
    const reflector = {
      getAllAndOverride: vi.fn(() => ['companies.create']),
    } as unknown as Reflector;
    const rbac = {
      hasAllPermissions: vi.fn(async () => true),
    } as unknown as PlatformRbacService;
    const request = {
      headers: {},
      platformUser: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
    } as PlatformAuthenticatedRequest;
    const guard = new PlatformPermissionGuard(reflector, rbac);

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(true);
    expect(rbac.hasAllPermissions).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      ['companies.create'],
    );
  });

  it('denies when the platform permission is missing or no permission metadata exists', async () => {
    const reflector = {
      getAllAndOverride: vi.fn(() => ['companies.create']),
    } as unknown as Reflector;
    const guard = new PlatformPermissionGuard(
      reflector,
      { hasAllPermissions: vi.fn(async () => false) } as unknown as PlatformRbacService,
    );
    const request = {
      headers: {},
      platformUser: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
    } as PlatformAuthenticatedRequest;

    await expect(guard.canActivate(executionContext(request))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    vi.mocked(reflector.getAllAndOverride).mockReturnValue(undefined);
    await expect(guard.canActivate(executionContext(request))).rejects.toMatchObject({
      response: { code: 'PLATFORM_PERMISSION_NOT_CONFIGURED' },
    });
  });
});
