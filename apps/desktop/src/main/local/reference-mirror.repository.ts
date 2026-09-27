import type Database from 'better-sqlite3'
import type { SyncEntityType, SyncProjection } from '@textile/sync-protocol'
import { compareDecimalStrings, parsePostgresBigint } from './decimal-string'
import type { BootstrapStagingRepository } from './bootstrap-staging.repository'
import { LocalUnitOfWork } from './local-unit-of-work'
import { SyncStateRepository } from './sync-state.repository'

interface ExistingBlockState {
  local_next_number: string | null
  local_consumed_count: string
  local_role: 'CURRENT' | 'RESERVED' | 'AVAILABLE'
}

interface LocalOwnershipState {
  ownership_state: 'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED'
}

interface CompletedBootstrap {
  session_id: string
  status: 'COMPLETED'
  already_completed: boolean
}

const SERVER_MIRRORS: readonly {
  entityType: SyncEntityType
  table: string
  onlyServerOwned: boolean
}[] = [
  { entityType: 'workers', table: 'workers', onlyServerOwned: false },
  { entityType: 'worker_badge_history', table: 'worker_badge_history', onlyServerOwned: false },
  { entityType: 'models', table: 'models', onlyServerOwned: false },
  { entityType: 'model_operations', table: 'model_operations', onlyServerOwned: false },
  { entityType: 'model_operation_prices', table: 'model_operation_prices', onlyServerOwned: false },
  { entityType: 'patta_templates', table: 'patta_templates', onlyServerOwned: false },
  { entityType: 'patta_hisob', table: 'patta_hisob', onlyServerOwned: true },
  {
    entityType: 'patta_operation_snapshots',
    table: 'patta_operation_snapshots',
    onlyServerOwned: true
  },
  { entityType: 'patta_number_blocks', table: 'patta_number_blocks', onlyServerOwned: false }
]

function validateBlockNumbers(
  rangeStartText: string,
  rangeEndText: string,
  reportedUsedCountText: string,
  status: 'ACTIVE' | 'EXHAUSTED' | 'CANCELLED'
): { rangeStart: bigint; rangeEnd: bigint; reportedUsedCount: bigint } {
  const rangeStart = parsePostgresBigint(rangeStartText, 'Patta block range start')
  const rangeEnd = parsePostgresBigint(rangeEndText, 'Patta block range end')
  const reportedUsedCount = parsePostgresBigint(reportedUsedCountText, 'Patta block reported usage')
  if (rangeStart < 1n || rangeEnd < rangeStart) {
    throw new Error('Patta number block has an invalid inclusive range')
  }
  const capacity = rangeEnd - rangeStart + 1n
  if (reportedUsedCount > capacity) {
    throw new Error('Patta number block usage exceeds its allocated range')
  }
  if ((status === 'EXHAUSTED') !== (reportedUsedCount === capacity)) {
    throw new Error('Patta number block status does not match its reported usage')
  }
  return { rangeStart, rangeEnd, reportedUsedCount }
}

