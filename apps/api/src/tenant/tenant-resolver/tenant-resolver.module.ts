import { Module } from '@nestjs/common';
import { MASTER_TENANT_READER, MasterTenantLookupService } from './master-tenant-lookup.service.js';
import { TenantResolverService } from './tenant-resolver.service.js';

@Module({
  providers: [
    { provide: MASTER_TENANT_READER, useClass: MasterTenantLookupService },
    TenantResolverService,
  ],
  exports: [MASTER_TENANT_READER, TenantResolverService],
})
export class TenantResolverModule {}
