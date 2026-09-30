import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { MasterTenantLookupService } from './master-tenant-lookup.service.js';

describe('MasterTenantLookupService', () => {
  it('loads and validates the company timezone with trusted tenant metadata', async () => {
    const query = vi.fn(async () => [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Atlas Textile',
      slug: 'atlas',
      status: 'ACTIVE',
      db_name: 'tenant_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      db_connection_ciphertext: 'v1:ciphertext',
      timezone: 'Asia/Tashkent',
    }]);
    const service = new MasterTenantLookupService({ query } as unknown as DataSource);

    await expect(service.findTenantBySlug('atlas')).resolves.toMatchObject({
      name: 'Atlas Textile', slug: 'atlas', timezone: 'Asia/Tashkent',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('"name"');
    expect(String(query.mock.calls[0]?.[0])).toContain('"timezone"');
  });

  it('rejects invalid Master timezone metadata instead of inventing a default', async () => {
    const query = vi.fn(async () => [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Atlas Textile',
      slug: 'atlas',
      status: 'ACTIVE',
      db_name: 'tenant_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa',
      db_connection_ciphertext: 'v1:ciphertext',
      timezone: 'Mars/Olympus',
    }]);
    const service = new MasterTenantLookupService({ query } as unknown as DataSource);

    await expect(service.findTenantById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .rejects.toThrow('Master tenant query returned incomplete metadata');
  });
});
