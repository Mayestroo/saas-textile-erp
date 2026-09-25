import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_CONFIGURATION,
  loadAuthConfiguration,
} from '../src/common/auth/auth-configuration.js';
import { JwtTokenService } from '../src/common/auth/jwt-token.service.js';
import { StructuredApiExceptionFilter } from '../src/common/errors/structured-api-exception.filter.js';
import { CompaniesController } from '../src/master/companies/companies.controller.js';
import { CompaniesService } from '../src/master/companies/companies.service.js';
import { PlatformAuthController } from '../src/master/platform-auth/platform-auth.controller.js';
import { PlatformAuthGuard } from '../src/master/platform-auth/platform-auth.guard.js';
import { PlatformAuthService } from '../src/master/platform-auth/platform-auth.service.js';
import { PlatformPermissionGuard } from '../src/master/platform-auth/platform-permission.guard.js';
import { PlatformRbacService } from '../src/master/platform-rbac/platform-rbac.service.js';
import type { ProvisioningSnapshot } from '../src/master/provisioning/provisioning.service.js';
import { TenantAuthController } from '../src/tenant/auth/tenant-auth.controller.js';
import { TenantAuthService } from '../src/tenant/auth/tenant-auth.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
});

const platformUserId = '11111111-1111-4111-8111-111111111111';
const platformSessionId = '22222222-2222-4222-8222-222222222222';
const tenantUserId = '33333333-3333-4333-8333-333333333333';
const companyId = '44444444-4444-4444-8444-444444444444';
const tokenService = new JwtTokenService();

async function issueToken(scope: 'platform' | 'tenant'): Promise<string> {
  const domain = authConfiguration[scope];
  const commonClaims = {
    sub: scope === 'platform' ? platformUserId : tenantUserId,
    session_id: platformSessionId,
    jti: '55555555-5555-4555-8555-555555555555',
    scope,
    token_type: 'access' as const,
  };
  const claims = scope === 'platform'
    ? commonClaims
    : { ...commonClaims, company_id: companyId };
  return tokenService.sign(claims, {
    secret: domain.accessSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
  });
}

describe('Authentication and RBAC endpoints (e2e)', () => {
  let app: INestApplication;
  const companyCreatePermission = vi.fn(async (userId: string, codes: readonly string[]) =>
    userId === platformUserId && codes.includes('companies.create'),
  );
  const masterDataSource = {
    query: vi.fn(async () => [{ id: platformSessionId }]),
  } as unknown as DataSource;
  const provisioningResult: ProvisioningSnapshot = {
    companyId,
    status: 'ACTIVE',
    provisioningStatus: 'ACTIVE',
    failureStep: null,
    failureReason: null,
    schemaVersion: 'test-schema',
  };
  const platformAuthService = {
    login: vi.fn(async () => ({
      access_token: 'platform-access',
      refresh_token: 'platform-refresh',
      token_type: 'Bearer' as const,
      expires_in: 900,
      user: { id: platformUserId, email: 'owner@example.test' },
    })),
    refresh: vi.fn(async () => ({
      access_token: 'platform-access-next',
      refresh_token: 'platform-refresh-next',
      token_type: 'Bearer' as const,
      expires_in: 900,
    })),
  };
  const tenantAuthService = {
    login: vi.fn(async () => ({
      access_token: 'tenant-access',
      refresh_token: 'tenant-refresh',
      token_type: 'Bearer' as const,
      expires_in: 900,
      user: { id: tenantUserId, email: 'worker@example.test', full_name: 'Factory Admin' },
      company: { id: companyId, slug: 'atlas-textile' },
    })),
    refresh: vi.fn(async () => ({
      access_token: 'tenant-access-next',
      refresh_token: 'tenant-refresh-next',
      token_type: 'Bearer' as const,
      expires_in: 900,
    })),
  };
  const companiesService = {
    createAndProvision: vi.fn(async () => provisioningResult),
  };

  beforeEach(() => {
    companyCreatePermission.mockResolvedValue(true);
  });

  beforeAll(async () => {
    const platformRbac = { hasAllPermissions: companyCreatePermission } as unknown as PlatformRbacService;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PlatformAuthController, TenantAuthController, CompaniesController],
      providers: [
        { provide: PlatformAuthService, useValue: platformAuthService },
        { provide: TenantAuthService, useValue: tenantAuthService },
        { provide: CompaniesService, useValue: companiesService },
        { provide: getDataSourceToken('master'), useValue: masterDataSource },
        { provide: AUTH_CONFIGURATION, useValue: authConfiguration },
        { provide: PlatformRbacService, useValue: platformRbac },
        JwtTokenService,
        PlatformAuthGuard,
        PlatformPermissionGuard,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }));
    app.useGlobalFilters(new StructuredApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('exposes platform login and tenant hostname-routed login', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/platform/auth/login')
      .send({ email: 'owner@example.test', password: 'test-only-password' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ user: { id: platformUserId }, token_type: 'Bearer' });
      });

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Host', 'atlas-textile.erp.example.test')
      .send({ email: 'worker@example.test', password: 'test-only-password' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          user: { id: tenantUserId },
          company: { id: companyId, slug: 'atlas-textile' },
        });
      });

    expect(tenantAuthService.login).toHaveBeenCalledWith(
      'atlas-textile.erp.example.test',
      { email: 'worker@example.test', password: 'test-only-password' },
      expect.any(String),
    );
  });

  it('requires platform scope and companies.create for company provisioning', async () => {
    const tenantToken = await issueToken('tenant');
    const platformToken = await issueToken('platform');

    await request(app.getHttpServer())
      .post('/api/v1/platform/companies')
      .send({ name: 'Atlas Textile', slug: 'atlas-textile' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ name: 'Atlas Textile', slug: 'atlas-textile' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ name: 'Atlas Textile', slug: 'atlas-textile' })
      .expect(201)
      .expect(({ body }) => expect(body).toEqual(provisioningResult));

    expect(companiesService.createAndProvision).toHaveBeenCalledWith({
      name: 'Atlas Textile',
      slug: 'atlas-textile',
    });
    expect(companyCreatePermission).toHaveBeenCalledWith(platformUserId, ['companies.create']);
  });

  it('rejects company creation when the platform user lacks companies.create', async () => {
    const previousProvisioningCalls = companiesService.createAndProvision.mock.calls.length;
    companyCreatePermission.mockResolvedValue(false);
    await request(app.getHttpServer())
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${await issueToken('platform')}`)
      .send({ name: 'Denied Textile', slug: 'denied-textile' })
      .expect(403);
    expect(companiesService.createAndProvision).toHaveBeenCalledTimes(previousProvisioningCalls);
  });

  it('validates company-create payloads before invoking provisioning', async () => {
    const provisioningCallsBefore = companiesService.createAndProvision.mock.calls.length;
    await request(app.getHttpServer())
      .post('/api/v1/platform/companies')
      .set('Authorization', `Bearer ${await issueToken('platform')}`)
      .send({ name: 'Invalid slug', slug: 'Bad Slug!' })
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'VALIDATION_ERROR' }));
    expect(companiesService.createAndProvision).toHaveBeenCalledTimes(provisioningCallsBefore);
  });

  it('rejects unknown DTO fields and returns the structured error envelope', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/platform/auth/login')
      .send({ email: 'owner@example.test', password: 'test-only-password', tenant_id: companyId })
      .expect(400)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'VALIDATION_ERROR',
          message: 'So‘rov ma’lumotlari noto‘g‘ri',
          details: {},
        });
        expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
      });
  });
});
