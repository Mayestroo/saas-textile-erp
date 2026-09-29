import { UnauthorizedException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import type { TenantPermissionsProjectionService } from './tenant-permissions-projection.service.js';
import { TenantAuthController } from './tenant-auth.controller.js';
import type { TenantAuthService } from './tenant-auth.service.js';

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('TenantAuthController permission projection', () => {
  it('protects the permission projection route with tenant authentication', () => {
    const guards = Reflect.getMetadata('__guards__', TenantAuthController.prototype.permissions) as unknown[];

    expect(guards).toContain(TenantAuthGuard);
  });

  it('projects only the authenticated tenant principal and DataSource', async () => {
    const dataSource = {} as DataSource;
    const projection = { permission_codes: ['models.manage'] };
    const permissions = {
      listForUser: vi.fn(async () => projection),
    };
    const controller = new TenantAuthController(
      {} as TenantAuthService,
      permissions as unknown as TenantPermissionsProjectionService,
    );
    const request = {
      hostname: 'atlas.example.test',
      tenantUser: { userId: USER_ID, sessionId: 'session-id', companyId: COMPANY_ID },
      companyContext: {
        companyId: COMPANY_ID,
        slug: 'atlas',
        databaseName: 'tenant_atlas',
        timezone: 'Asia/Tashkent',
      },
      tenantDataSource: dataSource,
    } as TenantAuthenticatedRequest;

    await expect(controller.permissions(request)).resolves.toEqual(projection);
    expect(permissions.listForUser).toHaveBeenCalledWith(dataSource, USER_ID);
  });

  it('fails closed when auth guard context is missing', async () => {
    const controller = new TenantAuthController(
      {} as TenantAuthService,
      { listForUser: vi.fn() } as unknown as TenantPermissionsProjectionService,
    );

    expect(() => controller.permissions({ hostname: 'atlas.example.test' } as TenantAuthenticatedRequest))
      .toThrow(UnauthorizedException);
  });
});
