import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { LocalUnitOfWork } from './local-unit-of-work'
import { PattaPartiyaNumberBlockRepository } from './patta-partiya-number-block.repository'

const directories: string[] = []
const databases: Database.Database[] = []
const instant = '2026-09-28T10:00:00.000Z'

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-partiya-blocks-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'tenant.sqlite'))
  databases.push(database)
  return database
}

function seedBlock(
  database: Database.Database,
  id: string,
  start: string,
  end: string,
  role: 'CURRENT' | 'RESERVED' | 'AVAILABLE' = 'AVAILABLE'
): void {
  database.prepare(`
    INSERT INTO patta_partiya_number_blocks (
      id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
      local_next_number, local_consumed_count, local_role
    ) VALUES (?, 'device-1', ?, ?, '0', 'ACTIVE', ?, ?, '0', ?)
  `).run(id, start, end, instant, start, role)
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('PattaPartiyaNumberBlockRepository', () => {
  it('consumes inclusive Partiya ranges without resetting when the model changes', () => {
    const database = createDatabase()
    seedBlock(database, 'partiya-current', '1', '2', 'CURRENT')
    seedBlock(database, 'partiya-reserved', '100', '101', 'RESERVED')
    const work = new LocalUnitOfWork(database)
    const blocks = new PattaPartiyaNumberBlockRepository(database, 'device-1')

    expect(work.transaction(() => blocks.consumeNext())).toMatchObject({ blockId: 'partiya-current', partiyaNumber: '1' })
    expect(work.transaction(() => blocks.consumeNext())).toMatchObject({ blockId: 'partiya-current', partiyaNumber: '2' })
    expect(work.transaction(() => blocks.consumeNext())).toMatchObject({ blockId: 'partiya-reserved', partiyaNumber: '100' })
    expect(work.transaction(() => blocks.consumeNext())).toMatchObject({ blockId: 'partiya-reserved', partiyaNumber: '101' })
    expect(() => work.transaction(() => blocks.consumeNext())).toThrow(/Partiya raqamlari tugadi/)
    expect(database.prepare(`
      SELECT local_next_number, local_consumed_count, reported_used_count
      FROM patta_partiya_number_blocks ORDER BY id
    `).all()).toEqual([
      { local_next_number: '3', local_consumed_count: '2', reported_used_count: '0' },
      { local_next_number: '102', local_consumed_count: '2', reported_used_count: '0' },
    ])
  })

  it('rolls back Partiya consumption atomically so the same reserved number remains available', () => {
    const database = createDatabase()
    seedBlock(database, 'partiya-current', '1', '4', 'CURRENT')
    const work = new LocalUnitOfWork(database)
    const blocks = new PattaPartiyaNumberBlockRepository(database, 'device-1')

    expect(() => work.transaction(() => {
      expect(blocks.consumeNext().partiyaNumber).toBe('1')
      throw new Error('injected batch insert failure')
    })).toThrow('injected batch insert failure')
    expect(work.transaction(() => blocks.consumeNext()).partiyaNumber).toBe('1')
  })

  it('requests a next Partiya range at 80 percent of the inclusive allocation', () => {
    const database = createDatabase()
    seedBlock(database, 'partiya-current', '1', '5', 'CURRENT')
    const blocks = new PattaPartiyaNumberBlockRepository(database, 'device-1')

    expect(blocks.shouldPrefetchNextBlock()).toBe(false)
    const work = new LocalUnitOfWork(database)
    work.transaction(() => {
      blocks.consumeNext()
      blocks.consumeNext()
      blocks.consumeNext()
      blocks.consumeNext()
    })
    expect(blocks.shouldPrefetchNextBlock()).toBe(true)
  })
})
