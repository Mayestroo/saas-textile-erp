import type Database from 'better-sqlite3'
import type { PattaPrintBatchProjection } from '@textile/sync-protocol'

export class PattaPrintBatchRepository {
  constructor(private readonly database: Database.Database) {}

  createLocal(batch: PattaPrintBatchProjection): PattaPrintBatchProjection {
    if (!this.database.inTransaction) {
      throw new Error('Local print batch persistence requires a SQLite unit-of-work transaction')
    }
    this.database.prepare(`
      INSERT INTO patta_print_batches (
        id, model_id, model_name_snapshot, partiya_number, partiya_block_id, ish_soni, rang,
        status, version, revision, corrected_from_batch_id, created_by, created_device_id,
        created_at, updated_at, printed_at, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `).run(
      batch.id,
      batch.model_id,
      batch.model_name_snapshot,
      batch.partiya_number,
      batch.partiya_block_id,
      batch.ish_soni,
      batch.rang,
      batch.status,
      batch.version,
      batch.revision,
      batch.corrected_from_batch_id,
      batch.created_by,
      batch.created_device_id,
      batch.created_at,
      batch.updated_at,
      batch.printed_at
    )

    const insertSize = this.database.prepare(`
      INSERT INTO patta_print_batch_sizes (
        id, print_batch_id, razmer, patta_count, sort_order, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `)
    for (const size of batch.size_distribution) {
      insertSize.run(size.id, size.print_batch_id, size.razmer, size.patta_count, size.sort_order)
    }

    const insertPatta = this.database.prepare(`
      INSERT INTO patta_hisob (
        id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
        konveyer_snapshot, razmer, rang, ish_soni, legacy_operation_count, status, print_batch_id,
        created_device_id, created_from_block_id, created_at, client_created_at, occurred_at,
        version, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `)
    const insertSnapshot = this.database.prepare(`
      INSERT INTO patta_operation_snapshots (
        id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
        sort_order, created_at, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `)
    for (const patta of batch.pattas) {
      insertPatta.run(
        patta.id,
        patta.partiya_number,
        patta.patta_number,
        patta.model_id,
        patta.model_name_snapshot,
        patta.template_id,
        patta.konveyer_snapshot,
        patta.razmer,
        patta.rang,
        patta.ish_soni,
        patta.legacy_operation_count,
        patta.status,
        patta.print_batch_id,
        patta.created_device_id,
        patta.created_from_block_id,
        patta.created_at,
        patta.client_created_at,
        patta.occurred_at,
        patta.version
      )
      for (const snapshot of patta.operations) {
        insertSnapshot.run(
          snapshot.id,
          patta.id,
          snapshot.operation_id,
          snapshot.operation_name_snapshot,
          snapshot.unit_price_snapshot,
          snapshot.sort_order,
          snapshot.created_at
        )
      }
    }
    return batch
  }

