import {
  createMasterDataSourceOptions,
  createTestMasterDataSourceOptions,
} from './master-database.config.js';

const testEnvironment = {
  TEST_MASTER_DB_HOST: 'localhost',
  TEST_MASTER_DB_PORT: '5432',
  TEST_MASTER_DB_NAME: 'textile_master_test',
  TEST_MASTER_DB_USER: 'test_user',
  TEST_MASTER_DB_PASSWORD: 'test_password',
};

describe('Master database configuration', () => {
  it('requires all Master database environment variables with a clear error', () => {
    expect(() => createMasterDataSourceOptions({})).toThrow(
      'Missing required Master Database environment variables: MASTER_DB_HOST, MASTER_DB_PORT, MASTER_DB_NAME, MASTER_DB_USER, MASTER_DB_PASSWORD',
    );
  });

  it('keeps schema synchronization disabled for Nest, migration, and test DataSources', () => {
    const options = createTestMasterDataSourceOptions(testEnvironment);
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
    expect(options.database).toBe('textile_master_test');
  });

  it('refuses test database names that do not end in _test', () => {
    expect(() =>
      createTestMasterDataSourceOptions({ ...testEnvironment, TEST_MASTER_DB_NAME: 'textile_master' }),
    ).toThrow('TEST_MASTER_DB_NAME must end with _test');
  });

  it('uses TEST_MASTER_DB_* rather than MASTER_DB_* values for test connections', () => {
    const options = createTestMasterDataSourceOptions({
      ...testEnvironment,
      MASTER_DB_HOST: 'unused-master-db.invalid',
      MASTER_DB_NAME: 'textile_master',
      MASTER_DB_USER: 'unused_master_user',
      MASTER_DB_PASSWORD: 'unused_master_password',
    });

    expect(options).toMatchObject({
      host: 'localhost',
      database: 'textile_master_test',
      username: 'test_user',
      password: 'test_password',
    });
  });

  it('preserves significant whitespace in database passwords', () => {
    const options = createTestMasterDataSourceOptions({
      ...testEnvironment,
      TEST_MASTER_DB_PASSWORD: ' test_password ',
    });

    if (options.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test DataSource');
    }
    expect(options.password).toBe(' test_password ');
  });

  it('rejects invalid Master database ports', () => {
    expect(() =>
      createMasterDataSourceOptions({
        MASTER_DB_HOST: 'localhost',
        MASTER_DB_PORT: '70000',
        MASTER_DB_NAME: 'textile_master',
        MASTER_DB_USER: 'platform_user',
        MASTER_DB_PASSWORD: 'placeholder',
      }),
    ).toThrow('MASTER_DB_PORT must be an integer between 1 and 65535');
  });
});
