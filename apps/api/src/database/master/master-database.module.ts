import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  createMasterDataSourceOptions,
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
      useFactory: () => createMasterDataSourceOptions(process.env),
    }),
  ],
  exports: [TypeOrmModule],
})
export class MasterDatabaseModule {}
