import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { MasterTenantMetadata, MasterTenantReader } from './master-tenant-lookup.service.js';
import { TenantResolverService } from './tenant-resolver.service.js';

const companyId = 'de305d54-75b4-431b-adb2-eb6b9e546014';

function createReader(company: MasterTenantMetadata | null): MasterTenantReader {
  return {
    findTenantById: async (requestedId) => (requestedId === companyId ? company : null),
  };
}

const activeCompany: MasterTenantMetadata = {
  id: companyId,
  slug: 'atlas-textile',
  status: 'ACTIVE',
  databaseName: 'tenant_de305d5475b4431badb2eb6b9e546014',
  connectionCiphertext: 'v1:encrypted',
};

describe('TenantResolverService', () => {
  it('resolves an active tenant only when hostname slug and authenticated company match', async () => {
    const resolver = new TenantResolverService(createReader(activeCompany));

    await expect(
      resolver.resolve({
        hostname: 'atlas-textile.erp.example.test:443',
        authenticatedCompanyId: companyId,
      }),
    ).resolves.toEqual({
      companyId,
      slug: 'atlas-textile',
      databaseName: activeCompany.databaseName,
    });
  });

  it('requires authenticated company context and rejects malformed IDs', async () => {
    const resolver = new TenantResolverService(createReader(activeCompany));

    await expect(
      resolver.resolve({ hostname: 'atlas-textile.erp.example.test', authenticatedCompanyId: null }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      resolver.resolve({ hostname: 'atlas-textile.erp.example.test', authenticatedCompanyId: 'company-a' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects slug mismatch, inactive companies, and hostnames without a tenant subdomain', async () => {
    const activeResolver = new TenantResolverService(createReader(activeCompany));
    await expect(
      activeResolver.resolve({ hostname: 'another.erp.example.test', authenticatedCompanyId: companyId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      activeResolver.resolve({ hostname: 'localhost', authenticatedCompanyId: companyId }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const inactiveResolver = new TenantResolverService(
      createReader({ ...activeCompany, status: 'PROVISIONING' }),
    );
    await expect(
      inactiveResolver.resolve({ hostname: 'atlas-textile.erp.example.test', authenticatedCompanyId: companyId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
