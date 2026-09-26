import { Module } from '@nestjs/common';
import { DevicesModule } from '../../master/devices/devices.module.js';
import { TenantAuditModule } from '../audit/audit.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { PattaConfigurationModule } from './patta.config.js';
import { PattaController } from './patta.controller.js';
import { PattaTemplatesController } from './patta-templates.controller.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaService } from './patta.service.js';
import { PattaTemplatesService } from './patta-templates.service.js';

@Module({
  imports: [
    DevicesModule,
    TenantAuthModule,
    TenantConnectionModule,
    TenantResolverModule,
    OperationsModule,
    TenantAuditModule,
    PattaConfigurationModule,
  ],
  controllers: [PattaController, PattaTemplatesController],
  providers: [
    PattaNumberBlocksService,
    PattaOfflineRegistrationValidator,
    PattaService,
    PattaTemplatesService,
    TenantAuthGuard,
    TenantPermissionGuard,
  ],
  exports: [PattaNumberBlocksService, PattaOfflineRegistrationValidator, PattaService, PattaTemplatesService],
})
export class PattaModule {}
