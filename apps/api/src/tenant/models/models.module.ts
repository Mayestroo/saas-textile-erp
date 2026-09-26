import { Module } from '@nestjs/common';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantAuditModule } from '../audit/audit.module.js';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';

@Module({
  imports: [TenantAuthModule, TenantConnectionModule, TenantResolverModule, TenantAuditModule],
  controllers: [ModelsController],
  providers: [ModelsService, TenantAuthGuard, TenantPermissionGuard],
  exports: [ModelsService],
})
export class ModelsModule {}
