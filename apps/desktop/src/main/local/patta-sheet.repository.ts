import type Database from 'better-sqlite3'
import type { PattaSheetProjection, PattaSheetProjectionV3 } from '@textile/sync-protocol'
import { LocalDomainError } from './local-errors'

export type LocalSheetOwnership = 'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED'

export interface PersistedPattaSheet extends PattaSheetProjectionV3 {
  ownership_state: LocalSheetOwnership
  server_sequence: string | null
}

export class PattaSheetRepository {
  constructor(private readonly database: Database.Database) {}

  createLocal(
    input: PattaSheetProjection | PattaSheetProjectionV3,
    badgeEvidence: ReadonlyMap<string, string> = new Map()
  ): PersistedPattaSheet {
    this.assertTransaction()
    const sheet = this.toV3(input)
    this.database.prepare(`
      INSERT INTO patta_sheets (
        id, entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
        partiya_number_snapshot, patta_number_snapshot, rang_snapshot, razmer_snapshot,
        entered_at, business_date, conveyor_snapshot, version, created_by, created_at,
        updated_at, deleted_at, deleted_by, deleted_by_name_snapshot, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `).run(
      sheet.id, sheet.entry_kind, sheet.patta_hisob_id, sheet.model_id, sheet.model_name_snapshot, sheet.ish_soni,
      sheet.partiya_number_snapshot, sheet.patta_number_snapshot, sheet.rang_snapshot, sheet.razmer_snapshot,
      sheet.entered_at, sheet.business_date, sheet.conveyor_snapshot, sheet.version, sheet.created_by,
      sheet.created_at, sheet.updated_at, sheet.deleted_at, sheet.deleted_by, sheet.deleted_by_name_snapshot
    )
    this.insertChildren(sheet, 'LOCAL_PENDING', null, badgeEvidence)
    return { ...sheet, ownership_state: 'LOCAL_PENDING', server_sequence: null }
  }

  updateLocal(
    input: PattaSheetProjection | PattaSheetProjectionV3,
    badgeEvidence: ReadonlyMap<string, string> = new Map()
  ): PersistedPattaSheet {
    this.assertTransaction()
    const sheet = this.toV3(input)
    const update = this.database.prepare(`
      UPDATE patta_sheets SET conveyor_snapshot = ?, version = ?, updated_at = ?,
        deleted_at = ?, deleted_by = ?, deleted_by_name_snapshot = ?,
        ownership_state = 'LOCAL_PENDING', server_sequence = NULL
      WHERE id = ?
    `).run(sheet.conveyor_snapshot, sheet.version, sheet.updated_at, sheet.deleted_at,
      sheet.deleted_by, sheet.deleted_by_name_snapshot, sheet.id)
    if (update.changes !== 1) throw new LocalDomainError('PATTA_SHEET_NOT_FOUND', 'Patta varag‘i topilmadi')
    this.upsertChildren(sheet, 'LOCAL_PENDING', null, badgeEvidence)
    return { ...sheet, ownership_state: 'LOCAL_PENDING', server_sequence: null }
  }

  applyServerProjection(input: PattaSheetProjection | PattaSheetProjectionV3, serverSequence: string): boolean {
    this.assertTransaction()
    const sheet = this.toV3(input)
    this.assertOperationSnapshotsMatch(sheet)
    const current = this.database.prepare(`
      SELECT ownership_state FROM patta_sheets WHERE id = ?
    `).get(sheet.id) as { ownership_state: LocalSheetOwnership } | undefined
    if (current && current.ownership_state !== 'SERVER_SYNCED') return false
    this.database.prepare(`
      INSERT INTO patta_sheets (
        id, entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
        partiya_number_snapshot, patta_number_snapshot, rang_snapshot, razmer_snapshot,
        entered_at, business_date, conveyor_snapshot, version, created_by, created_at,
        updated_at, deleted_at, deleted_by, deleted_by_name_snapshot, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SERVER_SYNCED', ?)
      ON CONFLICT(id) DO UPDATE SET entry_kind = excluded.entry_kind,
        patta_hisob_id = excluded.patta_hisob_id, model_id = excluded.model_id,
        model_name_snapshot = excluded.model_name_snapshot, ish_soni = excluded.ish_soni,
        partiya_number_snapshot = excluded.partiya_number_snapshot,
        patta_number_snapshot = excluded.patta_number_snapshot, rang_snapshot = excluded.rang_snapshot,
        razmer_snapshot = excluded.razmer_snapshot,
        entered_at = excluded.entered_at, business_date = excluded.business_date,
        conveyor_snapshot = excluded.conveyor_snapshot, version = excluded.version,
        created_by = excluded.created_by, created_at = excluded.created_at,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
        deleted_by = excluded.deleted_by, deleted_by_name_snapshot = excluded.deleted_by_name_snapshot,
        ownership_state = 'SERVER_SYNCED',
        server_sequence = excluded.server_sequence
    `).run(
      sheet.id, sheet.entry_kind, sheet.patta_hisob_id, sheet.model_id, sheet.model_name_snapshot, sheet.ish_soni,
      sheet.partiya_number_snapshot, sheet.patta_number_snapshot, sheet.rang_snapshot, sheet.razmer_snapshot,
      sheet.entered_at, sheet.business_date, sheet.conveyor_snapshot, sheet.version, sheet.created_by,
      sheet.created_at, sheet.updated_at, sheet.deleted_at, sheet.deleted_by, sheet.deleted_by_name_snapshot,
      serverSequence
    )
    this.upsertChildren(sheet, 'SERVER_SYNCED', serverSequence, new Map())
    this.database.prepare(`
      DELETE FROM sync_tombstones WHERE entity_type = 'patta_sheets' AND entity_id = ?
    `).run(sheet.id)
    return true
  }

