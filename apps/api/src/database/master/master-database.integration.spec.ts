import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
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
      ]);
      expect(await hasCompanyTable()).toBe(true);
    });
  },
);
