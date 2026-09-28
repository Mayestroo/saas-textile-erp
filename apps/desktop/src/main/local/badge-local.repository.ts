import type Database from 'better-sqlite3'
import { LocalDomainError } from './local-errors'
import { canonicalUtcTimestamp } from './utc-timestamp'

export interface LocalBadgeResolution {
  worker_id: string
  full_name: string
  assignment: {
    id: string
    badge_number: string
    valid_from: string
    valid_to: string | null
  }
}

interface LocalBadgeRow {
  id: string
  badge_number: string
  worker_id: string
  full_name: string
  valid_from: string
  valid_to: string | null
}

export class BadgeLocalRepository {
  constructor(private readonly database: Database.Database) {}

  resolveWorker(badgeNumberInput: string, performedAt: string): LocalBadgeResolution | null {
    const badgeNumber = badgeNumberInput.trim()
    if (!badgeNumber) {
      throw new LocalDomainError('BADGE_NUMBER_INVALID', 'Jeton raqami bo‘sh bo‘lishi mumkin emas')
    }
    let effectiveAt: string
    try {
      effectiveAt = canonicalUtcTimestamp(performedAt, 'Badge lookup timestamp')
    } catch {
      throw new LocalDomainError(
        'BADGE_TIMESTAMP_INVALID',
        'Ish vaqti ISO-8601 formatida bo‘lishi kerak'
      )
    }

    const row = this.database
      .prepare(
        `
      SELECT history.id, history.badge_number, history.worker_id, worker.full_name,
        history.valid_from, history.valid_to
      FROM worker_badge_history AS history
      INNER JOIN workers AS worker ON worker.id = history.worker_id
      WHERE history.badge_number = ?
        AND history.valid_from <= ?
        AND (history.valid_to IS NULL OR ? < history.valid_to)
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'worker_badge_history' AND tombstone.entity_id = history.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'workers' AND tombstone.entity_id = worker.id
        )
      ORDER BY history.valid_from DESC, history.id
      LIMIT 1
    `
      )
      .get(badgeNumber, effectiveAt, effectiveAt) as LocalBadgeRow | undefined

    if (!row) return null
    return {
      worker_id: row.worker_id,
      full_name: row.full_name,
      assignment: {
        id: row.id,
        badge_number: row.badge_number,
        valid_from: row.valid_from,
        valid_to: row.valid_to
      }
    }
  }
}