  getById(sheetId: string): PersistedPattaSheet | null {
    const row = this.database.prepare(`
      SELECT id, entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
        partiya_number_snapshot, patta_number_snapshot, rang_snapshot, razmer_snapshot,
        entered_at, business_date, conveyor_snapshot, version, created_by, created_at,
        updated_at, deleted_at, deleted_by, deleted_by_name_snapshot, ownership_state, server_sequence
      FROM patta_sheets WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM sync_tombstones tombstone
        WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = patta_sheets.id
      )
    `).get(sheetId) as Omit<PersistedPattaSheet, 'operation_snapshots' | 'rows'> | undefined
    return row ? { ...row, ...this.readChildren(sheetId) } : null
  }

  findByPatta(pattaId: string): PersistedPattaSheet | null {
    const row = this.database.prepare(`
      SELECT id FROM patta_sheets WHERE patta_hisob_id = ? AND NOT EXISTS (
        SELECT 1 FROM sync_tombstones tombstone
        WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = patta_sheets.id
      )
    `).get(pattaId) as { id: string } | undefined
    return row ? this.getById(row.id) : null
  }

  ownershipState(sheetId: string): LocalSheetOwnership | null {
    const row = this.database.prepare('SELECT ownership_state FROM patta_sheets WHERE id = ?').get(sheetId) as
      { ownership_state: LocalSheetOwnership } | undefined
    return row?.ownership_state ?? null
  }

  purgeLocal(sheetId: string, serverSequence: string, purgedAt: string): void {
    this.assertTransaction()
    const sheet = this.database.prepare('SELECT patta_hisob_id, deleted_at FROM patta_sheets WHERE id = ?').get(sheetId) as
      { patta_hisob_id: string | null; deleted_at: string | null } | undefined
    if (!sheet || sheet.deleted_at === null) {
      throw new LocalDomainError('PATTA_SHEET_PURGE_REQUIRES_TRASH', 'Varaqni butunlay o‘chirishdan oldin Korzinkaga yuboring')
    }
    const rows = this.database.prepare('SELECT id FROM patta_sheet_rows WHERE patta_sheet_id = ?').all(sheetId) as Array<{ id: string }>
    const snapshots = this.database.prepare('SELECT id FROM patta_sheet_operation_snapshots WHERE patta_sheet_id = ?')
      .all(sheetId) as Array<{ id: string }>
    const insertTombstone = this.database.prepare(`
      INSERT INTO sync_tombstones (entity_type, entity_id, server_sequence, deleted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        server_sequence = excluded.server_sequence, deleted_at = excluded.deleted_at
    `)
    for (const { id } of rows) insertTombstone.run('patta_sheet_rows', id, serverSequence, purgedAt)
    for (const { id } of snapshots) insertTombstone.run('patta_sheet_operation_snapshots', id, serverSequence, purgedAt)
    insertTombstone.run('patta_sheets', sheetId, serverSequence, purgedAt)
    this.database.prepare('DELETE FROM patta_sheet_rows WHERE patta_sheet_id = ?').run(sheetId)
    this.database.prepare('DELETE FROM patta_sheet_operation_snapshots WHERE patta_sheet_id = ?').run(sheetId)
    this.database.prepare('DELETE FROM patta_sheets WHERE id = ?').run(sheetId)
    if (sheet.patta_hisob_id !== null) {
      this.database.prepare('DELETE FROM entry_buffer WHERE patta_hisob_id = ?').run(sheet.patta_hisob_id)
    }
  }

