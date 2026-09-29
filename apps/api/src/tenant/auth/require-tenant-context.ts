import { UnauthorizedException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';

export interface TenantRequestContext {
  dataSource: DataSource;
  actorUserId: string;
  companyId: string;
  timezone: string;
}

export function requireTenantContext(request: TenantAuthenticatedRequest): TenantRequestContext {
  if (!request.tenantDataSource || !request.tenantUser || !request.companyContext) {
    throw new UnauthorizedException({
      code: 'TENANT_AUTH_REQUIRED',
      message: 'Korxona autentifikatsiyasi talab qilinadi',
      details: {},
    });
  }
  return {
    dataSource: request.tenantDataSource,
    actorUserId: request.tenantUser.userId,
    companyId: request.tenantUser.companyId,
    timezone: request.companyContext.timezone,
  };
}
