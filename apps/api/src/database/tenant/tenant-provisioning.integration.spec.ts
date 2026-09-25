import { randomBytes, randomUUID } from 'node:crypto';
import { verify } from 'argon2';
import { DataSource } from 'typeorm';
import { createTestMasterDataSourceOptions } from '../master/master-database.config.js';
import {
  createTenantRuntimeDataSourceOptions,
  createTestTenantProvisionerCredentials,
  TenantDatabaseCredentials,
} from './tenant-database.config.js';
import { TenantDatabaseManager, TenantRuntimeSecret } from './tenant-database-manager.js';
import { TenantMigrationRunner } from './tenant-migration-runner.js';
import { TenantTestDatabaseCleanup } from './tenant-test-database-cleanup.js';
import { AesGcmTenantConnectionSecretCipher } from '../../master/provisioning/aes-gcm-tenant-connection-secret-cipher.js';
import { CompaniesService } from '../../master/companies/companies.service.js';
import { CompanyEntity } from '../../master/companies/company.entity.js';
import { ProvisioningService, ProvisioningSnapshot } from '../../master/provisioning/provisioning.service.js';
import { MasterTenantLookupService } from '../../tenant/tenant-resolver/master-tenant-lookup.service.js';
import { TenantConnectionManager } from '../../tenant/tenant-connection/tenant-connection.manager.js';
import { seedDefaultTenantAdmin } from '../../tenant/users/tenant-admin.seed.js';
import { seedTenantPermissions, TENANT_PERMISSION_SEEDS } from '../../tenant/rbac/tenant-permission.seed.js';

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
        schemaVersion: 'InitialTenantFoundation20260926000000',
      });
      expect(JSON.stringify(result)).not.toContain(admin.password);
      await expect(provisioningService.provision(result.companyId)).resolves.toMatchObject({
        status: 'ACTIVE',
        provisioningStatus: 'ACTIVE',
      });

      const { databaseName, credentials } = await companyConnection(result.companyId);
      expect(databaseName).toMatch(/^tenant_test_[0-9a-f]{32}$/);
      const migrationDataSource = new DataSource(
        createTenantRuntimeDataSourceOptions(tenantDatabaseManager.migrationCredentials(databaseName)),
      );
      await migrationDataSource.initialize();
      try {
        const tableRows: Array<{ table_name: string }> = await migrationDataSource.query(
          `SELECT "table_name" FROM "information_schema"."tables"
           WHERE "table_schema" = 'public' ORDER BY "table_name"`,
        );
        expect(tableRows.map(({ table_name }) => table_name)).toEqual([
          'permissions',
          'role_permissions',
          'roles',
          'tenant_typeorm_migrations',
          'users',
        ]);
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
        expect(migrations.map(({ name }) => name)).toEqual(['InitialTenantFoundation20260926000000']);
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
        expect(migrations).toHaveLength(1);
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
