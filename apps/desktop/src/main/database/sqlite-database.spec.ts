import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applySqliteMigrations, openSqliteDatabase, SQLITE_MIGRATIONS } from './sqlite-database'
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
      expect(database.pragma('user_version', { simple: true })).toBe(7)
      expect(
        database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
      ).toEqual([
        { version: 1, name: 'sync-foundation' },
        { version: 2, name: 'tenant-ownership' },
        { version: 3, name: 'patta-quantity-print-batches' },
        { version: 4, name: 'patta-sheets' },
        { version: 5, name: 'patta-sheet-sync-metadata' },
        { version: 6, name: 'standalone-patta-entries' },
        { version: 7, name: 'model-account-adjustments' }
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
        database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_account_adjustments'`).get()
      ).toEqual({ name: 'model_account_adjustments' })
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

  it('stores standalone Entries without a Patta and enforces their own quantity and operation model', () => {
    const database = openSqliteDatabase(temporaryDatabasePath())
    const timestamp = '2026-09-29T10:00:00.000Z'
    try {
      database.prepare(`
        INSERT INTO models (id, name, status, version, created_at, updated_at)
        VALUES ('standalone-model', 'Atlas', 'ACTIVE', '1', ?, ?)
      `).run(timestamp, timestamp)
      database.prepare(`
        INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
        VALUES ('standalone-operation', 'standalone-model', 'Tikish', 0, 'ACTIVE', '1', ?, ?)
      `).run(timestamp, timestamp)
      database.prepare(`
        INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
        VALUES ('17', 'Ishchi 17', 'ACTIVE', '1', ?, ?)
      `).run(timestamp, timestamp)
      database.prepare(`
        INSERT INTO patta_sheets (
          id, entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
          entered_at, business_date, version, created_at, updated_at
        ) VALUES ('standalone-1', 'STANDALONE', NULL, 'standalone-model', 'Atlas', 125,
          ?, '2026-09-29', '0', ?, ?)
      `).run(timestamp, timestamp, timestamp)
      database.prepare(`
        INSERT INTO patta_sheet_operation_snapshots (
          id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
          operation_name_snapshot, unit_price_snapshot, sort_order, created_at
        ) VALUES ('standalone-snapshot', 'standalone-1', 'standalone-operation', 'MODEL', NULL,
          'Tikish', '150.00', 0, ?)
      `).run(timestamp)
      database.prepare(`
        INSERT INTO patta_sheet_rows (
          id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
          entered_badge_number, created_at, updated_at
        ) VALUES ('standalone-row', 'standalone-1', 'standalone-snapshot', '17', 125, '00418', ?, ?)
      `).run(timestamp, timestamp)

      expect(database.prepare(`
        SELECT entry_kind, patta_hisob_id, model_id, ish_soni FROM patta_sheets WHERE id = 'standalone-1'
      `).get()).toEqual({ entry_kind: 'STANDALONE', patta_hisob_id: null, model_id: 'standalone-model', ish_soni: 125 })
      expect(() => database.prepare(`
        UPDATE patta_sheet_rows SET quantity_snapshot = 124 WHERE id = 'standalone-row'
      `).run()).toThrow(/quantity must match its Entry quantity/)
      expect(() => database.prepare(`
        UPDATE patta_sheets SET ish_soni = 126 WHERE id = 'standalone-1'
      `).run()).toThrow(/Entry snapshots are immutable/)
      expect(() => database.prepare(`
        INSERT INTO patta_sheet_operation_snapshots (
          id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
          operation_name_snapshot, unit_price_snapshot, sort_order, created_at
        ) VALUES ('invalid-patta-source', 'standalone-1', 'standalone-operation', 'PATTA',
          'missing-patta-operation', 'Tikish', '150.00', 1, ?)
      `).run(timestamp)).toThrow(/operation source or model is invalid/)
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      database.close()
    }
  })

  it('requires local manual adjustments to use an active operation and preserves them as history', () => {
    const database = openSqliteDatabase(temporaryDatabasePath())
    const timestamp = '2026-09-29T10:00:00.000Z'
    try {
      database.prepare(`
        INSERT INTO models (id, name, status, version, created_at, updated_at)
        VALUES ('adjustment-model', 'Atlas', 'ACTIVE', '1', ?, ?)
      `).run(timestamp, timestamp)
      database.prepare(`
        INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
        VALUES ('adjustment-operation-active', 'adjustment-model', 'Tikish', 0, 'ACTIVE', '1', ?, ?),
          ('adjustment-operation-inactive', 'adjustment-model', 'Qadoqlash', 1, 'INACTIVE', '1', ?, ?)
      `).run(timestamp, timestamp, timestamp, timestamp)
      database.prepare(`
        INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
        VALUES ('19', 'Ishchi 19', 'ACTIVE', '1', ?, ?)
      `).run(timestamp, timestamp)

      database.prepare(`
        INSERT INTO model_account_adjustments (
          id, model_id, model_operation_id, worker_id, quantity, unit_price_snapshot,
          entered_at, business_date, version, created_by, created_device_id, created_at, updated_at
        ) VALUES ('adjustment-1', 'adjustment-model', 'adjustment-operation-active', '19', 7,
          '1200.00', ?, '2026-09-29', '0', 'actor-1', 'device-1', ?, ?)
      `).run(timestamp, timestamp, timestamp)

      expect(() => database.prepare(`
        INSERT INTO model_account_adjustments (
          id, model_id, model_operation_id, worker_id, quantity, unit_price_snapshot,
          entered_at, business_date, version, created_by, created_device_id, created_at, updated_at
        ) VALUES ('adjustment-2', 'adjustment-model', 'adjustment-operation-inactive', '19', 7,
          '1200.00', ?, '2026-09-29', '0', 'actor-1', 'device-1', ?, ?)
      `).run(timestamp, timestamp, timestamp)).toThrow(/operation does not belong to its model/)
      expect(() => database.prepare(`
        DELETE FROM model_account_adjustments WHERE id = 'adjustment-1'
      `).run()).toThrow(/retained as history/)
      expect(database.prepare(`
        SELECT quantity, unit_price_snapshot FROM model_account_adjustments WHERE id = 'adjustment-1'
      `).get()).toEqual({ quantity: 7, unit_price_snapshot: '1200.00' })
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      database.close()
    }
  })

  it('migrates Patta quantity and widens sync queues without losing local business or conflict rows', () => {
    const database = new Database(temporaryDatabasePath())
    database.pragma('foreign_keys = ON')
    applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 2))
    const createdAt = '2026-09-28T10:00:00.000Z'
    const legacyEventId = '11111111-1111-4111-8111-111111111111'
    const existingConflictEventId = '22222222-2222-4222-8222-222222222222'

    database.exec(`
      INSERT INTO models (id, name, status, version, created_at, updated_at)
      VALUES ('model-1', 'Atlas', 'ACTIVE', '1', '${createdAt}', '${createdAt}');
      INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
      VALUES ('operation-1', 'model-1', 'Tikish', 0, 'ACTIVE', '1', '${createdAt}', '${createdAt}');
      INSERT INTO patta_number_blocks (
        id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
        local_next_number, local_consumed_count, local_role
      ) VALUES ('block-1', 'device-1', '100', '199', '0', 'ACTIVE', '${createdAt}', '100', '0', 'CURRENT');
      INSERT INTO patta_hisob (
        id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
        konveyer_snapshot, razmer, rang, ish_soni, created_device_id, created_from_block_id,
        created_at, client_created_at, occurred_at, version, ownership_state
      ) VALUES (
        'patta-1', 'PARTIYA-1', '100', 'model-1', 'Atlas', NULL, 'Line A', 'S', 'Qora', 13,
        'device-1', 'block-1', '${createdAt}', '${createdAt}', '${createdAt}', '0', 'LOCAL_PENDING'
      );
      INSERT INTO patta_operation_snapshots (
        id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
        sort_order, created_at, ownership_state
      ) VALUES ('snapshot-1', 'patta-1', 'operation-1', 'Tikish', '10.00', 0, '${createdAt}', 'LOCAL_PENDING');
      INSERT INTO sync_queue (
        event_id, entity_type, entity_id, operation, base_version, client_created_at,
        occurred_at, reference_cursor, payload_json, status, created_at, updated_at
      ) VALUES
        ('${legacyEventId}', 'patta', 'patta-1', 'CREATE', '0', '${createdAt}', '${createdAt}',
         '7', '{"patta_number":"100"}', 'PENDING', '${createdAt}', '${createdAt}'),
        ('${existingConflictEventId}', 'patta', 'patta-conflict', 'CREATE', '0', '${createdAt}', '${createdAt}',
         '7', '{"patta_number":"101"}', 'CONFLICT', '${createdAt}', '${createdAt}');
      INSERT INTO sync_conflicts (
        id, event_id, code, message, local_payload_json, server_payload_json,
        resolution_state, created_at
      ) VALUES (
        'conflict-1', '${existingConflictEventId}', 'VERSION_CONFLICT', 'Existing conflict',
        '{"preserved":true}', '{"server":"old"}', 'OPEN', '${createdAt}'
      );
    `)

    try {
      applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 4))

      expect(database.pragma('user_version', { simple: true })).toBe(4)
      expect(database.prepare(`
        SELECT ish_soni, legacy_operation_count, status, print_batch_id
        FROM patta_hisob WHERE id = 'patta-1'
      `).get()).toEqual({ ish_soni: null, legacy_operation_count: 13, status: 'ACTIVE', print_batch_id: null })
      expect(database.prepare(`
        SELECT id, unit_price_snapshot, ownership_state
        FROM patta_operation_snapshots WHERE patta_hisob_id = 'patta-1'
      `).get()).toEqual({ id: 'snapshot-1', unit_price_snapshot: '10.00', ownership_state: 'CONFLICT' })
      expect(database.prepare(`
        SELECT event_id, entity_type, operation, payload_json, status, last_error_code
        FROM sync_queue WHERE event_id = ?
      `).get(legacyEventId)).toEqual({
        event_id: legacyEventId,
        entity_type: 'patta',
        operation: 'CREATE',
        payload_json: '{"patta_number":"100"}',
        status: 'CONFLICT',
        last_error_code: 'PATTA_QUANTITY_UNKNOWN'
      })
      expect(database.prepare(`
        SELECT id, code, local_payload_json, server_payload_json, resolution_state
        FROM sync_conflicts WHERE event_id = ?
      `).get(legacyEventId)).toEqual({
        id: legacyEventId,
        code: 'PATTA_QUANTITY_UNKNOWN',
        local_payload_json: '{"patta_number":"100"}',
        server_payload_json: null,
        resolution_state: 'OPEN'
      })
      expect(database.prepare(`
        SELECT id, code, local_payload_json, server_payload_json, resolution_state
        FROM sync_conflicts WHERE id = 'conflict-1'
      `).get()).toEqual({
        id: 'conflict-1',
        code: 'VERSION_CONFLICT',
        local_payload_json: '{"preserved":true}',
        server_payload_json: '{"server":"old"}',
        resolution_state: 'OPEN'
      })
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      for (const tableName of [
        'patta_partiya_number_blocks', 'patta_print_batches', 'patta_print_batch_sizes',
        'patta_print_events', 'sync_event_dependencies', 'patta_sheets',
        'patta_sheet_operation_snapshots', 'patta_sheet_rows', 'entry_buffer'
      ]) {
        expect(database.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?')
          .get(tableName)).toEqual({ name: tableName })
      }
      expect((database.prepare('PRAGMA table_info(patta_sheets)').all() as Array<{ name: string }>)
        .map(({ name }) => name)).not.toContain('status')
      database.prepare(`
        UPDATE patta_hisob SET ish_soni = 13, legacy_operation_count = NULL WHERE id = 'patta-1'
      `).run()
      database.prepare(`
        INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
        VALUES ('17', 'Ishchi 17', 'ACTIVE', '1', ?, ?)
      `).run(createdAt, createdAt)
      database.prepare(`
        INSERT INTO patta_sheets (
          id, patta_hisob_id, entered_at, business_date, version, created_at, updated_at
        ) VALUES ('sheet-1', 'patta-1', ?, '2026-09-28', '0', ?, ?)
      `).run(createdAt, createdAt, createdAt)
      database.prepare(`
        INSERT INTO patta_sheet_operation_snapshots (
          id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
          operation_name_snapshot, unit_price_snapshot, sort_order, created_at
        ) VALUES ('sheet-operation-1', 'sheet-1', 'operation-1', 'PATTA', 'snapshot-1', 'Tikish', '10.00', 0, ?)
      `).run(createdAt)
      database.prepare(`
        INSERT INTO patta_sheet_rows (
          id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
          entered_badge_number, created_at, updated_at
        ) VALUES ('sheet-row-1', 'sheet-1', 'sheet-operation-1', '17', 13, '00418', ?, ?)
      `).run(createdAt, createdAt)
      applySqliteMigrations(database, SQLITE_MIGRATIONS)
      expect(database.pragma('user_version', { simple: true })).toBe(7)
      expect(database.prepare(`
        SELECT entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
          partiya_number_snapshot, patta_number_snapshot, rang_snapshot, razmer_snapshot
        FROM patta_sheets WHERE id = 'sheet-1'
      `).get()).toEqual({
        entry_kind: 'PATTA_LINKED', patta_hisob_id: 'patta-1', model_id: 'model-1',
        model_name_snapshot: 'Atlas', ish_soni: 13, partiya_number_snapshot: 'PARTIYA-1',
        patta_number_snapshot: '100', rang_snapshot: 'Qora', razmer_snapshot: 'S'
      })
      expect(database.prepare(`
        SELECT source_type, source_patta_operation_snapshot_id, unit_price_snapshot
        FROM patta_sheet_operation_snapshots WHERE id = 'sheet-operation-1'
      `).get()).toEqual({ source_type: 'PATTA', source_patta_operation_snapshot_id: 'snapshot-1', unit_price_snapshot: '10.00' })
      expect(database.prepare(`
        SELECT worker_id, quantity_snapshot, entered_badge_number FROM patta_sheet_rows WHERE id = 'sheet-row-1'
      `).get()).toEqual({ worker_id: '17', quantity_snapshot: 13, entered_badge_number: '00418' })
      expect(database.prepare(`
      SELECT event_id, status FROM sync_queue ORDER BY event_id
      `).all()).toEqual([
        { event_id: legacyEventId, status: 'CONFLICT' },
        { event_id: existingConflictEventId, status: 'CONFLICT' }
      ])
      expect(database.prepare(`
      SELECT id, event_id, code FROM sync_conflicts ORDER BY id
      `).all()).toEqual([
        { id: legacyEventId, event_id: legacyEventId, code: 'PATTA_QUANTITY_UNKNOWN' },
        { id: 'conflict-1', event_id: existingConflictEventId, code: 'VERSION_CONFLICT' }
      ])
      expect(() => database.prepare(`
        UPDATE patta_sheets SET created_at = ?, ownership_state = 'SERVER_SYNCED' WHERE id = 'sheet-1'
      `).run('2026-09-28T10:01:00.000Z')).not.toThrow()
      expect(() => database.prepare(`
        UPDATE patta_sheets SET created_at = ? WHERE id = 'sheet-1'
      `).run('2026-09-28T10:02:00.000Z')).toThrow(/identity and Entry snapshots are immutable/)
      expect(() => database.prepare(`
        UPDATE patta_sheets SET entered_at = ? WHERE id = 'sheet-1'
      `).run('2026-09-29T10:00:00.000Z')).toThrow(/identity and Entry snapshots are immutable/)
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
