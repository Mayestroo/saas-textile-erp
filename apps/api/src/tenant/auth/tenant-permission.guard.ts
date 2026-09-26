import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TENANT_PERMISSIONS_METADATA_KEY } from '../../common/auth/auth-decorators.js';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';

@Injectable()
export class TenantPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantRbacService: TenantRbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      TENANT_PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<TenantAuthenticatedRequest>();
    if (!request.tenantUser || !request.tenantDataSource) {
      throw new UnauthorizedException({
        code: 'TENANT_AUTH_REQUIRED',
        message: 'Korxona autentifikatsiyasi talab qilinadi',
        details: {},
      });
    }
    if (!requiredPermissions || requiredPermissions.length === 0) {
      throw new ForbiddenException({
        code: 'TENANT_PERMISSION_NOT_CONFIGURED',
        message: 'Korxona ruxsati sozlanmagan',
        details: {},
      });
    }
    if (!await this.tenantRbacService.hasAllPermissions(
      request.tenantDataSource,
      request.tenantUser.userId,
      requiredPermissions,
    )) {
      throw new ForbiddenException({
        code: 'TENANT_PERMISSION_DENIED',
        message: 'Bu korxona amali uchun ruxsat yo‘q',
        details: {},
      });
    }
    return true;
  }
}
