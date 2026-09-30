import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelAccountAdjustmentProjection } from '@textile/sync-protocol'
import { openSqliteDatabase } from '../database/sqlite-database'
import { LocalUnitOfWork } from './local-unit-of-work'
import { ModelAccountAdjustmentRepository } from './model-account-adjustment.repository'

const timestamp = '2026-09-28T10:00:00.000000Z'
const modelId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const workerId = '17'
const adjustmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const databases: Database.Database[] = []
const directories: string[] = []

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-adjustment-repository-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'tenant.sqlite'))
  databases.push(database)
  database.prepare(`
    INSERT INTO models (id, name, status, version, created_at, updated_at)
    VALUES (?, 'Atlas', 'ACTIVE', '1', ?, ?)
  `).run(modelId, timestamp, timestamp)
  database.prepare(`
    INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
    VALUES (?, ?, 'Tikish', 0, 'ACTIVE', '1', ?, ?)
  `).run(operationId, modelId, timestamp, timestamp)
  database.prepare(`
    INSERT INTO workers (id, full_name, status, version, created_at, updated_at)
    VALUES (?, 'Nodira', 'ACTIVE', '1', ?, ?)
  `).run(workerId, timestamp, timestamp)
  return database
}

function projection(overrides: Partial<ModelAccountAdjustmentProjection> = {}): ModelAccountAdjustmentProjection {
  return {
    id: adjustmentId,
    model_id: modelId,
    model_operation_id: operationId,
    worker_id: workerId,
    quantity: 20,
    unit_price_snapshot: '21.50',
    entered_at: timestamp,
    business_date: '2026-09-28',
    version: '1',
    created_by: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    created_device_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    deleted_by: null,
    ...overrides
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ModelAccountAdjustmentRepository', () => {
  it('preserves server-owned adjustment rows when a local unsynced version exists', () => {
    const database = createDatabase()
    const repository = new ModelAccountAdjustmentRepository(database)
    const unitOfWork = new LocalUnitOfWork(database)
    const local = { ...projection(), version: '0', created_by: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }

    unitOfWork.transaction(() => repository.createLocal(local))
    expect(unitOfWork.transaction(() => repository.applyServerProjection(projection(), '10'))).toBe(false)
    expect(repository.getById(adjustmentId)).toMatchObject({ version: '0', ownership_state: 'LOCAL_PENDING' })
  })

  it('applies server projections and retains trash as a restorable historical row', () => {
    const database = createDatabase()
    const repository = new ModelAccountAdjustmentRepository(database)
    const unitOfWork = new LocalUnitOfWork(database)
    const trashed = projection({ version: '2', deleted_at: timestamp, deleted_by: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })

    expect(unitOfWork.transaction(() => repository.applyServerProjection(trashed, '20'))).toBe(true)
    expect(repository.getById(adjustmentId)).toMatchObject({
      version: '2', deleted_at: timestamp, ownership_state: 'SERVER_SYNCED', server_sequence: '20'
    })
    expect(repository.listForModel(modelId)).toEqual([])
    expect(repository.listForModel(modelId, true)).toHaveLength(1)
    expect(() => database.prepare('DELETE FROM model_account_adjustments WHERE id = ?').run(adjustmentId))
      .toThrow(/retained as history/)
  })
})
