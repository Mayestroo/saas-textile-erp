import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { normalizeCompanyUuid } from '../../database/tenant/tenant-database-names.js';
import { MASTER_TENANT_READER } from './master-tenant-lookup.service.js';
import type { MasterTenantReader } from './master-tenant-lookup.service.js';

export interface TenantResolutionInput {
  hostname: string;
  authenticatedCompanyId: string | null | undefined;
}

export interface ResolvedTenantContext {
  companyId: string;
  slug: string;
  databaseName: string;
}

function hostnameTenantSlug(hostname: string): string | null {
  let normalizedHost: string;
  try {
    normalizedHost = new URL(`http://${hostname}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }

  const labels = normalizedHost.split('.');
  if (labels.length < 2 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[0] ?? '')) {
    return null;
  }
  return labels[0] ?? null;
}

@Injectable()
export class TenantResolverService {
  constructor(@Inject(MASTER_TENANT_READER) private readonly masterTenantReader: MasterTenantReader) {}

  async resolve(input: TenantResolutionInput): Promise<ResolvedTenantContext> {
    if (!input.authenticatedCompanyId) {
      throw new UnauthorizedException({
        code: 'AUTHENTICATED_COMPANY_REQUIRED',
        message: 'Tasdiqlangan kompaniya konteksti talab qilinadi',
      });
    }

    let companyId: string;
    try {
      normalizeCompanyUuid(input.authenticatedCompanyId);
      companyId = input.authenticatedCompanyId;
    } catch {
      throw new UnauthorizedException({
        code: 'AUTHENTICATED_COMPANY_INVALID',
        message: 'Tasdiqlangan kompaniya konteksti yaroqsiz',
      });
    }

    const slug = hostnameTenantSlug(input.hostname);
    if (!slug) {
      throw new ForbiddenException({
        code: 'TENANT_HOST_INVALID',
        message: 'Korxona manzili aniqlanmadi',
      });
    }

    const company = await this.masterTenantReader.findTenantById(companyId);
    if (
      !company ||
      company.slug !== slug ||
      company.status !== 'ACTIVE' ||
      !company.connectionCiphertext
    ) {
      throw new ForbiddenException({
        code: 'TENANT_CONTEXT_MISMATCH',
        message: 'Korxona konteksti tasdiqlanmadi',
      });
    }

    return {
      companyId: company.id,
      slug: company.slug,
      databaseName: company.databaseName,
    };
  }
}
