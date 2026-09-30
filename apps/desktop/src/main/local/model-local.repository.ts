import type Database from 'better-sqlite3'
import type { OperationPriceChangeProjection, SyncPattaCreatePayload } from '@textile/sync-protocol'
import { LocalDomainError } from './local-errors'
import { canonicalUtcTimestamp } from './utc-timestamp'

const PRICE_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{2}$/
const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g

interface ModelRow {
  id: string
  name: string
  status: 'ACTIVE' | 'INACTIVE'
  version: string
}

interface TemplateRow {
  id: string
  model_id: string
  konveyer: string | null
  razmer: string | null
  rang: string | null
  status: 'ACTIVE' | 'INACTIVE'
  version: string
}

interface OperationPriceRow {
  operation_id: string
  model_id: string
  name: string
  sort_order: number
  version: string
  price_id: string | null
  price: string | null
}

export interface LocalPattaReferenceInput {
  model_id?: string
  template_id?: string
  konveyer?: string
  razmer?: string | null
  rang?: string | null
  occurred_at: string
}

export interface LocalOperationReference {
  operation_id: string
  operation_name: string
  unit_price: string
  sort_order: number
  version: string
}

export interface LocalPattaReferenceSnapshot {
  model_id: string
  model_name: string
  model_version: string
  template_id: string | null
  template_version: string | null
  konveyer: string | null
  razmer: string | null
  rang: string | null
  template_overrides?: SyncPattaCreatePayload['template_overrides']
  reference_versions: SyncPattaCreatePayload['reference_versions']
  operations: readonly LocalOperationReference[]
}

export interface LocalModelOption {
  id: string
  name: string
}

function canonicalize(value: string): string {
  return value.replace(ASCII_WHITESPACE, ' ').trim()
}

function requiredCanonical(value: string | undefined, field: string): string {
  const result = value === undefined ? '' : canonicalize(value)
  if (result === '') {
    throw new LocalDomainError('PATTA_FIELD_REQUIRED', `${field} bo‘sh bo‘lishi mumkin emas`, {
      field
    })
  }
  return result
}

function optionalCanonical(
  value: string | null | undefined,
  fallback: string | null
): string | null {
  if (value === undefined) return fallback
  if (value === null) return null
  return requiredCanonical(value, 'Patta qiymati')
}

function notFound(code: string, message: string, id: string): LocalDomainError {
  return new LocalDomainError(code, message, { id })
}

export class ModelLocalRepository {
  constructor(private readonly database: Database.Database) {}

  listActiveModels(): readonly LocalModelOption[] {
    return this.database.prepare(`
      SELECT model.id, model.name FROM models AS model
      WHERE model.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'models' AND tombstone.entity_id = model.id
        )
      ORDER BY model.name COLLATE NOCASE, model.id
    `).all() as LocalModelOption[]
  }

  listModelsWithPattaHistory(): readonly LocalModelOption[] {
    return this.database.prepare(`
      SELECT model.id, model.name FROM models AS model
      WHERE NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'models' AND tombstone.entity_id = model.id
        )
        AND (model.status = 'ACTIVE' OR EXISTS (
          SELECT 1 FROM patta_hisob patta WHERE patta.model_id = model.id
        ) OR EXISTS (
          SELECT 1 FROM patta_sheets sheet WHERE sheet.model_id = model.id
        ) OR EXISTS (
          SELECT 1 FROM model_account_adjustments adjustment WHERE adjustment.model_id = model.id
        ))
      ORDER BY model.name COLLATE NOCASE, model.id
    `).all() as LocalModelOption[]
  }

  applyOnlinePriceChange(change: OperationPriceChangeProjection): void {
    if (!this.database.inTransaction) throw new Error('Online price mirror update requires a SQLite transaction')
    const operation = this.database.prepare(`
      SELECT id, model_id, version FROM model_operations WHERE id = ?
    `).get(change.operation_id) as { id: string; model_id: string; version: string } | undefined
    if (!operation) throw notFound('OPERATION_NOT_FOUND', 'Operatsiya topilmadi', change.operation_id)
    const closeCurrent = this.database.prepare(`
      UPDATE model_operation_prices SET valid_to = ?
      WHERE operation_id = ? AND valid_to IS NULL AND valid_from < ?
    `).run(change.valid_from, change.operation_id, change.valid_from)
    if (closeCurrent.changes === 0) {
      const existing = this.database.prepare(`
        SELECT id FROM model_operation_prices WHERE operation_id = ? AND id = ?
      `).get(change.operation_id, change.id)
      if (!existing) throw new LocalDomainError('OPERATION_PRICE_HISTORY_STALE', 'Mahalliy narx tarixi serverdagi o‘zgarishga mos emas')
    }
    this.database.prepare(`
      INSERT INTO model_operation_prices (
        id, operation_id, price, valid_from, valid_to, created_at, server_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET price = excluded.price, valid_from = excluded.valid_from,
        valid_to = excluded.valid_to, created_at = excluded.created_at
    `).run(change.id, change.operation_id, change.price, change.valid_from, change.valid_to,
      change.created_at)
    this.database.prepare('UPDATE model_operations SET version = ? WHERE id = ?')
      .run(change.operation_version, change.operation_id)
  }

