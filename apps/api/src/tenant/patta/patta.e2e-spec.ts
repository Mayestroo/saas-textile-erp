import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_CONFIGURATION, loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import { StructuredApiExceptionFilter } from '../../common/errors/structured-api-exception.filter.js';
import { DeviceAccessService } from '../../master/devices/device-access.service.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import { TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';
import { PattaController } from './patta.controller.js';
import { PattaTemplatesController } from './patta-templates.controller.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaService } from './patta.service.js';
import { PattaTemplatesService } from './patta-templates.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-for-patta-e2e-0001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-for-patta-e2e-0002',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-for-patta-e2e-000003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-for-patta-e2e-000004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-secret-for-patta-e2e-00005',
});

const companyId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const viewUserId = '11111111-1111-4111-8111-111111111111';
const manageUserId = '22222222-2222-4222-8222-222222222222';
const deviceId = '66666666-6666-4666-8666-666666666666';
const foreignDeviceId = '77777777-7777-4777-8777-777777777777';
const templateId = '88888888-8888-4888-8888-888888888888';

const permissionByUser = new Map<string, Set<string>>([
  [viewUserId, new Set(['models.view', 'patta.hisob.view'])],
  [manageUserId, new Set([
    'models.manage',
    'patta.chiqarish.create',
    'patta.hisob.view',
  ])],
]);

const tenantDataSource = {
  query: vi.fn(async () => [{ id: sessionId }]),
} as unknown as DataSource;

const pattaTemplatesService = {
  list: vi.fn(async () => []),
  getById: vi.fn(async () => ({ id: templateId, name: 'Atlas', version: '1' })),
  create: vi.fn(async () => ({ id: templateId, name: 'Atlas', version: '1' })),
  update: vi.fn(async () => ({ id: templateId, name: 'Atlas', status: 'INACTIVE', version: '2' })),
};

const pattaNumberBlocksService = {
  allocate: vi.fn(async () => ({ id: templateId, device_id: deviceId, range_start: '1000', range_end: '1999' })),
  reportUsage: vi.fn(async () => ({ id: templateId, status: 'ACTIVE', reported_used_count: '12' })),
  cancel: vi.fn(async () => ({ id: templateId, status: 'CANCELLED' })),
};

const pattaService = {
  generate: vi.fn(async () => [{ id: templateId, partiya_number: 'A-1', patta_number: '1000' }]),
  lookup: vi.fn(async () => ({ id: templateId, partiya_number: 'A-1', patta_number: '1000' })),
  list: vi.fn(async () => ({ items: [], total: '0', page: 1, limit: 50 })),
};

async function issueToken(scope: 'platform' | 'tenant', userId = viewUserId): Promise<string> {
  const domain = authConfiguration[scope];
  const commonClaims = {
    sub: userId,
    session_id: sessionId,
    jti: '99999999-9999-4999-8999-999999999999',
    scope,
    token_type: 'access' as const,
  };
  const claims = scope === 'tenant' ? { ...commonClaims, company_id: companyId } : commonClaims;
  return new JwtTokenService().sign(claims, {
    secret: domain.accessSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
  });
}

