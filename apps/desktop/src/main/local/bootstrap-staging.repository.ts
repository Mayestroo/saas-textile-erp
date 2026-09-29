import type Database from 'better-sqlite3'
import type {
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncChange,
  SyncProjection,
  SyncProjectionV2
} from '@textile/sync-protocol'
import { compareDecimalStrings, parsePostgresBigint } from './decimal-string'
import { isJsonObject, parseLocalJson, serializeLocalJson } from './local-json'
import { LocalUnitOfWork } from './local-unit-of-work'

const SYNC_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'workers',
  'worker_badge_history',
  'models',
  'model_operations',
  'model_operation_prices',
  'patta_templates',
  'patta_hisob',
  'patta_operation_snapshots',
  'patta_number_blocks',
  'patta_partiya_number_blocks',
  'patta_print_batches',
  'patta_print_batch_sizes',
  'patta_print_events',
  'patta_sheets',
  'patta_sheet_operation_snapshots',
  'patta_sheet_rows'
])

interface BootstrapStateRow {
  session_id: string
  watermark: string
  next_order_key: string | null
  status: 'ACTIVE' | 'READY_TO_APPLY'
  updated_at: string
}

interface BootstrapItemRow {
  order_key: string
  entity_type: SyncChange['entity_type']
  entity_id: string
  projection_json: string
}

export interface LocalBootstrapState {
  session_id: string
  watermark: string
  next_order_key: string | null
  status: 'ACTIVE' | 'READY_TO_APPLY'
  updated_at: string
}

export interface StagedBootstrapItem {
  order_key: string
  entity_type: SyncChange['entity_type']
  entity_id: string
  projection: SyncProjection | SyncProjectionV2
}

function projectionIdentity(value: unknown): SyncProjection | SyncProjectionV2 {
  if (!isJsonObject(value) || !isJsonObject(value.data)) {
    throw new Error('Bootstrap item does not contain a projection object')
  }
  const entityType = value.entity_type
  const entityId = value.entity_id
  if (
    (value.projection_version !== 1 && value.projection_version !== 2) ||
    typeof entityType !== 'string' ||
    !SYNC_ENTITY_TYPES.has(entityType) ||
    typeof entityId !== 'string' ||
    value.data.id !== entityId
  ) {
    throw new Error('Bootstrap projection identity is invalid')
  }
  return value as unknown as SyncProjection
}

function validateOrderKey(value: string): bigint {
  const parsed = parsePostgresBigint(value, 'Bootstrap order key')
  if (parsed === 0n) throw new Error('Bootstrap order keys must be greater than zero')
  return parsed
}

