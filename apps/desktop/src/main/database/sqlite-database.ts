import Database from 'better-sqlite3'
import { syncFoundationMigration } from './migrations/001-sync-foundation'
import { applySqliteMigrations } from './sqlite-migration-runner'
import type { SqliteMigration } from './sqlite-migration-runner'

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [syncFoundationMigration]

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
