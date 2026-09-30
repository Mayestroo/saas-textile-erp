import type Database from 'better-sqlite3'
import { Decimal } from 'decimal.js'
import type {
  ConveyorAccountRow,
  ModelAccountContributionRow,
  ModelAccountOperationTotal,
  ModelAccountSheetV3,
  ModelAccountWorkerDetail
} from '@textile/sync-protocol'
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

interface PattaContributionRow {
  entry_kind?: 'PATTA_LINKED' | 'STANDALONE'
  model_operation_id: string
  operation_name: string
  sort_order: number
  worker_id: string
  worker_name: string
  quantity: number
  unit_price_snapshot: string
  entered_at: string
  version?: string | null
  deleted_at?: string | null
  deleted_by?: string | null
}

interface ManualContributionRow extends PattaContributionRow {
  adjustment_id: string
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
          WHERE snapshot.model_operation_id = operation.id AND sheet.model_id = ?
            AND sheet.deleted_at IS NULL AND sheet_row.deleted_at IS NULL
        ))
      ORDER BY operation.sort_order, operation.name COLLATE NOCASE, operation.id
    `).all(modelId, modelId) as LocalModelAccountSheet['operations']

    const rows = this.database.prepare(`
      SELECT snapshot.model_operation_id, sheet_row.worker_id, worker.full_name AS worker_name,
        CAST(SUM(sheet_row.quantity_snapshot) AS TEXT) AS quantity
      FROM patta_sheet_rows AS sheet_row
      JOIN patta_sheets AS sheet ON sheet.id = sheet_row.patta_sheet_id
      JOIN patta_sheet_operation_snapshots AS snapshot
        ON snapshot.id = sheet_row.patta_sheet_operation_snapshot_id
      JOIN workers AS worker ON worker.id = sheet_row.worker_id
      WHERE sheet.model_id = ?
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
      GROUP BY sheet.model_id, snapshot.model_operation_id, sheet_row.worker_id, worker.full_name
      ORDER BY worker.full_name COLLATE NOCASE, sheet_row.worker_id, snapshot.model_operation_id
    `).all(modelId) as LocalModelAccountSheet['rows']

    return { model_id: modelId, operations, rows }
  }

  getModelAccountSheetV3(modelId: string, currentAt = new Date().toISOString()): ModelAccountSheetV3 {
    const model = this.database.prepare('SELECT id, name FROM models WHERE id = ?').get(modelId) as
      { id: string; name: string } | undefined
    if (!model) throw new LocalDomainError('MODEL_NOT_FOUND', 'Model topilmadi', { model_id: modelId })
    const operations = this.database.prepare(`
      SELECT operation.id AS model_operation_id, operation.name AS operation_name, operation.sort_order,
        operation.version, operation.status,
        (SELECT price.price FROM model_operation_prices price
         WHERE price.operation_id = operation.id AND price.valid_from <= ?
           AND (price.valid_to IS NULL OR ? < price.valid_to)
           AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
             WHERE tombstone.entity_type = 'model_operation_prices' AND tombstone.entity_id = price.id)
         ORDER BY price.valid_from DESC, price.id DESC LIMIT 1) AS current_price
      FROM model_operations operation
      WHERE operation.model_id = ?
        AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'model_operations' AND tombstone.entity_id = operation.id)
        AND (operation.status = 'ACTIVE' OR EXISTS (
          SELECT 1 FROM patta_sheet_rows sheet_row
          JOIN patta_sheets sheet ON sheet.id = sheet_row.patta_sheet_id
          JOIN patta_sheet_operation_snapshots snapshot ON snapshot.id = sheet_row.patta_sheet_operation_snapshot_id
          WHERE sheet.model_id = operation.model_id AND snapshot.model_operation_id = operation.id
            AND sheet.deleted_at IS NULL AND sheet_row.deleted_at IS NULL
        ) OR EXISTS (
          SELECT 1 FROM model_account_adjustments adjustment
          WHERE adjustment.model_id = operation.model_id AND adjustment.model_operation_id = operation.id
            AND adjustment.deleted_at IS NULL
        ))
      ORDER BY operation.sort_order, operation.name COLLATE NOCASE, operation.id
    `).all(currentAt, currentAt, modelId) as Array<{
      model_operation_id: string
      operation_name: string
      sort_order: number
      version: string
      status: 'ACTIVE' | 'INACTIVE'
      current_price: string | null
    }>
    const pattaRows = this.database.prepare(`
      SELECT sheet.entry_kind, snapshot.model_operation_id, snapshot.operation_name_snapshot AS operation_name,
        snapshot.sort_order, sheet_row.worker_id, worker.full_name AS worker_name,
        sheet_row.quantity_snapshot AS quantity, snapshot.unit_price_snapshot, sheet.entered_at
      FROM patta_sheet_rows sheet_row
      JOIN patta_sheets sheet ON sheet.id = sheet_row.patta_sheet_id
      JOIN patta_sheet_operation_snapshots snapshot ON snapshot.id = sheet_row.patta_sheet_operation_snapshot_id
      JOIN workers worker ON worker.id = sheet_row.worker_id
      WHERE sheet.model_id = ? AND sheet.deleted_at IS NULL AND sheet_row.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = sheet.id)
        AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheet_rows' AND tombstone.entity_id = sheet_row.id)
        AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'workers' AND tombstone.entity_id = worker.id)
    `).all(modelId) as PattaContributionRow[]
    const manualRows = this.database.prepare(`
      SELECT adjustment.id AS adjustment_id, adjustment.model_operation_id, operation.name AS operation_name,
        operation.sort_order, adjustment.worker_id, worker.full_name AS worker_name,
        adjustment.quantity, adjustment.unit_price_snapshot, adjustment.entered_at
      FROM model_account_adjustments adjustment
      JOIN model_operations operation ON operation.id = adjustment.model_operation_id
      JOIN workers worker ON worker.id = adjustment.worker_id
      WHERE adjustment.model_id = ? AND adjustment.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'model_account_adjustments' AND tombstone.entity_id = adjustment.id)
        AND NOT EXISTS (SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'workers' AND tombstone.entity_id = worker.id)
    `).all(modelId) as ManualContributionRow[]

    const aggregate = new Map<string, {
      worker_id: string
      worker_name: string
      model_operation_id: string
      patta_quantity: bigint
      standalone_quantity: bigint
      manual_quantity: bigint
      patta_amount: Decimal
      standalone_amount: Decimal
      manual_amount: Decimal
    }>()
    const totalByOperation = new Map<string, {
      patta_quantity: bigint
      standalone_quantity: bigint
      manual_quantity: bigint
      patta_amount: Decimal
      standalone_amount: Decimal
      manual_amount: Decimal
    }>()
    const details: ModelAccountWorkerDetail[] = []
    const addContribution = (
      row: PattaContributionRow,
      source: 'PATTA' | 'STANDALONE' | 'MANUAL',
      adjustmentId: string | null
    ): void => {
      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1) {
        throw new LocalDomainError('MODEL_ACCOUNT_QUANTITY_INVALID', 'Mahalliy hisobdagi miqdor yaroqsiz')
      }
      const amount = new Decimal(row.unit_price_snapshot).mul(row.quantity)
      const key = `${row.model_operation_id}\u0000${row.worker_id}`
      const contribution = aggregate.get(key) ?? {
        worker_id: row.worker_id,
        worker_name: row.worker_name,
        model_operation_id: row.model_operation_id,
        patta_quantity: 0n,
        standalone_quantity: 0n,
        manual_quantity: 0n,
        patta_amount: new Decimal(0),
        standalone_amount: new Decimal(0),
        manual_amount: new Decimal(0)
      }
      const operationTotal = totalByOperation.get(row.model_operation_id) ?? {
        patta_quantity: 0n,
        standalone_quantity: 0n,
        manual_quantity: 0n,
        patta_amount: new Decimal(0),
        standalone_amount: new Decimal(0),
        manual_amount: new Decimal(0)
      }
      if (source === 'PATTA') {
        contribution.patta_quantity += BigInt(row.quantity)
        contribution.patta_amount = contribution.patta_amount.plus(amount)
        operationTotal.patta_quantity += BigInt(row.quantity)
        operationTotal.patta_amount = operationTotal.patta_amount.plus(amount)
      } else if (source === 'STANDALONE') {
        contribution.standalone_quantity += BigInt(row.quantity)
        contribution.standalone_amount = contribution.standalone_amount.plus(amount)
        operationTotal.standalone_quantity += BigInt(row.quantity)
        operationTotal.standalone_amount = operationTotal.standalone_amount.plus(amount)
      } else {
        contribution.manual_quantity += BigInt(row.quantity)
        contribution.manual_amount = contribution.manual_amount.plus(amount)
        operationTotal.manual_quantity += BigInt(row.quantity)
        operationTotal.manual_amount = operationTotal.manual_amount.plus(amount)
      }
      aggregate.set(key, contribution)
      totalByOperation.set(row.model_operation_id, operationTotal)
      details.push({
        model_id: modelId,
        model_name: model.name,
        model_operation_id: row.model_operation_id,
        operation_name: row.operation_name,
        source,
        quantity: String(row.quantity),
        unit_price_snapshot: new Decimal(row.unit_price_snapshot).toFixed(2),
        gross_amount: amount.toFixed(2),
        entered_at: row.entered_at,
        manual_adjustment_id: adjustmentId,
        version: row.version ?? null,
        deleted_at: row.deleted_at ?? null,
        deleted_by: row.deleted_by ?? null
      })
    }
    for (const row of pattaRows) {
      addContribution(row, row.entry_kind === 'PATTA_LINKED' ? 'PATTA' : 'STANDALONE', null)
    }
    for (const row of manualRows) addContribution(row, 'MANUAL', row.adjustment_id)

    const rows: ModelAccountContributionRow[] = [...aggregate.values()].map((row) => ({
      worker_id: row.worker_id,
      worker_name: row.worker_name,
      model_operation_id: row.model_operation_id,
      patta_quantity: row.patta_quantity.toString(),
      standalone_quantity: row.standalone_quantity.toString(),
      manual_quantity: row.manual_quantity.toString(),
      total_quantity: (row.patta_quantity + row.standalone_quantity + row.manual_quantity).toString(),
      patta_amount: row.patta_amount.toFixed(2),
      standalone_amount: row.standalone_amount.toFixed(2),
      manual_amount: row.manual_amount.toFixed(2),
      gross_amount: row.patta_amount.plus(row.standalone_amount).plus(row.manual_amount).toFixed(2)
    })).sort((left, right) => left.worker_name.localeCompare(right.worker_name) ||
      left.worker_id.localeCompare(right.worker_id) || left.model_operation_id.localeCompare(right.model_operation_id))

    const operationTotals: ModelAccountOperationTotal[] = operations.map((operation) => {
      const total = totalByOperation.get(operation.model_operation_id) ?? {
        patta_quantity: 0n,
        standalone_quantity: 0n,
        manual_quantity: 0n,
        patta_amount: new Decimal(0),
        standalone_amount: new Decimal(0),
        manual_amount: new Decimal(0)
      }
      return {
        model_operation_id: operation.model_operation_id,
        operation_name: operation.operation_name,
        sort_order: operation.sort_order,
        version: operation.version,
        status: operation.status,
        current_price: operation.current_price === null ? null : new Decimal(operation.current_price).toFixed(2),
        quantity: (total.patta_quantity + total.standalone_quantity + total.manual_quantity).toString(),
        patta_quantity: total.patta_quantity.toString(),
        standalone_quantity: total.standalone_quantity.toString(),
        manual_quantity: total.manual_quantity.toString(),
        gross_amount: total.patta_amount.plus(total.standalone_amount).plus(total.manual_amount).toFixed(2),
        patta_amount: total.patta_amount.toFixed(2),
        standalone_amount: total.standalone_amount.toFixed(2),
        manual_amount: total.manual_amount.toFixed(2)
      }
    })
    return { model_id: modelId, model_name: model.name, operations: operationTotals, rows }
  }

  getWorkerDetails(workerId: string): readonly ModelAccountWorkerDetail[] {
    if (!/^[1-9][0-9]*$/.test(workerId)) throw new LocalDomainError('WORKER_NOT_FOUND', 'Ishchi topilmadi', { worker_id: workerId })
    const result = this.database.prepare(`
      SELECT sheet.model_id, sheet.model_name_snapshot AS model_name, snapshot.model_operation_id,
        snapshot.operation_name_snapshot AS operation_name,
        CASE WHEN sheet.entry_kind = 'PATTA_LINKED' THEN 'PATTA' ELSE 'STANDALONE' END AS source,
        sheet_row.quantity_snapshot AS quantity, snapshot.unit_price_snapshot, sheet.entered_at,
        NULL AS manual_adjustment_id, sheet.version AS version,
        NULL AS deleted_at, NULL AS deleted_by
      FROM patta_sheet_rows sheet_row
      JOIN patta_sheets sheet ON sheet.id = sheet_row.patta_sheet_id
      JOIN patta_sheet_operation_snapshots snapshot ON snapshot.id = sheet_row.patta_sheet_operation_snapshot_id
      WHERE sheet_row.worker_id = ? AND sheet.deleted_at IS NULL AND sheet_row.deleted_at IS NULL
      UNION ALL
      SELECT adjustment.model_id, model.name, adjustment.model_operation_id, operation.name, 'MANUAL',
        adjustment.quantity, adjustment.unit_price_snapshot, adjustment.entered_at, adjustment.id,
        adjustment.version, adjustment.deleted_at, adjustment.deleted_by
      FROM model_account_adjustments adjustment
      JOIN models model ON model.id = adjustment.model_id
      JOIN model_operations operation ON operation.id = adjustment.model_operation_id
      WHERE adjustment.worker_id = ?
      ORDER BY entered_at DESC, model_id, model_operation_id, source
    `).all(workerId, workerId) as Array<{
      model_id: string
      model_name: string
      model_operation_id: string
      operation_name: string
      source: 'PATTA' | 'STANDALONE' | 'MANUAL'
      quantity: number
      unit_price_snapshot: string
      entered_at: string
      manual_adjustment_id: string | null
      version: string | null
      deleted_at: string | null
      deleted_by: string | null
    }>
    return result.map((row) => ({
      ...row,
      quantity: String(row.quantity),
      unit_price_snapshot: new Decimal(row.unit_price_snapshot).toFixed(2),
      gross_amount: new Decimal(row.unit_price_snapshot).mul(row.quantity).toFixed(2)
    }))
  }

  getConveyorAccount(): readonly ConveyorAccountRow[] {
    const contributions = this.database.prepare(`
      SELECT COALESCE(sheet.conveyor_snapshot, 'Noma’lum') AS conveyor_label,
        sheet.model_id, sheet.model_name_snapshot AS model_name, sheet.entry_kind,
        sheet.ish_soni AS quantity
      FROM patta_sheets sheet WHERE sheet.deleted_at IS NULL
      UNION ALL
      SELECT 'Noma’lum', adjustment.model_id, model.name, 'MANUAL', adjustment.quantity
      FROM model_account_adjustments adjustment JOIN models model ON model.id = adjustment.model_id
      WHERE adjustment.deleted_at IS NULL
    `).all() as Array<{
      conveyor_label: string
      model_id: string
      model_name: string
      entry_kind: 'PATTA_LINKED' | 'STANDALONE' | 'MANUAL'
      quantity: number
    }>
    const totals = new Map<string, {
      conveyor_label: string
      model_id: string
      model_name: string
      patta_count: bigint
      standalone_entry_count: bigint
      manual_adjustment_count: bigint
      ish_soni: bigint
    }>()
    for (const row of contributions) {
      const key = `${row.conveyor_label}\u0000${row.model_id}`
      const total = totals.get(key) ?? {
        conveyor_label: row.conveyor_label,
        model_id: row.model_id,
        model_name: row.model_name,
        patta_count: 0n,
        standalone_entry_count: 0n,
        manual_adjustment_count: 0n,
        ish_soni: 0n
      }
      if (row.entry_kind === 'PATTA_LINKED') total.patta_count += 1n
      else if (row.entry_kind === 'STANDALONE') total.standalone_entry_count += 1n
      else total.manual_adjustment_count += 1n
      total.ish_soni += BigInt(row.quantity)
      totals.set(key, total)
    }
    return [...totals.values()].map((row) => ({
      conveyor_label: row.conveyor_label,
      model_id: row.model_id,
      model_name: row.model_name,
      patta_count: row.patta_count.toString(),
      standalone_entry_count: row.standalone_entry_count.toString(),
      manual_adjustment_count: row.manual_adjustment_count.toString(),
      ish_soni: row.ish_soni.toString()
    })).sort((left, right) => left.conveyor_label.localeCompare(right.conveyor_label) ||
      left.model_name.localeCompare(right.model_name) || left.model_id.localeCompare(right.model_id))
  }
}