export class BootstrapStagingRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly unitOfWork: LocalUnitOfWork
  ) {}

  beginSession(session: SyncBootstrapSession, updatedAt: string): void {
    if (session.status !== 'ACTIVE')
      throw new Error('Only an active server bootstrap can be staged')
    parsePostgresBigint(session.watermark, 'Bootstrap watermark')
    this.unitOfWork.transaction((database) => {
      const current = database
        .prepare(
          `
        SELECT session_id, watermark, next_order_key, status, updated_at
        FROM bootstrap_local_state WHERE id = 1
      `
        )
        .get() as BootstrapStateRow | undefined

      if (current?.session_id === session.id) {
        if (current.watermark !== session.watermark) {
          throw new Error('Bootstrap session ID was reused with a different watermark')
        }
        return
      }

      if (current) {
        database.prepare('DELETE FROM bootstrap_items WHERE session_id = ?').run(current.session_id)
      }
      database.prepare('DELETE FROM bootstrap_items WHERE session_id = ?').run(session.id)
      database
        .prepare(
          `
        INSERT INTO bootstrap_local_state (id, session_id, watermark, next_order_key, status, updated_at)
        VALUES (1, ?, ?, '0', 'ACTIVE', ?)
        ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id,
          watermark = excluded.watermark, next_order_key = excluded.next_order_key,
          status = excluded.status, updated_at = excluded.updated_at
      `
        )
        .run(session.id, session.watermark, updatedAt)
    })
  }

  discardSession(sessionId: string): void {
    this.unitOfWork.transaction((database) => {
      const current = database
        .prepare(
          `
        SELECT session_id FROM bootstrap_local_state WHERE id = 1
      `
        )
        .get() as { session_id: string } | undefined
      if (current?.session_id !== sessionId) return
      database.prepare('DELETE FROM bootstrap_items WHERE session_id = ?').run(sessionId)
      database
        .prepare('DELETE FROM bootstrap_local_state WHERE id = 1 AND session_id = ?')
        .run(sessionId)
    })
  }

  persistPage(page: SyncBootstrapPage, updatedAt: string): void {
    this.unitOfWork.transaction((database) => {
      const state = database
        .prepare(
          `
        SELECT session_id, watermark, next_order_key, status, updated_at
        FROM bootstrap_local_state WHERE id = 1
      `
        )
        .get() as BootstrapStateRow | undefined
      if (!state || state.session_id !== page.session_id) {
        throw new Error('Bootstrap page does not match the active local session')
      }
      if (state.watermark !== page.watermark) {
        throw new Error('Bootstrap page watermark does not match the local session')
      }
      if (page.has_more && page.items.length === 0) {
        throw new Error('A bootstrap page with more data must contain at least one item')
      }
      const lastItem = page.items.at(-1)
      if (page.next_order_key !== (lastItem?.order_key ?? null)) {
        throw new Error('Bootstrap page cursor does not match its final item')
      }

      const currentOrderKey = state.next_order_key ?? '0'
      let nextExpectedOrder = BigInt(currentOrderKey) + 1n
      let greatestOrder = BigInt(currentOrderKey)
      let insertedNewItem = false
      const findByOrderKey = database.prepare(`
        SELECT order_key, entity_type, entity_id, projection_json
        FROM bootstrap_items WHERE session_id = ? AND order_key = ?
      `)
      const findByEntity = database.prepare(`
        SELECT order_key, entity_type, entity_id, projection_json
        FROM bootstrap_items WHERE session_id = ? AND entity_type = ? AND entity_id = ?
      `)
      const insertItem = database.prepare(`
        INSERT INTO bootstrap_items (
          session_id, order_key, entity_type, entity_id, projection_json
        ) VALUES (?, ?, ?, ?, ?)
      `)

      for (const item of page.items) {
        const order = validateOrderKey(item.order_key)
        const projection = projectionIdentity(item.projection)
        const projectionJson = serializeLocalJson(projection)
        const stagedByOrder = findByOrderKey.get(page.session_id, item.order_key) as
          BootstrapItemRow | undefined
        const stagedByEntity = findByEntity.get(
          page.session_id,
          projection.entity_type,
          projection.entity_id
        ) as BootstrapItemRow | undefined

        if (stagedByOrder) {
          const sameItem =
            stagedByOrder.entity_type === projection.entity_type &&
            stagedByOrder.entity_id === projection.entity_id &&
            stagedByOrder.projection_json === projectionJson
          if (!sameItem) {
            throw new Error('bootstrap order key is already staged with different data')
          }
          if (order > BigInt(currentOrderKey)) greatestOrder = order
          if (order === nextExpectedOrder) nextExpectedOrder += 1n
          continue
        }
        if (stagedByEntity) {
          throw new Error('Bootstrap entity is already staged at a different order key')
        }
        if (state.status === 'READY_TO_APPLY' || order !== nextExpectedOrder) {
          throw new Error('Bootstrap page order is not the next expected key')
        }

        insertItem.run(
          page.session_id,
          item.order_key,
          projection.entity_type,
          projection.entity_id,
          projectionJson
        )
        insertedNewItem = true
        greatestOrder = order
        nextExpectedOrder += 1n
      }

      if (
        page.next_order_key !== null &&
        compareDecimalStrings(page.next_order_key, currentOrderKey, 'Bootstrap page order') > 0 &&
        greatestOrder !== BigInt(page.next_order_key)
      ) {
        throw new Error('Bootstrap page cursor advances beyond its staged items')
      }
      const finalStatus = page.has_more ? 'ACTIVE' : 'READY_TO_APPLY'
      const preserveReadyState = state.status === 'READY_TO_APPLY' && !insertedNewItem
      database
        .prepare(
          `
        UPDATE bootstrap_local_state SET next_order_key = ?, status = ?, updated_at = ?
        WHERE id = 1 AND session_id = ?
      `
        )
        .run(
          greatestOrder.toString(),
          preserveReadyState ? 'READY_TO_APPLY' : finalStatus,
          updatedAt,
          page.session_id
        )
    })
  }

  currentSession(): LocalBootstrapState | null {
    const row = this.database
      .prepare(
        `
      SELECT session_id, watermark, next_order_key, status, updated_at
      FROM bootstrap_local_state WHERE id = 1
    `
      )
      .get() as BootstrapStateRow | undefined
    return row ?? null
  }

  stagedItemsAfter(
    sessionId: string,
    afterOrderKey: string,
    limit = 250
  ): readonly StagedBootstrapItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Bootstrap finalization page limit must be between 1 and 500')
    }
    const rows = this.database
      .prepare(
        `
      SELECT order_key, entity_type, entity_id, projection_json
      FROM bootstrap_items
      WHERE session_id = ? AND (
        length(order_key) > length(?) OR
        (length(order_key) = length(?) AND order_key > ?)
      )
      ORDER BY length(order_key), order_key
      LIMIT ?
    `
      )
      .all(sessionId, afterOrderKey, afterOrderKey, afterOrderKey, limit) as BootstrapItemRow[]
    return rows.map((row) => {
      const projection = projectionIdentity(parseLocalJson(row.projection_json))
      if (projection.entity_type !== row.entity_type || projection.entity_id !== row.entity_id) {
        throw new Error('Stored bootstrap projection identity does not match its staging row')
      }
      return {
        order_key: row.order_key,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        projection
      }
    })
  }
}
