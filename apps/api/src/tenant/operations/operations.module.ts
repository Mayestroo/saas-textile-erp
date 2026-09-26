import { Module } from '@nestjs/common';
import { TenantAuditModule } from '../audit/audit.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { OperationPriceService } from './operation-price.service.js';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';

@Module({
  imports: [TenantAuthModule, TenantConnectionModule, TenantResolverModule, TenantAuditModule],
  controllers: [OperationsController],
  providers: [OperationsService, OperationPriceService, TenantAuthGuard, TenantPermissionGuard],
  exports: [OperationsService, OperationPriceService],
})
export class OperationsModule {}
