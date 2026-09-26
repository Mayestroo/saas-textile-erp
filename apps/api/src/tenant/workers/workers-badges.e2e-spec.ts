import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { AUTH_CONFIGURATION, loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import { StructuredApiExceptionFilter } from '../../common/errors/structured-api-exception.filter.js';
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js';
import { TenantPermissionGuard } from '../auth/tenant-permission.guard.js';
import { TenantConnectionManager } from '../tenant-connection/tenant-connection.manager.js';
import { TenantResolverService } from '../tenant-resolver/tenant-resolver.service.js';
import { TenantRbacService } from '../rbac/tenant-rbac.service.js';
import { BadgeHistoryService } from '../badges/badge-history.service.js';
import { BadgesController } from '../badges/badges.controller.js';
import { BadgeResolutionService } from '../badges/badge-resolution.service.js';
import { WorkersController } from './workers.controller.js';
import { WorkersService } from './workers.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-for-workers-e2e-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-for-workers-e2e-002',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-for-workers-e2e-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-for-workers-e2e-0004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-secret-for-workers-e2e-0005',
});

const companyA = '44444444-4444-4444-8444-444444444444';
const companyB = '55555555-5555-4555-8555-555555555555';
const sessionId = '66666666-6666-4666-8666-666666666666';
const viewUserId = '11111111-1111-4111-8111-111111111111';
const workerManageUserId = '22222222-2222-4222-8222-222222222222';
const badgeManageUserId = '33333333-3333-4333-8333-333333333333';
const workerId = '9007199254740993';

const permissionsByUser = new Map<string, Set<string>>([
  [viewUserId, new Set(['workers.view'])],
  [workerManageUserId, new Set(['workers.manage'])],
  [badgeManageUserId, new Set(['workers.badge.manage'])],
]);

const tenantDataSourceA = { query: vi.fn(async () => [{ id: sessionId }]) } as unknown as DataSource;
const tenantDataSourceB = { query: vi.fn(async () => [{ id: sessionId }]) } as unknown as DataSource;
const dataSourceByCompany = new Map([
  [companyA, tenantDataSourceA],
  [companyB, tenantDataSourceB],
]);

const workerRecordA = {
  id: workerId,
  full_name: 'Abdullayeva Nodira',
  status: 'ACTIVE',
  version: '1',
  created_at: '2026-09-26T00:00:00.000000Z',
  updated_at: '2026-09-26T00:00:00.000000Z',
};
const workerRecordB = { ...workerRecordA, id: '1', full_name: 'Tenant B worker' };
const badgeRecord = {
  id: '77777777-7777-4777-8777-777777777777',
  badge_number: '00125',
  worker_id: workerId,
  full_name: 'Abdullayeva Nodira',
  valid_from: '2026-09-26T00:00:00.000000Z',
  valid_to: null,
  created_by: badgeManageUserId,
  created_at: '2026-09-26T00:00:00.000000Z',
};

const workersService = {
  list: vi.fn(async (source: DataSource) => source === tenantDataSourceB ? [workerRecordB] : [workerRecordA]),
  getById: vi.fn(async (source: DataSource, id: string) =>
    source === tenantDataSourceB ? workerRecordB : { ...workerRecordA, id }),
  create: vi.fn(async (_source: DataSource, _actor: string, input: { full_name: string }) => ({
    ...workerRecordA,
    full_name: input.full_name,
  })),
  update: vi.fn(async () => ({ ...workerRecordA, version: '2' })),
};

const badgeHistoryService = {
  listByWorker: vi.fn(async () => [badgeRecord]),
  assign: vi.fn(async () => badgeRecord),
  reassign: vi.fn(async () => badgeRecord),
  release: vi.fn(async () => ({ ...badgeRecord, valid_to: '2026-10-01T00:00:00.000000Z' })),
};

const badgeResolutionService = {
  resolve: vi.fn(async () => ({
    worker_id: workerId,
    full_name: 'Abdullayeva Nodira',
    assignment: {
      id: badgeRecord.id,
      badge_number: '00125',
      valid_from: badgeRecord.valid_from,
      valid_to: null,
    },
  })),
};

