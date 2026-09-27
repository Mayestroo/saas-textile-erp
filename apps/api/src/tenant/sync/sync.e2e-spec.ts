import { ForbiddenException, type INestApplication, ValidationPipe } from '@nestjs/common';
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
import { SYNC_CONFIGURATION, loadSyncConfiguration } from './sync.config.js';
import { SyncController } from './sync.controller.js';
import { SyncBootstrapService } from './sync-bootstrap.service.js';
import { SyncService } from './sync.service.js';

const authConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-for-sync-e2e-0001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-for-sync-e2e-0002',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-for-sync-e2e-000003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-for-sync-e2e-000004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-secret-for-sync-e2e-000005',
});

const companyId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const viewUserId = '11111111-1111-4111-8111-111111111111';
const syncUserId = '22222222-2222-4222-8222-222222222222';
const pushOnlyUserId = '33333333-3333-4333-8333-333333333333';
const deviceId = '66666666-6666-4666-8666-666666666666';
const foreignDeviceId = '77777777-7777-4777-8777-777777777777';

const permissionByUser = new Map<string, Set<string>>([
  [viewUserId, new Set(['sync.pull'])],
  [syncUserId, new Set(['sync.pull', 'sync.push', 'patta.chiqarish.create'])],
  [pushOnlyUserId, new Set(['sync.push'])],
]);

const tenantDataSource = {
  query: vi.fn(async () => [{ id: sessionId }]),
} as unknown as DataSource;

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

