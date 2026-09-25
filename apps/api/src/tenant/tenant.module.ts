import { Module } from '@nestjs/common';
import { TenantResolverModule } from './tenant-resolver/tenant-resolver.module.js';
import { TenantConnectionModule } from './tenant-connection/tenant-connection.module.js';

@Module({
  imports: [TenantResolverModule, TenantConnectionModule]
})
export class TenantModule {}
