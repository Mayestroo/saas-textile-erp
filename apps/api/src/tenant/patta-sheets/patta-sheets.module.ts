import { Module } from '@nestjs/common';
import { DevicesModule } from '../../master/devices/devices.module.js';
import { TenantAuditModule } from '../audit/audit.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { OperationsModule } from '../operations/operations.module.js';
import { TenantSyncCoreModule } from '../sync/sync-core.module.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { ModelAccountController, PattaSheetsController, PattaSheetsV3Controller } from './patta-sheets.controller.js';
import { ModelAccountQueryService } from './model-account-query.service.js';
import { PattaSheetsService } from './patta-sheets.service.js';
import { ModelAccountAdjustmentsService } from './model-account-adjustments.service.js';
import { ModelAccountV3Controller } from './model-account-v3.controller.js';

@Module({
  imports: [
    DevicesModule,
    TenantAuthModule,
    TenantConnectionModule,
    TenantResolverModule,
    TenantAuditModule,
    TenantSyncCoreModule,
    WorkersModule,
    OperationsModule,
  ],
  controllers: [PattaSheetsController, PattaSheetsV3Controller, ModelAccountController, ModelAccountV3Controller],
  providers: [PattaSheetsService, ModelAccountAdjustmentsService, ModelAccountQueryService, TenantAuthGuard, TenantPermissionGuard],
  exports: [PattaSheetsService, ModelAccountAdjustmentsService, ModelAccountQueryService],
})
export class PattaSheetsModule {}
