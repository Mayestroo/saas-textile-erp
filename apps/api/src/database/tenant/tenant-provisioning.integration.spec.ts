import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  type INestApplication,
  type ExecutionContext,
  ValidationPipe,
} from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { verify } from 'argon2';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  AUTH_CONFIGURATION,
  loadAuthConfiguration,
} from '../../common/auth/auth-configuration.js';
import { JwtTokenService } from '../../common/auth/jwt-token.service.js';
import { PasswordPolicy } from '../../common/auth/password-policy.js';
import { PostgresLoginRateLimiter } from '../../common/auth/postgres-login-rate-limiter.js';
import { StructuredApiExceptionFilter } from '../../common/errors/structured-api-exception.filter.js';
import type { TenantAuthenticatedRequest } from '../../common/auth/auth-types.js';
import { TenantPermissions } from '../../common/auth/auth-decorators.js';
import {
  MASTER_DATA_SOURCE_NAME,
  createTestMasterDataSourceOptions,
} from '../master/master-database.config.js';
import {
  createTenantRuntimeDataSourceOptions,
  createTenantMigrationDataSourceOptions,
  createTestTenantProvisionerCredentials,
  TenantDatabaseCredentials,
} from './tenant-database.config.js';
import { TenantDatabaseManager, TenantRuntimeSecret } from './tenant-database-manager.js';
import { TenantMigrationRunner } from './tenant-migration-runner.js';
import { TenantTestDatabaseCleanup } from './tenant-test-database-cleanup.js';
import { AesGcmTenantConnectionSecretCipher } from '../../master/provisioning/aes-gcm-tenant-connection-secret-cipher.js';
import { CompaniesService } from '../../master/companies/companies.service.js';
import { CompaniesController } from '../../master/companies/companies.controller.js';
import { CompanyEntity } from '../../master/companies/company.entity.js';
import { ProvisioningService, ProvisioningSnapshot } from '../../master/provisioning/provisioning.service.js';
import { PlatformAuthController } from '../../master/platform-auth/platform-auth.controller.js';
import { PlatformAuthGuard } from '../../master/platform-auth/platform-auth.guard.js';
import { PlatformAuthService } from '../../master/platform-auth/platform-auth.service.js';
import { PlatformPermissionGuard } from '../../master/platform-auth/platform-permission.guard.js';
import { PlatformSessionRepository } from '../../master/platform-auth/platform-session.repository.js';
import { PlatformRbacService } from '../../master/platform-rbac/platform-rbac.service.js';
import { seedPlatformPermissions } from '../../master/platform-rbac/platform-permission.seed.js';
import { TenantAuthController } from '../../tenant/auth/tenant-auth.controller.js';
import { TenantAuthGuard } from '../../tenant/auth/tenant-auth.guard.js';
import { TenantAuthService } from '../../tenant/auth/tenant-auth.service.js';
import { TenantPermissionGuard } from '../../tenant/auth/tenant-permission.guard.js';
import { TenantSessionRepository } from '../../tenant/auth/tenant-session.repository.js';
import { MasterTenantLookupService } from '../../tenant/tenant-resolver/master-tenant-lookup.service.js';
import { TenantResolverService } from '../../tenant/tenant-resolver/tenant-resolver.service.js';
import { TenantConnectionManager } from '../../tenant/tenant-connection/tenant-connection.manager.js';
import { TenantRbacService } from '../../tenant/rbac/tenant-rbac.service.js';
import { seedDefaultTenantAdmin } from '../../tenant/users/tenant-admin.seed.js';
import { seedTenantPermissions, TENANT_PERMISSION_SEEDS } from '../../tenant/rbac/tenant-permission.seed.js';

class TenantPermissionIntegrationProbe {
  @TenantPermissions('workers.view')
  workersView(): void {}

  @TenantPermissions('companies.create')
  platformPermission(): void {}
}

function tenantExecutionContext(
  requestContext: TenantAuthenticatedRequest,
  handler: () => void,
  controller: new () => TenantPermissionIntegrationProbe,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => requestContext }),
  } as unknown as ExecutionContext;
}

const TEST_DATABASE_VARIABLES = [
  'TEST_MASTER_DB_HOST',
  'TEST_MASTER_DB_PORT',
  'TEST_MASTER_DB_NAME',
  'TEST_MASTER_DB_USER',
  'TEST_MASTER_DB_PASSWORD',
] as const;

const configuredTestVariables = TEST_DATABASE_VARIABLES.filter((key) => Boolean(process.env[key]?.trim()));
if (configuredTestVariables.length > 0 && configuredTestVariables.length !== TEST_DATABASE_VARIABLES.length) {
  const missing = TEST_DATABASE_VARIABLES.filter((key) => !process.env[key]?.trim());
  throw new Error(`Tenant provisioning integration test configuration is incomplete: ${missing.join(', ')}`);
}

const integrationDescribe = configuredTestVariables.length === TEST_DATABASE_VARIABLES.length
  ? describe
  : describe.skip;
const testDataSourceOptions = configuredTestVariables.length === TEST_DATABASE_VARIABLES.length
  ? createTestMasterDataSourceOptions(process.env)
  : undefined;
const testProvisionerCredentials = configuredTestVariables.length === TEST_DATABASE_VARIABLES.length
  ? createTestTenantProvisionerCredentials(process.env)
  : undefined;
