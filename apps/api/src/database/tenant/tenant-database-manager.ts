import { randomBytes } from 'node:crypto';
import { OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  createTenantRuntimeDataSourceOptions,
  TenantDatabaseCredentials,
} from './tenant-database.config.js';
import {
  assertTenantDatabaseName,
  assertTenantRuntimeRoleName,
  createTenantDatabaseName,
  createTenantRuntimeRoleName,
  TenantDatabaseNameMode,
} from './tenant-database-names.js';

const RUNTIME_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{64}$/;

export interface TenantDatabaseManagerOptions {
  provisioner: TenantDatabaseCredentials;
  masterDataSource: DataSource;
  runtimeHost: string;
  runtimePort: number;
  mode?: TenantDatabaseNameMode;
}

export interface TenantRuntimeSecret {
  username: string;
  password: string;
}

interface ExistingDatabaseRow {
  owner: string;
}

interface ExistingRoleRow {
  rolname: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function createTenantRuntimeSecret(companyId: string): TenantRuntimeSecret {
  return {
    username: createTenantRuntimeRoleName(companyId),
    password: randomBytes(48).toString('base64url'),
  };
}

function validateRuntimeSecret(companyId: string, secret: TenantRuntimeSecret): void {
  const expectedUsername = createTenantRuntimeRoleName(companyId);
  assertTenantRuntimeRoleName(secret.username);
  if (secret.username !== expectedUsername || !RUNTIME_PASSWORD_PATTERN.test(secret.password)) {
    throw new Error('Tenant runtime credential does not match the generated company identity');
  }
}

export class TenantDatabaseManager implements OnModuleDestroy {
  private readonly mode: TenantDatabaseNameMode;
  private provisionerDataSourcePromise: Promise<DataSource> | undefined;
  private isClosed = false;

  constructor(private readonly options: TenantDatabaseManagerOptions) {
    this.mode = options.mode ?? 'production';
    const masterOptions = options.masterDataSource.options;
    if (masterOptions.type !== 'postgres' || masterOptions.database === options.provisioner.database) {
      throw new Error('Master and tenant provisioner connections must use separate PostgreSQL databases');
    }
    if (!Number.isInteger(options.runtimePort) || options.runtimePort < 1 || options.runtimePort > 65_535) {
      throw new Error('TENANT_DB_PORT must be an integer between 1 and 65535');
    }
  }

  expectedDatabaseName(companyId: string): string {
    return createTenantDatabaseName(companyId, this.mode);
  }

  createSecret(companyId: string): TenantRuntimeSecret {
    return createTenantRuntimeSecret(companyId);
  }

  sensitiveValues(): string[] {
    return [this.options.provisioner.password];
  }

  runtimeCredentials(
    companyId: string,
    databaseName: string,
    secret: TenantRuntimeSecret,
  ): TenantDatabaseCredentials {
    assertTenantDatabaseName(databaseName, this.mode);
    if (databaseName !== this.expectedDatabaseName(companyId)) {
      throw new Error('Tenant database name does not match the authenticated company');
    }
    validateRuntimeSecret(companyId, secret);
    return {
      host: this.options.runtimeHost,
      port: this.options.runtimePort,
      database: databaseName,
      username: secret.username,
      password: secret.password,
    };
  }

  async ensureDatabase(
    companyId: string,
    databaseName: string,
    secret: TenantRuntimeSecret,
  ): Promise<void> {
    const expectedDatabaseName = this.expectedDatabaseName(companyId);
    assertTenantDatabaseName(databaseName, this.mode);
    if (databaseName !== expectedDatabaseName) {
      throw new Error('Company tenant database name does not match its generated identity');
    }
    validateRuntimeSecret(companyId, secret);

    const admin = await this.getProvisionerDataSource();
    await this.applyProvisionerDatabaseAccessPolicy(admin);
    await this.ensureRole(admin, secret);
    await this.ensureDatabaseExists(admin, databaseName);
    await this.applyTenantDatabaseAccessPolicy(admin, databaseName, secret.username);
  }

  migrationCredentials(databaseName: string): TenantDatabaseCredentials {
    assertTenantDatabaseName(databaseName, this.mode);
    return { ...this.options.provisioner, database: databaseName };
  }

  async grantRuntimePrivileges(
    companyId: string,
    databaseName: string,
    secret: TenantRuntimeSecret,
  ): Promise<void> {
    assertTenantDatabaseName(databaseName, this.mode);
    assertTenantRuntimeRoleName(secret.username);
    validateRuntimeSecret(companyId, secret);

    const dataSource = new DataSource(
      createTenantRuntimeDataSourceOptions(this.migrationCredentials(databaseName)),
    );
    try {
      await dataSource.initialize();
      const role = quoteIdentifier(secret.username);
      await dataSource.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await dataSource.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
          "users", "roles", "permissions", "role_permissions", "auth_sessions", "login_rate_limits",
          "models", "model_operations", "model_operation_prices", "audit_log",
          "workers", "worker_badge_history"
         TO ${role}`,
      );
      await dataSource.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await dataSource.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(this.options.provisioner.username)} IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      );
      await dataSource.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(this.options.provisioner.username)} IN SCHEMA public
         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`,
      );
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
  }

