import { createHmac, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadAuthConfiguration } from '../../common/auth/auth-configuration.js';
import { PostgresLoginRateLimiter } from '../../common/auth/postgres-login-rate-limiter.js';
import { createTestMasterDataSourceOptions } from './master-database.config.js';

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
  throw new Error(`Master DB integration test configuration is incomplete: ${missing.join(', ')}`);
}

const integrationDescribe = configuredTestVariables.length === TEST_DATABASE_VARIABLES.length
  ? describe
  : describe.skip;
const testDataSourceOptions = configuredTestVariables.length === TEST_DATABASE_VARIABLES.length
  ? createTestMasterDataSourceOptions(process.env)
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

integrationDescribe(
  configuredTestVariables.length === 0
    ? 'Master database integration (BLOCKED: TEST_MASTER_DB_* is not configured)'
    : 'Master database integration',
  () => {
    if (!testDataSourceOptions) {
      it.skip('requires all TEST_MASTER_DB_* variables and a dedicated _test database', () => {});
      return;
    }

    const dataSource = new DataSource(testDataSourceOptions);

    async function hasCompanyTable(): Promise<boolean> {
      const queryRunner = dataSource.createQueryRunner();
      try {
        return await queryRunner.hasTable('companies');
      } finally {
        await queryRunner.release();
      }
    }

    async function createCompany(): Promise<string> {
      const id = randomUUID();
      await dataSource.query(
        `INSERT INTO "companies" ("id", "name", "slug", "status", "db_name")
         VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [id, `Company ${id}`, `company-${id}`, `tenant_${id.replaceAll('-', '')}`],
      );
      return id;
    }

    async function createDevice(companyId: string): Promise<string> {
      const id = randomUUID();
      const seenAt = new Date();
      await dataSource.query(
        `INSERT INTO "devices" (
           "id", "company_id", "installation_id", "hardware_fingerprint_hash",
           "device_name", "status", "first_seen_at", "last_seen_at"
         ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6)`,
        [id, companyId, randomUUID(), `fingerprint-${id}`, 'Test workstation', seenAt],
      );
      return id;
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

    beforeAll(async () => {
      try {
        await dataSource.initialize();
      } catch {
        throw new Error(
          'BLOCKED: local PostgreSQL unavailable or TEST_MASTER_DB_* connection settings are invalid.',
        );
      }

      await dataSource.runMigrations({ transaction: 'all' });
    });

    afterAll(async () => {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    });

    it('applies the initial Master migration', async () => {
      const queryRunner = dataSource.createQueryRunner();
      let table;
      try {
        table = await queryRunner.getTable('companies');
      } finally {
        await queryRunner.release();
      }
      expect(table).not.toBeNull();

      const migrationRows: Array<{ name: string }> = await dataSource.query(
        'SELECT "name" FROM "master_typeorm_migrations"',
      );
      expect(migrationRows.map(({ name }) => name)).toContain('InitialMasterDatabase20260925000000');
      expect(migrationRows.map(({ name }) => name)).toContain(
        'AddCompanyProvisioningFailure20260926000000',
      );
      expect(migrationRows.map(({ name }) => name)).toContain(
        'AddDefaultAdminRequirement20260926000100',
      );
      expect(migrationRows.map(({ name }) => name)).toContain(
        'AddPlatformAuthInfrastructure20260926000200',
      );

      const companyTableQueryRunner = dataSource.createQueryRunner();
      let companyTable;
      try {
        companyTable = await companyTableQueryRunner.getTable('companies');
      } finally {
        await companyTableQueryRunner.release();
      }
      expect(companyTable?.findColumnByName('failure_step')).not.toBeUndefined();
      expect(companyTable?.findColumnByName('failure_reason')).not.toBeUndefined();
      expect(companyTable?.findColumnByName('default_admin_required')).not.toBeUndefined();

      const sessionTable = dataSource.createQueryRunner();
      try {
        const table = await sessionTable.getTable('platform_auth_sessions');
        expect(table?.findColumnByName('refresh_token_hash')).not.toBeUndefined();
        expect(table?.foreignKeys.map(({ name }) => name)).toContain(
          'fk_platform_auth_sessions_user_id',
        );
      } finally {
        await sessionTable.release();
      }
    });

    it('seeds only platform permissions and remains idempotent', async () => {
      const { seedPlatformPermissions } = await import('../../master/platform-rbac/platform-permission.seed.js');
      await seedPlatformPermissions(dataSource);
      await seedPlatformPermissions(dataSource);

      const permissionRows: Array<{ code: string }> = await dataSource.query(
        'SELECT "code" FROM "platform_permissions" ORDER BY "code"',
      );
      expect(permissionRows.map(({ code }) => code)).toEqual([
        'companies.create',
        'companies.migrate',
        'companies.suspend',
        'companies.view',
        'licenses.create',
        'licenses.revoke',
        'licenses.view',
        'platform_users.manage',
      ]);

      const superadminRows: Array<{ permission_count: string }> = await dataSource.query(
        `SELECT count(*) AS "permission_count"
         FROM "platform_role_permissions" AS assignment
         INNER JOIN "platform_roles" AS role ON role."id" = assignment."role_id"
         WHERE role."name" = 'Superadmin'`,
      );
      expect(Number(superadminRows[0]?.permission_count)).toBe(8);
    });

    it('enforces unique company slugs', async () => {
      const id = randomUUID();
      const slug = `unique-${id}`;
      await dataSource.query(
        `INSERT INTO "companies" ("id", "name", "slug", "status", "db_name")
         VALUES ($1, 'First', $2, 'ACTIVE', $3)`,
        [id, slug, `tenant_${id.replaceAll('-', '')}`],
      );

      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "companies" ("name", "slug", "status", "db_name")
           VALUES ('Second', $1, 'ACTIVE', $2)`,
          [slug, `tenant_${randomUUID().replaceAll('-', '')}`],
        ),
        'uq_companies_slug',
      );
    });

    it('enforces case-insensitive unique platform user emails', async () => {
      const email = `User-${randomUUID()}@example.test`;
      await dataSource.query(
        `INSERT INTO "platform_users" ("email", "password_hash", "status")
         VALUES ($1, 'argon-hash-placeholder', 'ACTIVE')`,
        [email],
      );

      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "platform_users" ("email", "password_hash", "status")
           VALUES ($1, 'another-argon-hash', 'ACTIVE')`,
          [email.toUpperCase()],
        ),
        'uq_platform_users_email',
      );
    });

    it('blocks duplicate role-permission assignments', async () => {
      const roleId = randomUUID();
      const permissionId = randomUUID();
      await dataSource.query('INSERT INTO "platform_roles" ("id", "name") VALUES ($1, $2)', [
        roleId,
        `role-${roleId}`,
      ]);
      await dataSource.query(
        'INSERT INTO "platform_permissions" ("id", "code") VALUES ($1, $2)',
        [permissionId, `test.permission.${permissionId}`],
      );
      await dataSource.query(
        'INSERT INTO "platform_role_permissions" ("role_id", "permission_id") VALUES ($1, $2)',
        [roleId, permissionId],
      );

      await expectDatabaseConstraintViolation(
        dataSource.query(
          'INSERT INTO "platform_role_permissions" ("role_id", "permission_id") VALUES ($1, $2)',
          [roleId, permissionId],
        ),
        'pk_platform_role_permissions',
      );
    });

    it('enforces platform session user, refresh hash, and login bucket constraints', async () => {
      const userId = randomUUID();
      await dataSource.query(
        `INSERT INTO "platform_users" ("id", "email", "password_hash", "status")
         VALUES ($1, $2, 'argon-placeholder', 'ACTIVE')`,
        [userId, `auth-${userId}@example.test`],
      );
      const sessionId = randomUUID();
      const refreshHash = 'a'.repeat(64);
      const expiresAt = new Date(Date.now() + 60_000);
      await dataSource.query(
        `INSERT INTO "platform_auth_sessions" ("id", "user_id", "refresh_token_hash", "expires_at")
         VALUES ($1, $2, $3, $4)`,
        [sessionId, userId, refreshHash, expiresAt],
      );

      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "platform_auth_sessions" ("user_id", "refresh_token_hash", "expires_at")
           VALUES ($1, $2, $3)`,
          [userId, refreshHash, expiresAt],
        ),
        'uq_platform_auth_sessions_refresh_token_hash',
      );
      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "platform_auth_sessions" ("user_id", "refresh_token_hash", "expires_at")
           VALUES ($1, $2, $3)`,
          [randomUUID(), 'b'.repeat(64), expiresAt],
        ),
        'fk_platform_auth_sessions_user_id',
      );
      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "platform_login_rate_limits" (
             "bucket_hash", "window_started_at", "attempt_count", "expires_at"
           ) VALUES ($1, now(), 0, now() + interval '15 minutes')`,
          ['c'.repeat(64)],
        ),
        'ck_platform_login_rate_limits_attempt_count',
      );
    });

    it('increments platform login limits atomically under concurrent PostgreSQL attempts', async () => {
      const limiter = new PostgresLoginRateLimiter(testAuthConfiguration);
      const identifier = `concurrent-${randomUUID()}@example.test`;
      const ipAddress = '198.51.100.27';
      const results = await Promise.all(
        Array.from({ length: 20 }, async () => {
          try {
            await limiter.consume(dataSource, {
              scope: 'platform',
              identifier,
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
      const accountHash = createHmac(
        'sha256',
        testAuthConfiguration.loginRateLimit.hashSecret,
      ).update(`platform\0account\0${identifier.toLowerCase()}`).digest('hex');
      const ipHash = createHmac(
        'sha256',
        testAuthConfiguration.loginRateLimit.hashSecret,
      ).update(`platform\0ip\0${ipAddress}`).digest('hex');
      const rows: Array<{ bucket_hash: string; attempt_count: number }> = await dataSource.query(
        `SELECT "bucket_hash", "attempt_count" FROM "platform_login_rate_limits"
         WHERE "bucket_hash" = ANY($1::varchar[]) ORDER BY "bucket_hash"`,
        [[accountHash, ipHash]],
      );

      expect(results.filter((result) => result === 'allowed')).toHaveLength(5);
      expect(results.filter((result) => result === 'limited')).toHaveLength(15);
      expect(rows).toHaveLength(2);
      expect(rows.map(({ attempt_count }) => attempt_count)).toEqual([20, 20]);
    });

    it('enforces the device company foreign key', async () => {
      const deviceId = randomUUID();
      const seenAt = new Date();
      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "devices" (
             "id", "company_id", "installation_id", "hardware_fingerprint_hash",
             "device_name", "status", "first_seen_at", "last_seen_at"
           ) VALUES ($1, $2, $3, 'test-fingerprint', 'Test workstation', 'ACTIVE', $4, $4)`,
          [deviceId, randomUUID(), randomUUID(), seenAt],
        ),
        'fk_devices_company_id',
      );
    });

    it('enforces the license company foreign key', async () => {
      const companyId = await createCompany();
      const deviceId = await createDevice(companyId);
      const issuedAt = new Date();
      const invalidCompanyId = randomUUID();

      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "licenses" (
             "company_id", "device_id", "signed_license", "issued_at", "valid_until",
             "offline_grace_until", "status"
           ) VALUES ($1, $2, 'signed-test-license', $3, $4, $5, 'ACTIVE')`,
          [
            invalidCompanyId,
            deviceId,
            issuedAt,
            new Date(issuedAt.getTime() + 86_400_000),
            new Date(issuedAt.getTime() + 172_800_000),
          ],
        ),
        'fk_licenses_company_id',
      );
    });

    it('enforces the license device foreign key', async () => {
      const companyId = await createCompany();
      const issuedAt = new Date();

      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "licenses" (
             "company_id", "device_id", "signed_license", "issued_at", "valid_until",
             "offline_grace_until", "status"
           ) VALUES ($1, $2, 'signed-test-license', $3, $4, $5, 'ACTIVE')`,
          [
            companyId,
            randomUUID(),
            issuedAt,
            new Date(issuedAt.getTime() + 86_400_000),
            new Date(issuedAt.getTime() + 172_800_000),
          ],
        ),
        'fk_licenses_device_company',
      );
    });

    it('prevents a license from referencing another company’s device', async () => {
      const licenseCompanyId = await createCompany();
      const deviceCompanyId = await createCompany();
      const deviceId = await createDevice(deviceCompanyId);
      const issuedAt = new Date();

      await expectDatabaseConstraintViolation(
        dataSource.query(
          `INSERT INTO "licenses" (
             "company_id", "device_id", "signed_license", "issued_at", "valid_until",
             "offline_grace_until", "status"
           ) VALUES ($1, $2, 'signed-test-license', $3, $4, $5, 'ACTIVE')`,
          [
            licenseCompanyId,
            deviceId,
            issuedAt,
            new Date(issuedAt.getTime() + 86_400_000),
            new Date(issuedAt.getTime() + 172_800_000),
          ],
        ),
        'fk_licenses_device_company',
      );
    });

    it('reverts the initial migration and reapplies it without dropping the shared citext extension', async () => {
      await dataSource.undoLastMigration({ transaction: 'all' });
      await dataSource.undoLastMigration({ transaction: 'all' });
      await dataSource.undoLastMigration({ transaction: 'all' });
      await dataSource.undoLastMigration({ transaction: 'all' });

      const queryRunner = dataSource.createQueryRunner();
      try {
        expect(await queryRunner.hasTable('companies')).toBe(false);
        const extensions: Array<{ extname: string }> = await queryRunner.query(
          'SELECT "extname" FROM "pg_extension" WHERE "extname" = $1',
          ['citext'],
        );
        expect(extensions).toHaveLength(1);
      } finally {
        await queryRunner.release();
      }

      const appliedAgain = await dataSource.runMigrations({ transaction: 'all' });
      expect(appliedAgain.map(({ name }) => name)).toEqual([
        'InitialMasterDatabase20260925000000',
        'AddCompanyProvisioningFailure20260926000000',
        'AddDefaultAdminRequirement20260926000100',
        'AddPlatformAuthInfrastructure20260926000200',
      ]);
      expect(await hasCompanyTable()).toBe(true);
    });
  },
);
