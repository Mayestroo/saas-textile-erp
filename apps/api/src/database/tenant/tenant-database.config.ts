import { fileURLToPath } from 'node:url';
import { DataSourceOptions } from 'typeorm';

export const TENANT_MIGRATIONS_TABLE = 'tenant_typeorm_migrations';

export interface TenantDatabaseCredentials {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export interface TenantRuntimeDatabaseAddress {
  host: string;
  port: number;
}

const TENANT_MIGRATION_GLOB = fileURLToPath(
  new URL('../../../../../database/tenant-migrations/*.js', import.meta.url),
);

function requiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required tenant database setting: ${key}`);
  }

  return value.trim();
}

function requiredPassword(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required tenant database setting: ${key}`);
  }

  return value;
}

function parsePort(config: Record<string, unknown>, key: string): number {
  const rawPort = requiredString(config, key);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} must be an integer between 1 and 65535`);
  }

  return port;
}

function parseCredentials(
  config: Record<string, unknown>,
  keys: { host: string; port: string; database: string; username: string; password: string },
): TenantDatabaseCredentials {
  return {
    host: requiredString(config, keys.host),
    port: parsePort(config, keys.port),
    database: requiredString(config, keys.database),
    username: requiredString(config, keys.username),
    password: requiredPassword(config, keys.password),
  };
}

export function createTenantProvisionerCredentials(
  config: Record<string, unknown>,
): TenantDatabaseCredentials {
  return parseCredentials(config, {
    host: 'TENANT_PROVISIONER_DB_HOST',
    port: 'TENANT_PROVISIONER_DB_PORT',
    database: 'TENANT_PROVISIONER_DB_NAME',
    username: 'TENANT_PROVISIONER_DB_USER',
    password: 'TENANT_PROVISIONER_DB_PASSWORD',
  });
}

export function createTestTenantProvisionerCredentials(
  config: Record<string, unknown>,
): TenantDatabaseCredentials {
  const testMasterName = requiredString(config, 'TEST_MASTER_DB_NAME');
  if (!testMasterName.endsWith('_test')) {
    throw new Error('TEST_MASTER_DB_NAME must end with _test; refusing tenant database provisioning');
  }

  return {
    host: requiredString(config, 'TEST_MASTER_DB_HOST'),
    port: parsePort(config, 'TEST_MASTER_DB_PORT'),
    database: 'postgres',
    username: requiredString(config, 'TEST_MASTER_DB_USER'),
    password: requiredPassword(config, 'TEST_MASTER_DB_PASSWORD'),
  };
}

function createBaseOptions(credentials: TenantDatabaseCredentials): Pick<
  Extract<DataSourceOptions, { type: 'postgres' }>,
  'type' | 'host' | 'port' | 'database' | 'username' | 'password' | 'synchronize' | 'migrationsRun' | 'logging'
> {
  return {
    type: 'postgres',
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    username: credentials.username,
    password: credentials.password,
    synchronize: false,
    migrationsRun: false,
    logging: false,
  };
}

export function createTenantMigrationDataSourceOptions(
  credentials: TenantDatabaseCredentials,
): DataSourceOptions {
  return {
    ...createBaseOptions(credentials),
    entities: [],
    migrations: [TENANT_MIGRATION_GLOB],
    migrationsTableName: TENANT_MIGRATIONS_TABLE,
  };
}

export function createTenantRuntimeDataSourceOptions(
  credentials: TenantDatabaseCredentials,
): DataSourceOptions {
  return {
    ...createBaseOptions(credentials),
    entities: [],
    migrations: [],
    migrationsTableName: TENANT_MIGRATIONS_TABLE,
  };
}

export function createTenantRuntimeCredentials(
  config: Record<string, unknown>,
  database: string,
  username: string,
  password: string,
): TenantDatabaseCredentials {
  return {
    host: requiredString(config, 'TENANT_DB_HOST'),
    port: parsePort(config, 'TENANT_DB_PORT'),
    database,
    username,
    password,
  };
}

export function createTenantRuntimeDatabaseAddress(
  config: Record<string, unknown>,
): TenantRuntimeDatabaseAddress {
  return {
    host: requiredString(config, 'TENANT_DB_HOST'),
    port: parsePort(config, 'TENANT_DB_PORT'),
  };
}

export function createTestTenantRuntimeCredentials(
  config: Record<string, unknown>,
  database: string,
  username: string,
  password: string,
): TenantDatabaseCredentials {
  const testMasterName = requiredString(config, 'TEST_MASTER_DB_NAME');
  if (!testMasterName.endsWith('_test')) {
    throw new Error('TEST_MASTER_DB_NAME must end with _test; refusing tenant database connection');
  }

  return {
    host: requiredString(config, 'TEST_MASTER_DB_HOST'),
    port: parsePort(config, 'TEST_MASTER_DB_PORT'),
    database,
    username,
    password,
  };
}
