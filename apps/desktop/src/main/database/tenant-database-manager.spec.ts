import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase } from './sqlite-database'
import { TenantDatabaseManager } from './tenant-database-manager'

const COMPANY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COMPANY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const APPLICATION_ID = 'com.textile.erp.desktop'
const managers: TenantDatabaseManager[] = []
const directories: string[] = []
const openDatabases: Database.Database[] = []

function createManager(): TenantDatabaseManager {
  const userDataPath = mkdtempSync(join(tmpdir(), 'textile-tenant-db-'))
  directories.push(userDataPath)
  const manager = new TenantDatabaseManager(userDataPath)
  managers.push(manager)
  return manager
}

function recordOpenDatabase(database: Database.Database): Database.Database {
  openDatabases.push(database)
  return database
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeActive()
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('TenantDatabaseManager', () => {
  it('uses server company UUID files, isolates A/B rows, and closes A before opening B', () => {
    const manager = createManager()
    const legacyPath = join(manager.userDataPath, 'textile-erp.sqlite')
    const legacyBytes = Buffer.from('legacy database placeholder')
    writeFileSync(legacyPath, legacyBytes)

    const databaseA = manager.activate(COMPANY_A)
    recordOpenDatabase(databaseA)
    databaseA
      .prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('tenant-check', 'A-only', '2026-09-28T00:00:00.000Z')
    expect(manager.activeDatabasePath()).toContain(`tenant-${COMPANY_A}.sqlite`)
    expect(
      databaseA.prepare('SELECT application_id, company_id FROM tenant_database_identity').get()
    ).toEqual({ application_id: APPLICATION_ID, company_id: COMPANY_A })

    const databaseB = manager.activate(COMPANY_B)
    recordOpenDatabase(databaseB)
    expect(databaseA.open).toBe(false)
    expect(manager.activeCompanyId()).toBe(COMPANY_B)
    expect(manager.activeDatabasePath()).toContain(`tenant-${COMPANY_B}.sqlite`)
    expect(databaseB.prepare('SELECT value FROM sync_state WHERE key = ?').get('tenant-check'))
      .toBeUndefined()

    const reopenedA = manager.activate(COMPANY_A)
    recordOpenDatabase(reopenedA)
    expect(databaseB.open).toBe(false)
    expect(reopenedA.prepare('SELECT value FROM sync_state WHERE key = ?').get('tenant-check'))
      .toEqual({ value: 'A-only' })
    expect(readFileSync(legacyPath)).toEqual(legacyBytes)
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('rejects a company UUID path whose database owner belongs to another company', () => {
    const manager = createManager()
    const tenantDirectory = join(manager.userDataPath, 'tenants')
    mkdirSync(tenantDirectory, { recursive: true })
    const fileForB = join(tenantDirectory, `tenant-${COMPANY_B}.sqlite`)
    const database = recordOpenDatabase(openSqliteDatabase(fileForB))
    database
      .prepare(
        `INSERT INTO tenant_database_identity (id, application_id, company_id, schema_version)
         VALUES (1, ?, ?, ?)`
      )
      .run(APPLICATION_ID, COMPANY_A, 2)
    database.close()

    expect(() => manager.activate(COMPANY_B)).toThrow(
      expect.objectContaining({ code: 'TENANT_DATABASE_OWNERSHIP_MISMATCH' })
    )
    expect(manager.activeDatabase()).toBeNull()
    expect(manager.activeCompanyId()).toBeNull()
  })

  it('rejects an unowned populated database without changing its rows', () => {
    const manager = createManager()
    const tenantDirectory = join(manager.userDataPath, 'tenants')
    mkdirSync(tenantDirectory, { recursive: true })
    const fileForB = join(tenantDirectory, `tenant-${COMPANY_B}.sqlite`)
    const database = recordOpenDatabase(openSqliteDatabase(fileForB))
    database
      .prepare(
        `INSERT INTO models (id, name, status, version, created_at, updated_at)
         VALUES ('model-a', 'Atlas', 'ACTIVE', '1', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z')`
      )
      .run()
    database.close()

    expect(() => manager.activate(COMPANY_B)).toThrow(
      expect.objectContaining({ code: 'TENANT_DATABASE_OWNERSHIP_MISSING' })
    )
    const verification = recordOpenDatabase(openSqliteDatabase(fileForB))
    expect(verification.prepare('SELECT id FROM models').all()).toEqual([{ id: 'model-a' }])
    expect(verification.prepare('SELECT * FROM tenant_database_identity').all()).toEqual([])
  })

  it('rejects invalid company UUIDs before constructing a path', () => {
    const manager = createManager()

    expect(() => manager.activate('..\\textile-erp.sqlite')).toThrow(
      expect.objectContaining({ code: 'TENANT_DATABASE_COMPANY_ID_INVALID' })
    )
    expect(manager.activeDatabase()).toBeNull()
  })

  it('rejects a copied tenant file whose internal company identity does not match its target filename', () => {
    const manager = createManager()
    const databaseA = recordOpenDatabase(manager.activate(COMPANY_A))
    databaseA.close()
    const pathA = join(manager.userDataPath, 'tenants', `tenant-${COMPANY_A}.sqlite`)
    const pathB = join(manager.userDataPath, 'tenants', `tenant-${COMPANY_B}.sqlite`)
    copyFileSync(pathA, pathB)

    expect(() => manager.activate(COMPANY_B)).toThrow(
      expect.objectContaining({ code: 'TENANT_DATABASE_OWNERSHIP_MISMATCH' })
    )
  })
})
