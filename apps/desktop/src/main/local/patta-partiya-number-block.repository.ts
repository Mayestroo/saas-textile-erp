import type Database from 'better-sqlite3'
import type { PattaPartiyaNumberBlockProjection } from '@textile/sync-protocol'
import { parsePostgresBigint } from './decimal-string'
import { LocalDomainError } from './local-errors'

interface PartiyaBlockRow {
  id: string
  device_id: string
  range_start: string
  range_end: string
  reported_used_count: string
  status: 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED'
  allocated_at: string
  exhausted_at: string | null
  local_next_number: string | null
  local_consumed_count: string
  local_role: 'CURRENT' | 'RESERVED' | 'AVAILABLE'
}

interface CurrentProgress {
  local_next_number: string | null
  local_consumed_count: string
  local_role: PartiyaBlockRow['local_role']
}

export interface LocalPartiyaBlockConsumption {
  blockId: string
  partiyaNumber: string
  shouldPrefetch: boolean
}

export interface LocalPartiyaBlockUsageReport {
  blockId: string
  reportedUsedCount: string
}

export class PattaPartiyaNumberBlockRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly deviceId: string
  ) {}

  consumeNext(): LocalPartiyaBlockConsumption {
    this.assertTransaction()
    let current = this.currentBlock()
    if (current) {
      const progress = this.progress(current)
      if (progress.next <= progress.end) return this.consume(current, progress)
      this.database.prepare(`
        UPDATE patta_partiya_number_blocks SET local_role = 'AVAILABLE'
        WHERE id = ? AND local_role = 'CURRENT'
      `).run(current.id)
      current = null
    }

    const candidates = this.database.prepare(`
      SELECT block.* FROM patta_partiya_number_blocks AS block
      WHERE block.device_id = ? AND block.status = 'ACTIVE'
        AND block.local_role IN ('RESERVED', 'AVAILABLE')
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_partiya_number_blocks'
            AND tombstone.entity_id = block.id
        )
      ORDER BY CASE block.local_role WHEN 'RESERVED' THEN 0 ELSE 1 END,
        block.allocated_at, block.id
    `).all(this.deviceId) as PartiyaBlockRow[]
    for (const candidate of candidates) {
      const progress = this.progress(candidate)
      if (progress.next > progress.end) continue
      this.database.prepare(`
        UPDATE patta_partiya_number_blocks SET local_role = 'CURRENT'
        WHERE id = ? AND device_id = ? AND status = 'ACTIVE'
      `).run(candidate.id, this.deviceId)
      return this.consume(candidate, progress)
    }
    throw new LocalDomainError(
      'PARTIYA_NUMBER_BLOCKS_EXHAUSTED',
      'Partiya raqamlari tugadi. Internet ulanganda yangi blok oling.'
    )
  }

  shouldPrefetchNextBlock(): boolean {
    const current = this.database.prepare(`
      SELECT block.* FROM patta_partiya_number_blocks AS block
      WHERE block.device_id = ? AND block.local_role IN ('CURRENT', 'AVAILABLE')
        AND block.status IN ('ACTIVE', 'EXHAUSTED')
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_partiya_number_blocks'
            AND tombstone.entity_id = block.id
        )
      ORDER BY CASE block.local_role WHEN 'CURRENT' THEN 0 ELSE 1 END,
        block.allocated_at DESC, block.id DESC LIMIT 1
    `).get(this.deviceId) as PartiyaBlockRow | undefined
    if (!current) {
      const usable = this.database.prepare(`
        SELECT block.* FROM patta_partiya_number_blocks AS block
        WHERE block.device_id = ? AND block.status = 'ACTIVE'
          AND block.local_role IN ('RESERVED', 'AVAILABLE')
          AND NOT EXISTS (
            SELECT 1 FROM sync_tombstones AS tombstone
            WHERE tombstone.entity_type = 'patta_partiya_number_blocks'
              AND tombstone.entity_id = block.id
          )
      `).all(this.deviceId) as PartiyaBlockRow[]
      return !usable.some((block) => {
        const progress = this.progress(block)
        return progress.next <= progress.end
      })
    }
    const progress = this.progress(current)
    const capacity = progress.end - progress.start + 1n
    if (progress.consumed * 100n < capacity * 80n) return false
    const available = this.database.prepare(`
      SELECT id FROM patta_partiya_number_blocks
      WHERE device_id = ? AND status = 'ACTIVE' AND local_role IN ('RESERVED', 'AVAILABLE')
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_partiya_number_blocks'
            AND tombstone.entity_id = patta_partiya_number_blocks.id
        )
    `).all(this.deviceId) as Array<{ id: string }>
    return available.length === 0
  }

  pendingUsageReports(): readonly LocalPartiyaBlockUsageReport[] {
    const rows = this.database.prepare(`
      SELECT id, reported_used_count, local_consumed_count
      FROM patta_partiya_number_blocks
      WHERE device_id = ? AND status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_partiya_number_blocks'
            AND tombstone.entity_id = patta_partiya_number_blocks.id
        )
      ORDER BY allocated_at, id
    `).all(this.deviceId) as Array<{ id: string; reported_used_count: string; local_consumed_count: string }>
    return rows.flatMap((row) => {
      const reported = parsePostgresBigint(row.reported_used_count, 'Server Partiya block usage')
      const consumed = parsePostgresBigint(row.local_consumed_count, 'Local Partiya block usage')
      return consumed > reported ? [{ blockId: row.id, reportedUsedCount: consumed.toString() }] : []
    })
  }

  storeAllocatedBlock(block: PattaPartiyaNumberBlockProjection): void {
    this.assertTransaction()
    if (block.device_id.toLowerCase() !== this.deviceId.toLowerCase()) {
      throw new LocalDomainError('PARTIYA_BLOCK_DEVICE_MISMATCH', 'Partiya bloki boshqa qurilmaga berilgan')
    }
    this.upsertBlock(block)
  }

  applyReportedUsage(block: PattaPartiyaNumberBlockProjection): void {
    this.assertTransaction()
    const existing = this.database.prepare(`
      SELECT id FROM patta_partiya_number_blocks WHERE id = ? AND device_id = ?
    `).get(block.id, this.deviceId)
    if (!existing) throw new LocalDomainError('PARTIYA_BLOCK_NOT_FOUND', 'Partiya raqam bloki topilmadi')
    this.upsertBlock(block)
  }

  private currentBlock(): PartiyaBlockRow | null {
    const rows = this.database.prepare(`
      SELECT block.* FROM patta_partiya_number_blocks AS block
      WHERE block.device_id = ? AND block.local_role = 'CURRENT' AND block.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_partiya_number_blocks'
            AND tombstone.entity_id = block.id
        )
      ORDER BY block.allocated_at, block.id
    `).all(this.deviceId) as PartiyaBlockRow[]
    const current = rows[0] ?? null
    this.database.prepare(`
      UPDATE patta_partiya_number_blocks SET local_role = 'AVAILABLE'
      WHERE device_id = ? AND local_role = 'CURRENT' AND (? IS NULL OR id <> ?)
    `).run(this.deviceId, current?.id ?? null, current?.id ?? null)
    return current
  }

  private consume(block: PartiyaBlockRow, progress: ReturnType<PattaPartiyaNumberBlockRepository['progress']>): LocalPartiyaBlockConsumption {
    const next = progress.next + 1n
    const consumed = [progress.consumed, next - progress.start].reduce(
      (greatest, value) => value > greatest ? value : greatest,
      0n
    )
    this.database.prepare(`
      UPDATE patta_partiya_number_blocks
      SET local_next_number = ?, local_consumed_count = ?, local_role = 'CURRENT'
      WHERE id = ? AND device_id = ? AND status = 'ACTIVE'
    `).run(next.toString(), consumed.toString(), block.id, this.deviceId)
    const capacity = progress.end - progress.start + 1n
    return {
      blockId: block.id,
      partiyaNumber: progress.next.toString(),
      shouldPrefetch: consumed * 100n >= capacity * 80n
    }
  }

  private progress(block: PartiyaBlockRow): { start: bigint; end: bigint; next: bigint; consumed: bigint } {
    const start = parsePostgresBigint(block.range_start, 'Partiya range start')
    const end = parsePostgresBigint(block.range_end, 'Partiya range end')
    const reported = parsePostgresBigint(block.reported_used_count, 'Partiya reported usage')
    const localConsumed = parsePostgresBigint(block.local_consumed_count, 'Partiya local usage')
    if (start < 1n || end < start || reported > end - start + 1n || localConsumed > end - start + 1n) {
      throw new LocalDomainError('PARTIYA_BLOCK_INVALID', 'Partiya raqam bloki yaroqsiz')
    }
    const serverNext = start + reported
    const storedNext = block.local_next_number === null
      ? serverNext
      : parsePostgresBigint(block.local_next_number, 'Partiya local next number')
    if (storedNext < start || storedNext > end + 1n) {
      throw new LocalDomainError('PARTIYA_BLOCK_INVALID', 'Keyingi Partiya raqami blok oralig‘idan tashqarida')
    }
    const next = storedNext > serverNext ? storedNext : serverNext
    const consumed = [localConsumed, reported, next - start].reduce(
      (greatest, value) => value > greatest ? value : greatest,
      0n
    )
    return { start, end, next, consumed }
  }

  private upsertBlock(block: PattaPartiyaNumberBlockProjection): void {
    const start = parsePostgresBigint(block.range_start, 'Partiya range start')
    const end = parsePostgresBigint(block.range_end, 'Partiya range end')
    const reported = parsePostgresBigint(block.reported_used_count, 'Partiya reported usage')
    const capacity = end - start + 1n
    if (start < 1n || end < start || reported > capacity ||
      (block.status === 'EXHAUSTED') !== (reported === capacity)) {
      throw new LocalDomainError('PARTIYA_BLOCK_INVALID', 'Serverdan olingan Partiya bloki yaroqsiz')
    }
    const existing = this.database.prepare(`
      SELECT local_next_number, local_consumed_count, local_role, device_id
      FROM patta_partiya_number_blocks WHERE id = ?
    `).get(block.id) as (CurrentProgress & { device_id: string }) | undefined
    if (existing && existing.device_id.toLowerCase() !== block.device_id.toLowerCase()) {
      throw new LocalDomainError('PARTIYA_BLOCK_DEVICE_MISMATCH', 'Partiya bloki boshqa qurilmaga berilgan')
    }
    const serverNext = start + reported
    const localNext = existing?.local_next_number == null
      ? serverNext
      : parsePostgresBigint(existing.local_next_number, 'Partiya local next number')
    if (localNext < start || localNext > end + 1n) {
      throw new LocalDomainError('PARTIYA_BLOCK_INVALID', 'Mahalliy keyingi Partiya raqami blok oralig‘idan tashqarida')
    }
    const next = localNext > serverNext ? localNext : serverNext
    const localConsumed = [
      existing ? parsePostgresBigint(existing.local_consumed_count, 'Partiya local usage') : 0n,
      reported,
      next - start
    ].reduce((greatest, value) => value > greatest ? value : greatest, 0n)
    this.database.prepare(`
      INSERT INTO patta_partiya_number_blocks (
        id, device_id, range_start, range_end, reported_used_count, status, allocated_at,
        exhausted_at, local_next_number, local_consumed_count, local_role, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET range_start = excluded.range_start, range_end = excluded.range_end,
        reported_used_count = excluded.reported_used_count, status = excluded.status,
        exhausted_at = excluded.exhausted_at, local_next_number = excluded.local_next_number,
        local_consumed_count = excluded.local_consumed_count, server_sequence = excluded.server_sequence
    `).run(block.id, block.device_id, block.range_start, block.range_end, block.reported_used_count,
      block.status, block.allocated_at, block.exhausted_at, next.toString(), localConsumed.toString(),
      existing?.local_role ?? 'AVAILABLE')
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Partiya block updates require a SQLite unit-of-work transaction')
    }
  }
}
