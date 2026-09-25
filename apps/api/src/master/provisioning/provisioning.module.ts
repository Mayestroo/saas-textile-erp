import { Module } from '@nestjs/common';
import { TenantDatabaseModule } from '../../database/tenant/tenant-database.module.js';
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
  exports: [
    ProvisioningService,
    TenantDatabaseModule,
    TENANT_CONNECTION_SECRET_CIPHER,
  ],
})
export class ProvisioningModule {}
