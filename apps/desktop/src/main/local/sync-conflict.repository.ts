import type Database from 'better-sqlite3'
import type { SyncConflict } from '@textile/sync-protocol'
import { parseLocalJson, serializeLocalJson } from './local-json'

interface SyncConflictRow {
  id: string
  event_id: string
  code: string
  message: string
  local_payload_json: string
  server_payload_json: string | null
  resolution_state: 'OPEN' | 'RESOLVED'
  created_at: string
  resolved_at: string | null
}

export interface LocalSyncConflict extends SyncConflictRow {
  local_payload: unknown
  server_payload: unknown
}

export class SyncConflictRepository {
  constructor(private readonly database: Database.Database) {}

  persist(eventId: string, conflict: SyncConflict, createdAt: string): void {
    const localPayload = serializeLocalJson(conflict.local_payload ?? null)
    const serverPayload =
      conflict.server_payload === undefined ? null : serializeLocalJson(conflict.server_payload)
    this.database
      .prepare(
        `
      INSERT OR IGNORE INTO sync_conflicts (
        id, event_id, code, message, local_payload_json, server_payload_json,
        resolution_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `
      )
      .run(
        eventId,
        eventId,
        conflict.code,
        conflict.message,
        localPayload,
        serverPayload,
        createdAt
      )
    this.database
      .prepare(
        `
      UPDATE sync_queue SET status = 'CONFLICT', last_error_code = ?,
        last_error_message = ?, updated_at = ?
      WHERE event_id = ? AND status IN ('PENDING', 'SYNCING')
    `
      )
      .run(conflict.code, conflict.message, createdAt, eventId)
    this.database
      .prepare(
        `
      UPDATE patta_hisob SET ownership_state = 'CONFLICT'
      WHERE id = (SELECT entity_id FROM sync_queue WHERE event_id = ?)
        AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `
      )
      .run(eventId)
    this.database
      .prepare(
        `
      UPDATE patta_operation_snapshots SET ownership_state = 'CONFLICT'
      WHERE patta_hisob_id = (SELECT entity_id FROM sync_queue WHERE event_id = ?)
        AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `
      )
      .run(eventId)
  }

  open(limit = 100): readonly LocalSyncConflict[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Local conflict page limit must be between 1 and 500')
    }
    const rows = this.database
      .prepare(
        `
      SELECT id, event_id, code, message, local_payload_json, server_payload_json,
        resolution_state, created_at, resolved_at
      FROM sync_conflicts WHERE resolution_state = 'OPEN'
      ORDER BY created_at, id LIMIT ?
    `
      )
      .all(limit) as SyncConflictRow[]
    return rows.map((row) => ({
      ...row,
      local_payload: parseLocalJson(row.local_payload_json),
      server_payload:
        row.server_payload_json === null ? null : parseLocalJson(row.server_payload_json)
    }))
  }

  resolve(eventId: string, resolvedAt: string): boolean {
    const result = this.database
      .prepare(
        `
      UPDATE sync_conflicts SET resolution_state = 'RESOLVED', resolved_at = ?
      WHERE event_id = ? AND resolution_state = 'OPEN'
    `
      )
      .run(resolvedAt, eventId)
    return result.changes > 0
  }
}
