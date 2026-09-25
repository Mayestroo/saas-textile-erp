import { Module } from '@nestjs/common';
import { ProvisioningModule } from '../../master/provisioning/provisioning.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { TenantConnectionManager } from './tenant-connection.manager.js';

@Module({
  imports: [ProvisioningModule, TenantResolverModule],
  providers: [TenantConnectionManager],
  exports: [TenantConnectionManager],
})
export class TenantConnectionModule {}
