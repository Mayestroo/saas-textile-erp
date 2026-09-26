import { Module } from '@nestjs/common';
import { MasterDatabaseModule } from '../../database/master/master-database.module.js';
import { PlatformRbacService } from '../platform-rbac/platform-rbac.service.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthGuard } from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformPermissionGuard } from './platform-permission.guard.js';
import { PlatformSessionRepository } from './platform-session.repository.js';

@Module({
  imports: [MasterDatabaseModule],
  controllers: [PlatformAuthController],
  providers: [
    PlatformAuthService,
    PlatformSessionRepository,
    PlatformRbacService,
    PlatformAuthGuard,
    PlatformPermissionGuard,
  ],
  exports: [
    PlatformAuthService,
    PlatformRbacService,
    PlatformAuthGuard,
    PlatformPermissionGuard,
  ],
})
export class PlatformAuthModule {}
