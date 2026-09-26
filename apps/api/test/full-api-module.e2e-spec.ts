import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, it } from 'vitest';

const TEST_DATABASE_KEYS = [
  'TEST_MASTER_DB_HOST',
  'TEST_MASTER_DB_PORT',
  'TEST_MASTER_DB_NAME',
  'TEST_MASTER_DB_USER',
  'TEST_MASTER_DB_PASSWORD',
] as const;
const testDatabaseReady = TEST_DATABASE_KEYS.every((key) => Boolean(process.env[key]?.trim())) &&
  (process.env.TEST_MASTER_DB_NAME ?? '').endsWith('_test');
const appDescribe = testDatabaseReady ? describe : describe.skip;

appDescribe('AppModule authentication dependency graph (e2e)', () => {
  let app: INestApplication | undefined;
  const originalEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    const testHost = process.env.TEST_MASTER_DB_HOST ?? '';
    const testPort = process.env.TEST_MASTER_DB_PORT ?? '';
    const testDatabase = process.env.TEST_MASTER_DB_NAME ?? '';
    const testUser = process.env.TEST_MASTER_DB_USER ?? '';
    const testPassword = process.env.TEST_MASTER_DB_PASSWORD ?? '';
    const overrides: Record<string, string> = {
      MASTER_DB_HOST: testHost,
      MASTER_DB_PORT: testPort,
      MASTER_DB_NAME: testDatabase,
      MASTER_DB_USER: testUser,
      MASTER_DB_PASSWORD: testPassword,
      TENANT_PROVISIONER_DB_HOST: testHost,
      TENANT_PROVISIONER_DB_PORT: testPort,
      TENANT_PROVISIONER_DB_NAME: 'postgres',
      TENANT_PROVISIONER_DB_USER: testUser,
      TENANT_PROVISIONER_DB_PASSWORD: testPassword,
      TENANT_DB_HOST: testHost,
      TENANT_DB_PORT: testPort,
      TENANT_CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
      PLATFORM_JWT_ACCESS_SECRET: 'platform-e2e-access-secret-not-for-production-001',
      PLATFORM_JWT_REFRESH_SECRET: 'platform-e2e-refresh-secret-not-for-production-02',
      TENANT_JWT_ACCESS_SECRET: 'tenant-e2e-access-secret-not-for-production-003',
      TENANT_JWT_REFRESH_SECRET: 'tenant-e2e-refresh-secret-not-for-production-04',
      AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-e2e-bucket-secret-not-for-production-005',
    };

    for (const [key, value] of Object.entries(overrides)) {
      originalEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }

    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    for (const [key, originalValue] of originalEnvironment) {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

  it('starts all platform, tenant, provisioning, and shared-auth modules against the dedicated test database', async () => {
    if (!app) {
      throw new Error('Test application did not initialize');
    }
    await request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
