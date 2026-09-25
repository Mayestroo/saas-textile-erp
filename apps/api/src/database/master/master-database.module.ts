import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  createMasterDataSourceOptions,
  MASTER_DATA_SOURCE_NAME,
  resolveApiEnvFiles,
  validateMasterDatabaseEnvironment,
} from './master-database.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: resolveApiEnvFiles(),
      isGlobal: true,
      validate: validateMasterDatabaseEnvironment,
    }),
    TypeOrmModule.forRootAsync({
      name: 'master',
      useFactory: () => ({
        ...createMasterDataSourceOptions(process.env),
        name: MASTER_DATA_SOURCE_NAME,
      }),
    }),
  ],
  exports: [TypeOrmModule],
})
export class MasterDatabaseModule {}
