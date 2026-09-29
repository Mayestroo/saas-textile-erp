import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { BadgeLocalRepository } from './badge-local.repository'
import { LocalUnitOfWork } from './local-unit-of-work'
import { ModelAccountRepository } from './model-account.repository'
import { PattaLocalRepository } from './patta-local.repository'
import { PattaSheetRepository } from './patta-sheet.repository'
import { PattaSheetService } from './patta-sheet.service'
import { PattaSheetCustomOperationRepository } from './patta-sheet-custom-operation.repository'
import { SyncQueueRepository } from './sync-queue.repository'
import { SyncStateRepository } from './sync-state.repository'

const timestamp = '2026-09-27T20:00:00.000000Z'
const firstPattaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const secondPattaId = '99999999-9999-4999-8999-999999999999'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const firstWorkerId = '7'
const secondWorkerId = '8'
const databases: Database.Database[] = []
const directories: string[] = []

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-model-account-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'tenant.sqlite'))
  databases.push(database)
  database.prepare(`
    INSERT INTO models (id, name, status, version, created_at, updated_at)
    VALUES ('model-1', 'Atlas', 'ACTIVE', '1', ?, ?)
  `).run(timestamp, timestamp)
  database.prepare(`
    INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
    VALUES (?, 'model-1', 'Tikish', 0, 'ACTIVE', '1', ?, ?)
  `).run(operationId, timestamp, timestamp)
  for (const workerId of [firstWorkerId, secondWorkerId]) {
    database.prepare(`
      INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
      VALUES (?, 'Nodira', 'ACTIVE', '1', ?, ?)
    `).run(workerId, timestamp, timestamp)
  }
  for (const [pattaId, pattaNumber] of [[firstPattaId, '10'], [secondPattaId, '11']] as const) {
    database.prepare(`
      INSERT INTO patta_hisob (
        id, partiya_number, patta_number, model_id, model_name_snapshot, template_id, konveyer_snapshot,
        razmer, rang, ish_soni, legacy_operation_count, status, print_batch_id, created_device_id,
        created_from_block_id, created_at, client_created_at, occurred_at, version, ownership_state
      ) VALUES (?, '1', ?, 'model-1', 'Atlas', NULL, NULL, 'S', 'Qora', 125, NULL, 'ACTIVE', NULL,
        'device-1', NULL, ?, NULL, NULL, '1', 'SERVER_SYNCED')
    `).run(pattaId, pattaNumber, timestamp)
    database.prepare(`
      INSERT INTO patta_operation_snapshots (
        id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order,
        created_at, ownership_state, server_sequence
      ) VALUES (?, ?, ?, 'Tikish', '37.00', 0, ?, 'SERVER_SYNCED', '8')
    `).run(`snapshot-${pattaNumber}`, pattaId, operationId, timestamp)
  }
  const state = new SyncStateRepository(database)
  state.setLastServerCursor('9', timestamp)
  state.setTenantTimezone('Asia/Tashkent', timestamp)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ModelAccountRepository', () => {
  it('aggregates by stable worker and operation IDs and excludes deleted assignments', () => {
    const database = createDatabase()
    const queue = new SyncQueueRepository(database)
    const sheets = new PattaSheetRepository(database)
    let nextId = 1
    const service = new PattaSheetService({
      unitOfWork: new LocalUnitOfWork(database),
      pattaRepository: new PattaLocalRepository(database),
      sheetRepository: sheets,
      customOperationRepository: new PattaSheetCustomOperationRepository(database),
      badgeRepository: new BadgeLocalRepository(database),
      queueRepository: queue,
      syncStateRepository: new SyncStateRepository(database),
      deviceId: 'device-1',
      clock: { nowIsoUtc: () => timestamp },
      idFactory: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`
    })
    database.prepare(`
      INSERT INTO worker_badge_history (id, badge_number, worker_id, valid_from, valid_to, created_at, server_sequence)
      VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '0007', ?, '2026-09-27T19:00:00.000Z', NULL, ?, '8'),
        ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '0008', ?, '2026-09-27T19:00:00.000Z', NULL, ?, '8')
    `).run(firstWorkerId, timestamp, secondWorkerId, timestamp)
    const firstSheet = service.create({
      partiya_number: '1', patta_number: '10', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0007', nuqson: false }]
    })
    const secondSheet = service.create({
      partiya_number: '1', patta_number: '11', conveyor_snapshot: null,
      assignments: [{ model_operation_id: operationId, badge_number: '0008', nuqson: true }]
    })
    const repository = new ModelAccountRepository(database)

    expect(repository.getModelAccountSheet('model-1')).toEqual({
      model_id: 'model-1',
      operations: [{ model_operation_id: operationId, operation_name: 'Tikish', sort_order: 0 }],
      rows: [
        { worker_id: firstWorkerId, worker_name: 'Nodira', model_operation_id: operationId, quantity: '125' },
        { worker_id: secondWorkerId, worker_name: 'Nodira', model_operation_id: operationId, quantity: '125' }
      ]
    })

    service.update({
      sheet_id: secondSheet.id,
      expected_version: '0',
      conveyor_snapshot: null,
      assignments: [],
      clear_operation_ids: [operationId]
    }, 'ffffffff-ffff-4fff-8fff-ffffffffffff')

    expect(repository.getModelAccountSheet('model-1').rows).toEqual([{
      worker_id: firstWorkerId, worker_name: 'Nodira', model_operation_id: operationId, quantity: '125'
    }])
    expect(sheets.getById(firstSheet.id)?.rows[0]?.worker_id).toBe(firstWorkerId)
  })
})
