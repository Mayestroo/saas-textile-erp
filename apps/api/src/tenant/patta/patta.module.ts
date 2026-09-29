import { Module } from '@nestjs/common';
import { DevicesModule } from '../../master/devices/devices.module.js';
import { TenantAuditModule } from '../audit/audit.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { TenantSyncCoreModule } from '../sync/sync-core.module.js';
import { PattaSyncHandler } from '../sync/patta-sync-handler.js';
import { OperationsModule } from '../operations/operations.module.js';
import { PattaConfigurationModule } from './patta.config.js';
import { PattaController } from './patta.controller.js';
import { PattaPrintBatchesController } from './patta-print-batches.controller.js';
import { PattaPartiyaNumberBlocksController } from './patta-partiya-number-blocks.controller.js';
import { PattaV2Controller } from './patta-v2.controller.js';
import { PattaTemplatesController } from './patta-templates.controller.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaPartiyaNumberBlocksService } from './patta-partiya-number-blocks.service.js';
import { PattaPrintBatchesService } from './patta-print-batches.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaService } from './patta.service.js';
import { PattaTemplatesService } from './patta-templates.service.js';
import { PattaSheetsModule } from '../patta-sheets/patta-sheets.module.js';

@Module({
  imports: [
    DevicesModule,
    TenantAuthModule,
    TenantConnectionModule,
    TenantResolverModule,
    OperationsModule,
    TenantAuditModule,
    TenantSyncCoreModule,
    PattaConfigurationModule,
    PattaSheetsModule,
  ],
  controllers: [PattaController, PattaTemplatesController, PattaPrintBatchesController,
    PattaPartiyaNumberBlocksController, PattaV2Controller],
  providers: [
    PattaNumberBlocksService,
    PattaPartiyaNumberBlocksService,
    PattaPrintBatchesService,
    PattaOfflineRegistrationValidator,
    PattaService,
    PattaTemplatesService,
    PattaSyncHandler,
    TenantAuthGuard,
    TenantPermissionGuard,
  ],
  exports: [PattaNumberBlocksService, PattaPartiyaNumberBlocksService, PattaPrintBatchesService,
    PattaOfflineRegistrationValidator, PattaService, PattaTemplatesService, PattaSyncHandler],
})
export class PattaModule {}