  async testRuntimeConnection(credentials: TenantDatabaseCredentials): Promise<void> {
    const dataSource = new DataSource(createTenantRuntimeDataSourceOptions(credentials));
    try {
      await dataSource.initialize();
      const result: Array<{ database_name: string; role_name: string }> = await dataSource.query(
        'SELECT current_database() AS database_name, current_user AS role_name',
      );
      if (
        result[0]?.database_name !== credentials.database ||
        result[0]?.role_name !== credentials.username
      ) {
        throw new Error('Tenant runtime connection identity did not match the requested tenant');
      }
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    const pending = this.provisionerDataSourcePromise;
    this.provisionerDataSourcePromise = undefined;
    if (pending) {
      const dataSource = await pending.catch(() => undefined);
      if (dataSource?.isInitialized) {
        await dataSource.destroy();
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async getProvisionerDataSource(): Promise<DataSource> {
    if (this.isClosed) {
      throw new Error('Tenant database manager is closed');
    }
    if (!this.provisionerDataSourcePromise) {
      const dataSource = new DataSource(createTenantRuntimeDataSourceOptions(this.options.provisioner));
      this.provisionerDataSourcePromise = dataSource.initialize().then(
        () => dataSource,
        (error: unknown) => {
          this.provisionerDataSourcePromise = undefined;
          throw error;
        },
      );
    }

    return this.provisionerDataSourcePromise;
  }

  private async applyProvisionerDatabaseAccessPolicy(dataSource: DataSource): Promise<void> {
    const provisionerDatabase = quoteIdentifier(this.options.provisioner.database);
    const provisionerRole = quoteIdentifier(this.options.provisioner.username);
    const masterDatabase = this.options.masterDataSource.options.database;
    if (typeof masterDatabase !== 'string') {
      throw new Error('Master DataSource database name is unavailable');
    }

    const connectableDatabases: Array<{ datname: string }> = await dataSource.query(
      `SELECT "datname" FROM "pg_catalog"."pg_database"
       WHERE "datallowconn" = true AND "datname" <> $1`,
      [masterDatabase],
    );
    for (const { datname } of connectableDatabases) {
      await dataSource.query(
        `REVOKE CONNECT, TEMP ON DATABASE ${quoteIdentifier(datname)} FROM PUBLIC`,
      );
    }

    await dataSource.query(`REVOKE CONNECT, TEMP ON DATABASE ${provisionerDatabase} FROM PUBLIC`);
    await dataSource.query(`GRANT CONNECT, TEMP ON DATABASE ${provisionerDatabase} TO ${provisionerRole}`);
    await this.options.masterDataSource.query(`
      DO $$
      BEGIN
        EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), current_user);
      END
      $$
    `);
  }

  private async ensureRole(dataSource: DataSource, secret: TenantRuntimeSecret): Promise<void> {
    const rows: ExistingRoleRow[] = await dataSource.query(
      'SELECT "rolname" FROM "pg_catalog"."pg_roles" WHERE "rolname" = $1',
      [secret.username],
    );
    if (rows.length > 0) {
      const memberships: Array<{ member_role: string }> = await dataSource.query(
        `SELECT parent_role."rolname" AS "member_role"
         FROM "pg_catalog"."pg_auth_members" AS membership
         INNER JOIN "pg_catalog"."pg_roles" AS parent_role ON parent_role."oid" = membership."roleid"
         WHERE membership."member" = (
           SELECT "oid" FROM "pg_catalog"."pg_roles" WHERE "rolname" = $1
         )`,
        [secret.username],
      );
      if (memberships.length > 0) {
        throw new Error('Existing tenant runtime role has unexpected role memberships');
      }
    }

    const role = quoteIdentifier(secret.username);
    const password = `'${secret.password}'`;
    const alterRole = rows.length > 0 ? 'ALTER ROLE' : 'CREATE ROLE';
    await dataSource.query(
      `${alterRole} ${role} WITH LOGIN PASSWORD ${password}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20`,
    );
  }

  private async ensureDatabaseExists(dataSource: DataSource, databaseName: string): Promise<void> {
    const rows: ExistingDatabaseRow[] = await dataSource.query(
      `SELECT pg_catalog.pg_get_userbyid("datdba") AS "owner"
       FROM "pg_catalog"."pg_database" WHERE "datname" = $1`,
      [databaseName],
    );
    if (rows.length > 0) {
      if (rows[0]?.owner !== this.options.provisioner.username) {
        throw new Error('Existing tenant database is not owned by the configured provisioner');
      }
      return;
    }

    await dataSource.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(this.options.provisioner.username)}`,
    );
  }

  private async applyTenantDatabaseAccessPolicy(
    dataSource: DataSource,
    databaseName: string,
    runtimeRoleName: string,
  ): Promise<void> {
    const database = quoteIdentifier(databaseName);
    const runtimeRole = quoteIdentifier(runtimeRoleName);
    await dataSource.query(`REVOKE CONNECT, TEMP ON DATABASE ${database} FROM PUBLIC`);
    await dataSource.query(`GRANT CONNECT ON DATABASE ${database} TO ${runtimeRole}`);
  }
}
