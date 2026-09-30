import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { MasterTenantMetadata, MasterTenantReader } from './master-tenant-lookup.service.js';
import { TenantResolverService } from './tenant-resolver.service.js';

const companyId = 'de305d54-75b4-431b-adb2-eb6b9e546014';

function createReader(company: MasterTenantMetadata | null): MasterTenantReader {
  return {
    findTenantById: async (requestedId) => (requestedId === companyId ? company : null),
    findTenantBySlug: async (requestedSlug) => (requestedSlug === company?.slug ? company : null),
  };
}

const activeCompany: MasterTenantMetadata = {
  id: companyId,
  name: 'Atlas Textile',
  slug: 'atlas-textile',
  status: 'ACTIVE',
  databaseName: 'tenant_de305d5475b4431badb2eb6b9e546014',
  connectionCiphertext: 'v1:encrypted',
  timezone: 'Asia/Tashkent',
};

describe('TenantResolverService', () => {
  it('resolves tenant login from hostname and active Master metadata without a body tenant ID', async () => {
    const resolver = new TenantResolverService(createReader(activeCompany));

    await expect(resolver.resolveForLogin({ hostname: 'atlas-textile.erp.example.test:443' }))
      .resolves.toEqual({
        companyId,
        name: 'Atlas Textile',
        slug: 'atlas-textile',
        databaseName: activeCompany.databaseName,
        timezone: activeCompany.timezone,
      });
  });

  it('resolves an active tenant only when hostname slug and authenticated company match', async () => {
    const resolver = new TenantResolverService(createReader(activeCompany));

    await expect(
      resolver.resolve({
        hostname: 'atlas-textile.erp.example.test:443',
        authenticatedCompanyId: companyId,
      }),
    ).resolves.toEqual({
      companyId,
      name: 'Atlas Textile',
      slug: 'atlas-textile',
      databaseName: activeCompany.databaseName,
      timezone: activeCompany.timezone,
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

  it('rejects unknown/inactive login hosts and reports Master lookup outage as 503', async () => {
    const activeResolver = new TenantResolverService(createReader(activeCompany));
    await expect(activeResolver.resolveForLogin({ hostname: 'unknown.erp.example.test' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(activeResolver.resolveForLogin({ hostname: 'localhost' }))
      .rejects.toBeInstanceOf(ForbiddenException);

    const inactiveResolver = new TenantResolverService(
      createReader({ ...activeCompany, status: 'PROVISIONING' }),
    );
    await expect(inactiveResolver.resolveForLogin({ hostname: 'atlas-textile.erp.example.test' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    const companyWithoutConnection = new TenantResolverService(
      createReader({ ...activeCompany, connectionCiphertext: null }),
    );
    await expect(companyWithoutConnection.resolveForLogin({
      hostname: 'atlas-textile.erp.example.test',
    })).rejects.toBeInstanceOf(ForbiddenException);

    const failingReader: MasterTenantReader = {
      findTenantById: async () => { throw new Error('Master DB unavailable'); },
      findTenantBySlug: async () => { throw new Error('Master DB unavailable'); },
    };
    await expect(new TenantResolverService(failingReader)
      .resolveForLogin({ hostname: 'atlas-textile.erp.example.test' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed when trusted Master tenant timezone is invalid', async () => {
    const resolver = new TenantResolverService(createReader({ ...activeCompany, timezone: 'Mars/Olympus' }));
    await expect(resolver.resolveForLogin({ hostname: 'atlas-textile.erp.example.test' }))
      .rejects.toMatchObject({ response: { code: 'TENANT_TIMEZONE_UNAVAILABLE' } });
    await expect(resolver.resolve({
      hostname: 'atlas-textile.erp.example.test', authenticatedCompanyId: companyId,
    })).rejects.toMatchObject({ response: { code: 'TENANT_TIMEZONE_UNAVAILABLE' } });
  });
});
