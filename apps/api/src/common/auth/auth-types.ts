import type { Request } from 'express';
import type { DataSource } from 'typeorm';

export interface PlatformPrincipal {
  userId: string;
  sessionId: string;
}

export interface TenantPrincipal {
  userId: string;
  sessionId: string;
  companyId: string;
}

export interface TenantCompanyContext {
  companyId: string;
  slug: string;
  databaseName: string;
}

export interface OfflineCapabilityClaims {
  tokenType: 'offline-capability';
  userId: string;
  companyId: string;
  deviceId: string;
  issuedAt: number;
  expiresAt: number;
  capabilityId: string;
}

export interface PlatformAuthenticatedRequest extends Request {
  platformUser?: PlatformPrincipal;
}

export interface TenantAuthenticatedRequest extends Request {
  tenantUser?: TenantPrincipal;
  companyContext?: TenantCompanyContext;
  tenantDataSource?: DataSource;
}