async function issueToken(
  scope: 'platform' | 'tenant',
  userId = viewUserId,
  tokenCompanyId = companyA,
): Promise<string> {
  const domain = authConfiguration[scope];
  const commonClaims = {
    sub: userId,
    session_id: sessionId,
    jti: '88888888-8888-4888-8888-888888888888',
    scope,
    token_type: 'access' as const,
  };
  const claims = scope === 'tenant'
    ? { ...commonClaims, company_id: tokenCompanyId }
    : commonClaims;
  return new JwtTokenService().sign(claims, {
    secret: domain.accessSecret,
    issuer: domain.issuer,
    audience: domain.audience,
    expiresInSeconds: 60,
  });
}

describe('Workers and badges tenant API (e2e)', () => {
  let app: INestApplication;
  const tenantBySlug = new Map([
    ['atlas-textile', { companyId: companyA, slug: 'atlas-textile', databaseName: 'tenant_a' }],
    ['bora-textile', { companyId: companyB, slug: 'bora-textile', databaseName: 'tenant_b' }],
  ]);
  const resolver = {
    resolve: vi.fn(async ({ hostname, authenticatedCompanyId }: {
      hostname: string;
      authenticatedCompanyId: string | null | undefined;
    }) => {
      const slug = hostname.split('.')[0] ?? '';
      const tenant = tenantBySlug.get(slug);
      if (!tenant || tenant.companyId !== authenticatedCompanyId) {
        throw new ForbiddenException({
          code: 'TENANT_CONTEXT_MISMATCH',
          message: 'Korxona konteksti tasdiqlanmadi',
          details: {},
        });
      }
      return tenant;
    }),
  };
  const connectionManager = {
    getDataSource: vi.fn(async (authenticatedCompanyId: string) => dataSourceByCompany.get(authenticatedCompanyId)),
  };
  const tenantRbac = {
    hasAllPermissions: vi.fn(async (_source: DataSource, userId: string, required: readonly string[]) => {
      const granted = permissionsByUser.get(userId) ?? new Set<string>();
      return required.every((permission) => granted.has(permission));
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [WorkersController, BadgesController],
      providers: [
        { provide: WorkersService, useValue: workersService },
        { provide: BadgeHistoryService, useValue: badgeHistoryService },
        { provide: BadgeResolutionService, useValue: badgeResolutionService },
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

  it('requires tenant authentication and rejects a platform token', async () => {
    await request(app.getHttpServer()).get('/api/v1/workers').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/workers')
      .set('Authorization', `Bearer ${await issueToken('platform')}`)
      .expect(401);
    expect(connectionManager.getDataSource).not.toHaveBeenCalled();
  });

  it('enforces worker read/manage and badge-manage permissions separately', async () => {
    const viewToken = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .get('/api/v1/workers')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);
    expect(workersService.list).toHaveBeenCalledWith(tenantDataSourceA, 'ACTIVE');

    await request(app.getHttpServer())
      .post('/api/v1/workers')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ full_name: 'Denied Worker' })
      .expect(403);
    expect(workersService.create).not.toHaveBeenCalled();

    const manageToken = await issueToken('tenant', workerManageUserId);
    await request(app.getHttpServer())
      .post('/api/v1/workers')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ full_name: '  Abdullayeva\t Nodira  ' })
      .expect(201);
    expect(workersService.create).toHaveBeenCalledWith(
      tenantDataSourceA,
      workerManageUserId,
      { full_name: 'Abdullayeva Nodira' },
    );

    await request(app.getHttpServer())
      .patch(`/api/v1/workers/${workerId}`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ full_name: 'Updated Name', expected_version: '1' })
      .expect(200);
    expect(workersService.update).toHaveBeenCalledWith(
      tenantDataSourceA,
      workerManageUserId,
      workerId,
      { full_name: 'Updated Name', expected_version: '1' },
    );

    await request(app.getHttpServer())
      .post(`/api/v1/workers/${workerId}/badges`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ badge_number: '125' })
      .expect(403);

    const badgeToken = await issueToken('tenant', badgeManageUserId);
    await request(app.getHttpServer())
      .post(`/api/v1/workers/${workerId}/badges`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${badgeToken}`)
      .send({ badge_number: ' 00125 ' })
      .expect(201);
    expect(badgeHistoryService.assign).toHaveBeenCalledWith(
      tenantDataSourceA,
      badgeManageUserId,
      workerId,
      { badge_number: '00125' },
    );
  });

  it('exposes protected worker and badge reads and badge mutation routes', async () => {
    const viewToken = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .get(`/api/v1/workers/${workerId}`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/workers/${workerId}/badges`)
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/badges/00125/resolve?at=2026-09-26T00%3A00%3A00Z')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(200);
    expect(badgeResolutionService.resolve).toHaveBeenCalledWith(
      tenantDataSourceA,
      '00125',
      '2026-09-26T00:00:00Z',
    );

    const badgeToken = await issueToken('tenant', badgeManageUserId);
    await request(app.getHttpServer())
      .post('/api/v1/badges/00125/reassign')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${badgeToken}`)
      .send({ worker_id: '47', effective_at: '2026-10-01T00:00:00Z' })
      .expect(201);
    expect(badgeHistoryService.reassign).toHaveBeenCalledWith(
      tenantDataSourceA,
      badgeManageUserId,
      '00125',
      { worker_id: '47', effective_at: '2026-10-01T00:00:00Z' },
    );

    await request(app.getHttpServer())
      .post('/api/v1/badges/00125/release')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${badgeToken}`)
      .send({})
      .expect(201);
  });

  it('rejects invalid IDs, fields, timestamps, statuses, and empty badge values', async () => {
    const manageToken = await issueToken('tenant', workerManageUserId);
    const viewToken = await issueToken('tenant', viewUserId);
    const host = 'atlas-textile.erp.example.test';
    await request(app.getHttpServer())
      .get('/api/v1/workers/0')
      .set('Host', host)
      .set('Authorization', `Bearer ${viewToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/workers')
      .set('Host', host)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ full_name: '   ' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/workers')
      .set('Host', host)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ full_name: 'Worker', tenant_id: companyA })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/workers/${workerId}`)
      .set('Host', host)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ status: 'DELETED', expected_version: '1' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/workers/${workerId}`)
      .set('Host', host)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ full_name: 'Name', expected_version: '0' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/badges/%20/reassign')
      .set('Host', host)
      .set('Authorization', `Bearer ${await issueToken('tenant', badgeManageUserId)}`)
      .send({ worker_id: '0', effective_at: 'yesterday' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/badges/125/reassign')
      .set('Host', host)
      .set('Authorization', `Bearer ${await issueToken('tenant', badgeManageUserId)}`)
      .send({ worker_id: '7', effective_at: 'yesterday' })
      .expect(400);
    expect(workersService.create).not.toHaveBeenCalled();
    expect(workersService.update).not.toHaveBeenCalled();
  });

  it('rejects Tenant A against Tenant B host and routes Tenant B to its own database', async () => {
    const tokenA = await issueToken('tenant', viewUserId, companyA);
    await request(app.getHttpServer())
      .get('/api/v1/workers')
      .set('Host', 'bora-textile.erp.example.test')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);
    expect(connectionManager.getDataSource).not.toHaveBeenCalled();
    expect(workersService.list).not.toHaveBeenCalled();

    const tokenB = await issueToken('tenant', viewUserId, companyB);
    await request(app.getHttpServer())
      .get('/api/v1/workers')
      .set('Host', 'bora-textile.erp.example.test')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200)
      .expect(({ body }) => expect(body[0]?.full_name).toBe('Tenant B worker'));
    expect(workersService.list).toHaveBeenCalledWith(tenantDataSourceB, 'ACTIVE');
  });
});
