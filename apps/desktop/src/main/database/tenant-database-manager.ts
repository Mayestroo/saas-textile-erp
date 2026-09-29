import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { LocalDomainError } from '../local/local-errors'
import { openSqliteDatabase } from './sqlite-database'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DEFAULT_APPLICATION_ID = 'com.textile.erp.desktop'
const BUSINESS_TABLES = [
  'sync_state',
  'workers',
  'worker_badge_history',
  'models',
  'model_operations',
  'model_operation_prices',
  'patta_templates',
  'patta_number_blocks',
  'patta_partiya_number_blocks',
  'patta_print_batches',
  'patta_print_batch_sizes',
  'patta_print_events',
  'patta_hisob',
  'patta_operation_snapshots',
  'patta_sheets',
  'patta_sheet_operation_snapshots',
  'patta_sheet_rows',
  'entry_buffer',
  'sync_queue',
  'sync_conflicts',
  'sync_event_dependencies',
  'sync_tombstones',
  'bootstrap_local_state',
  'bootstrap_items'
] as const

interface TenantDatabaseIdentity {
  application_id: string
  company_id: string
  schema_version: number
}

interface CountRow {
  count: number
}

function countBusinessRows(database: Database.Database): number {
  return BUSINESS_TABLES.reduce((total, table) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow
    return total + row.count
  }, 0)
}

function schemaVersion(database: Database.Database): number {
  const version: unknown = database.pragma('user_version', { simple: true })
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new LocalDomainError(
      'TENANT_DATABASE_SCHEMA_MISMATCH',
      'Mahalliy ma’lumotlar sxemasi mos kelmadi'
    )
  }
  return version
}

export class TenantDatabaseManager {
  private currentDatabase: Database.Database | null = null
  private currentCompanyId: string | null = null
  private currentPath: string | null = null

  constructor(
    readonly userDataPath: string,
    private readonly applicationId = DEFAULT_APPLICATION_ID
  ) {}

  activate(companyId: string): Database.Database {
    if (!UUID_PATTERN.test(companyId)) {
      throw new LocalDomainError(
        'TENANT_DATABASE_COMPANY_ID_INVALID',
        'Korxona identifikatori yaroqsiz'
      )
    }
    const canonicalCompanyId = companyId.toLowerCase()
    if (
      this.currentDatabase?.open &&
      this.currentCompanyId === canonicalCompanyId &&
      this.currentPath !== null
    ) {
      return this.currentDatabase
    }

    this.closeActive()
    const tenantDirectory = join(this.userDataPath, 'tenants')
    mkdirSync(tenantDirectory, { recursive: true })
    const databasePath = join(tenantDirectory, `tenant-${canonicalCompanyId}.sqlite`)
    const database = openSqliteDatabase(databasePath)
    try {
      this.assertOrClaimOwnership(database, canonicalCompanyId)
    } catch (error) {
      database.close()
      throw error
    }

    this.currentDatabase = database
    this.currentCompanyId = canonicalCompanyId
    this.currentPath = databasePath
    return database
  }

  activeDatabase(): Database.Database | null {
    return this.currentDatabase?.open ? this.currentDatabase : null
  }

  activeCompanyId(): string | null {
    return this.activeDatabase() ? this.currentCompanyId : null
  }

  activeDatabasePath(): string | null {
    return this.activeDatabase() ? this.currentPath : null
  }

  closeActive(): void {
    const database = this.currentDatabase
    this.currentDatabase = null
    this.currentCompanyId = null
    this.currentPath = null
    if (database?.open) database.close()
  }

  private assertOrClaimOwnership(database: Database.Database, companyId: string): void {
    const existing = database
      .prepare(
        `SELECT application_id, company_id, schema_version
         FROM tenant_database_identity WHERE id = 1`
      )
      .get() as TenantDatabaseIdentity | undefined

    if (!existing) {
      if (countBusinessRows(database) > 0) {
        throw new LocalDomainError(
          'TENANT_DATABASE_OWNERSHIP_MISSING',
          'Mahalliy ma’lumotlar korxonaga xavfsiz bog‘lanmagan'
        )
      }
      const claimOwnership = database.transaction(() => {
        database
          .prepare(
          `INSERT INTO tenant_database_identity (id, application_id, company_id, schema_version)
             VALUES (1, ?, ?, ?)`
          )
          .run(this.applicationId, companyId, schemaVersion(database))
      })
      claimOwnership.immediate()
      return
    }

    if (existing.application_id !== this.applicationId || existing.company_id !== companyId) {
      throw new LocalDomainError(
        'TENANT_DATABASE_OWNERSHIP_MISMATCH',
        'Mahalliy ma’lumotlar boshqa korxonaga tegishli'
      )
    }

    const currentSchemaVersion = schemaVersion(database)
    if (existing.schema_version > currentSchemaVersion) {
      throw new LocalDomainError(
        'TENANT_DATABASE_SCHEMA_MISMATCH',
        'Mahalliy ma’lumotlar sxemasi mos kelmadi'
      )
    }
    if (existing.schema_version !== currentSchemaVersion) {
      database
        .prepare('UPDATE tenant_database_identity SET schema_version = ? WHERE id = 1')
        .run(currentSchemaVersion)
    }
  }
}
