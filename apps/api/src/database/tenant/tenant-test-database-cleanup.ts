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
  isTestTenantDatabaseName,
  normalizeCompanyUuid,
} from './tenant-database-names.js';

function quoteGeneratedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export class TenantTestDatabaseCleanup {
  private readonly generatedCompanyIds = new Set<string>();

  constructor(
    private readonly testMasterDatabaseName: string,
    private readonly provisionerCredentials: TenantDatabaseCredentials,
  ) {
    if (!testMasterDatabaseName.endsWith('_test')) {
      throw new Error('TEST_MASTER_DB_NAME must end with _test; refusing tenant database cleanup');
    }
    if (provisionerCredentials.database !== 'postgres') {
      throw new Error('Tenant integration cleanup must connect only to the postgres maintenance database');
    }
  }

  trackCompany(companyId: string): string {
    normalizeCompanyUuid(companyId);
    const databaseName = createTenantDatabaseName(companyId, 'test');
    assertTenantDatabaseName(databaseName, 'test');
    if (!isTestTenantDatabaseName(databaseName)) {
      throw new Error('Generated tenant integration database name is not safe to clean');
    }
    this.generatedCompanyIds.add(companyId.toLowerCase());
    return databaseName;
  }

  async cleanup(): Promise<void> {
    if (this.generatedCompanyIds.size === 0) {
      return;
    }

    const dataSource = new DataSource(createTenantRuntimeDataSourceOptions(this.provisionerCredentials));
    try {
      await dataSource.initialize();
      for (const companyId of this.generatedCompanyIds) {
        const databaseName = createTenantDatabaseName(companyId, 'test');
        const roleName = createTenantRuntimeRoleName(companyId);
        assertTenantDatabaseName(databaseName, 'test');
        assertTenantRuntimeRoleName(roleName);
        if (!isTestTenantDatabaseName(databaseName)) {
          throw new Error('Refusing to clean a database outside the tenant_test_<uuid> allowlist');
        }

        const databaseRows: Array<{ datname: string }> = await dataSource.query(
          'SELECT "datname" FROM "pg_catalog"."pg_database" WHERE "datname" = $1',
          [databaseName],
        );
        if (databaseRows.length > 0) {
          await dataSource.query(
            `DROP DATABASE ${quoteGeneratedIdentifier(databaseName)} WITH (FORCE)`,
          );
        }
        await dataSource.query(`DROP ROLE IF EXISTS ${quoteGeneratedIdentifier(roleName)}`);
      }
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
      this.generatedCompanyIds.clear();
    }
  }
}
