import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  createTenantMigrationDataSourceOptions,
  TENANT_MIGRATIONS_TABLE,
  TenantDatabaseCredentials,
} from './tenant-database.config.js';

@Injectable()
export class TenantMigrationRunner {
  async run(credentials: TenantDatabaseCredentials): Promise<string | null> {
    const dataSource = new DataSource(createTenantMigrationDataSourceOptions(credentials));
    try {
      await dataSource.initialize();
      await dataSource.runMigrations({ transaction: 'all' });
      const rows: Array<{ name: string }> = await dataSource.query(
        `SELECT "name" FROM "${TENANT_MIGRATIONS_TABLE}" ORDER BY "timestamp" DESC LIMIT 1`,
      );
      return rows[0]?.name ?? null;
    } finally {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    }
  }
}
