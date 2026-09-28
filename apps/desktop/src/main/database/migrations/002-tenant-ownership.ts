import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function createTenantOwnership(database: Database.Database): void {
  database.exec(`
    CREATE TABLE tenant_database_identity (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      application_id TEXT NOT NULL CHECK (length(trim(application_id)) > 0),
      company_id TEXT NOT NULL CHECK (length(company_id) = 36),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0)
    );
  `)
}

export const tenantOwnershipMigration: SqliteMigration = {
  version: 2,
  name: 'tenant-ownership',
  up: createTenantOwnership
}
