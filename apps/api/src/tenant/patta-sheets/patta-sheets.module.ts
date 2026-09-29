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
import { ModelAccountController, PattaSheetsController } from './patta-sheets.controller.js';
import { ModelAccountQueryService } from './model-account-query.service.js';
import { PattaSheetsService } from './patta-sheets.service.js';

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
  controllers: [PattaSheetsController, ModelAccountController],
  providers: [PattaSheetsService, ModelAccountQueryService, TenantAuthGuard, TenantPermissionGuard],
  exports: [PattaSheetsService, ModelAccountQueryService],
})
export class PattaSheetsModule {}
