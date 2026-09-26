import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_PERMISSIONS_METADATA_KEY } from '../../common/auth/auth-decorators.js';
import type { PlatformAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { PlatformRbacService } from '../platform-rbac/platform-rbac.service.js';

@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly platformRbacService: PlatformRbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PLATFORM_PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<PlatformAuthenticatedRequest>();
    if (!request.platformUser) {
      throw new UnauthorizedException({
        code: 'PLATFORM_AUTH_REQUIRED',
        message: 'Platforma autentifikatsiyasi talab qilinadi',
        details: {},
      });
    }
    if (!requiredPermissions || requiredPermissions.length === 0) {
      throw new ForbiddenException({
        code: 'PLATFORM_PERMISSION_NOT_CONFIGURED',
        message: 'Platforma ruxsati sozlanmagan',
        details: {},
      });
    }
    if (!await this.platformRbacService.hasAllPermissions(
      request.platformUser.userId,
      requiredPermissions,
    )) {
      throw new ForbiddenException({
        code: 'PLATFORM_PERMISSION_DENIED',
        message: 'Bu platforma amali uchun ruxsat yo‘q',
        details: {},
      });
    }
    return true;
  }
}
