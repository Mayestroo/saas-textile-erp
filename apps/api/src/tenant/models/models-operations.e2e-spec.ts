import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUTH_CONFIGURATION, loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import { StructuredApiExceptionFilter } from '../../common/errors/structured-api-exception.filter.js';
import { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import { TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';
import { OperationsController } from '../operations/operations.controller.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import { OperationsService } from '../operations/operations.service.js';
import { ModelsController } from './models.controller.js';
import { ModelsService } from './models.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-for-models-e2e-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-for-models-e2e-002',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-for-models-e2e-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-for-models-e2e-0004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-secret-for-models-e2e-0005',
});

const companyId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const viewUserId = '11111111-1111-4111-8111-111111111111';
const manageUserId = '22222222-2222-4222-8222-222222222222';
const modelId = '66666666-6666-4666-8666-666666666666';
const operationId = '77777777-7777-4777-8777-777777777777';

const permissionByUser = new Map<string, Set<string>>([
  [viewUserId, new Set(['models.view'])],
  [manageUserId, new Set(['models.manage'])],
]);

const tenantDataSource = {
  query: vi.fn(async () => [{ id: sessionId }]),
} as unknown as DataSource;

const modelsService = {
  list: vi.fn(async () => []),
  getById: vi.fn(async () => ({ id: modelId, name: 'Atlas Knit', status: 'ACTIVE', version: '1' })),
  create: vi.fn(async () => ({ id: modelId, name: 'Atlas Knit', status: 'ACTIVE', version: '1' })),
  update: vi.fn(async () => ({ id: modelId, name: 'Atlas Knit', status: 'INACTIVE', version: '2' })),
};

const operationsService = {
  listByModel: vi.fn(async () => []),
  create: vi.fn(async () => ({
    id: operationId,
    model_id: modelId,
    name: 'Yeng tikish',
    price: '1000.00',
    sort_order: 0,
    status: 'ACTIVE',
    version: '1',
  })),
  update: vi.fn(async () => ({
    id: operationId,
    model_id: modelId,
    name: 'Yeng tikish',
    price: '1000.00',
    sort_order: 0,
    status: 'INACTIVE',
    version: '2',
  })),
};

const operationPriceService = {
  changePrice: vi.fn(async () => ({
    id: '88888888-8888-4888-8888-888888888888',
    operation_id: operationId,
    price: '1200.00',
    valid_from: '2026-10-01T00:00:00.000000Z',
    valid_to: null,
    created_by: manageUserId,
    created_at: '2026-09-26T00:00:00.000000Z',
    operation_version: '2',
  })),
  listHistory: vi.fn(async () => []),
  resolvePrice: vi.fn(async () => '1000.00'),
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
  const claims = scope === 'tenant'
    ? { ...commonClaims, company_id: companyId }
    : commonClaims;
  return new JwtTokenService().sign(claims, {
    secret: domain.accessSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
  });
}

describe('Models and operations tenant API (e2e)', () => {
  let app: INestApplication;
  const resolver = { resolve: vi.fn(async () => ({
    companyId,
    slug: 'atlas-textile',
    databaseName: 'tenant_44444444444444448444444444444444',
  })) };
  const connectionManager = { getDataSource: vi.fn(async () => tenantDataSource) };
  const tenantRbac = {
    hasAllPermissions: vi.fn(async (_dataSource: DataSource, userId: string, required: readonly string[]) => {
      const granted = permissionByUser.get(userId) ?? new Set<string>();
      return required.every((code) => granted.has(code));
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [ModelsController, OperationsController],
      providers: [
        { provide: ModelsService, useValue: modelsService },
        { provide: OperationsService, useValue: operationsService },
        { provide: OperationPriceService, useValue: operationPriceService },
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

  it('requires a valid tenant token and rejects a platform token', async () => {
    await request(app.getHttpServer()).get('/api/v1/models').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/models')
      .set('Authorization', `Bearer ${await issueToken('platform')}`)
      .expect(401);
    expect(connectionManager.getDataSource).not.toHaveBeenCalled();
  });

  it('allows models.view reads and denies writes to a view-only tenant user', async () => {
    const token = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .get('/api/v1/models')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(modelsService.list).toHaveBeenCalledWith(tenantDataSource, 'ACTIVE');

    await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Denied model' })
      .expect(403);
    expect(modelsService.create).not.toHaveBeenCalled();
  });

  it('allows models.manage writes and normalizes request names before service delegation', async () => {
    const token = await issueToken('tenant', manageUserId);
    await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  Atlas\t Knit  ' })
      .expect(201);

    expect(modelsService.create).toHaveBeenCalledWith(
      tenantDataSource,
      manageUserId,
      { name: 'Atlas Knit' },
    );
  });

  it('rejects invalid price payloads and unknown DTO fields before business writes', async () => {
    const token = await issueToken('tenant', manageUserId);
    await request(app.getHttpServer())
      .post(`/api/v1/models/${modelId}/operations`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Yeng tikish', price: '-1.00', sort_order: 0 })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/operations/${operationId}/price`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ price: '1200.00', effective_from: 'yesterday', expected_version: '1' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/models')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Atlas Knit', tenant_id: companyId })
      .expect(400);
    expect(operationsService.create).not.toHaveBeenCalled();
    expect(operationPriceService.changePrice).not.toHaveBeenCalled();
    expect(modelsService.create).not.toHaveBeenCalled();
  });

  it('requires models.manage for operation price scheduling and models.view for price history', async () => {
    const viewToken = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .post(`/api/v1/operations/${operationId}/price`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ price: '1200.00', expected_version: '1' })
      .expect(403);

    const manageToken = await issueToken('tenant', manageUserId);
    await request(app.getHttpServer())
      .post(`/api/v1/operations/${operationId}/price`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ price: '1200.00', expected_version: '1' })
      .expect(200);
    expect(operationPriceService.changePrice).toHaveBeenCalledWith(tenantDataSource, {
      operationId,
      actorUserId: manageUserId,
      price: '1200.00',
      effectiveFrom: undefined,
      expectedVersion: '1',
    });

    await request(app.getHttpServer())
      .get(`/api/v1/operations/${operationId}/prices?effective_at=2026-09-15T00%3A00%3A00Z`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);
    expect(operationPriceService.resolvePrice).toHaveBeenCalledWith(
      operationId,
      '2026-09-15T00:00:00Z',
      tenantDataSource,
    );
  });
});
