import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type {
  PlatformAuthenticatedRequest,
  PlatformPrincipal,
  TenantAuthenticatedRequest,
  TenantCompanyContext,
  TenantPrincipal,
} from './auth-types.js';

export const PLATFORM_PERMISSIONS_METADATA_KEY = 'auth.platform.permissions';
export const TENANT_PERMISSIONS_METADATA_KEY = 'auth.tenant.permissions';

export const PlatformPermissions = (...permissionCodes: string[]) =>
  SetMetadata(PLATFORM_PERMISSIONS_METADATA_KEY, permissionCodes);

export const TenantPermissions = (...permissionCodes: string[]) =>
  SetMetadata(TENANT_PERMISSIONS_METADATA_KEY, permissionCodes);

export const CurrentPlatformUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformPrincipal | undefined =>
    context.switchToHttp().getRequest<PlatformAuthenticatedRequest>().platformUser,
);

export const CurrentTenantUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantPrincipal | undefined =>
    context.switchToHttp().getRequest<TenantAuthenticatedRequest>().tenantUser,
);

export const CurrentCompany = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantCompanyContext | undefined =>
    context.switchToHttp().getRequest<TenantAuthenticatedRequest>().companyContext,
);