  listForModel(modelId: string, includeDeleted = false): readonly PersistedPattaSheet[] {
    const rows = this.database.prepare(`
      SELECT sheet.id FROM patta_sheets sheet
      WHERE sheet.model_id = ? ${includeDeleted ? '' : 'AND sheet.deleted_at IS NULL'}
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = sheet.id
        )
      ORDER BY sheet.entered_at DESC, sheet.id DESC
    `).all(modelId) as Array<{ id: string }>
    return rows.flatMap(({ id }) => {
      const sheet = this.getById(id)
      return sheet ? [sheet] : []
    })
  }

  badgeEvidence(sheetId: string): ReadonlyMap<string, string> {
    const rows = this.database.prepare(`
      SELECT id, entered_badge_number FROM patta_sheet_rows WHERE patta_sheet_id = ?
    `).all(sheetId) as Array<{ id: string; entered_badge_number: string | null }>
    return new Map(rows.flatMap(({ id, entered_badge_number }) =>
      entered_badge_number === null ? [] : [[id, entered_badge_number] as const]
    ))
  }

  private readChildren(sheetId: string): Pick<PattaSheetProjectionV3, 'operation_snapshots' | 'rows'> {
    const operationSnapshots = this.database.prepare(`
      SELECT id, patta_sheet_id, model_operation_id, source_type,
        source_patta_operation_snapshot_id, operation_name_snapshot,
        unit_price_snapshot, sort_order, created_at
      FROM patta_sheet_operation_snapshots WHERE patta_sheet_id = ?
      ORDER BY sort_order, model_operation_id
    `).all(sheetId) as PattaSheetProjectionV3['operation_snapshots']
    const rows = this.database.prepare(`
      SELECT id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id,
        quantity_snapshot, nuqson, deleted_at, deleted_by, created_at, updated_at
      FROM patta_sheet_rows WHERE patta_sheet_id = ? ORDER BY created_at, id
    `).all(sheetId) as Array<Omit<PattaSheetProjectionV3['rows'][number], 'nuqson'> & { nuqson: number }>
    return { operation_snapshots: operationSnapshots, rows: rows.map((row) => ({ ...row, nuqson: Boolean(row.nuqson) })) }
  }

