import type Database from 'better-sqlite3'
import { LocalDomainError } from './local-errors'

export interface LocalModelAccountSheet {
  model_id: string
  operations: readonly {
    model_operation_id: string
    operation_name: string
    sort_order: number
  }[]
  rows: readonly {
    worker_id: string
    worker_name: string
    model_operation_id: string
    quantity: string
  }[]
}

interface ModelRow {
  id: string
}

export class ModelAccountRepository {
  constructor(private readonly database: Database.Database) {}

  getModelAccountSheet(modelId: string): LocalModelAccountSheet {
    const model = this.database.prepare('SELECT id FROM models WHERE id = ?').get(modelId) as ModelRow | undefined
    if (!model) throw new LocalDomainError('MODEL_NOT_FOUND', 'Model topilmadi', { model_id: modelId })

    const operations = this.database.prepare(`
      SELECT operation.id AS model_operation_id, operation.name AS operation_name, operation.sort_order
      FROM model_operations AS operation
      WHERE operation.model_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'model_operations' AND tombstone.entity_id = operation.id
        )
        AND (operation.status = 'ACTIVE' OR EXISTS (
          SELECT 1 FROM patta_sheet_operation_snapshots snapshot
          JOIN patta_sheet_rows sheet_row ON sheet_row.patta_sheet_operation_snapshot_id = snapshot.id
          JOIN patta_sheets sheet ON sheet.id = sheet_row.patta_sheet_id
          JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
          WHERE snapshot.model_operation_id = operation.id AND patta.model_id = ?
            AND patta.status = 'ACTIVE' AND sheet.deleted_at IS NULL AND sheet_row.deleted_at IS NULL
        ))
      ORDER BY operation.sort_order, operation.name COLLATE NOCASE, operation.id
    `).all(modelId, modelId) as LocalModelAccountSheet['operations']

    const rows = this.database.prepare(`
      SELECT snapshot.model_operation_id, sheet_row.worker_id, worker.full_name AS worker_name,
        CAST(SUM(sheet_row.quantity_snapshot) AS TEXT) AS quantity
      FROM patta_sheet_rows AS sheet_row
      JOIN patta_sheets AS sheet ON sheet.id = sheet_row.patta_sheet_id
      JOIN patta_hisob AS patta ON patta.id = sheet.patta_hisob_id
      JOIN patta_sheet_operation_snapshots AS snapshot
        ON snapshot.id = sheet_row.patta_sheet_operation_snapshot_id
      JOIN workers AS worker ON worker.id = sheet_row.worker_id
      WHERE patta.model_id = ? AND patta.status = 'ACTIVE'
        AND sheet.deleted_at IS NULL AND sheet_row.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = sheet.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheet_rows' AND tombstone.entity_id = sheet_row.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'workers' AND tombstone.entity_id = worker.id
        )
      GROUP BY patta.model_id, snapshot.model_operation_id, sheet_row.worker_id, worker.full_name
      ORDER BY worker.full_name COLLATE NOCASE, sheet_row.worker_id, snapshot.model_operation_id
    `).all(modelId) as LocalModelAccountSheet['rows']

    return { model_id: modelId, operations, rows }
  }
}
