import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { TenantPermissionsProjectionService } from './tenant-permissions-projection.service.js';

const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('TenantPermissionsProjectionService', () => {
  it('returns only the authenticated user effective permission codes in stable order', async () => {
    const query = vi.fn(async () => [
      { code: 'patta.hisob.view' },
      { code: 'models.manage' },
      { code: 'patta.hisob.view' },
    ]);
    const dataSource = { query } as unknown as DataSource;
    const service = new TenantPermissionsProjectionService();

    await expect(service.listForUser(dataSource, USER_ID)).resolves.toEqual({
      permission_codes: ['models.manage', 'patta.hisob.view'],
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([USER_ID]);
  });

  it('returns an empty permission projection for a user with no assigned permissions', async () => {
    const dataSource = {
      query: vi.fn(async () => []),
    } as unknown as DataSource;
    const service = new TenantPermissionsProjectionService();

    await expect(service.listForUser(dataSource, USER_ID)).resolves.toEqual({
      permission_codes: [],
    });
  });

  it('maps a tenant database outage to a structured authorization error', async () => {
    const dataSource = {
      query: vi.fn(async () => { throw new Error('database private detail'); }),
    } as unknown as DataSource;
    const service = new TenantPermissionsProjectionService();

    await expect(service.listForUser(dataSource, USER_ID)).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'AUTHORIZATION_UNAVAILABLE',
        message: 'Ruxsatlar ro‘yxatini olib bo‘lmadi',
      },
    });
  });
});
