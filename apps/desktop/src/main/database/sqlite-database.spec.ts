import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applySqliteMigrations, openSqliteDatabase } from './sqlite-database'
import type { SqliteMigration } from './sqlite-migration-runner'

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-sqlite-'))
  temporaryDirectories.push(directory)
  return join(directory, 'desktop.sqlite')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Electron SQLite startup', () => {
  it('opens a durable database, applies its versioned schema, and enables safe pragmas', () => {
    const databasePath = temporaryDatabasePath()
    const database = openSqliteDatabase(databasePath)
    try {
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(database.pragma('busy_timeout', { simple: true })).toBe(5_000)
      expect(database.pragma('user_version', { simple: true })).toBe(2)
      expect(
        database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
      ).toEqual([
        { version: 1, name: 'sync-foundation' },
        { version: 2, name: 'tenant-ownership' }
      ])
      expect(
        database.prepare(`SELECT value FROM sync_state WHERE key = 'last_server_cursor'`).get()
      ).toBeUndefined()
      expect(
        database
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_queue'`)
          .get()
      ).toEqual({ name: 'sync_queue' })
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_database_identity'`
          )
          .get()
      ).toEqual({ name: 'tenant_database_identity' })
    } finally {
      database.close()
    }
  })

  it('rolls back a failed migration without erasing prior versions or leaving half its DDL', () => {
    const database = new Database(temporaryDatabasePath())
    const migrations: readonly SqliteMigration[] = [
      {
        version: 1,
        name: 'foundation',
        up: (connection) =>
          connection.exec('CREATE TABLE durable_before_failure (id TEXT PRIMARY KEY)')
      },
      {
        version: 2,
        name: 'interrupted-upgrade',
        up: (connection) => {
          connection.exec('CREATE TABLE partial_upgrade (id TEXT PRIMARY KEY)')
          throw new Error('injected migration interruption')
        }
      }
    ]

    try {
      expect(() => applySqliteMigrations(database, migrations)).toThrow(
        'injected migration interruption'
      )
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_before_failure'`
          )
          .get()
      ).toEqual({ name: 'durable_before_failure' })
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_upgrade'`
          )
          .get()
      ).toBeUndefined()
      expect(
        database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
      ).toEqual([{ version: 1, name: 'foundation' }])
      expect(database.pragma('user_version', { simple: true })).toBe(1)
    } finally {
      database.close()
    }
  })
})
