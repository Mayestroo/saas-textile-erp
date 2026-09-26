import { Module } from '@nestjs/common';
import { TenantAuditModule } from '../audit/audit.module.js';
import { TenantAuthModule } from '../auth/tenant-auth.module.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { BadgesController } from '../badges/badges.controller.js';
import { BadgeHistoryService } from '../badges/badge-history.service.js';
import { BadgeResolutionService } from '../badges/badge-resolution.service.js';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { WorkersController } from './workers.controller.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [TenantAuthModule, TenantConnectionModule, TenantResolverModule, TenantAuditModule],
  controllers: [WorkersController, BadgesController],
  providers: [
    WorkersService,
    BadgeHistoryService,
    BadgeResolutionService,
    TenantAuthGuard,
    TenantPermissionGuard,
  ],
  exports: [WorkersService, BadgeHistoryService, BadgeResolutionService],
})
export class WorkersModule {}
