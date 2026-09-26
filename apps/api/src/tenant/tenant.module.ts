import { Module } from '@nestjs/common';
import { TenantResolverModule } from './tenant-resolver/tenant-resolver.module.js';
import { TenantConnectionModule } from './tenant-connection/tenant-connection.module.js';
import { TenantAuthModule } from './auth/tenant-auth.module.js';

@Module({
  imports: [TenantResolverModule, TenantConnectionModule, TenantAuthModule]
})
export class TenantModule {}
