import { ForbiddenException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { TenantRbacService } from './tenant-rbac.service.js';

describe('TenantRbacService', () => {
  it('checks requested codes only through the tenant RBAC tables', async () => {
    const query = vi.fn(async () => [{ allowed: true }]);
    const service = new TenantRbacService();

    await expect(service.hasAllPermissions(
      { query } as unknown as DataSource,
      '11111111-1111-4111-8111-111111111111',
      ['workers.view'],
    )).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain('"role_permissions"');
    expect(query.mock.calls[0]?.[0]).toContain('"permissions"');
    expect(query.mock.calls[0]?.[0]).not.toContain('"platform_permissions"');
  });

  it('denies platform permission codes even when they are not represented by tenant tables', async () => {
    const query = vi.fn(async () => [{ allowed: true }]);
    const service = new TenantRbacService();

    await expect(service.hasAllPermissions(
      { query } as unknown as DataSource,
      '11111111-1111-4111-8111-111111111111',
      ['companies.create'],
    )).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects granting a platform code before touching the tenant database', async () => {
    const transaction = vi.fn(async <T>(_operation: (manager: EntityManager) => Promise<T>) => {
      throw new Error('must not execute');
    });
    const service = new TenantRbacService();

    await expect(service.grantRolePermissions(
      { transaction } as unknown as DataSource,
      '11111111-1111-4111-8111-111111111111',
      ['companies.suspend'],
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('grants only allowlisted tenant permissions that exist in that tenant database', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "roles"')) {
        return [{ id: '11111111-1111-4111-8111-111111111111', is_system: false }];
      }
      if (sql.startsWith('SELECT')) {
        return [{ code: 'workers.view' }];
      }
      return [];
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      transaction: async <T>(operation: (transactionManager: EntityManager) => Promise<T>) =>
        operation(manager),
    } as unknown as DataSource;
    const service = new TenantRbacService();

    await expect(service.grantRolePermissions(
      dataSource,
      '11111111-1111-4111-8111-111111111111',
      ['workers.view'],
    )).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toContain('INSERT INTO "role_permissions"');
  });

  it('protects the provisioned system administrator role from permission edits', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('FROM "roles"')
        ? [{ id: '11111111-1111-4111-8111-111111111111', is_system: true }]
        : [],
    );
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      transaction: async <T>(operation: (transactionManager: EntityManager) => Promise<T>) =>
        operation(manager),
    } as unknown as DataSource;
    const service = new TenantRbacService();

    await expect(service.grantRolePermissions(
      dataSource,
      '11111111-1111-4111-8111-111111111111',
      ['workers.manage'],
    )).rejects.toMatchObject({ response: { code: 'TENANT_SYSTEM_ROLE_PROTECTED' } });
    expect(query).toHaveBeenCalledOnce();
  });
});
