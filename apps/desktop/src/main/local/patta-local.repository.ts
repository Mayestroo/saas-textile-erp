import type Database from 'better-sqlite3'
import type { LocalPattaRecord, PersistedLocalPatta } from './local-patta.types'

interface PattaRow extends Omit<PersistedLocalPatta, 'operations'> {}

interface SnapshotRow {
  id: string
  operation_id: string
  operation_name_snapshot: string
  unit_price_snapshot: string
  sort_order: number
  ownership_state: PersistedLocalPatta['ownership_state']
}

const PATTA_COLUMNS = `
  id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
  konveyer_snapshot, razmer, rang, ish_soni, created_device_id, created_from_block_id,
  created_at, client_created_at, occurred_at, version, ownership_state, server_sequence
`

export class PattaLocalRepository {
  constructor(private readonly database: Database.Database) {}

  createLocal(patta: LocalPattaRecord): PersistedLocalPatta {
    if (!this.database.inTransaction) {
      throw new Error('Local Patta writes require a shared SQLite unit-of-work transaction')
    }
    this.database
      .prepare(
        `
      INSERT INTO patta_hisob (
        id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
        konveyer_snapshot, razmer, rang, ish_soni, created_device_id,
        created_from_block_id, created_at, client_created_at, occurred_at,
        version, ownership_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING')
    `
      )
      .run(
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
        patta.created_device_id,
        patta.created_from_block_id,
        patta.created_at,
        patta.client_created_at,
        patta.occurred_at,
        patta.version
      )

    const insertSnapshot = this.database.prepare(`
      INSERT INTO patta_operation_snapshots (
        id, patta_hisob_id, operation_id, operation_name_snapshot,
        unit_price_snapshot, sort_order, created_at, ownership_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING')
    `)
    for (const snapshot of patta.operations) {
      insertSnapshot.run(
        snapshot.id,
        patta.id,
        snapshot.operation_id,
        snapshot.operation_name_snapshot,
        snapshot.unit_price_snapshot,
        snapshot.sort_order,
        patta.created_at
      )
    }
    return {
      id: patta.id,
      partiya_number: patta.partiya_number,
      patta_number: patta.patta_number,
      model_id: patta.model_id,
      model_name_snapshot: patta.model_name_snapshot,
      template_id: patta.template_id,
      konveyer_snapshot: patta.konveyer_snapshot,
      razmer: patta.razmer,
      rang: patta.rang,
      ish_soni: patta.ish_soni,
      created_device_id: patta.created_device_id,
      created_from_block_id: patta.created_from_block_id,
      created_at: patta.created_at,
      client_created_at: patta.client_created_at,
      occurred_at: patta.occurred_at,
      version: patta.version,
      ownership_state: 'LOCAL_PENDING',
      server_sequence: null,
      operations: patta.operations
    }
  }

  getById(pattaId: string): PersistedLocalPatta | null {
    const row = this.database
      .prepare(
        `
      SELECT ${PATTA_COLUMNS} FROM patta_hisob
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM sync_tombstones AS tombstone
        WHERE tombstone.entity_type = 'patta_hisob' AND tombstone.entity_id = patta_hisob.id
      )
    `
      )
      .get(pattaId) as PattaRow | undefined
    return row ? this.withSnapshots(row) : null
  }

  findByBusinessKey(partiyaNumber: string, pattaNumber: string): PersistedLocalPatta | null {
    const row = this.database
      .prepare(
        `
      SELECT ${PATTA_COLUMNS} FROM patta_hisob
      WHERE partiya_number = ? AND patta_number = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_hisob' AND tombstone.entity_id = patta_hisob.id
        )
      ORDER BY id LIMIT 1
    `
      )
      .get(partiyaNumber, pattaNumber) as PattaRow | undefined
    return row ? this.withSnapshots(row) : null
  }

  private withSnapshots(patta: PattaRow): PersistedLocalPatta {
    const operations = this.database
      .prepare(
        `
      SELECT id, operation_id, operation_name_snapshot, unit_price_snapshot,
        sort_order, ownership_state
      FROM patta_operation_snapshots
      WHERE patta_hisob_id = ?
      ORDER BY sort_order, id
    `
      )
      .all(patta.id) as SnapshotRow[]
    return {
      ...patta,
      operations: operations.map(
        ({ id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order }) => ({
          id,
          operation_id,
          operation_name_snapshot,
          unit_price_snapshot,
          sort_order
        })
      )
    }
  }
}