  correctLocal(batch: PattaPrintBatchProjection, updateEntryQuantities: boolean): PattaPrintBatchProjection {
    if (!this.database.inTransaction) {
      throw new Error('Local print batch correction requires a SQLite unit-of-work transaction')
    }
    const existingBatch = this.database.prepare(`
      SELECT id FROM patta_print_batches WHERE id = ? AND status = 'ACTIVE'
    `).get(batch.id) as { id: string } | undefined
    if (!existingBatch) throw new Error('Active local Patta print batch was not found')
    const existingPattas = this.database.prepare(`
      SELECT id FROM patta_hisob WHERE print_batch_id = ?
    `).all(batch.id) as Array<{ id: string }>
    const existingPattaIds = new Set(existingPattas.map(({ id }) => id))
    const projectionPattaIds = new Set(batch.pattas.map(({ id }) => id))
    if (existingPattaIds.size > projectionPattaIds.size ||
      [...existingPattaIds].some((id) => !projectionPattaIds.has(id))) {
      throw new Error('A local correction cannot remove historical Patta identities')
    }

    this.database.prepare(`
      UPDATE patta_print_batches SET model_id = ?, model_name_snapshot = ?, partiya_number = ?,
        partiya_block_id = ?, ish_soni = ?, rang = ?, status = ?, version = ?, revision = ?,
        updated_at = ?, ownership_state = 'LOCAL_PENDING', server_sequence = NULL
      WHERE id = ? AND status = 'ACTIVE'
    `).run(
      batch.model_id, batch.model_name_snapshot, batch.partiya_number, batch.partiya_block_id,
      batch.ish_soni, batch.rang, batch.status, batch.version, batch.revision, batch.updated_at, batch.id
    )
    this.database.prepare('DELETE FROM patta_print_batch_sizes WHERE print_batch_id = ?').run(batch.id)
    const insertSize = this.database.prepare(`
      INSERT INTO patta_print_batch_sizes (
        id, print_batch_id, razmer, patta_count, sort_order, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `)
    for (const size of batch.size_distribution) {
      insertSize.run(size.id, batch.id, size.razmer, size.patta_count, size.sort_order)
    }

    const updatePatta = this.database.prepare(`
      UPDATE patta_hisob SET razmer = ?, rang = ?, ish_soni = ?, status = ?, version = ?,
        ownership_state = 'LOCAL_PENDING', server_sequence = NULL
      WHERE id = ? AND print_batch_id = ?
    `)
    const insertPatta = this.database.prepare(`
      INSERT INTO patta_hisob (
        id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
        konveyer_snapshot, razmer, rang, ish_soni, legacy_operation_count, status, print_batch_id,
        created_device_id, created_from_block_id, created_at, client_created_at, occurred_at,
        version, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `)
    const insertSnapshot = this.database.prepare(`
      INSERT INTO patta_operation_snapshots (
        id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
        sort_order, created_at, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `)
    for (const patta of batch.pattas) {
      if (existingPattaIds.has(patta.id)) {
        const update = updatePatta.run(
          patta.razmer, patta.rang, patta.ish_soni, patta.status, patta.version, patta.id, batch.id
        )
        if (update.changes !== 1) throw new Error('Existing Patta correction target disappeared')
        continue
      }
      insertPatta.run(
        patta.id, patta.partiya_number, patta.patta_number, patta.model_id, patta.model_name_snapshot,
        patta.template_id, patta.konveyer_snapshot, patta.razmer, patta.rang, patta.ish_soni,
        patta.legacy_operation_count, patta.status, patta.print_batch_id, patta.created_device_id,
        patta.created_from_block_id, patta.created_at, patta.client_created_at, patta.occurred_at,
        patta.version
      )
      for (const snapshot of patta.operations) {
        insertSnapshot.run(
          snapshot.id, patta.id, snapshot.operation_id, snapshot.operation_name_snapshot,
          snapshot.unit_price_snapshot, snapshot.sort_order, snapshot.created_at
        )
      }
    }
    this.database.prepare(`
      UPDATE patta_operation_snapshots SET ownership_state = 'LOCAL_PENDING', server_sequence = NULL
      WHERE patta_hisob_id IN (SELECT id FROM patta_hisob WHERE print_batch_id = ?)
    `).run(batch.id)
    if (updateEntryQuantities && this.hasTable('patta_sheets')) {
      const sheetIds = this.database.prepare(`
        SELECT id FROM patta_sheets
        WHERE patta_hisob_id IN (SELECT id FROM patta_hisob WHERE print_batch_id = ?)
      `).all(batch.id) as Array<{ id: string }>
      const ids = sheetIds.map(({ id }) => id)
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ')
        this.database.prepare(`
          UPDATE patta_sheet_rows SET quantity_snapshot = ?
          WHERE patta_sheet_id IN (${placeholders}) AND deleted_at IS NULL
        `).run(batch.ish_soni, ...ids)
        this.database.prepare(`
          UPDATE patta_sheets SET version = CAST(version AS INTEGER) + 1, updated_at = ?
          WHERE id IN (${placeholders})
        `).run(batch.updated_at, ...ids)
      }
    }
    return batch
  }

  pattaIdsWithEntries(pattaIds: readonly string[]): ReadonlySet<string> {
    if (pattaIds.length === 0 || !this.hasTable('patta_sheets')) return new Set()
    const placeholders = pattaIds.map(() => '?').join(', ')
    const rows = this.database.prepare(`
      SELECT DISTINCT patta_hisob_id FROM patta_sheets
      WHERE patta_hisob_id IN (${placeholders})
    `).all(...pattaIds) as Array<{ patta_hisob_id: string }>
    return new Set(rows.map(({ patta_hisob_id }) => patta_hisob_id))
  }

  ownershipState(batchId: string): 'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED' | null {
    const row = this.database.prepare(`
      SELECT ownership_state FROM patta_print_batches WHERE id = ?
    `).get(batchId) as { ownership_state: 'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED' } | undefined
    return row?.ownership_state ?? null
  }

  private hasTable(tableName: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName) !== undefined
  }

  recordPrintEventLocal(event: {
    id: string
    batch_id: string
    revision: number
    kind: 'INITIAL' | 'REPRINT' | 'CORRECTED_REPRINT'
    outcome: 'REQUESTED' | 'SUCCEEDED' | 'FAILED'
    actor_user_id: string | null
    device_id: string
    created_at: string
    printed_at: string | null
  }): void {
    if (!this.database.inTransaction) {
      throw new Error('Local print event writes require a SQLite unit-of-work transaction')
    }
    this.database.prepare(`
      INSERT INTO patta_print_events (
        id, batch_id, revision, kind, outcome, actor_user_id, device_id,
        created_at, printed_at, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      event.id,
      event.batch_id,
      event.revision,
      event.kind,
      event.outcome,
      event.actor_user_id,
      event.device_id,
      event.created_at,
      event.printed_at
    )
    if (event.outcome === 'SUCCEEDED' && event.printed_at !== null) {
      this.database.prepare(`
        UPDATE patta_print_batches SET printed_at = COALESCE(printed_at, ?), updated_at = ?
        WHERE id = ?
      `).run(event.printed_at, event.created_at, event.batch_id)
    }
  }

  getById(batchId: string): PattaPrintBatchProjection | null {
    const row = this.database.prepare(`
      SELECT id, model_id, model_name_snapshot, partiya_number, partiya_block_id, ish_soni,
        rang, status, version, revision, corrected_from_batch_id, created_by, created_device_id,
        created_at, updated_at, printed_at
      FROM patta_print_batches WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_print_batches' AND tombstone.entity_id = patta_print_batches.id
        )
    `).get(batchId) as Omit<PattaPrintBatchProjection, 'size_distribution' | 'pattas'> | undefined
    if (!row) return null
    return {
      ...row,
      size_distribution: this.database.prepare(`
        SELECT id, print_batch_id, razmer, patta_count, sort_order
        FROM patta_print_batch_sizes WHERE print_batch_id = ? ORDER BY sort_order, razmer
      `).all(batchId) as PattaPrintBatchProjection['size_distribution'],
      pattas: (this.database.prepare(`
        SELECT patta.id, patta.partiya_number, patta.patta_number, patta.model_id,
          patta.model_name_snapshot, patta.template_id, patta.konveyer_snapshot, patta.razmer,
          patta.rang, patta.ish_soni, patta.legacy_operation_count, patta.status,
          patta.print_batch_id, patta.created_device_id, patta.created_from_block_id,
          patta.created_at, patta.client_created_at, patta.occurred_at, patta.version
        FROM patta_hisob patta WHERE patta.print_batch_id = ? ORDER BY patta.patta_number
      `).all(batchId) as Array<Omit<PattaPrintBatchProjection['pattas'][number], 'operations'>>).map((patta) => ({
        ...patta,
        operations: this.database.prepare(`
          SELECT id, patta_hisob_id, operation_id, operation_name_snapshot,
            unit_price_snapshot, sort_order, created_at
          FROM patta_operation_snapshots WHERE patta_hisob_id = ? ORDER BY sort_order, operation_id
        `).all((patta as { id: string }).id)
      })) as PattaPrintBatchProjection['pattas']
    }
  }
}
