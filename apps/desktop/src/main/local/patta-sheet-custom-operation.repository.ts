import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { LocalDomainError } from './local-errors'

const PRICE_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{2}$/
const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g

export interface CustomOperationDraft {
  id: string
  name: string
  initial_price: string
}

export interface LocalCustomOperation {
  id: string
  model_id: string
  name: string
  unit_price: string
  sort_order: number
  is_new: boolean
}

interface ExistingOperationRow {
  id: string
  model_id: string
  name: string
  sort_order: number
  price_id: string | null
  price: string | null
}

function canonicalName(value: string): string {
  return value.replace(ASCII_WHITESPACE, ' ').trim()
}

export class PattaSheetCustomOperationRepository {
  constructor(private readonly database: Database.Database, private readonly idFactory: () => string = randomUUID) {}

  createOrReuse(modelId: string, enteredAt: string, draft: CustomOperationDraft, sortOrder: number): LocalCustomOperation {
    if (!this.database.inTransaction) throw new Error('Custom operation writes require a SQLite transaction')
    const name = canonicalName(draft.name)
    const price = draft.initial_price.trim()
    if (!name || name.length > 500 || !PRICE_PATTERN.test(price)) {
      throw new LocalDomainError('CUSTOM_OPERATION_INVALID', 'Yangi operatsiya nomi yoki narxi yaroqsiz')
    }
    const existingRows = this.database.prepare(`
      SELECT operation.id, operation.model_id, operation.name, operation.sort_order,
        price.id AS price_id, price.price
      FROM model_operations operation
      LEFT JOIN model_operation_prices price ON price.operation_id = operation.id
        AND price.valid_from <= ? AND (price.valid_to IS NULL OR ? < price.valid_to)
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'model_operation_prices' AND tombstone.entity_id = price.id
        )
      WHERE operation.model_id = ? AND operation.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'model_operations' AND tombstone.entity_id = operation.id
        )
      ORDER BY operation.id
    `).all(enteredAt, enteredAt, modelId) as ExistingOperationRow[]
    const matchingRows = existingRows.filter(({ name: existingName }) =>
      canonicalName(existingName).toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))
    if (matchingRows.length > 1) {
      throw new LocalDomainError('OPERATION_NAME_AMBIGUOUS', 'Shu nomdagi bir nechta faol operatsiya bor')
    }
    const existing = matchingRows[0]
    if (existing) {
      if (existing.price_id === null || existing.price === null) {
        throw new LocalDomainError('OPERATION_PRICE_NOT_FOUND', 'Mavjud operatsiya uchun Kiritilgan vaqtga mos narx topilmadi')
      }
      if (existing.price !== price) {
        throw new LocalDomainError('CUSTOM_OPERATION_PRICE_MISMATCH', 'Shu nomdagi faol operatsiyaning amaldagi narxi boshqacha')
      }
      return {
        id: existing.id,
        model_id: existing.model_id,
        name: existing.name,
        unit_price: existing.price,
        sort_order: sortOrder,
        is_new: false
      }
    }

    const operationId = draft.id.toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
      throw new LocalDomainError('LOCAL_ID_INVALID', 'Yangi operatsiyaning UUID formati noto‘g‘ri')
    }
    const existingId = this.database.prepare('SELECT id FROM model_operations WHERE id = ?').get(operationId)
    if (existingId) throw new LocalDomainError('LOCAL_ID_COLLISION', 'Yangi operatsiya UUID takrorlandi')
    this.database.prepare(`
      INSERT INTO model_operations (id, model_id, name, sort_order, status, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', '1', ?, ?)
    `).run(operationId, modelId, name, sortOrder, enteredAt, enteredAt)
    this.database.prepare(`
      INSERT INTO model_operation_prices (id, operation_id, price, valid_from, valid_to, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(this.idFactory().toLowerCase(), operationId, price, enteredAt, enteredAt)
    return { id: operationId, model_id: modelId, name, unit_price: price, sort_order: sortOrder, is_new: true }
  }
}