  snapshotAt(input: LocalPattaReferenceInput): LocalPattaReferenceSnapshot {
    let occurredAt: string
    try {
      occurredAt = canonicalUtcTimestamp(input.occurred_at, 'Patta occurred_at')
    } catch {
      throw new LocalDomainError(
        'PATTA_OCCURRED_AT_INVALID',
        'Ish vaqti ISO-8601 ko‘rinishida bo‘lishi kerak',
        { field: 'occurred_at' }
      )
    }

    const template = input.template_id === undefined ? null : this.findTemplate(input.template_id)
    const modelId = template?.model_id ?? input.model_id
    if (!modelId) {
      throw new LocalDomainError('PATTA_MODEL_REQUIRED', 'Patta yaratish uchun model tanlang')
    }

    const model = this.database
      .prepare(
        `
      SELECT model.id, model.name, model.status, model.version
      FROM models AS model
      WHERE model.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'models' AND tombstone.entity_id = model.id
        )
    `
      )
      .get(modelId) as ModelRow | undefined
    if (!model) throw notFound('MODEL_NOT_FOUND', 'Model topilmadi', modelId)
    if (model.status !== 'ACTIVE') {
      throw new LocalDomainError('MODEL_INACTIVE', 'Tanlangan model faol emas', {
        model_id: modelId
      })
    }
    if (template && template.model_id !== model.id) {
      throw new LocalDomainError(
        'PATTA_TEMPLATE_MODEL_MISMATCH',
        'Qolip tanlangan modelga tegishli emas',
        { template_id: template.id, model_id: model.id }
      )
    }

    const conveyor =
      input.konveyer === undefined
        ? (template?.konveyer ?? null)
        : requiredCanonical(input.konveyer, 'Konveyer')
    const size = optionalCanonical(input.razmer, template?.razmer ?? null)
    const color = optionalCanonical(input.rang, template?.rang ?? null)
    const templateOverrides = template
      ? {
          ...(input.konveyer === undefined
            ? {}
            : { konveyer: requiredCanonical(input.konveyer, 'Konveyer') }),
          ...(input.razmer === undefined ? {} : { razmer: optionalCanonical(input.razmer, null) }),
          ...(input.rang === undefined ? {} : { rang: optionalCanonical(input.rang, null) })
        }
      : undefined

    const rows = this.database
      .prepare(
        `
      SELECT operation.id AS operation_id, operation.model_id, operation.name,
        operation.sort_order, operation.version, price.id AS price_id, price.price
      FROM model_operations AS operation
      LEFT JOIN model_operation_prices AS price
        ON price.operation_id = operation.id
        AND price.valid_from <= ?
        AND (price.valid_to IS NULL OR ? < price.valid_to)
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS price_tombstone
          WHERE price_tombstone.entity_type = 'model_operation_prices'
            AND price_tombstone.entity_id = price.id
        )
      WHERE operation.model_id = ? AND operation.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS operation_tombstone
          WHERE operation_tombstone.entity_type = 'model_operations'
            AND operation_tombstone.entity_id = operation.id
        )
      ORDER BY operation.sort_order, operation.id
    `
      )
      .all(occurredAt, occurredAt, model.id) as OperationPriceRow[]

    if (rows.length === 0) {
      throw new LocalDomainError(
        'MODEL_HAS_NO_ACTIVE_OPERATIONS',
        'Tanlangan modelda faol operatsiyalar yo‘q',
        { model_id: model.id }
      )
    }

    const seenOperationIds = new Set<string>()
    const operations = rows.map((row): LocalOperationReference => {
      if (seenOperationIds.has(row.operation_id)) {
        throw new LocalDomainError(
          'OPERATION_PRICE_AMBIGUOUS',
          'Operatsiya uchun bir nechta amaldagi narx topildi',
          { operation_id: row.operation_id }
        )
      }
      seenOperationIds.add(row.operation_id)
      if (row.price_id === null || row.price === null) {
        throw new LocalDomainError(
          'OPERATION_PRICE_NOT_FOUND',
          'Operatsiya uchun shu vaqtga mos narx topilmadi',
          { operation_id: row.operation_id }
        )
      }
      if (!PRICE_PATTERN.test(row.price)) {
        throw new LocalDomainError(
          'OPERATION_PRICE_INVALID',
          'Mahalliy narx decimal formatida yaroqsiz',
          { operation_id: row.operation_id }
        )
      }
      return {
        operation_id: row.operation_id,
        operation_name: row.name,
        unit_price: row.price,
        sort_order: row.sort_order,
        version: row.version
      }
    })

    return {
      model_id: model.id,
      model_name: model.name,
      model_version: model.version,
      template_id: template?.id ?? null,
      template_version: template?.version ?? null,
      konveyer: conveyor,
      razmer: size,
      rang: color,
      ...(template && templateOverrides && Object.keys(templateOverrides).length > 0
        ? { template_overrides: templateOverrides }
        : {}),
      reference_versions: {
        model: model.version,
        template: template?.version ?? null,
        operations: Object.fromEntries(
          operations.map((operation) => [operation.operation_id, operation.version])
        )
      },
      operations
    }
  }

  private findTemplate(templateId: string): TemplateRow {
    const template = this.database
      .prepare(
        `
      SELECT template.id, template.model_id, template.konveyer, template.razmer,
        template.rang, template.status, template.version
      FROM patta_templates AS template
      WHERE template.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones AS tombstone
          WHERE tombstone.entity_type = 'patta_templates' AND tombstone.entity_id = template.id
        )
    `
      )
      .get(templateId) as TemplateRow | undefined
    if (!template) throw notFound('PATTA_TEMPLATE_NOT_FOUND', 'Qolip topilmadi', templateId)
    if (template.status !== 'ACTIVE') {
      throw new LocalDomainError('PATTA_TEMPLATE_INACTIVE', 'Tanlangan qolip faol emas', {
        template_id: templateId
      })
    }
    return template
  }
}
