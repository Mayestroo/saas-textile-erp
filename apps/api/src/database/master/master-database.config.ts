import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataSourceOptions } from 'typeorm';
import { CompanyEntity } from '../../master/companies/company.entity.js';
import { DeviceEntity } from '../../master/devices/device.entity.js';
import { LicenseEntity } from '../../master/licenses/license.entity.js';
import { PlatformPermissionEntity } from '../../master/platform-rbac/platform-permission.entity.js';
import { PlatformRoleEntity } from '../../master/platform-rbac/platform-role.entity.js';
import { PlatformRolePermissionEntity } from '../../master/platform-rbac/platform-role-permission.entity.js';
import { PlatformUserRoleEntity } from '../../master/platform-rbac/platform-user-role.entity.js';
import { PlatformUserEntity } from '../../master/platform-users/platform-user.entity.js';

export const MASTER_DATA_SOURCE_NAME = 'master';
export const MASTER_MIGRATIONS_TABLE = 'master_typeorm_migrations';

interface MasterDatabaseCredentials {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

const MASTER_ENTITY_CLASSES = [
  CompanyEntity,
  PlatformUserEntity,
  PlatformRoleEntity,
  PlatformPermissionEntity,
  PlatformRolePermissionEntity,
  PlatformUserRoleEntity,
  DeviceEntity,
  LicenseEntity,
];

const MASTER_MIGRATION_GLOB = fileURLToPath(
  new URL('../../../../../database/master-migrations/*.js', import.meta.url),
);
const REQUIRED_MASTER_ENVIRONMENT_VARIABLES = [
  'MASTER_DB_HOST',
  'MASTER_DB_PORT',
  'MASTER_DB_NAME',
  'MASTER_DB_USER',
  'MASTER_DB_PASSWORD',
] as const;

function requiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required Master Database environment variable: ${key}`);
  }

  return value.trim();
}

function requiredPassword(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required Master Database environment variable: ${key}`);
  }

  return value;
}

function parseMasterDatabaseCredentials(config: Record<string, unknown>): MasterDatabaseCredentials {
  const missingVariables = REQUIRED_MASTER_ENVIRONMENT_VARIABLES.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missingVariables.length > 0) {
    throw new Error(
      `Missing required Master Database environment variables: ${missingVariables.join(', ')}`,
    );
  }

  const host = requiredString(config, 'MASTER_DB_HOST');
  const database = requiredString(config, 'MASTER_DB_NAME');
  const username = requiredString(config, 'MASTER_DB_USER');
  const password = requiredPassword(config, 'MASTER_DB_PASSWORD');
  const rawPort = requiredString(config, 'MASTER_DB_PORT');
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MASTER_DB_PORT must be an integer between 1 and 65535');
  }

  return { host, port, database, username, password };
}

export function validateMasterDatabaseEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const credentials = parseMasterDatabaseCredentials(config);

  return {
    ...config,
    MASTER_DB_HOST: credentials.host,
    MASTER_DB_PORT: String(credentials.port),
    MASTER_DB_NAME: credentials.database,
    MASTER_DB_USER: credentials.username,
    MASTER_DB_PASSWORD: credentials.password,
  };
}

export function createMasterDataSourceOptions(config: Record<string, unknown>): DataSourceOptions {
  const credentials = parseMasterDatabaseCredentials(config);

  return {
    type: 'postgres',
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    username: credentials.username,
    password: credentials.password,
    entities: MASTER_ENTITY_CLASSES,
    migrations: [MASTER_MIGRATION_GLOB],
    migrationsTableName: MASTER_MIGRATIONS_TABLE,
    synchronize: false,
    migrationsRun: false,
    logging: false,
  };
}

export function createTestMasterDataSourceOptions(env: NodeJS.ProcessEnv): DataSourceOptions {
  const testDatabaseName = requiredString(env, 'TEST_MASTER_DB_NAME');
  if (!testDatabaseName.endsWith('_test')) {
    throw new Error('TEST_MASTER_DB_NAME must end with _test; refusing database migration or revert');
  }

  return createMasterDataSourceOptions({
    MASTER_DB_HOST: requiredString(env, 'TEST_MASTER_DB_HOST'),
    MASTER_DB_PORT: requiredString(env, 'TEST_MASTER_DB_PORT'),
    MASTER_DB_NAME: testDatabaseName,
    MASTER_DB_USER: requiredString(env, 'TEST_MASTER_DB_USER'),
    MASTER_DB_PASSWORD: requiredPassword(env, 'TEST_MASTER_DB_PASSWORD'),
  });
}

export function resolveApiEnvFiles(cwd = process.cwd()): string[] {
  return [resolve(cwd, '.env'), resolve(cwd, 'apps/api/.env')];
}