const testAuthConfiguration = loadAuthConfiguration({
  PLATFORM_JWT_ACCESS_SECRET: 'platform-access-secret-that-is-long-enough-001',
  PLATFORM_JWT_REFRESH_SECRET: 'platform-refresh-secret-that-is-long-enough-02',
  TENANT_JWT_ACCESS_SECRET: 'tenant-access-secret-that-is-long-enough-0003',
  TENANT_JWT_REFRESH_SECRET: 'tenant-refresh-secret-that-is-long-enough-004',
  AUTH_LOGIN_BUCKET_HASH_SECRET: 'login-bucket-hash-secret-that-is-long-enough',
  AUTH_LOGIN_MAX_ATTEMPTS: '5',
  AUTH_LOGIN_WINDOW_SECONDS: '60',
});

interface CompanyConnectionRow {
  db_name: string;
  db_connection_ciphertext: string | null;
}

interface RuntimeUserRow {
  id: string;
  role_id: string;
  password_hash: string;
}

interface DatabaseRow {
  datname: string;
  oid: string;
}

interface RolePrivilegeRow {
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

function isTenantRuntimeSecret(value: unknown): value is TenantRuntimeSecret {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, 'username') === 'string' &&
    typeof Reflect.get(value, 'password') === 'string'
  );
}

class FailAfterMigrationOnceRunner extends TenantMigrationRunner {
  private shouldFail = true;

  override async run(credentials: TenantDatabaseCredentials): Promise<string | null> {
    const schemaVersion = await super.run(credentials);
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('Injected migration completion interruption');
    }
    return schemaVersion;
  }
}

