import {
  createTenantProvisionerCredentials,
  createTenantMigrationDataSourceOptions,
  createTenantRuntimeCredentials,
  createTenantRuntimeDataSourceOptions,
  createTestTenantProvisionerCredentials,
} from './tenant-database.config.js';
import {
  assertTenantDatabaseName,
  assertTenantRuntimeRoleName,
  createTenantDatabaseName,
  createTenantRuntimeRoleName,
  isTestTenantDatabaseName,
} from './tenant-database-names.js';

const provisionerEnvironment = {
  TENANT_PROVISIONER_DB_HOST: 'db-admin.internal',
  TENANT_PROVISIONER_DB_PORT: '5432',
  TENANT_PROVISIONER_DB_NAME: 'postgres',
  TENANT_PROVISIONER_DB_USER: 'tenant_provisioner',
  TENANT_PROVISIONER_DB_PASSWORD: 'provisioner-only-secret',
};

const testEnvironment = {
  TEST_MASTER_DB_HOST: 'localhost',
  TEST_MASTER_DB_PORT: '5432',
  TEST_MASTER_DB_NAME: 'textile_master_test',
  TEST_MASTER_DB_USER: 'test_provisioner',
  TEST_MASTER_DB_PASSWORD: 'test_only_secret',
};

describe('Tenant database configuration', () => {
  it('requires a separate explicit provisioner configuration', () => {
    expect(() => createTenantProvisionerCredentials({})).toThrow(
      'Missing required tenant database setting: TENANT_PROVISIONER_DB_HOST',
    );
    expect(createTenantProvisionerCredentials(provisionerEnvironment)).toEqual({
      host: 'db-admin.internal',
      port: 5432,
      database: 'postgres',
      username: 'tenant_provisioner',
      password: 'provisioner-only-secret',
    });
  });

  it('keeps migration and runtime DataSources separate with synchronization disabled', () => {
    const migration = createTenantMigrationDataSourceOptions(
      createTenantProvisionerCredentials(provisionerEnvironment),
    );
    const runtimeCredentials = createTenantRuntimeCredentials(
      { TENANT_DB_HOST: 'tenant.internal', TENANT_DB_PORT: '5433' },
      'tenant_0123456789abcdef0123456789abcdef',
      'tenant_0123456789abcdef0123456789abcdef_app',
      'runtime-secret',
    );
    const runtime = createTenantRuntimeDataSourceOptions(runtimeCredentials);

    expect(migration.synchronize).toBe(false);
    expect(migration.migrationsRun).toBe(false);
    expect(migration.migrationsTableName).toBe('tenant_typeorm_migrations');
    expect(runtime.synchronize).toBe(false);
    expect(runtime.migrationsRun).toBe(false);
    expect(runtime).toMatchObject({
      host: 'tenant.internal',
      database: runtimeCredentials.database,
      username: runtimeCredentials.username,
    });
    expect(runtime.database).not.toBe(migration.database);
  });

  it('uses only TEST_MASTER_DB_* for the test provisioner and requires a _test master database', () => {
    expect(createTestTenantProvisionerCredentials(testEnvironment)).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'postgres',
      username: 'test_provisioner',
      password: 'test_only_secret',
    });
    expect(() =>
      createTestTenantProvisionerCredentials({
        ...testEnvironment,
        TEST_MASTER_DB_NAME: 'textile_master',
      }),
    ).toThrow('TEST_MASTER_DB_NAME must end with _test');
  });

  it('rejects invalid provisioner ports', () => {
    expect(() =>
      createTenantProvisionerCredentials({
        ...provisionerEnvironment,
        TENANT_PROVISIONER_DB_PORT: '70000',
      }),
    ).toThrow('TENANT_PROVISIONER_DB_PORT must be an integer between 1 and 65535');
  });
});

describe('Generated tenant identifiers', () => {
  const companyId = 'de305d54-75b4-431b-adb2-eb6b9e546014';
  const normalizedId = 'de305d5475b4431badb2eb6b9e546014';

  it('derives database and runtime role names only from the company UUID', () => {
    expect(createTenantDatabaseName(companyId)).toBe(`tenant_${normalizedId}`);
    expect(createTenantDatabaseName(companyId, 'test')).toBe(`tenant_test_${normalizedId}`);
    expect(createTenantRuntimeRoleName(companyId)).toBe(`tenant_${normalizedId}_app`);
  });

  it('strictly validates production/test identifiers and test cleanup names', () => {
    expect(assertTenantDatabaseName(`tenant_${normalizedId}`, 'production')).toBe(
      `tenant_${normalizedId}`,
    );
    expect(assertTenantDatabaseName(`tenant_test_${normalizedId}`, 'test')).toBe(
      `tenant_test_${normalizedId}`,
    );
    expect(assertTenantRuntimeRoleName(`tenant_${normalizedId}_app`)).toBe(
      `tenant_${normalizedId}_app`,
    );
    expect(isTestTenantDatabaseName(`tenant_test_${normalizedId}`)).toBe(true);
    expect(isTestTenantDatabaseName(`tenant_${normalizedId}`)).toBe(false);
    expect(() => assertTenantDatabaseName('company; DROP DATABASE postgres', 'production')).toThrow(
      'Tenant database name is not a valid generated identifier',
    );
    expect(() => createTenantDatabaseName('company name')).toThrow('Company ID must be a valid UUID');
  });
});
