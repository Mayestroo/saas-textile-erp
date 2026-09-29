import Database from 'better-sqlite3'
import { syncFoundationMigration } from './migrations/001-sync-foundation'
import { tenantOwnershipMigration } from './migrations/002-tenant-ownership'
import { pattaQuantityPrintBatchesMigration } from './migrations/003-patta-quantity-print-batches'
import { pattaSheetsMigration } from './migrations/004-patta-sheets'
import { pattaSheetSyncMetadataMigration } from './migrations/005-patta-sheet-sync-metadata'
import { applySqliteMigrations } from './sqlite-migration-runner'
import type { SqliteMigration } from './sqlite-migration-runner'

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  syncFoundationMigration,
  tenantOwnershipMigration,
  pattaQuantityPrintBatchesMigration,
  pattaSheetsMigration,
  pattaSheetSyncMetadataMigration
]

export { applySqliteMigrations }

export function openSqliteDatabase(
  databasePath: string,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS
): Database.Database {
  const database = new Database(databasePath)

  try {
    database.pragma('foreign_keys = ON')
    database.pragma('journal_mode = WAL')
    database.pragma('busy_timeout = 5000')
    applySqliteMigrations(database, migrations)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