describe('Tenant sync API (e2e)', () => {
  let app: INestApplication;
  const resolver = {
    resolve: vi.fn(async (input: { hostname: string }) => {
      if (input.hostname.startsWith('other-tenant')) {
        throw new ForbiddenException({
          code: 'TENANT_CONTEXT_MISMATCH',
          message: 'Token boshqa korxonaga tegishli',
          details: {},
        });
      }
      return {
        companyId,
        slug: 'atlas-textile',
        databaseName: 'tenant_44444444444444448444444444444444',
      };
    }),
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
  const syncService = {
    push: vi.fn(async () => ({ results: [] })),
    pull: vi.fn(async () => ({ changes: [], next_cursor: '0', has_more: false })),
  };
  const syncBootstrapService = {
    create: vi.fn(async () => ({
      id: '88888888-8888-4888-8888-888888888888',
      device_id: deviceId,
      watermark: '12840',
      status: 'ACTIVE',
      expires_at: '2026-09-26T10:30:00.000000Z',
    })),
    page: vi.fn(async () => ({
      session_id: '88888888-8888-4888-8888-888888888888',
      watermark: '12840',
      items: [],
      next_order_key: null,
      has_more: false,
    })),
    complete: vi.fn(async () => ({
      session_id: '88888888-8888-4888-8888-888888888888',
      status: 'COMPLETED',
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an authenticated tenant token on another tenant hostname', async () => {
    const token = await issueToken('tenant', syncUserId);
    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'other-tenant.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, events: [] })
      .expect(403);
    expect(deviceAccess.assertActiveDevice).not.toHaveBeenCalled();
    expect(syncService.push).not.toHaveBeenCalled();
  });

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [
        { provide: SyncService, useValue: syncService },
        { provide: SyncBootstrapService, useValue: syncBootstrapService },
        { provide: DeviceAccessService, useValue: deviceAccess },
        { provide: TenantResolverService, useValue: resolver },
        { provide: TenantConnectionManager, useValue: connectionManager },
        { provide: TenantRbacService, useValue: tenantRbac },
        { provide: AUTH_CONFIGURATION, useValue: authConfiguration },
        { provide: SYNC_CONFIGURATION, useValue: loadSyncConfiguration({}) },
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

  it('requires tenant authentication and rejects platform tokens', async () => {
    await request(app.getHttpServer()).get('/api/v1/sync/pull').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/sync/pull')
      .set('Authorization', `Bearer ${await issueToken('platform')}`)
      .expect(401);
    expect(connectionManager.getDataSource).not.toHaveBeenCalled();
  });

  it('requires sync permissions and additionally requires Patta creation permission for push', async () => {
    const viewToken = await issueToken('tenant', viewUserId);
    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ device_id: deviceId, events: [] })
      .expect(403);

    const pushOnlyToken = await issueToken('tenant', pushOnlyUserId);
    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${pushOnlyToken}`)
      .send({ device_id: deviceId, events: [] })
      .expect(403);
    expect(syncService.push).not.toHaveBeenCalled();
  });

  it('validates and authorizes a device before push and pull service calls', async () => {
    const token = await issueToken('tenant', syncUserId);
    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'other-tenant.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, events: [] })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: foreignDeviceId, events: [] })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, company_id: companyId, events: [] })
      .expect(400);
    expect(syncService.push).not.toHaveBeenCalled();

    const pullResponse = await request(app.getHttpServer())
      .get('/api/v1/sync/pull')
      .query({ device_id: deviceId, cursor: '0', limit: '10' })
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(pullResponse.body).toEqual({ changes: [], next_cursor: '0', has_more: false });
    expect(deviceAccess.assertActiveDevice).toHaveBeenCalledWith(companyId, deviceId);
    expect(syncService.pull).toHaveBeenCalledWith(
      tenantDataSource,
      '0',
      10,
    );
  });

  it('returns independent outcomes for valid, conflicting and valid batch events', async () => {
    const token = await issueToken('tenant', syncUserId);
    const outcomes = {
      results: [
        { event_id: '11111111-1111-4111-8111-111111111111', status: 'SYNCED' },
        { event_id: '22222222-2222-4222-8222-222222222222', status: 'CONFLICT' },
        { event_id: '33333333-3333-4333-8333-333333333333', status: 'SYNCED' },
      ],
    };
    syncService.push.mockResolvedValueOnce(outcomes);

    const response = await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, events: [{}, {}, {}] })
      .expect(200);
    expect(response.body).toEqual(outcomes);
    expect(syncService.push).toHaveBeenCalledOnce();
  });

  it('rejects an unknown event envelope field and invalid device UUID', async () => {
    const token = await issueToken('tenant', syncUserId);
    await request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId, tenant_id: companyId, events: [] })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/sync/pull')
      .query({ device_id: 'invalid', cursor: '0' })
      .set('Host', 'atlas-textile.erp.example.test')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(syncService.push).not.toHaveBeenCalled();
  });

  it('creates, pages and completes only the validated device bootstrap session', async () => {
    const token = await issueToken('tenant', viewUserId);
    const host = 'atlas-textile.erp.example.test';
    const sessionIdValue = '88888888-8888-4888-8888-888888888888';

    const created = await request(app.getHttpServer())
      .post('/api/v1/sync/bootstrap')
      .set('Host', host)
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId })
      .expect(201);
    expect(created.body).toMatchObject({ id: sessionIdValue, watermark: '12840' });
    expect(syncBootstrapService.create).toHaveBeenCalledWith(tenantDataSource, deviceId);

    const page = await request(app.getHttpServer())
      .get(`/api/v1/sync/bootstrap/${sessionIdValue}`)
      .query({ device_id: deviceId, after: '9007199254740992', limit: '10' })
      .set('Host', host)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(page.body).toMatchObject({ session_id: sessionIdValue, watermark: '12840' });
    expect(syncBootstrapService.page).toHaveBeenCalledWith(
      tenantDataSource,
      deviceId,
      sessionIdValue,
      '9007199254740992',
      10,
    );

    const completed = await request(app.getHttpServer())
      .post(`/api/v1/sync/bootstrap/${sessionIdValue}/complete`)
      .set('Host', host)
      .set('Authorization', `Bearer ${token}`)
      .send({ device_id: deviceId })
      .expect(200);
    expect(completed.body).toEqual({ session_id: sessionIdValue, status: 'COMPLETED' });
    expect(syncBootstrapService.complete).toHaveBeenCalledWith(
      tenantDataSource,
      deviceId,
      sessionIdValue,
    );
  });
});
