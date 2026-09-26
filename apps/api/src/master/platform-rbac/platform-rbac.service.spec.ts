import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { PlatformRbacService } from './platform-rbac.service.js';

describe('PlatformRbacService', () => {
  it('checks all requested permissions only through Master platform RBAC tables', async () => {
    const query = vi.fn(async () => [{ allowed: true }]);
    const dataSource = { query } as unknown as DataSource;
    const service = new PlatformRbacService(dataSource);

    await expect(service.hasAllPermissions('11111111-1111-4111-8111-111111111111', [
      'companies.create',
      'licenses.view',
    ])).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"platform_user_roles"'), [
      '11111111-1111-4111-8111-111111111111',
      ['companies.create', 'licenses.view'],
    ]);
    expect(query.mock.calls[0]?.[0]).toContain('"platform_permissions"');
    expect(query.mock.calls[0]?.[0]).not.toContain('"role_permissions"');
  });

  it('denies missing permission assignments and empty permission metadata', async () => {
    const query = vi.fn(async () => [{ allowed: false }]);
    const service = new PlatformRbacService({ query } as unknown as DataSource);

    await expect(service.hasAllPermissions('11111111-1111-4111-8111-111111111111', [
      'companies.suspend',
    ])).resolves.toBe(false);
    await expect(service.hasAllPermissions('11111111-1111-4111-8111-111111111111', []))
      .resolves.toBe(false);
    expect(query).toHaveBeenCalledOnce();
  });
});
