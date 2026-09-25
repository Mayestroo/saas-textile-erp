import { Module } from '@nestjs/common';
import { TenantDatabaseModule } from '../../database/tenant/tenant-database.module.js';
import { TenantDatabaseManager } from '../../database/tenant/tenant-database-manager.js';
import { TenantMigrationRunner } from '../../database/tenant/tenant-migration-runner.js';
import { EnvironmentTenantConnectionSecretCipher } from './aes-gcm-tenant-connection-secret-cipher.js';
import { ProvisioningService } from './provisioning.service.js';
import { TENANT_CONNECTION_SECRET_CIPHER } from './tenant-connection-secret-cipher.js';

@Module({
  imports: [TenantDatabaseModule],
  providers: [
    ProvisioningService,
    {
      provide: TENANT_CONNECTION_SECRET_CIPHER,
      useClass: EnvironmentTenantConnectionSecretCipher,
    },
  ],
  exports: [ProvisioningService, TenantDatabaseManager, TenantMigrationRunner, TENANT_CONNECTION_SECRET_CIPHER],
})
export class ProvisioningModule {}