describe('Patta tenant API (e2e)', () => {
  let app: INestApplication;
  const resolver = {
    resolve: vi.fn(async () => ({
      companyId,
      slug: 'atlas-textile',
      databaseName: 'tenant_44444444444444448444444444444444',
    })),
  };
  const connectionManager = { getDataSource: vi.fn(async () => tenantDataSource) };
  const tenantRbac = {
    hasAllPermissions: vi.fn(async (_dataSource: DataSource, userId: string, permissions: readonly string[]) => {
      const granted = permissionByUser.get(userId) ?? new Set<string>();
      return permissions.every((permission) => granted.has(permission));
    }),
  };
  const deviceAccess = {
    assertActiveDevice: vi.fn(async (authenticatedCompanyId: string, requestedDeviceId: string) => {
      if (requestedDeviceId === foreignDeviceId) {
        throw new ForbiddenException({
          code: 'DEVICE_TENANT_MISMATCH',
          message: 'Qurilma bu korxonaga tegishli emas',
          details: {},
        });
      }
      return { id: requestedDeviceId, companyId: authenticatedCompanyId };
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [PattaController, PattaTemplatesController],
      providers: [
        { provide: PattaService, useValue: pattaService },
        { provide: PattaNumberBlocksService, useValue: pattaNumberBlocksService },
        { provide: PattaTemplatesService, useValue: pattaTemplatesService },
        { provide: DeviceAccessService, useValue: deviceAccess },
        { provide: TenantResolverService, useValue: resolver },
        { provide: TenantConnectionManager, useValue: connectionManager },
        { provide: TenantRbacService, useValue: tenantRbac },
        { provide: AUTH_CONFIGURATION, useValue: authConfiguration },
        JwtTokenService,
        TenantAuthGuard,
        TenantPermissionGuard,
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
    await app?.close();
  });

  it('requires a tenant token and rejects a platform token', async () => {
    await request(app.getHttpServer()).get('/api/v1/patta').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/patta')
      .set('Authorization', `Bearer ${await issueToken('platform')}`)
      .expect(401);
    expect(connectionManager.getDataSource).not.toHaveBeenCalled();
  });

  it('enforces template read/manage permissions', async () => {
    const viewToken = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .get('/api/v1/patta-templates')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/patta-templates')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ name: 'Denied', model_id: templateId, konveyer: '1' })
      .expect(403);
    expect(pattaTemplatesService.create).not.toHaveBeenCalled();

    const manageToken = await issueToken('tenant', manageUserId);
    await request(app.getHttpServer())
      .post('/api/v1/patta-templates')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ name: 'Atlas', model_id: templateId, konveyer: '1' })
      .expect(201);
    expect(pattaTemplatesService.create).toHaveBeenCalledWith(
      tenantDataSource,
      manageUserId,
      expect.objectContaining({ name: 'Atlas' }),
    );
  });

  it('validates each block request device and rejects foreign devices and forged tenant fields', async () => {
    const token = await issueToken('tenant', manageUserId);
    const viewToken = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .post('/api/v1/patta-number-blocks/allocate')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ device_id: deviceId })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/patta-number-blocks/allocate')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId })
      .expect(201);
    expect(deviceAccess.assertActiveDevice).toHaveBeenCalledWith(companyId, deviceId);
    expect(pattaNumberBlocksService.allocate).toHaveBeenCalledWith(tenantDataSource, manageUserId, deviceId);

    await request(app.getHttpServer())
      .post(`/api/v1/patta-number-blocks/${templateId}/usage`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, reported_used_count: '12' })
      .expect(200);
    expect(pattaNumberBlocksService.reportUsage).toHaveBeenCalledWith(
      tenantDataSource,
      manageUserId,
      deviceId,
      templateId,
      12n,
    );

    await request(app.getHttpServer())
      .post(`/api/v1/patta-number-blocks/${templateId}/cancel`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId })
      .expect(200);
    expect(pattaNumberBlocksService.cancel).toHaveBeenCalledWith(
      tenantDataSource,
      manageUserId,
      deviceId,
      templateId,
    );

    await request(app.getHttpServer())
      .post('/api/v1/patta-number-blocks/allocate')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: foreignDeviceId })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/patta-number-blocks/allocate')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, company_id: companyId, requested_block_size: 999999999 })
      .expect(400);
    expect(pattaNumberBlocksService.allocate).toHaveBeenCalledTimes(1);
  });

  it('validates device identity for generation and rejects client-authored accounting fields', async () => {
    const token = await issueToken('tenant', manageUserId);
    await request(app.getHttpServer())
      .post('/api/v1/patta/generate')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({
        partiya_number: 'A-1',
        model_id: templateId,
        konveyer: '1',
        count: 1,
        device_id: deviceId,
      })
      .expect(201);
    expect(pattaService.generate).toHaveBeenCalledWith(
      tenantDataSource,
      manageUserId,
      deviceId,
      expect.objectContaining({ partiya_number: 'A-1' }),
    );

    await request(app.getHttpServer())
      .post('/api/v1/patta/generate')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({
        partiya_number: 'A-1',
        model_id: templateId,
        konveyer: '1',
        count: 1,
        device_id: deviceId,
        ish_soni: 4,
        created_from_block_id: templateId,
        operation_snapshots: [{ unit_price: '1.00' }],
      })
      .expect(400);
    expect(pattaService.generate).toHaveBeenCalledTimes(1);
  });

  it('protects lookup/list with patta.hisob.view and passes slash-containing partiya as query data', async () => {
    const token = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .get('/api/v1/patta/lookup?partiya_number=25%2F09-3&patta_number=1057')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(pattaService.lookup).toHaveBeenCalledWith(tenantDataSource, '25/09-3', '1057');

    await request(app.getHttpServer())
      .get('/api/v1/patta?page=1&limit=50')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(pattaService.list).toHaveBeenCalledWith(tenantDataSource, expect.objectContaining({ page: 1, limit: 50 }));
  });
});
