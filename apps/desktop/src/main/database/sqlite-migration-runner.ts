import type Database from 'better-sqlite3'

export interface SqliteMigration {
  readonly version: number
  readonly name: string
  up(database: Database.Database): void
}

interface AppliedMigration {
  version: number
  name: string
}

export function applySqliteMigrations(
  database: Database.Database,
  migrations: readonly SqliteMigration[]
): void {
  const orderedMigrations = [...migrations].sort((left, right) => left.version - right.version)
  const knownVersions = new Set<number>()

  for (const migration of orderedMigrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new Error(`SQLite migration version must be a positive safe integer: ${migration.name}`)
    }
    if (migration.name.trim() === '') {
      throw new Error(`SQLite migration ${migration.version} must have a name`)
    }
    if (knownVersions.has(migration.version)) {
      throw new Error(`Duplicate SQLite migration version: ${migration.version}`)
    }
    knownVersions.add(migration.version)
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      applied_at TEXT NOT NULL
    )
  `)

  const appliedMigrations = database
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[]

  for (const [index, applied] of appliedMigrations.entries()) {
    const expected = orderedMigrations[index]
    if (expected === undefined || expected.version !== applied.version) {
      throw new Error(
        `SQLite migration history is not a known prefix at version ${applied.version}`
      )
    }
    if (expected.name !== applied.name) {
      throw new Error(`SQLite migration name mismatch at version ${applied.version}`)
    }
  }

  const currentVersion = appliedMigrations.at(-1)?.version ?? 0
  const databaseVersion = database.pragma('user_version', { simple: true })
  if (databaseVersion !== currentVersion) {
    throw new Error(
      `SQLite user_version ${String(databaseVersion)} does not match migration history ${currentVersion}`
    )
  }

  const insertAppliedMigration = database.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  )

  for (const migration of orderedMigrations.slice(appliedMigrations.length)) {
    const applyOneMigration = database.transaction(() => {
      migration.up(database)
      insertAppliedMigration.run(migration.version, migration.name, new Date().toISOString())
      database.pragma(`user_version = ${migration.version}`)
    })
    applyOneMigration.exclusive()
  }
}
