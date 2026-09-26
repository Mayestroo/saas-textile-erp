import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PATTA_CONFIGURATION } from '../../tenant/patta/patta.config.js';
import type { PattaConfiguration } from '../../tenant/patta/patta.config.js';
import {
  createTenantMigrationDataSourceOptions,
  TENANT_MIGRATIONS_TABLE,
  TenantDatabaseCredentials,
} from './tenant-database.config.js';
import { PattaSequenceInitializer } from './patta-sequence.initializer.js';

@Injectable()
export class TenantMigrationRunner {
  constructor(
    private readonly pattaSequenceInitializer: PattaSequenceInitializer,
    @Inject(PATTA_CONFIGURATION) private readonly pattaConfiguration: PattaConfiguration,
  ) {}

  async run(credentials: TenantDatabaseCredentials): Promise<string | null> {
    const dataSource = new DataSource(createTenantMigrationDataSourceOptions(credentials));
    try {
      await dataSource.initialize();
      await dataSource.runMigrations({ transaction: 'all' });
      await this.pattaSequenceInitializer.initialize(
        dataSource,
        this.pattaConfiguration.numberStart,
      );
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
