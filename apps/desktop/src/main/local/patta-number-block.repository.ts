import type Database from 'better-sqlite3'
import type { PattaNumberBlockProjection } from '@textile/sync-protocol'
import { parsePostgresBigint } from './decimal-string'
import { LocalDomainError } from './local-errors'

interface NumberBlockRow {
  id: string
  device_id: string
  range_start: string
  range_end: string
  reported_used_count: string
  status: 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED'
  local_next_number: string | null
  local_consumed_count: string
  local_role: 'CURRENT' | 'RESERVED' | 'AVAILABLE'
}

interface ExistingBlockState {
  local_next_number: string | null
  local_consumed_count: string
  local_role: 'CURRENT' | 'RESERVED' | 'AVAILABLE'
}

export interface LocalBlockConsumption {
  blockId: string
  pattaNumber: string
  shouldPrefetch: boolean
}

export interface LocalBlockUsageReport {
  blockId: string
  reportedUsedCount: string
}

interface NormalizedBlockProgress {
  rangeStart: bigint
  rangeEnd: bigint
  nextNumber: bigint
  consumedCount: bigint
}

export class PattaNumberBlockRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly deviceId: string
  ) {}

  consumeNext(): LocalBlockConsumption {
    if (!this.database.inTransaction) {
      throw new Error('Patta block number consumption requires a SQLite write transaction')
    }

    let current = this.currentBlock()
    if (current) {
      const progress = this.normalizeProgress(current)
      if (progress.nextNumber <= progress.rangeEnd) {
        return this.consume(current, progress)
      }
      this.database
        .prepare(
          `
        UPDATE patta_number_blocks SET local_role = 'AVAILABLE'
        WHERE id = ? AND local_role = 'CURRENT'
      `
        )
        .run(current.id)
      current = null
    }

    this.database
      .prepare(
        `
      UPDATE patta_number_blocks SET local_role = 'AVAILABLE'
      WHERE device_id = ? AND local_role = 'CURRENT' AND status <> 'ACTIVE'
    `
      )
      .run(this.deviceId)

    const candidates = this.database
      .prepare(
        `
      SELECT block.id, block.device_id, block.range_start, block.range_end,
        block.reported_used_count, block.status, block.local_next_number,
        block.local_consumed_count, block.local_role
      FROM patta_number_blocks AS block
      WHERE block.device_id = ? AND block.status = 'ACTIVE'
        AND block.local_role IN ('RESERVED', 'AVAILABLE')
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_number_blocks' AND tombstone.entity_id = block.id
        )
      ORDER BY CASE block.local_role WHEN 'RESERVED' THEN 0 ELSE 1 END,
        block.allocated_at, block.id
    `
      )
      .all(this.deviceId) as NumberBlockRow[]

    for (const candidate of candidates) {
      const progress = this.normalizeProgress(candidate)
      if (progress.nextNumber > progress.rangeEnd) continue
      this.database
        .prepare(
          `
        UPDATE patta_number_blocks SET local_role = 'CURRENT'
        WHERE id = ? AND device_id = ? AND status = 'ACTIVE'
      `
        )
        .run(candidate.id, this.deviceId)
      return this.consume(candidate, progress)
    }

    throw new LocalDomainError(
      'PATTA_NUMBER_BLOCKS_EXHAUSTED',
      'Yangi Patta raqamlari tugadi. Internet ulanganda yangi blok oling.'
    )
  }

  shouldPrefetchNextBlock(): boolean {
    const current = this.database
      .prepare(
        `
      SELECT id, device_id, range_start, range_end, reported_used_count,
        status, local_next_number, local_consumed_count, local_role
      FROM patta_number_blocks
      WHERE device_id = ? AND local_role IN ('CURRENT', 'AVAILABLE')
        AND status IN ('ACTIVE', 'EXHAUSTED')
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_number_blocks'
            AND tombstone.entity_id = patta_number_blocks.id
        )
      ORDER BY CASE local_role WHEN 'CURRENT' THEN 0 ELSE 1 END,
        allocated_at DESC, id DESC
      LIMIT 1
    `
      )
      .get(this.deviceId) as NumberBlockRow | undefined
    if (!current) {
      const usable = this.database.prepare(`
        SELECT id, device_id, range_start, range_end, reported_used_count,
          status, local_next_number, local_consumed_count, local_role
        FROM patta_number_blocks
        WHERE device_id = ? AND status = 'ACTIVE' AND local_role IN ('RESERVED', 'AVAILABLE')
          AND NOT EXISTS (
            SELECT 1 FROM sync_tombstones AS tombstone
            WHERE tombstone.entity_type = 'patta_number_blocks'
              AND tombstone.entity_id = patta_number_blocks.id
          )
      `).all(this.deviceId) as NumberBlockRow[]
      return !usable.some((block) => this.normalizeProgress(block).nextNumber <= this.normalizeProgress(block).rangeEnd)
    }
    const currentProgress = this.normalizeProgress(current)
    const capacity = currentProgress.rangeEnd - currentProgress.rangeStart + 1n
    if (currentProgress.consumedCount * 100n < capacity * 80n) return false

    const candidates = this.database
      .prepare(
        `
      SELECT id, device_id, range_start, range_end, reported_used_count,
        status, local_next_number, local_consumed_count, local_role
      FROM patta_number_blocks
      WHERE device_id = ? AND status = 'ACTIVE'
        AND local_role IN ('RESERVED', 'AVAILABLE')
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_number_blocks' AND tombstone.entity_id = id
        )
      ORDER BY allocated_at, id
    `
      )
      .all(this.deviceId) as NumberBlockRow[]
    return !candidates.some((candidate) => {
      const progress = this.normalizeProgress(candidate)
      return progress.nextNumber <= progress.rangeEnd
    })
  }

  pendingUsageReports(): readonly LocalBlockUsageReport[] {
    const blocks = this.database
      .prepare(
        `
      SELECT id, reported_used_count, local_consumed_count
      FROM patta_number_blocks
      WHERE device_id = ? AND status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_number_blocks'
            AND tombstone.entity_id = patta_number_blocks.id
        )
      ORDER BY allocated_at, id
    `
      )
      .all(this.deviceId) as Array<{
      id: string
      reported_used_count: string
      local_consumed_count: string
    }>
    return blocks.flatMap((block) => {
      const reported = parsePostgresBigint(block.reported_used_count, 'Server block usage')
      const consumed = parsePostgresBigint(block.local_consumed_count, 'Local block usage')
      return consumed > reported
        ? [{ blockId: block.id, reportedUsedCount: consumed.toString() }]
        : []
    })
  }

  storeAllocatedBlock(block: PattaNumberBlockProjection): void {
    this.assertTransaction()
    if (block.device_id.toLowerCase() !== this.deviceId.toLowerCase()) {
      throw new LocalDomainError(
        'PATTA_BLOCK_DEVICE_MISMATCH',
        'Patta raqamlar bloki boshqa qurilmaga berilgan'
      )
    }
    this.upsertServerBlock(block, null)
  }

  applyReportedUsage(block: PattaNumberBlockProjection): void {
    this.assertTransaction()
    if (block.device_id.toLowerCase() !== this.deviceId.toLowerCase()) {
      throw new LocalDomainError(
        'PATTA_BLOCK_DEVICE_MISMATCH',
        'Patta raqamlar bloki boshqa qurilmaga berilgan'
      )
    }
    const existing = this.database
      .prepare(
        `
      SELECT id FROM patta_number_blocks WHERE id = ? AND device_id = ?
    `
      )
      .get(block.id, this.deviceId)
    if (!existing)
      throw new LocalDomainError('PATTA_BLOCK_NOT_FOUND', 'Patta raqamlar bloki topilmadi')
    this.upsertServerBlock(block, null)
  }

  private currentBlock(): NumberBlockRow | null {
    const currentBlocks = this.database
      .prepare(
        `
      SELECT block.id, block.device_id, block.range_start, block.range_end,
        block.reported_used_count, block.status, block.local_next_number,
        block.local_consumed_count, block.local_role
      FROM patta_number_blocks AS block
      WHERE block.device_id = ? AND block.local_role = 'CURRENT' AND block.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_number_blocks' AND tombstone.entity_id = block.id
        )
      ORDER BY block.allocated_at, block.id
      LIMIT 1
      `
      )
      .all(this.deviceId) as NumberBlockRow[]
    const current = currentBlocks[0]
    if (current) {
      this.database
        .prepare(
          `
          UPDATE patta_number_blocks SET local_role = 'AVAILABLE'
          WHERE device_id = ? AND local_role = 'CURRENT' AND status = 'ACTIVE' AND id <> ?
        `
        )
        .run(this.deviceId, current.id)
    } else {
      this.database
        .prepare(
          `
          UPDATE patta_number_blocks SET local_role = 'AVAILABLE'
          WHERE device_id = ? AND local_role = 'CURRENT'
        `
        )
        .run(this.deviceId)
    }
    return current ?? null
  }

  private normalizeProgress(block: NumberBlockRow): NormalizedBlockProgress {
    const rangeStart = parsePostgresBigint(block.range_start, 'Patta block range start')
    const rangeEnd = parsePostgresBigint(block.range_end, 'Patta block range end')
    const reportedUsedCount = parsePostgresBigint(
      block.reported_used_count,
      'Patta block server-reported usage'
    )
    const localConsumedCount = parsePostgresBigint(
      block.local_consumed_count,
      'Patta block local usage'
    )
    if (rangeStart < 1n || rangeEnd < rangeStart) {
      throw new LocalDomainError('PATTA_NUMBER_BLOCK_INVALID', 'Patta raqamlar bloki yaroqsiz')
    }
    const capacity = rangeEnd - rangeStart + 1n
    if (reportedUsedCount > capacity || localConsumedCount > capacity) {
      throw new LocalDomainError(
        'PATTA_NUMBER_BLOCK_INVALID',
        'Patta raqamlar blokidagi foydalanish soni yaroqsiz'
      )
    }

    const serverNextNumber = rangeStart + reportedUsedCount
    const storedNextNumber =
      block.local_next_number === null
        ? serverNextNumber
        : parsePostgresBigint(block.local_next_number, 'Patta block local next number')
    if (storedNextNumber < rangeStart || storedNextNumber > rangeEnd + 1n) {
      throw new LocalDomainError(
        'PATTA_NUMBER_BLOCK_INVALID',
        'Keyingi Patta raqami blok chegarasidan tashqarida'
      )
    }
    const nextNumber = storedNextNumber > serverNextNumber ? storedNextNumber : serverNextNumber
    const localProgress = nextNumber - rangeStart
    const consumedCount = [localConsumedCount, reportedUsedCount, localProgress].reduce(
      (greatest, value) => (value > greatest ? value : greatest),
      0n
    )
    return { rangeStart, rangeEnd, nextNumber, consumedCount }
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Patta block updates require a SQLite unit-of-work transaction')
    }
  }

  private upsertServerBlock(
    block: PattaNumberBlockProjection,
    serverSequence: string | null
  ): void {
    const rangeStart = parsePostgresBigint(block.range_start, 'Patta block range start')
    const rangeEnd = parsePostgresBigint(block.range_end, 'Patta block range end')
    const reportedUsedCount = parsePostgresBigint(
      block.reported_used_count,
      'Patta block server usage'
    )
    const capacity = rangeEnd - rangeStart + 1n
    if (
      rangeStart < 1n ||
      rangeEnd < rangeStart ||
      reportedUsedCount > capacity ||
      (block.status === 'EXHAUSTED') !== (reportedUsedCount === capacity)
    ) {
      throw new LocalDomainError(
        'PATTA_NUMBER_BLOCK_INVALID',
        'Serverdan olingan Patta raqamlar bloki yaroqsiz'
      )
    }
    const existing = this.database
      .prepare(
        `
      SELECT device_id, local_next_number, local_consumed_count, local_role
      FROM patta_number_blocks WHERE id = ?
    `
      )
      .get(block.id) as (ExistingBlockState & { device_id: string }) | undefined
    if (existing && existing.device_id.toLowerCase() !== block.device_id.toLowerCase()) {
      throw new LocalDomainError(
        'PATTA_BLOCK_DEVICE_MISMATCH',
        'Patta raqamlar bloki boshqa qurilmaga berilgan'
      )
    }
    const nextFromServer = rangeStart + reportedUsedCount
    const oldNext =
      existing?.local_next_number == null
        ? nextFromServer
        : parsePostgresBigint(existing.local_next_number, 'Local block next number')
    if (oldNext < rangeStart || oldNext > rangeEnd + 1n) {
      throw new LocalDomainError(
        'PATTA_NUMBER_BLOCK_INVALID',
        'Mahalliy keyingi raqam blok chegarasidan tashqarida'
      )
    }
    const localNext = oldNext > nextFromServer ? oldNext : nextFromServer
    const oldConsumed = existing
      ? parsePostgresBigint(existing.local_consumed_count, 'Local block usage')
      : 0n
    const consumedByNext = localNext - rangeStart
    const localConsumed = [oldConsumed, reportedUsedCount, consumedByNext].reduce(
      (greatest, value) => (value > greatest ? value : greatest),
      0n
    )
    let localRole = existing?.local_role
    if (localRole === undefined) {
      const hasCurrent = this.database
        .prepare(
          `
        SELECT 1 FROM patta_number_blocks
        WHERE device_id = ? AND status = 'ACTIVE' AND local_role = 'CURRENT'
        LIMIT 1
      `
        )
        .get(this.deviceId)
      localRole = hasCurrent ? 'RESERVED' : 'CURRENT'
    }
    this.database
      .prepare(
        `
      INSERT INTO patta_number_blocks (
        id, device_id, range_start, range_end, reported_used_count, status,
        allocated_at, exhausted_at, local_next_number, local_consumed_count,
        local_role, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET range_start = excluded.range_start,
        range_end = excluded.range_end, reported_used_count = excluded.reported_used_count,
        status = excluded.status, allocated_at = excluded.allocated_at,
        exhausted_at = excluded.exhausted_at, local_next_number = excluded.local_next_number,
        local_consumed_count = excluded.local_consumed_count,
        server_sequence = COALESCE(excluded.server_sequence, patta_number_blocks.server_sequence)
    `
      )
      .run(
        block.id,
        block.device_id,
        block.range_start,
        block.range_end,
        block.reported_used_count,
        block.status,
        block.allocated_at,
        block.exhausted_at,
        localNext.toString(),
        localConsumed.toString(),
        localRole,
        serverSequence
      )
  }

  private consume(block: NumberBlockRow, progress: NormalizedBlockProgress): LocalBlockConsumption {
    const pattaNumber = progress.nextNumber
    const nextNumber = pattaNumber + 1n
    const consumedByNextNumber = nextNumber - progress.rangeStart
    const consumedCount =
      progress.consumedCount > consumedByNextNumber ? progress.consumedCount : consumedByNextNumber
    this.database
      .prepare(
        `
      UPDATE patta_number_blocks SET local_next_number = ?, local_consumed_count = ?,
        local_role = 'CURRENT'
      WHERE id = ? AND device_id = ? AND status = 'ACTIVE'
    `
      )
      .run(nextNumber.toString(), consumedCount.toString(), block.id, this.deviceId)
    const capacity = progress.rangeEnd - progress.rangeStart + 1n
    return {
      blockId: block.id,
      pattaNumber: pattaNumber.toString(),
      shouldPrefetch: consumedCount * 100n >= capacity * 80n
    }
  }
}