integrationDescribe(
  configuredTestVariables.length === 0
    ? 'Tenant provisioning integration (BLOCKED: TEST_MASTER_DB_* is not configured)'
    : 'Tenant provisioning integration',
  () => {
    if (!testDataSourceOptions || !testProvisionerCredentials) {
      it.skip('requires all TEST_MASTER_DB_* variables and a dedicated _test database', () => {});
      return;
    }

    let masterDataSource: DataSource;
    let catalogDataSource: DataSource;
    let tenantDatabaseManager: TenantDatabaseManager;
    let migrationRunner: TenantMigrationRunner;
    let cipher: AesGcmTenantConnectionSecretCipher;
    let provisioningService: ProvisioningService;
    let companiesService: CompaniesService;
    let cleanup: TenantTestDatabaseCleanup;
    let tenantConnectionManager: TenantConnectionManager;

    beforeAll(async () => {
      masterDataSource = new DataSource(testDataSourceOptions);
      await masterDataSource.initialize();
      await masterDataSource.runMigrations({ transaction: 'all' });
      catalogDataSource = new DataSource(
        createTenantRuntimeDataSourceOptions(testProvisionerCredentials),
      );
      await catalogDataSource.initialize();
      tenantDatabaseManager = new TenantDatabaseManager({
        provisioner: testProvisionerCredentials,
        masterDataSource,
        runtimeHost: testProvisionerCredentials.host,
        runtimePort: testProvisionerCredentials.port,
        mode: 'test',
      });
      migrationRunner = new TenantMigrationRunner();
      cipher = new AesGcmTenantConnectionSecretCipher(randomBytes(32));
      provisioningService = new ProvisioningService(
        masterDataSource,
        tenantDatabaseManager,
        migrationRunner,
        cipher,
      );
      companiesService = new CompaniesService(
        masterDataSource,
        tenantDatabaseManager,
        provisioningService,
      );
      cleanup = new TenantTestDatabaseCleanup(
        process.env.TEST_MASTER_DB_NAME ?? '',
        testProvisionerCredentials,
      );
      tenantConnectionManager = new TenantConnectionManager(
        new MasterTenantLookupService(masterDataSource),
        tenantDatabaseManager,
        cipher,
      );
    }, 30_000);

    afterAll(async () => {
      await tenantConnectionManager?.close();
      await tenantDatabaseManager?.close();
      if (catalogDataSource?.isInitialized) {
        await catalogDataSource.destroy();
      }
      await cleanup?.cleanup();
      if (masterDataSource?.isInitialized) {
        await masterDataSource.destroy();
      }
    }, 30_000);

    async function createCompany(
      admin?: { email: string; fullName: string; password: string },
      service = companiesService,
    ): Promise<ProvisioningSnapshot> {
      const result = await service.createAndProvision({
        name: `Integration company ${randomUUID()}`,
        slug: `integration-${randomUUID()}`,
        defaultAdmin: admin,
      });
      cleanup.trackCompany(result.companyId);
      return result;
    }

    async function expectDatabaseConstraintViolation(
      operation: Promise<unknown>,
      expectedConstraint: string,
    ): Promise<void> {
      const unexpectedSuccessMessage = `Expected database constraint ${expectedConstraint} to reject the write`;
      try {
        await operation;
        throw new Error(unexpectedSuccessMessage);
      } catch (error) {
        if (error instanceof Error && error.message === unexpectedSuccessMessage) {
          throw error;
        }
        const driverError = error instanceof Error ? Reflect.get(error, 'driverError') : undefined;
        const actualConstraint =
          typeof driverError === 'object' && driverError !== null
            ? Reflect.get(driverError, 'constraint')
            : undefined;
        expect(actualConstraint).toBe(expectedConstraint);
      }
    }

    async function insertPendingCompany(): Promise<string> {
      const id = randomUUID();
      cleanup.trackCompany(id);
      await masterDataSource.manager.insert(CompanyEntity, {
        id,
        name: `Pending company ${id}`,
        slug: `pending-${id}`,
        status: 'PROVISIONING',
        dbName: tenantDatabaseManager.expectedDatabaseName(id),
        dbConnectionCiphertext: null,
        schemaVersion: null,
        timezone: 'Asia/Tashkent',
        provisioningStatus: 'REQUESTED',
        failureStep: null,
        failureReason: null,
        defaultAdminRequired: false,
        lastMigrationAt: null,
      });
      return id;
    }

    async function companyConnection(companyId: string): Promise<{
      databaseName: string;
      credentials: TenantDatabaseCredentials;
    }> {
      const rows: CompanyConnectionRow[] = await masterDataSource.query(
        'SELECT "db_name", "db_connection_ciphertext" FROM "companies" WHERE "id" = $1',
        [companyId],
      );
      const company = rows[0];
      if (!company?.db_connection_ciphertext) {
        throw new Error('Provisioned company is missing encrypted tenant runtime credentials');
      }
      const plaintext = await cipher.decrypt(company.db_connection_ciphertext);
      const parsed: unknown = JSON.parse(plaintext);
      if (!isTenantRuntimeSecret(parsed)) {
        throw new Error('Tenant runtime credentials have an invalid test representation');
      }
      return {
        databaseName: company.db_name,
        credentials: tenantDatabaseManager.runtimeCredentials(companyId, company.db_name, parsed),
      };
    }

    it('creates and migrates a tenant, seeds permissions and an Argon2id administrator idempotently', async () => {
      const admin = {
        email: `owner-${randomUUID()}@example.test`,
        fullName: 'Integration Owner',
        password: 'test-only-secret-password',
      };
      const result = await createCompany(admin);

      expect(result).toMatchObject({
        status: 'ACTIVE',
        provisioningStatus: 'ACTIVE',
        failureStep: null,
        failureReason: null,
        schemaVersion: 'AddWorkersAndBadgeHistory20260926000400',
      });
      expect(JSON.stringify(result)).not.toContain(admin.password);
      await expect(provisioningService.provision(result.companyId)).resolves.toMatchObject({
        status: 'ACTIVE',
        provisioningStatus: 'ACTIVE',
      });

      const { databaseName, credentials } = await companyConnection(result.companyId);
      expect(databaseName).toMatch(/^tenant_test_[0-9a-f]{32}$/);
      const migrationDataSource = new DataSource(
        createTenantMigrationDataSourceOptions(tenantDatabaseManager.migrationCredentials(databaseName)),
      );
      await migrationDataSource.initialize();
      try {
        const tableRows: Array<{ table_name: string }> = await migrationDataSource.query(
          `SELECT "table_name" FROM "information_schema"."tables"
           WHERE "table_schema" = 'public' ORDER BY "table_name"`,
        );
        expect(tableRows.map(({ table_name }) => table_name)).toEqual([
          'audit_log',
          'auth_sessions',
          'login_rate_limits',
          'model_operation_prices',
          'model_operations',
          'models',
          'permissions',
          'role_permissions',
          'roles',
          'tenant_typeorm_migrations',
          'users',
          'worker_badge_history',
          'workers',
        ]);

        await migrationDataSource.undoLastMigration({ transaction: 'all' });
        await migrationDataSource.undoLastMigration({ transaction: 'all' });
        const tablesAfterRevert: Array<{ table_name: string }> = await migrationDataSource.query(
          `SELECT "table_name" FROM "information_schema"."tables"
           WHERE "table_schema" = 'public' AND "table_name" IN
             ('models', 'model_operations', 'model_operation_prices', 'audit_log')`,
        );
        expect(tablesAfterRevert).toHaveLength(0);

        const committedAuthTables: Array<{ table_name: string }> = await migrationDataSource.query(
          `SELECT "table_name" FROM "information_schema"."tables"
           WHERE "table_schema" = 'public' AND "table_name" IN ('auth_sessions', 'login_rate_limits')`,
        );
        expect(committedAuthTables).toHaveLength(2);

        const reappliedMigrations = await migrationDataSource.runMigrations({ transaction: 'all' });
        expect(reappliedMigrations.map(({ name }) => name)).toEqual([
          'AddModelsOperationsAndPriceHistory20260926000300',
          'AddWorkersAndBadgeHistory20260926000400',
        ]);
        await tenantDatabaseManager.grantRuntimePrivileges(
          result.companyId,
          databaseName,
          tenantDatabaseManager.createSecret(result.companyId),
        );
      } finally {
        await migrationDataSource.destroy();
      }

      const runtimeDataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
      await runtimeDataSource.initialize();
      try {
        await expect(
          runtimeDataSource.query('SELECT "name" FROM "tenant_typeorm_migrations"'),
        ).rejects.toThrow(/permission denied/i);

        await seedTenantPermissions(runtimeDataSource);
        await seedTenantPermissions(runtimeDataSource);
        await seedDefaultTenantAdmin(runtimeDataSource, admin);
        await seedDefaultTenantAdmin(runtimeDataSource, admin);

        const permissions: Array<{ count: string }> = await runtimeDataSource.query(
          'SELECT count(*) AS "count" FROM "permissions"',
        );
        const permissionCodes: Array<{ code: string }> = await runtimeDataSource.query(
          'SELECT "code" FROM "permissions" ORDER BY "code"',
        );
        const rolePermissions: Array<{ count: string }> = await runtimeDataSource.query(
          'SELECT count(*) AS "count" FROM "role_permissions"',
        );
        const administratorRole: Array<{ is_system: boolean; permission_count: string }> =
          await runtimeDataSource.query(
            `SELECT role."is_system", count(assignment."permission_id") AS "permission_count"
             FROM "roles" AS role
             LEFT JOIN "role_permissions" AS assignment ON assignment."role_id" = role."id"
             WHERE role."name" = 'Korxona administratori'
             GROUP BY role."id"`,
          );
        const users: RuntimeUserRow[] = await runtimeDataSource.query(
          `SELECT "id", "role_id", "password_hash" FROM "users" WHERE "email" = $1`,
          [admin.email.toLowerCase()],
        );
        expect(Number(permissions[0]?.count)).toBe(TENANT_PERMISSION_SEEDS.length);
        expect(permissionCodes.map(({ code }) => code)).toEqual(
          TENANT_PERMISSION_SEEDS.map(({ code }) => code).sort(),
        );
        expect(Number(rolePermissions[0]?.count)).toBe(TENANT_PERMISSION_SEEDS.length);
        expect(administratorRole).toEqual([
          { is_system: true, permission_count: String(TENANT_PERMISSION_SEEDS.length) },
        ]);
        expect(users).toHaveLength(1);
        expect(users[0]?.password_hash).not.toContain(admin.password);
        expect(await verify(users[0]?.password_hash ?? '', admin.password)).toBe(true);

        const refreshHash = createHash('sha256').update(randomUUID()).digest('hex');
        const sessionExpiry = new Date(Date.now() + 60_000);
        await runtimeDataSource.query(
          `INSERT INTO "auth_sessions" ("user_id", "refresh_token_hash", "expires_at")
           VALUES ($1, $2, $3)`,
          [users[0]?.id, refreshHash, sessionExpiry],
        );
        await expectDatabaseConstraintViolation(
          runtimeDataSource.query(
            `INSERT INTO "auth_sessions" ("user_id", "refresh_token_hash", "expires_at")
             VALUES ($1, $2, $3)`,
            [users[0]?.id, refreshHash, sessionExpiry],
          ),
          'uq_auth_sessions_refresh_token_hash',
        );
        await expectDatabaseConstraintViolation(
          runtimeDataSource.query(
            `INSERT INTO "auth_sessions" ("user_id", "refresh_token_hash", "expires_at")
             VALUES ($1, $2, $3)`,
            [randomUUID(), createHash('sha256').update(randomUUID()).digest('hex'), sessionExpiry],
          ),
          'fk_auth_sessions_user_id',
        );
        await expectDatabaseConstraintViolation(
          runtimeDataSource.query(
            `INSERT INTO "login_rate_limits" (
               "bucket_hash", "window_started_at", "attempt_count", "expires_at"
             ) VALUES ($1, now(), 0, now() + interval '15 minutes')`,
            [createHash('sha256').update(randomUUID()).digest('hex')],
          ),
          'ck_login_rate_limits_attempt_count',
        );

        const rateLimiter = new PostgresLoginRateLimiter(testAuthConfiguration);
        const ipAddress = '198.51.100.38';
        const rateLimitResults = await Promise.all(
          Array.from({ length: 12 }, async () => {
            try {
              await rateLimiter.consume(runtimeDataSource, {
                scope: 'tenant',
                companyId: result.companyId,
                identifier: admin.email,
                ipAddress,
              });
              return 'allowed';
            } catch (error) {
              if (error instanceof HttpException && error.getStatus() === 429) {
                return 'limited';
              }
              throw error;
            }
          }),
        );
        const accountBucketHash = createHmac(
          'sha256',
          testAuthConfiguration.loginRateLimit.hashSecret,
        ).update(`tenant\0${result.companyId}\0account\0${admin.email.toLowerCase()}`)
          .digest('hex');
        const ipBucketHash = createHmac(
          'sha256',
          testAuthConfiguration.loginRateLimit.hashSecret,
        ).update(`tenant\0${result.companyId}\0ip\0${ipAddress}`).digest('hex');
        const limitRows: Array<{ bucket_hash: string; attempt_count: number }> =
          await runtimeDataSource.query(
            `SELECT "bucket_hash", "attempt_count" FROM "login_rate_limits"
             WHERE "bucket_hash" = ANY($1::varchar[]) ORDER BY "bucket_hash"`,
            [[accountBucketHash, ipBucketHash]],
          );
        expect(rateLimitResults.filter((value) => value === 'allowed')).toHaveLength(5);
        expect(rateLimitResults.filter((value) => value === 'limited')).toHaveLength(7);
        expect(limitRows).toHaveLength(2);
        expect(limitRows.map(({ attempt_count }) => attempt_count)).toEqual([12, 12]);

        const restartedLimiter = new PostgresLoginRateLimiter(testAuthConfiguration);
        await expect(restartedLimiter.consume(runtimeDataSource, {
          scope: 'tenant',
          companyId: result.companyId,
          identifier: admin.email,
          ipAddress,
        })).rejects.toMatchObject({ response: { code: 'TOO_MANY_LOGIN_ATTEMPTS' } });
        await runtimeDataSource.query(
          `UPDATE "login_rate_limits" SET "expires_at" = now()
           WHERE "bucket_hash" = ANY($1::varchar[])`,
          [[accountBucketHash, ipBucketHash]],
        );
        await restartedLimiter.consume(runtimeDataSource, {
          scope: 'tenant',
          companyId: result.companyId,
          identifier: admin.email,
          ipAddress,
        });
        const resetRows: Array<{ attempt_count: number }> = await runtimeDataSource.query(
          `SELECT "attempt_count" FROM "login_rate_limits"
           WHERE "bucket_hash" = ANY($1::varchar[]) ORDER BY "bucket_hash"`,
          [[accountBucketHash, ipBucketHash]],
        );
        expect(resetRows.map(({ attempt_count }) => attempt_count)).toEqual([1, 1]);
      } finally {
        await runtimeDataSource.destroy();
      }
    }, 30_000);

    it('persists migration failure and retries without dropping or duplicating completed migrations', async () => {
      const failingService = new ProvisioningService(
        masterDataSource,
        tenantDatabaseManager,
        new FailAfterMigrationOnceRunner(),
        cipher,
      );
      const failingCompaniesService = new CompaniesService(
        masterDataSource,
        tenantDatabaseManager,
        failingService,
      );
      const retryAdmin = {
        email: `retry-${randomUUID()}@example.test`,
        fullName: 'Retry Owner',
        password: 'test-only-retry-password',
      };
      const first = await createCompany(retryAdmin, failingCompaniesService);
      expect(first.status).toBe('FAILED');
      expect(first.provisioningStatus).toBe('FAILED');
      expect(first.failureStep).toBe('RUNNING_MIGRATIONS');
      expect(first.failureReason).toContain('Injected migration completion interruption');
      expect(JSON.stringify(first)).not.toContain(retryAdmin.password);
      await expect(failingService.provision(first.companyId)).rejects.toMatchObject({
        response: { code: 'DEFAULT_ADMIN_INPUT_REQUIRED' },
      });

      const beforeRetry: DatabaseRow[] = await catalogDataSource.query(
        'SELECT "datname", "oid"::text FROM "pg_catalog"."pg_database" WHERE "datname" = $1',
        [tenantDatabaseManager.expectedDatabaseName(first.companyId)],
      );
      expect(beforeRetry).toHaveLength(1);
      const retried = await failingService.provision(first.companyId, retryAdmin);
      expect(retried.status).toBe('ACTIVE');
      expect(retried.failureStep).toBeNull();

      const afterRetry: DatabaseRow[] = await catalogDataSource.query(
        'SELECT "datname", "oid"::text FROM "pg_catalog"."pg_database" WHERE "datname" = $1',
        [tenantDatabaseManager.expectedDatabaseName(first.companyId)],
      );
      expect(afterRetry[0]?.oid).toBe(beforeRetry[0]?.oid);
      const { credentials } = await companyConnection(first.companyId);
      const migrationDataSource = new DataSource(
        createTenantRuntimeDataSourceOptions(tenantDatabaseManager.migrationCredentials(credentials.database)),
      );
      await migrationDataSource.initialize();
      try {
        const migrations: Array<{ name: string }> = await migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations"',
        );
        expect(migrations.map(({ name }) => name)).toEqual([
          'InitialTenantFoundation20260926000000',
          'AddTenantAuthInfrastructure20260926000200',
          'AddModelsOperationsAndPriceHistory20260926000300',
          'AddWorkersAndBadgeHistory20260926000400',
        ]);
        const userCount: Array<{ count: string }> = await migrationDataSource.query(
          'SELECT count(*) AS "count" FROM "users" WHERE "email" = $1',
          [retryAdmin.email.toLowerCase()],
        );
        expect(Number(userCount[0]?.count)).toBe(1);
      } finally {
        await migrationDataSource.destroy();
      }
    }, 30_000);

    it('serializes concurrent provisioning requests for the same company with a pinned advisory-lock session', async () => {
      const companyId = await insertPendingCompany();
      const results = await Promise.all([
        provisioningService.provision(companyId),
        provisioningService.provision(companyId),
      ]);

      expect(results.map(({ status }) => status)).toEqual(['ACTIVE', 'ACTIVE']);
      const databaseRows: DatabaseRow[] = await catalogDataSource.query(
        'SELECT "datname", "oid"::text FROM "pg_catalog"."pg_database" WHERE "datname" = $1',
        [tenantDatabaseManager.expectedDatabaseName(companyId)],
      );
      expect(databaseRows).toHaveLength(1);
      const { credentials } = await companyConnection(companyId);
      const migrationDataSource = new DataSource(
        createTenantRuntimeDataSourceOptions(tenantDatabaseManager.migrationCredentials(credentials.database)),
      );
      await migrationDataSource.initialize();
      try {
        const migrations: Array<{ name: string }> = await migrationDataSource.query(
          'SELECT "name" FROM "tenant_typeorm_migrations"',
        );
        expect(migrations.map(({ name }) => name)).toEqual([
          'InitialTenantFoundation20260926000000',
          'AddTenantAuthInfrastructure20260926000200',
          'AddModelsOperationsAndPriceHistory20260926000300',
          'AddWorkersAndBadgeHistory20260926000400',
        ]);
      } finally {
        await migrationDataSource.destroy();
      }
    }, 30_000);

    it('isolates two tenants and limits each runtime role to its own database', async () => {
      const companyA = await createCompany({
        email: `first-${randomUUID()}@example.test`,
        fullName: 'First Owner',
        password: 'test-only-first-password',
      });
      const companyB = await createCompany({
        email: `second-${randomUUID()}@example.test`,
        fullName: 'Second Owner',
        password: 'test-only-second-password',
      });
      const connectionA = await companyConnection(companyA.companyId);
      const connectionB = await companyConnection(companyB.companyId);
      expect(connectionA.databaseName).not.toBe(connectionB.databaseName);
      const runtimeA = new DataSource(createTenantRuntimeDataSourceOptions(connectionA.credentials));
      await runtimeA.initialize();
      try {
        const userRows: Array<{ count: string }> = await runtimeA.query(
          'SELECT count(*) AS "count" FROM "users"',
        );
        expect(Number(userRows[0]?.count)).toBe(1);
      } finally {
        await runtimeA.destroy();
      }

      const roleRows: RolePrivilegeRow[] = await catalogDataSource.query(
        `SELECT "rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication"
         FROM "pg_catalog"."pg_roles" WHERE "rolname" = $1`,
        [connectionA.credentials.username],
      );
      expect(roleRows).toEqual([
        { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false },
      ]);

      const roleCount: Array<{ count: string }> = await catalogDataSource.query(
        'SELECT count(*) AS "count" FROM "pg_catalog"."pg_roles" WHERE "rolname" = $1',
        [connectionA.credentials.username],
      );
      expect(Number(roleCount[0]?.count)).toBe(1);

      await expectConnectionDenied({ ...connectionA.credentials, database: connectionB.databaseName });
      await expectConnectionDenied({ ...connectionA.credentials, database: process.env.TEST_MASTER_DB_NAME ?? '' });
      await expectConnectionDenied({ ...connectionA.credentials, database: 'postgres' });
      await expectConnectionDenied({ ...connectionA.credentials, database: 'template1' });
    }, 30_000);

    it('reuses healthy cached connections and cleans up failed initialization before retry', async () => {
      const result = await createCompany({
        email: `cache-${randomUUID()}@example.test`,
        fullName: 'Cache Owner',
        password: 'test-only-cache-password',
      });
      const company = await companyConnection(result.companyId);
      const companyRows: CompanyConnectionRow[] = await masterDataSource.query(
        'SELECT "db_name", "db_connection_ciphertext" FROM "companies" WHERE "id" = $1',
        [result.companyId],
      );
      const ciphertext = companyRows[0]?.db_connection_ciphertext;
      if (!ciphertext) {
        throw new Error('Expected stored encrypted tenant credentials');
      }

      const badSecret = {
        username: company.credentials.username,
        password: 'A'.repeat(64),
      };
      await masterDataSource.manager.update(CompanyEntity, { id: result.companyId }, {
        dbConnectionCiphertext: await cipher.encrypt(JSON.stringify(badSecret)),
      });

      const manager = new TenantConnectionManager(
        new MasterTenantLookupService(masterDataSource),
        tenantDatabaseManager,
        cipher,
      );
      await expect(manager.getDataSource(result.companyId)).rejects.toThrow();

      await masterDataSource.manager.update(CompanyEntity, { id: result.companyId }, {
        dbConnectionCiphertext: ciphertext,
      });
      const [first, second] = await Promise.all([
        manager.getDataSource(result.companyId),
        manager.getDataSource(result.companyId),
      ]);
      expect(first).toBe(second);
      expect(first.isInitialized).toBe(true);
      await manager.close();
      expect(first.isInitialized).toBe(false);
    }, 30_000);

    it('creates a company through protected platform auth and logs in its provisioned tenant admin', async () => {
      await seedPlatformPermissions(masterDataSource);
      const passwordPolicy = new PasswordPolicy();
      const jwtTokens = new JwtTokenService();
      const loginRateLimiter = new PostgresLoginRateLimiter(testAuthConfiguration);
      const superadminId = randomUUID();
      const superadminEmail = `superadmin-${randomUUID()}@example.test`;
      const superadminPassword = 'platform-integration-strong-password';
      await masterDataSource.query(
        `INSERT INTO "platform_users" ("id", "email", "password_hash", "status")
         VALUES ($1, $2, $3, 'ACTIVE')`,
        [superadminId, superadminEmail, await passwordPolicy.hash(superadminPassword)],
      );
      await masterDataSource.query(
        `INSERT INTO "platform_user_roles" ("user_id", "role_id")
         SELECT $1, "id" FROM "platform_roles" WHERE "name" = 'Superadmin'`,
        [superadminId],
      );

      const unprivilegedPlatformId = randomUUID();
      const unprivilegedPlatformEmail = `platform-user-${randomUUID()}@example.test`;
      const unprivilegedPlatformPassword = 'platform-unprivileged-password';
      await masterDataSource.query(
        `INSERT INTO "platform_users" ("id", "email", "password_hash", "status")
         VALUES ($1, $2, $3, 'ACTIVE')`,
        [
          unprivilegedPlatformId,
          unprivilegedPlatformEmail,
          await passwordPolicy.hash(unprivilegedPlatformPassword),
        ],
      );

      const jwtTokensConfiguration = testAuthConfiguration;
      const tenantResolver = new TenantResolverService(new MasterTenantLookupService(masterDataSource));
      const tenantSessionRepository = new TenantSessionRepository();
      const platformAuthService = new PlatformAuthService(
        masterDataSource,
        new PlatformSessionRepository(masterDataSource),
        passwordPolicy,
        jwtTokens,
        loginRateLimiter,
        jwtTokensConfiguration,
      );
      const tenantAuthService = new TenantAuthService(
        tenantResolver,
        tenantConnectionManager,
        tenantSessionRepository,
        passwordPolicy,
        jwtTokens,
        loginRateLimiter,
        jwtTokensConfiguration,
      );
      const platformRbacService = new PlatformRbacService(masterDataSource);
      const tenantRbacService = new TenantRbacService();
      const moduleFixture = await Test.createTestingModule({
        controllers: [PlatformAuthController, TenantAuthController, CompaniesController],
        providers: [
          { provide: getDataSourceToken(MASTER_DATA_SOURCE_NAME), useValue: masterDataSource },
          { provide: AUTH_CONFIGURATION, useValue: jwtTokensConfiguration },
          { provide: JwtTokenService, useValue: jwtTokens },
          { provide: TenantResolverService, useValue: tenantResolver },
          { provide: TenantConnectionManager, useValue: tenantConnectionManager },
          { provide: PlatformAuthService, useValue: platformAuthService },
          { provide: TenantAuthService, useValue: tenantAuthService },
          { provide: CompaniesService, useValue: companiesService },
          { provide: PlatformRbacService, useValue: platformRbacService },
          { provide: TenantRbacService, useValue: tenantRbacService },
          { provide: Reflector, useValue: new Reflector() },
          PlatformAuthGuard,
          PlatformPermissionGuard,
          TenantAuthGuard,
          TenantPermissionGuard,
        ],
      }).compile();
      const app: INestApplication = moduleFixture.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
      }));
      app.useGlobalFilters(new StructuredApiExceptionFilter());
      await app.init();

      const companyASlug = `auth-${randomUUID().slice(0, 8)}`;
      const tenantAdminEmail = `tenant-admin-${randomUUID()}@example.test`;
      const tenantAdminPassword = 'tenant-integration-admin-password';
      try {
        const platformLogin = await request(app.getHttpServer())
          .post('/api/v1/platform/auth/login')
          .send({ email: superadminEmail, password: superadminPassword })
          .expect(200);
        const platformTokens = platformLogin.body as {
          access_token: string;
          refresh_token: string;
        };

        const companyAResponse = await request(app.getHttpServer())
          .post('/api/v1/platform/companies')
          .set('Authorization', `Bearer ${platformTokens.access_token}`)
          .send({
            name: 'Authenticated Integration Textile',
            slug: companyASlug,
            defaultAdmin: {
              email: tenantAdminEmail,
              fullName: 'Integration Tenant Admin',
              password: tenantAdminPassword,
            },
          })
          .expect(201);
        const companyA = companyAResponse.body as ProvisioningSnapshot;
        cleanup.trackCompany(companyA.companyId);
        expect(companyA.status).toBe('ACTIVE');
        expect(JSON.stringify(companyAResponse.body)).not.toContain(tenantAdminPassword);

        const tenantLogin = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('Host', `${companyASlug}.erp.example.test`)
          .send({ email: tenantAdminEmail, password: tenantAdminPassword })
          .expect(200);
        const tenantTokens = tenantLogin.body as {
          access_token: string;
          refresh_token: string;
          user: { id: string };
          company: { id: string; slug: string };
        };
        expect(tenantTokens.company).toEqual({ id: companyA.companyId, slug: companyASlug });
        expect(JSON.stringify(tenantLogin.body)).not.toContain(tenantAdminPassword);

        const tenantDataSource = await tenantConnectionManager.getDataSource(companyA.companyId);
        const adminRows: Array<{ id: string; role_id: string }> = await tenantDataSource.query(
          'SELECT "id", "role_id" FROM "users" WHERE lower("email") = $1',
          [tenantAdminEmail.toLowerCase()],
        );
        expect(adminRows).toHaveLength(1);
        expect(await tenantRbacService.hasAllPermissions(
          tenantDataSource,
          tenantTokens.user.id,
          ['workers.view'],
        )).toBe(true);

        await tenantDataSource.query(
          `INSERT INTO "permissions" ("code", "description")
           VALUES ('companies.create', 'test-only invalid tenant permission')
           ON CONFLICT ("code") DO NOTHING`,
        );
        await expect(tenantRbacService.grantRolePermissions(
          tenantDataSource,
          adminRows[0]?.role_id ?? '',
          ['companies.create'],
        )).rejects.toMatchObject({ response: { code: 'TENANT_PERMISSION_NOT_ALLOWED' } });
        expect(await tenantRbacService.hasAllPermissions(
          tenantDataSource,
          tenantTokens.user.id,
          ['companies.create'],
        )).toBe(false);
        expect(await platformRbacService.hasAllPermissions(superadminId, ['workers.view'])).toBe(false);

        const tenantRequest = {
          hostname: `${companyASlug}.erp.example.test`,
          headers: { authorization: `Bearer ${tenantTokens.access_token}` },
        } as unknown as TenantAuthenticatedRequest;
        const tenantAuthGuard = moduleFixture.get(TenantAuthGuard);
        const requestContext = {
          switchToHttp: () => ({ getRequest: () => tenantRequest }),
        } as unknown as ExecutionContext;
        await expect(tenantAuthGuard.canActivate(requestContext)).resolves.toBe(true);

        const probe = new TenantPermissionIntegrationProbe();
        const permissionGuard = moduleFixture.get(TenantPermissionGuard);
        await expect(permissionGuard.canActivate(tenantExecutionContext(
          tenantRequest,
          probe.workersView,
          TenantPermissionIntegrationProbe,
        ))).resolves.toBe(true);
        await expect(permissionGuard.canActivate(tenantExecutionContext(
          tenantRequest,
          probe.platformPermission,
          TenantPermissionIntegrationProbe,
        ))).rejects.toBeInstanceOf(ForbiddenException);

        const companyBSlug = `other-${randomUUID().slice(0, 8)}`;
        const companyBResponse = await request(app.getHttpServer())
          .post('/api/v1/platform/companies')
          .set('Authorization', `Bearer ${platformTokens.access_token}`)
          .send({
            name: 'Second Isolated Integration Textile',
            slug: companyBSlug,
            defaultAdmin: {
              email: tenantAdminEmail,
              fullName: 'Integration Tenant Admin',
              password: tenantAdminPassword,
            },
          })
          .expect(201);
        const companyB = companyBResponse.body as ProvisioningSnapshot;
        cleanup.trackCompany(companyB.companyId);
        expect(companyB.companyId).not.toBe(companyA.companyId);

        const crossTenantRequest = {
          hostname: `${companyBSlug}.erp.example.test`,
          headers: { authorization: `Bearer ${tenantTokens.access_token}` },
        } as unknown as TenantAuthenticatedRequest;
        await expect(tenantAuthGuard.canActivate({
          switchToHttp: () => ({ getRequest: () => crossTenantRequest }),
        } as unknown as ExecutionContext)).rejects.toMatchObject({
          response: { code: 'TENANT_CONTEXT_MISMATCH' },
        });
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Host', `${companyBSlug}.erp.example.test`)
          .send({ refresh_token: tenantTokens.refresh_token })
          .expect(403);
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Host', `${companyASlug}.erp.example.test`)
          .send({ refresh_token: platformTokens.refresh_token })
          .expect(401);

        const tenantRotation = await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Host', `${companyASlug}.erp.example.test`)
          .send({ refresh_token: tenantTokens.refresh_token })
          .expect(200);
        expect(tenantRotation.body.refresh_token).not.toBe(tenantTokens.refresh_token);
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Host', `${companyASlug}.erp.example.test`)
          .send({ refresh_token: tenantTokens.refresh_token })
          .expect(401);

        const unprivilegedLogin = await request(app.getHttpServer())
          .post('/api/v1/platform/auth/login')
          .send({ email: unprivilegedPlatformEmail, password: unprivilegedPlatformPassword })
          .expect(200);
        await request(app.getHttpServer())
          .post('/api/v1/platform/companies')
          .set('Authorization', `Bearer ${unprivilegedLogin.body.access_token}`)
          .send({ name: 'Forbidden Platform Company', slug: `forbidden-${randomUUID().slice(0, 8)}` })
          .expect(403);

        const platformRotation = await request(app.getHttpServer())
          .post('/api/v1/platform/auth/refresh')
          .send({ refresh_token: platformTokens.refresh_token })
          .expect(200);
        expect(platformRotation.body.refresh_token).not.toBe(platformTokens.refresh_token);
        await request(app.getHttpServer())
          .post('/api/v1/platform/auth/refresh')
          .send({ refresh_token: platformTokens.refresh_token })
          .expect(401);
        await request(app.getHttpServer())
          .post('/api/v1/platform/companies')
          .set('Authorization', `Bearer ${platformRotation.body.access_token}`)
          .send({ name: 'Revoked Platform Session', slug: `revoked-${randomUUID().slice(0, 8)}` })
          .expect(401);
        await request(app.getHttpServer())
          .post('/api/v1/platform/companies')
          .set('Authorization', `Bearer ${tenantTokens.access_token}`)
          .send({ name: 'Tenant Cannot Create Platform Company', slug: `tenant-${randomUUID().slice(0, 8)}` })
          .expect(401);
      } finally {
        await app.close();
      }
    }, 120_000);

    it('refuses test cleanup configuration without the required test suffix', () => {
      expect(
        () =>
          new TenantTestDatabaseCleanup('textile_master', testProvisionerCredentials),
      ).toThrow('TEST_MASTER_DB_NAME must end with _test');
    });

    async function expectConnectionDenied(credentials: TenantDatabaseCredentials): Promise<void> {
      const dataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
      try {
        await expect(dataSource.initialize()).rejects.toThrow(/permission denied for database/i);
      } finally {
        if (dataSource.isInitialized) {
          await dataSource.destroy();
        }
      }
    }
  },
);
