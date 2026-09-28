import type Database from 'better-sqlite3'
import { assertPostgresBigint } from './decimal-string'

interface SyncStateRow {
  value: string
}

export class SyncStateRepository {
  constructor(private readonly database: Database.Database) {}

  get(key: string): string | null {
    const row = this.database.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
      SyncStateRow | undefined
    return row?.value ?? null
  }

  set(key: string, value: string, updatedAt: string): void {
    this.database
      .prepare(
        `
      INSERT INTO sync_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
      )
      .run(key, value, updatedAt)
  }

  lastServerCursor(): string | null {
    return this.get('last_server_cursor')
  }

  setLastServerCursor(cursor: string, updatedAt: string): void {
    this.set('last_server_cursor', assertPostgresBigint(cursor, 'Server change cursor'), updatedAt)
  }

  lastCompletedBootstrapSessionId(): string | null {
    return this.get('last_completed_bootstrap_session_id')
  }

  lastCompletedBootstrapWatermark(): string | null {
    return this.get('last_completed_bootstrap_watermark')
  }

  markBootstrapCompleted(sessionId: string, watermark: string, completedAt: string): void {
    const validWatermark = assertPostgresBigint(watermark, 'Bootstrap watermark')
    this.setLastServerCursor(validWatermark, completedAt)
    this.set('last_completed_bootstrap_session_id', sessionId, completedAt)
    this.set('last_completed_bootstrap_watermark', validWatermark, completedAt)
    this.set('last_completed_bootstrap_at', completedAt, completedAt)
  }
}
