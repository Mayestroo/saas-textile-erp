import type Database from 'better-sqlite3'
import type { ModelAccountAdjustmentProjection } from '@textile/sync-protocol'
import { LocalDomainError } from './local-errors'

export type LocalAdjustmentOwnership = 'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED'

export interface PersistedModelAccountAdjustment extends ModelAccountAdjustmentProjection {
  ownership_state: LocalAdjustmentOwnership
  server_sequence: string | null
}

export class ModelAccountAdjustmentRepository {
  constructor(private readonly database: Database.Database) {}

  createLocal(adjustment: ModelAccountAdjustmentProjection): PersistedModelAccountAdjustment {
    this.assertTransaction()
    this.database.prepare(`
      INSERT INTO model_account_adjustments (
        id, model_id, model_operation_id, worker_id, quantity, unit_price_snapshot,
        entered_at, business_date, version, created_by, created_device_id,
        created_at, updated_at, deleted_at, deleted_by, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_PENDING', NULL)
    `).run(
      adjustment.id, adjustment.model_id, adjustment.model_operation_id, adjustment.worker_id,
      adjustment.quantity, adjustment.unit_price_snapshot, adjustment.entered_at, adjustment.business_date,
      adjustment.version, adjustment.created_by, adjustment.created_device_id,
      adjustment.created_at, adjustment.updated_at, adjustment.deleted_at, adjustment.deleted_by
    )
    return { ...adjustment, ownership_state: 'LOCAL_PENDING', server_sequence: null }
  }

  updateLocal(adjustment: ModelAccountAdjustmentProjection): PersistedModelAccountAdjustment {
    this.assertTransaction()
    const update = this.database.prepare(`
      UPDATE model_account_adjustments SET quantity = ?, version = ?, updated_at = ?,
        deleted_at = ?, deleted_by = ?, ownership_state = 'LOCAL_PENDING', server_sequence = NULL
      WHERE id = ?
    `).run(adjustment.quantity, adjustment.version, adjustment.updated_at,
      adjustment.deleted_at, adjustment.deleted_by, adjustment.id)
    if (update.changes !== 1) {
      throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_NOT_FOUND', 'Model hisob yozuvi topilmadi')
    }
    return { ...adjustment, ownership_state: 'LOCAL_PENDING', server_sequence: null }
  }

  applyServerProjection(adjustment: ModelAccountAdjustmentProjection, sequence: string): boolean {
    this.assertTransaction()
    const current = this.database.prepare(`
      SELECT ownership_state FROM model_account_adjustments WHERE id = ?
    `).get(adjustment.id) as { ownership_state: LocalAdjustmentOwnership } | undefined
    if (current && current.ownership_state !== 'SERVER_SYNCED') return false
    if (current) {
      const existing = this.getById(adjustment.id)
      if (!existing || existing.model_id !== adjustment.model_id ||
        existing.model_operation_id !== adjustment.model_operation_id || existing.worker_id !== adjustment.worker_id ||
        existing.unit_price_snapshot !== adjustment.unit_price_snapshot ||
        existing.entered_at !== adjustment.entered_at || existing.business_date !== adjustment.business_date) {
        throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_IDENTITY_CONFLICT', 'Server adjustment identity differs from its immutable local snapshot')
      }
    }
    this.database.prepare(`
      INSERT INTO model_account_adjustments (
        id, model_id, model_operation_id, worker_id, quantity, unit_price_snapshot,
        entered_at, business_date, version, created_by, created_device_id,
        created_at, updated_at, deleted_at, deleted_by, ownership_state, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SERVER_SYNCED', ?)
      ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity, version = excluded.version,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by,
        ownership_state = 'SERVER_SYNCED', server_sequence = excluded.server_sequence
    `).run(
      adjustment.id, adjustment.model_id, adjustment.model_operation_id, adjustment.worker_id,
      adjustment.quantity, adjustment.unit_price_snapshot, adjustment.entered_at, adjustment.business_date,
      adjustment.version, adjustment.created_by, adjustment.created_device_id,
      adjustment.created_at, adjustment.updated_at, adjustment.deleted_at, adjustment.deleted_by, sequence
    )
    this.database.prepare(`
      DELETE FROM sync_tombstones WHERE entity_type = 'model_account_adjustments' AND entity_id = ?
    `).run(adjustment.id)
    return true
  }

  getById(adjustmentId: string): PersistedModelAccountAdjustment | null {
    const row = this.database.prepare(`
      SELECT id, model_id, model_operation_id, worker_id, quantity, unit_price_snapshot,
        entered_at, business_date, version, created_by, created_device_id, created_at,
        updated_at, deleted_at, deleted_by, ownership_state, server_sequence
      FROM model_account_adjustments WHERE id = ?
    `).get(adjustmentId) as PersistedModelAccountAdjustment | undefined
    return row ?? null
  }

  listForModel(modelId: string, includeDeleted = false): readonly PersistedModelAccountAdjustment[] {
    return this.database.prepare(`
      SELECT id, model_id, model_operation_id, worker_id, quantity, unit_price_snapshot,
        entered_at, business_date, version, created_by, created_device_id, created_at,
        updated_at, deleted_at, deleted_by, ownership_state, server_sequence
      FROM model_account_adjustments
      WHERE model_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY entered_at, id
    `).all(modelId) as PersistedModelAccountAdjustment[]
  }

  ownershipState(adjustmentId: string): LocalAdjustmentOwnership | null {
    const row = this.database.prepare(`
      SELECT ownership_state FROM model_account_adjustments WHERE id = ?
    `).get(adjustmentId) as { ownership_state: LocalAdjustmentOwnership } | undefined
    return row?.ownership_state ?? null
  }

  setOwnershipState(adjustmentId: string, state: LocalAdjustmentOwnership): void {
    this.database.prepare(`
      UPDATE model_account_adjustments SET ownership_state = ? WHERE id = ?
        AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(state, adjustmentId)
  }

  private assertTransaction(): void {
    if (!this.database.inTransaction) {
      throw new Error('Model Account adjustment persistence requires a SQLite transaction')
    }
  }
}
