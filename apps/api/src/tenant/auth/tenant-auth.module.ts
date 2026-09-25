import { Module } from '@nestjs/common';
import { TenantConnectionModule } from '../tenant-connection/tenant-connection.module.js';
import { TenantResolverModule } from '../tenant-resolver/tenant-resolver.module.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';
import { TenantAuthController } from './tenant-auth.controller.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantAuthService } from './tenant-auth.service.js';
import { TenantPermissionGuard } from './tenant-permission.guard.js';
import { TenantSessionRepository } from './tenant-session.repository.js';

@Module({
  imports: [TenantResolverModule, TenantConnectionModule],
  controllers: [TenantAuthController],
  providers: [
    TenantAuthService,
    TenantSessionRepository,
    TenantRbacService,
    TenantAuthGuard,
    TenantPermissionGuard,
  ],
  exports: [TenantAuthService, TenantRbacService, TenantAuthGuard, TenantPermissionGuard],
})
export class TenantAuthModule {}
