import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PattaConfigurationModule } from '../../tenant/patta/patta.config.js';
import { MASTER_DATA_SOURCE_NAME } from '../master/master-database.config.js';
import {
  createTenantProvisionerCredentials,
  createTenantRuntimeDatabaseAddress,
} from './tenant-database.config.js';
import { TenantDatabaseManager } from './tenant-database-manager.js';
import { TenantMigrationRunner } from './tenant-migration-runner.js';
import { PattaSequenceInitializer } from './patta-sequence.initializer.js';

@Module({
  imports: [PattaConfigurationModule],
  providers: [
    {
      provide: TenantDatabaseManager,
      inject: [getDataSourceToken(MASTER_DATA_SOURCE_NAME)],
      useFactory: (masterDataSource: DataSource) => {
        const provisioner = createTenantProvisionerCredentials(process.env);
        const runtimeAddress = createTenantRuntimeDatabaseAddress(process.env);
        if (
          masterDataSource.options.type !== 'postgres' ||
          typeof masterDataSource.options.database !== 'string' ||
          typeof masterDataSource.options.username !== 'string'
        ) {
          throw new Error('Master DataSource must use PostgreSQL credentials');
        }
        return new TenantDatabaseManager({
          provisioner,
          masterDataSource,
          runtimeHost: runtimeAddress.host,
          runtimePort: runtimeAddress.port,
          mode: 'production',
        });
      },
    },
    PattaSequenceInitializer,
    TenantMigrationRunner,
  ],
  exports: [TenantDatabaseManager, TenantMigrationRunner],
})
export class TenantDatabaseModule {}