function applyProjection(
  database: Database.Database,
  projection: SyncProjection,
  watermark: string
): void {
  database
    .prepare(
      `
    DELETE FROM sync_tombstones WHERE entity_type = ? AND entity_id = ?
  `
    )
    .run(projection.entity_type, projection.entity_id)

  switch (projection.entity_type) {
    case 'workers': {
      const row = projection.data
      database
        .prepare(
          `
        INSERT INTO workers (
          id, full_name, status, version, created_at, updated_at, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET full_name = excluded.full_name,
          status = excluded.status, version = excluded.version,
          created_at = excluded.created_at, updated_at = excluded.updated_at,
          server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.full_name,
          row.status,
          row.version,
          row.created_at,
          row.updated_at,
          watermark
        )
      return
    }
    case 'worker_badge_history': {
      const row = projection.data
      database
        .prepare(
          `
        INSERT INTO worker_badge_history (
          id, badge_number, worker_id, valid_from, valid_to, created_at, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET badge_number = excluded.badge_number,
          worker_id = excluded.worker_id, valid_from = excluded.valid_from,
          valid_to = excluded.valid_to, created_at = excluded.created_at,
          server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.badge_number,
          row.worker_id,
          row.valid_from,
          row.valid_to,
          row.created_at,
          watermark
        )
      return
    }
    case 'models': {
      const row = projection.data
      database
        .prepare(
          `
        INSERT INTO models (id, name, status, version, created_at, updated_at, server_sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status,
          version = excluded.version, created_at = excluded.created_at,
          updated_at = excluded.updated_at, server_sequence = excluded.server_sequence
      `
        )
        .run(row.id, row.name, row.status, row.version, row.created_at, row.updated_at, watermark)
      return
    }
    case 'model_operations': {
      const row = projection.data
      database
        .prepare(
          `
        INSERT INTO model_operations (
          id, model_id, name, sort_order, status, version, created_at, updated_at, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET model_id = excluded.model_id, name = excluded.name,
          sort_order = excluded.sort_order, status = excluded.status, version = excluded.version,
          created_at = excluded.created_at, updated_at = excluded.updated_at,
          server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.model_id,
          row.name,
          row.sort_order,
          row.status,
          row.version,
          row.created_at,
          row.updated_at,
          watermark
        )
      return
    }
    case 'model_operation_prices': {
      const row = projection.data
      database
        .prepare(
          `
        INSERT INTO model_operation_prices (
          id, operation_id, price, valid_from, valid_to, created_at, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET operation_id = excluded.operation_id,
          price = excluded.price, valid_from = excluded.valid_from, valid_to = excluded.valid_to,
          created_at = excluded.created_at, server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.operation_id,
          row.price,
          row.valid_from,
          row.valid_to,
          row.created_at,
          watermark
        )
      return
    }
    case 'patta_templates': {
      const row = projection.data
      database
        .prepare(
          `
        INSERT INTO patta_templates (
          id, name, model_id, konveyer, razmer, rang, status, version,
          created_at, updated_at, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, model_id = excluded.model_id,
          konveyer = excluded.konveyer, razmer = excluded.razmer, rang = excluded.rang,
          status = excluded.status, version = excluded.version,
          created_at = excluded.created_at, updated_at = excluded.updated_at,
          server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.name,
          row.model_id,
          row.konveyer,
          row.razmer,
          row.rang,
          row.status,
          row.version,
          row.created_at,
          row.updated_at,
          watermark
        )
      return
    }
    case 'patta_hisob': {
      const row = projection.data
      const current = database
        .prepare(
          `
        SELECT ownership_state FROM patta_hisob WHERE id = ?
      `
        )
        .get(row.id) as LocalOwnershipState | undefined
      if (current && current.ownership_state !== 'SERVER_SYNCED') return

      database
        .prepare(
          `
        INSERT INTO patta_hisob (
          id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
          konveyer_snapshot, razmer, rang, ish_soni, created_device_id,
          created_from_block_id, created_at, client_created_at, occurred_at,
          version, ownership_state, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SERVER_SYNCED', ?)
        ON CONFLICT(id) DO UPDATE SET partiya_number = excluded.partiya_number,
          patta_number = excluded.patta_number, model_id = excluded.model_id,
          model_name_snapshot = excluded.model_name_snapshot, template_id = excluded.template_id,
          konveyer_snapshot = excluded.konveyer_snapshot, razmer = excluded.razmer,
          rang = excluded.rang, ish_soni = excluded.ish_soni,
          created_device_id = excluded.created_device_id,
          created_from_block_id = excluded.created_from_block_id,
          created_at = excluded.created_at, client_created_at = excluded.client_created_at,
          occurred_at = excluded.occurred_at, version = excluded.version,
          ownership_state = 'SERVER_SYNCED', server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.partiya_number,
          row.patta_number,
          row.model_id,
          row.model_name_snapshot,
          row.template_id,
          row.konveyer_snapshot,
          row.razmer,
          row.rang,
          row.ish_soni,
          row.created_device_id,
          row.created_from_block_id,
          row.created_at,
          row.client_created_at,
          row.occurred_at,
          projection.entity_version,
          watermark
        )
      return
    }
    case 'patta_operation_snapshots': {
      const row = projection.data
      const current = database
        .prepare(
          `
        SELECT ownership_state FROM patta_operation_snapshots WHERE id = ?
      `
        )
        .get(row.id) as LocalOwnershipState | undefined
      if (current && current.ownership_state !== 'SERVER_SYNCED') return

      database
        .prepare(
          `
        INSERT INTO patta_operation_snapshots (
          id, patta_hisob_id, operation_id, operation_name_snapshot,
          unit_price_snapshot, sort_order, created_at, ownership_state, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SERVER_SYNCED', ?)
        ON CONFLICT(id) DO UPDATE SET patta_hisob_id = excluded.patta_hisob_id,
          operation_id = excluded.operation_id,
          operation_name_snapshot = excluded.operation_name_snapshot,
          unit_price_snapshot = excluded.unit_price_snapshot,
          sort_order = excluded.sort_order, created_at = excluded.created_at,
          ownership_state = 'SERVER_SYNCED', server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.patta_hisob_id,
          row.operation_id,
          row.operation_name_snapshot,
          row.unit_price_snapshot,
          row.sort_order,
          row.created_at,
          watermark
        )
      return
    }
    case 'patta_number_blocks': {
      const row = projection.data
      const numbers = validateBlockNumbers(
        row.range_start,
        row.range_end,
        row.reported_used_count,
        row.status
      )
      const current = database
        .prepare(
          `
        SELECT local_next_number, local_consumed_count, local_role
        FROM patta_number_blocks WHERE id = ?
      `
        )
        .get(row.id) as ExistingBlockState | undefined
      const nextFromServer = numbers.rangeStart + numbers.reportedUsedCount
      const previousNext =
        current?.local_next_number === null || current?.local_next_number === undefined
          ? numbers.rangeStart
          : parsePostgresBigint(current.local_next_number, 'Local Patta block next number')
      if (previousNext < numbers.rangeStart || previousNext > numbers.rangeEnd + 1n) {
        throw new Error('Local Patta block next number is outside the allocated range')
      }
      const next = previousNext > nextFromServer ? previousNext : nextFromServer
      const previousConsumed = current
        ? parsePostgresBigint(current.local_consumed_count, 'Local Patta block usage')
        : 0n
      const consumedByCursor = next - numbers.rangeStart
      const localConsumed = [previousConsumed, numbers.reportedUsedCount, consumedByCursor].reduce(
        (greatest, value) => (value > greatest ? value : greatest),
        0n
      )
      const localRole = current?.local_role ?? 'AVAILABLE'

      database
        .prepare(
          `
        INSERT INTO patta_number_blocks (
          id, device_id, range_start, range_end, reported_used_count, status,
          allocated_at, exhausted_at, local_next_number, local_consumed_count,
          local_role, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id,
          range_start = excluded.range_start, range_end = excluded.range_end,
          reported_used_count = excluded.reported_used_count, status = excluded.status,
          allocated_at = excluded.allocated_at, exhausted_at = excluded.exhausted_at,
          local_next_number = excluded.local_next_number,
          local_consumed_count = excluded.local_consumed_count,
          server_sequence = excluded.server_sequence
      `
        )
        .run(
          row.id,
          row.device_id,
          row.range_start,
          row.range_end,
          row.reported_used_count,
          row.status,
          row.allocated_at,
          row.exhausted_at,
          next.toString(),
          localConsumed.toString(),
          localRole,
          watermark
        )
      return
    }
  }
}

export class ReferenceMirrorRepository {
  constructor(
    private readonly unitOfWork: LocalUnitOfWork,
    private readonly stagingRepository: BootstrapStagingRepository,
    private readonly stateRepository: SyncStateRepository
  ) {}

  finalizeBootstrap(sessionId: string, watermark: string, completedAt: string): CompletedBootstrap {
    parsePostgresBigint(watermark, 'Bootstrap watermark')
    return this.unitOfWork.transaction((database) => {
      const previousSessionId = this.stateRepository.lastCompletedBootstrapSessionId()
      const previousWatermark = this.stateRepository.lastCompletedBootstrapWatermark()
      if (previousSessionId === sessionId) {
        if (previousWatermark !== watermark) {
          throw new Error('Completed bootstrap session was reused with a different watermark')
        }
        const cursor = this.stateRepository.lastServerCursor()
        if (cursor === null || compareDecimalStrings(cursor, watermark, 'Server cursor') < 0) {
          throw new Error('Completed bootstrap watermark is ahead of the committed cursor')
        }
        return { session_id: sessionId, status: 'COMPLETED', already_completed: true }
      }

      const session = this.stagingRepository.currentSession()
      if (!session || session.session_id !== sessionId) {
        throw new Error('Bootstrap session is not staged locally')
      }
      if (session.status !== 'READY_TO_APPLY') {
        throw new Error('Bootstrap session is not ready for finalization')
      }
      if (session.watermark !== watermark) {
        throw new Error('Bootstrap finalization watermark does not match its staged session')
      }

      const currentCursor = this.stateRepository.lastServerCursor()
      if (
        currentCursor !== null &&
        compareDecimalStrings(currentCursor, watermark, 'Server cursor') > 0
      ) {
        throw new Error('Bootstrap cannot move the committed server cursor backwards')
      }

      database.pragma('defer_foreign_keys = ON')
      let afterOrderKey = ''
      while (true) {
        const stagedPage = this.stagingRepository.stagedItemsAfter(sessionId, afterOrderKey)
        for (const item of stagedPage) applyProjection(database, item.projection, watermark)
        if (stagedPage.length < 250) break
        const lastItem = stagedPage.at(-1)
        if (!lastItem) break
        afterOrderKey = lastItem.order_key
      }
      this.reconcileAbsentServerRows(database, sessionId, watermark, completedAt)

      this.stateRepository.markBootstrapCompleted(sessionId, watermark, completedAt)
      database.prepare('DELETE FROM bootstrap_items WHERE session_id = ?').run(sessionId)
      database
        .prepare('DELETE FROM bootstrap_local_state WHERE id = 1 AND session_id = ?')
        .run(sessionId)
      return { session_id: sessionId, status: 'COMPLETED', already_completed: false }
    })
  }

  private reconcileAbsentServerRows(
    database: Database.Database,
    sessionId: string,
    watermark: string,
    reconciledAt: string
  ): void {
    for (const mirror of SERVER_MIRRORS) {
      const ownershipFilter = mirror.onlyServerOwned
        ? `AND mirror.ownership_state = 'SERVER_SYNCED'`
        : ''
      database
        .prepare(
          `
        INSERT INTO sync_tombstones (entity_type, entity_id, server_sequence, deleted_at)
        SELECT ?, mirror.id, ?, ?
        FROM ${mirror.table} AS mirror
        WHERE NOT EXISTS (
          SELECT 1 FROM bootstrap_items AS staged
          WHERE staged.session_id = ? AND staged.entity_type = ? AND staged.entity_id = mirror.id
        )
        ${ownershipFilter}
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          server_sequence = excluded.server_sequence, deleted_at = excluded.deleted_at
      `
        )
        .run(mirror.entityType, watermark, reconciledAt, sessionId, mirror.entityType)
    }
  }
}
