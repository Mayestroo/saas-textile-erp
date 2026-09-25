import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, MigrationInterface } from 'typeorm';
import { seedPlatformPermissions } from '../../master/platform-rbac/platform-permission.seed.js';
import { MasterDatabaseModule } from './master-database.module.js';
import { MASTER_DATA_SOURCE_NAME, MASTER_MIGRATIONS_TABLE } from './master-database.config.js';
import { Module } from '@nestjs/common';

type MasterDatabaseCommand = 'migrate' | 'revert' | 'show' | 'seed';

interface ExecutedMigrationRow {
  name: string;
}

@Module({ imports: [MasterDatabaseModule] })
class MasterDatabaseCliModule {}

function isMasterDatabaseCommand(value: string | undefined): value is MasterDatabaseCommand {
  return value === 'migrate' || value === 'revert' || value === 'show' || value === 'seed';
}

function migrationName(migration: MigrationInterface): string {
  return migration.name ?? migration.constructor.name;
}

async function showMigrations(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    const hasMigrationTable = await queryRunner.hasTable(MASTER_MIGRATIONS_TABLE);
    const executedRows: ExecutedMigrationRow[] = hasMigrationTable
      ? await queryRunner.query(
          `SELECT "name" FROM "${MASTER_MIGRATIONS_TABLE}" ORDER BY "timestamp"`,
        )
      : [];
    const executedNames = new Set(executedRows.map(({ name }) => name));

    if (dataSource.migrations.length === 0) {
      console.log('No Master migrations are registered.');
      return;
    }

    for (const migration of dataSource.migrations) {
      const state = executedNames.has(migrationName(migration)) ? 'EXECUTED' : 'PENDING';
      console.log(`${state} ${migrationName(migration)}`);
    }
  } finally {
    await queryRunner.release();
  }
}

async function executeCommand(command: MasterDatabaseCommand): Promise<void> {
  const app = await NestFactory.createApplicationContext(MasterDatabaseCliModule, { logger: false });
  try {
    const dataSource = app.get<DataSource>(getDataSourceToken(MASTER_DATA_SOURCE_NAME));

    if (command === 'migrate') {
      const applied = await dataSource.runMigrations({ transaction: 'all' });
      if (applied.length === 0) {
        console.log('No pending Master migrations.');
      } else {
        for (const migration of applied) {
          console.log(`APPLIED ${migration.name}`);
        }
      }
      return;
    }

    if (command === 'revert') {
      await dataSource.undoLastMigration({ transaction: 'all' });
      console.log('Last Master migration reverted.');
      return;
    }

    if (command === 'show') {
      await showMigrations(dataSource);
      return;
    }

    await seedPlatformPermissions(dataSource);
    console.log('Platform permissions and Superadmin role seeded.');
  } finally {
    await app.close();
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const password = process.env.MASTER_DB_PASSWORD;
  return password ? message.replaceAll(password, '[redacted]') : message;
}

const command = process.argv[2];
if (!isMasterDatabaseCommand(command)) {
  console.error('Usage: node master-database.cli.js <migrate|revert|show|seed>');
  process.exitCode = 1;
} else {
  try {
    await executeCommand(command);
  } catch (error) {
    console.error(`Master database command failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