  private insertChildren(
    sheet: PattaSheetProjectionV3,
    ownership: LocalSheetOwnership,
    serverSequence: string | null,
    badgeEvidence: ReadonlyMap<string, string>,
  ): void {
    const insertSnapshot = this.database.prepare(`
      INSERT INTO patta_sheet_operation_snapshots (
        id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
        operation_name_snapshot, unit_price_snapshot, sort_order, created_at, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const snapshot of sheet.operation_snapshots) {
      insertSnapshot.run(snapshot.id, sheet.id, snapshot.model_operation_id, snapshot.source_type,
        snapshot.source_patta_operation_snapshot_id, snapshot.operation_name_snapshot,
        snapshot.unit_price_snapshot, snapshot.sort_order, snapshot.created_at, ownership, serverSequence)
    }
    const insertRow = this.database.prepare(`
      INSERT INTO patta_sheet_rows (
        id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
        nuqson, entered_badge_number, deleted_at, deleted_by, created_at, updated_at, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const row of sheet.rows) {
      insertRow.run(row.id, sheet.id, row.patta_sheet_operation_snapshot_id, row.worker_id,
        row.quantity_snapshot, row.nuqson ? 1 : 0, badgeEvidence.get(row.id) ?? null, row.deleted_at, row.deleted_by,
        row.created_at, row.updated_at, ownership, serverSequence)
    }
  }

  private upsertChildren(
    sheet: PattaSheetProjectionV3,
    ownership: LocalSheetOwnership,
    serverSequence: string | null,
    badgeEvidence: ReadonlyMap<string, string>,
  ): void {
    for (const snapshot of sheet.operation_snapshots) {
      const existing = this.database.prepare(
        'SELECT id FROM patta_sheet_operation_snapshots WHERE id = ?'
      ).get(snapshot.id)
      if (existing) {
        this.database.prepare(`
          UPDATE patta_sheet_operation_snapshots SET ownership_state = ?, server_sequence = ? WHERE id = ?
        `).run(ownership, serverSequence, snapshot.id)
        continue
      }
      this.database.prepare(`
        INSERT INTO patta_sheet_operation_snapshots (
          id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
          operation_name_snapshot, unit_price_snapshot, sort_order, created_at, ownership_state, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.id, sheet.id, snapshot.model_operation_id, snapshot.source_type,
        snapshot.source_patta_operation_snapshot_id, snapshot.operation_name_snapshot,
        snapshot.unit_price_snapshot, snapshot.sort_order, snapshot.created_at, ownership, serverSequence)
    }
    for (const row of sheet.rows) {
      this.database.prepare(`
        INSERT INTO patta_sheet_rows (
          id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
          nuqson, entered_badge_number, deleted_at, deleted_by, created_at, updated_at, ownership_state, server_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET patta_sheet_operation_snapshot_id = excluded.patta_sheet_operation_snapshot_id,
          worker_id = excluded.worker_id, quantity_snapshot = excluded.quantity_snapshot,
          nuqson = excluded.nuqson, entered_badge_number = COALESCE(excluded.entered_badge_number, patta_sheet_rows.entered_badge_number),
          deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
          updated_at = excluded.updated_at, ownership_state = excluded.ownership_state,
          server_sequence = excluded.server_sequence
      `).run(row.id, sheet.id, row.patta_sheet_operation_snapshot_id, row.worker_id,
        row.quantity_snapshot, row.nuqson ? 1 : 0, badgeEvidence.get(row.id) ?? null, row.deleted_at, row.deleted_by,
        row.created_at, row.updated_at, ownership, serverSequence)
    }
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) throw new Error('Patta Sheet persistence requires a SQLite transaction')
  }

  private toV3(input: PattaSheetProjection | PattaSheetProjectionV3): PattaSheetProjectionV3 {
    if ('entry_kind' in input) return input
    const patta = this.database.prepare(`
      SELECT id, model_id, model_name_snapshot, ish_soni, partiya_number,
        patta_number, rang, razmer FROM patta_hisob WHERE id = ?
    `).get(input.patta_hisob_id) as {
      id: string
      model_id: string
      model_name_snapshot: string
      ish_soni: number | null
      partiya_number: string
      patta_number: string
      rang: string | null
      razmer: string | null
    } | undefined
    if (!patta || patta.ish_soni === null) {
      throw new LocalDomainError('PATTA_QUANTITY_UNKNOWN', 'Patta miqdori Standalone projectionga aylantirilmadi')
    }
    const existingDeletionName = this.database.prepare(`
      SELECT deleted_by_name_snapshot FROM patta_sheets WHERE id = ?
    `).get(input.id) as { deleted_by_name_snapshot: string | null } | undefined
    return {
      ...input,
      entry_kind: 'PATTA_LINKED',
      model_id: patta.model_id,
      model_name_snapshot: patta.model_name_snapshot,
      ish_soni: patta.ish_soni,
      partiya_number_snapshot: patta.partiya_number,
      patta_number_snapshot: patta.patta_number,
      rang_snapshot: patta.rang,
      razmer_snapshot: patta.razmer,
      deleted_by_name_snapshot: existingDeletionName?.deleted_by_name_snapshot ?? null
    }
  }

  private assertOperationSnapshotsMatch(sheet: PattaSheetProjectionV3): void {
    for (const snapshot of sheet.operation_snapshots) {
      const existing = this.database.prepare(`
        SELECT patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
          operation_name_snapshot, unit_price_snapshot, sort_order
        FROM patta_sheet_operation_snapshots WHERE id = ?
      `).get(snapshot.id) as Omit<typeof snapshot, 'id' | 'created_at'> | undefined
      if (existing && (
        existing.patta_sheet_id !== sheet.id || existing.model_operation_id !== snapshot.model_operation_id ||
        existing.source_type !== snapshot.source_type ||
        existing.source_patta_operation_snapshot_id !== snapshot.source_patta_operation_snapshot_id ||
        existing.operation_name_snapshot !== snapshot.operation_name_snapshot ||
        existing.unit_price_snapshot !== snapshot.unit_price_snapshot || existing.sort_order !== snapshot.sort_order
      )) {
        throw new LocalDomainError('PATTA_SHEET_SNAPSHOT_MISMATCH', 'Server varaq operatsiya tarixi mahalliy nusxaga mos emas')
      }
    }
  }
}
