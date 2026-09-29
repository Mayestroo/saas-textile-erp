import type Database from 'better-sqlite3'
import type {
  OfflinePattaCreateEvent,
  PattaPrintEventSyncEvent,
  PattaPrintBatchMutationPayload,
  PattaPrintBatchProjection,
  PattaPrintBatchSyncEvent,
  PattaSheetMutationPayload,
  PattaSheetProjection,
  PattaSheetSyncEvent,
  CustomModelOperationCreateEvent,
  SyncPattaCreatePayload,
  SyncPattaOperationSnapshotInput,
  SyncProjection,
  SyncPushResult
} from '@textile/sync-protocol'
import { isJsonObject, parseLocalJson, serializeLocalJson } from './local-json'
import { assertPostgresBigint } from './decimal-string'
import { LocalDomainError } from './local-errors'

interface StoredQueueEvent {
  event_id: string
  entity_type: string
  entity_id: string
  operation: string
  base_version: string
  client_created_at: string
  occurred_at: string
  reference_cursor: string
  payload_json: string
}

interface QueueEntityRow {
  entity_id: string
  entity_type: string
}

interface LocalPattaEchoRow {
  id: string
  partiya_number: string
  patta_number: string
  model_id: string
  model_name_snapshot: string
  template_id: string | null
  konveyer_snapshot: string | null
  razmer: string | null
  rang: string | null
  ish_soni: number
  created_device_id: string
  created_from_block_id: string | null
}

type ServerPattaProjection = Extract<SyncProjection, { entity_type: 'patta_hisob' }>

type QueueStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'CONFLICT' | 'FAILED'
type LocalQueuedEvent = OfflinePattaCreateEvent | PattaPrintBatchSyncEvent | PattaPrintEventSyncEvent |
  PattaSheetSyncEvent | CustomModelOperationCreateEvent

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Stored Patta event has invalid ${field}`)
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return requiredString(value, field)
}

function parseSnapshot(value: unknown): SyncPattaOperationSnapshotInput {
  if (!isJsonObject(value)) throw new Error('Stored Patta event has an invalid operation snapshot')
  const sortOrder = value.sort_order
  if (typeof sortOrder !== 'number' || !Number.isSafeInteger(sortOrder) || sortOrder < 0) {
    throw new Error('Stored Patta event has an invalid operation sort order')
  }
  return {
    id: requiredString(value.id, 'operation snapshot id'),
    operation_id: requiredString(value.operation_id, 'operation id'),
    operation_name_snapshot: requiredString(value.operation_name_snapshot, 'operation name'),
    unit_price_snapshot: requiredString(value.unit_price_snapshot, 'operation price snapshot'),
    sort_order: sortOrder
  }
}

function parseReferenceVersions(value: unknown): SyncPattaCreatePayload['reference_versions'] {
  if (!isJsonObject(value) || !isJsonObject(value.operations)) {
    throw new Error('Stored Patta event has invalid reference versions')
  }
  const operations = Object.fromEntries(
    Object.entries(value.operations).map(([operationId, version]) => [
      operationId,
      requiredString(version, `operation version for ${operationId}`)
    ])
  )
  return {
    model: requiredString(value.model, 'model version'),
    template: nullableString(value.template, 'template version'),
    operations
  }
}

function parsePattaPayload(json: string): SyncPattaCreatePayload {
  const value = parseLocalJson(json)
  if (!isJsonObject(value) || !Array.isArray(value.operations)) {
    throw new Error('Stored queue payload is not an offline Patta create payload')
  }
  const productQuantity = value.ish_soni
  if (
    typeof productQuantity !== 'number' ||
    !Number.isSafeInteger(productQuantity) ||
    productQuantity <= 0
  ) {
    throw new Error('Stored Patta event has invalid product quantity')
  }
  const templateOverrides = value.template_overrides
  let parsedTemplateOverrides: SyncPattaCreatePayload['template_overrides']
  if (templateOverrides !== undefined) {
    if (!isJsonObject(templateOverrides)) {
      throw new Error('Stored Patta event has invalid template overrides')
    }
    const overrides: NonNullable<SyncPattaCreatePayload['template_overrides']> = {}
    if (templateOverrides.konveyer !== undefined) {
      overrides.konveyer = requiredString(templateOverrides.konveyer, 'template conveyor override')
    }
    if (templateOverrides.razmer !== undefined) {
      overrides.razmer = nullableString(templateOverrides.razmer, 'template size override')
    }
    if (templateOverrides.rang !== undefined) {
      overrides.rang = nullableString(templateOverrides.rang, 'template color override')
    }
    parsedTemplateOverrides = overrides
  }

  return {
    ish_soni: productQuantity,
    partiya_number: requiredString(value.partiya_number, 'partiya number'),
    patta_number: requiredString(value.patta_number, 'Patta number'),
    model_id: requiredString(value.model_id, 'model id'),
    model_name_snapshot: requiredString(value.model_name_snapshot, 'model name snapshot'),
    template_id: nullableString(value.template_id, 'template id'),
    konveyer_snapshot: nullableString(value.konveyer_snapshot, 'conveyor snapshot'),
    razmer: nullableString(value.razmer, 'size'),
    rang: nullableString(value.rang, 'color'),
    block_id: requiredString(value.block_id, 'number block id'),
    ...(parsedTemplateOverrides === undefined
      ? {}
      : { template_overrides: parsedTemplateOverrides }),
    reference_versions: parseReferenceVersions(value.reference_versions),
    operations: value.operations.map(parseSnapshot)
  }
}

function parseCustomModelOperationPayload(json: string, eventId: string): CustomModelOperationCreateEvent['payload'] {
  const value = parseLocalJson(json)
  if (!isJsonObject(value) || Object.keys(value).some((key) => ![
    'id', 'model_id', 'name', 'initial_price', 'sort_order', 'effective_from'
  ].includes(key)) || value.id !== eventId || typeof value.model_id !== 'string' ||
    typeof value.name !== 'string' || !value.name.trim() || typeof value.initial_price !== 'string' ||
    !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value.initial_price) || !Number.isSafeInteger(value.sort_order) ||
    (value.sort_order as number) < 0 || typeof value.effective_from !== 'string' ||
    !Number.isFinite(Date.parse(value.effective_from))) {
    throw new Error('Stored custom model operation event has invalid payload')
  }
  return {
    id: requiredString(value.id, 'custom operation id'),
    model_id: requiredString(value.model_id, 'custom operation model id'),
    name: requiredString(value.name, 'custom operation name'),
    initial_price: requiredString(value.initial_price, 'custom operation initial price'),
    sort_order: value.sort_order as number,
    effective_from: requiredString(value.effective_from, 'custom operation effective time')
  }
}

function parsePrintBatchPayload(json: string): PattaPrintBatchMutationPayload {
  const value = parseLocalJson(json)
  if (!isJsonObject(value) || !Array.isArray(value.size_distribution) || !Array.isArray(value.pattas) ||
    !Array.isArray(value.depends_on_event_ids)) {
    throw new Error('Stored queue payload is not a v2 Patta print batch payload')
  }
  const productQuantity = value.ish_soni
  if (typeof productQuantity !== 'number' || !Number.isSafeInteger(productQuantity) || productQuantity <= 0) {
    throw new Error('Stored print batch has invalid product quantity')
  }
  const sizeDistribution = value.size_distribution.map((item) => {
    if (!isJsonObject(item) || !Number.isSafeInteger(item.patta_count) ||
      (item.patta_count as number) <= 0 || !Number.isSafeInteger(item.sort_order) ||
      (item.sort_order as number) < 0) {
      throw new Error('Stored print batch has an invalid size row')
    }
    return {
      id: requiredString(item.id, 'size id'),
      razmer: requiredString(item.razmer, 'size name'),
      patta_count: item.patta_count as number,
      sort_order: item.sort_order as number
    }
  })
  const pattas = value.pattas.map((item) => {
    if (!isJsonObject(item) || !Array.isArray(item.operation_snapshots)) {
      throw new Error('Stored print batch has an invalid Patta row')
    }
    const blockId = item.block_id === null ? null : requiredString(item.block_id, 'Patta number block id')
    return {
      id: requiredString(item.id, 'Patta id'),
      patta_number: requiredString(item.patta_number, 'Patta number'),
      block_id: blockId,
      razmer: requiredString(item.razmer, 'Patta size'),
      operation_snapshots: item.operation_snapshots.map(parseSnapshot)
    }
  })
  const correctionReason = value.correction_reason
  if (correctionReason !== undefined && (typeof correctionReason !== 'string' || correctionReason.trim().length < 3 || correctionReason.trim().length > 500)) {
    throw new Error('Stored print batch correction has an invalid reason')
  }
  return {
    model_id: requiredString(value.model_id, 'model id'),
    model_name_snapshot: requiredString(value.model_name_snapshot, 'model name snapshot'),
    partiya_block_id: value.partiya_block_id === null ? null : requiredString(value.partiya_block_id, 'Partiya block id'),
    partiya_number: requiredString(value.partiya_number, 'Partiya number'),
    ish_soni: productQuantity,
    rang: requiredString(value.rang, 'color'),
    size_distribution: sizeDistribution,
    pattas,
    depends_on_event_ids: value.depends_on_event_ids.map((id) => requiredString(id, 'dependency event id')),
    ...(typeof correctionReason === 'string' ? { correction_reason: correctionReason.trim() } : {})
  }
}

function parsePrintEventPayload(json: string): PattaPrintEventSyncEvent['payload'] {
  const value = parseLocalJson(json)
  if (!isJsonObject(value)) throw new Error('Stored queue payload is not a print event payload')
  const kind = value.kind
  const outcome = value.outcome
  if (kind !== 'INITIAL' && kind !== 'REPRINT' && kind !== 'CORRECTED_REPRINT') {
    throw new Error('Stored print event has an invalid kind')
  }
  if (outcome !== 'REQUESTED' && outcome !== 'SUCCEEDED' && outcome !== 'FAILED') {
    throw new Error('Stored print event has an invalid outcome')
  }
  const revision = value.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Stored print event has an invalid revision')
  }
  return {
    batch_id: requiredString(value.batch_id, 'batch id'),
    revision,
    kind,
    outcome,
    device_id: requiredString(value.device_id, 'device id')
  }
}

function parsePattaSheetPayload(json: string): PattaSheetMutationPayload {
  const value = parseLocalJson(json)
  const allowed = new Set([
    'patta_hisob_id', 'entered_at', 'business_date', 'conveyor_snapshot', 'deleted_at', 'deleted_by',
    'operation_snapshots', 'rows', 'depends_on_event_ids'
  ])
  if (!isJsonObject(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
    !Array.isArray(value.operation_snapshots) || !Array.isArray(value.rows) ||
    !Array.isArray(value.depends_on_event_ids)) {
    throw new Error('Stored Patta Sheet event has an invalid aggregate payload')
  }
  const enteredAt = requiredString(value.entered_at, 'Sheet entered_at')
  const businessDate = requiredString(value.business_date, 'Sheet business_date')
  if (!Number.isFinite(Date.parse(enteredAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error('Stored Patta Sheet event has an invalid entry timestamp or business date')
  }
  const conveyor = nullableString(value.conveyor_snapshot, 'Sheet conveyor')
  const deletedAt = nullableString(value.deleted_at, 'Sheet deleted_at')
  const deletedBy = nullableString(value.deleted_by, 'Sheet deleted_by')
  if ((deletedAt === null) !== (deletedBy === null) ||
    (deletedAt !== null && !Number.isFinite(Date.parse(deletedAt)))) {
    throw new Error('Stored Patta Sheet event has invalid deletion metadata')
  }
  const operationSnapshots = value.operation_snapshots.map((raw) => {
    if (!isJsonObject(raw) || Object.keys(raw).some((key) => ![
      'id', 'model_operation_id', 'source_type', 'source_patta_operation_snapshot_id',
      'operation_name_snapshot', 'unit_price_snapshot', 'sort_order'
    ].includes(key)) || (raw.source_type !== 'PATTA' && raw.source_type !== 'CUSTOM') ||
      !Number.isSafeInteger(raw.sort_order) || (raw.sort_order as number) < 0) {
      throw new Error('Stored Patta Sheet operation snapshot is invalid')
    }
    const sourceId = nullableString(raw.source_patta_operation_snapshot_id, 'source Patta snapshot id')
    if ((raw.source_type === 'PATTA') !== (sourceId !== null)) {
      throw new Error('Stored Patta Sheet operation source metadata is invalid')
    }
    return {
      id: requiredString(raw.id, 'Sheet operation snapshot id'),
      model_operation_id: requiredString(raw.model_operation_id, 'model operation id'),
      source_type: raw.source_type as 'PATTA' | 'CUSTOM',
      source_patta_operation_snapshot_id: sourceId,
      operation_name_snapshot: requiredString(raw.operation_name_snapshot, 'operation name snapshot'),
      unit_price_snapshot: requiredString(raw.unit_price_snapshot, 'operation price snapshot'),
      sort_order: raw.sort_order as number
    }
  })
  const rows = value.rows.map((raw) => {
    if (!isJsonObject(raw) || Object.keys(raw).some((key) => ![
      'id', 'patta_sheet_operation_snapshot_id', 'worker_id', 'quantity_snapshot', 'nuqson',
      'entered_badge_number', 'deleted_at', 'deleted_by'
    ].includes(key)) || !Number.isSafeInteger(raw.quantity_snapshot) ||
      (raw.quantity_snapshot as number) < 1 || typeof raw.nuqson !== 'boolean') {
      throw new Error('Stored Patta Sheet row is invalid')
    }
    const rowDeletedAt = nullableString(raw.deleted_at, 'Sheet row deleted_at')
    const rowDeletedBy = nullableString(raw.deleted_by, 'Sheet row deleted_by')
    if ((rowDeletedAt === null) !== (rowDeletedBy === null) ||
      (rowDeletedAt !== null && !Number.isFinite(Date.parse(rowDeletedAt)))) {
      throw new Error('Stored Patta Sheet row deletion metadata is invalid')
    }
    return {
      id: requiredString(raw.id, 'Sheet row id'),
      patta_sheet_operation_snapshot_id: requiredString(raw.patta_sheet_operation_snapshot_id, 'Sheet snapshot id'),
      worker_id: requiredString(raw.worker_id, 'worker id'),
      quantity_snapshot: raw.quantity_snapshot as number,
      nuqson: raw.nuqson,
      entered_badge_number: requiredString(raw.entered_badge_number, 'entered badge number'),
      deleted_at: rowDeletedAt,
      deleted_by: rowDeletedBy
    }
  })
  return {
    patta_hisob_id: requiredString(value.patta_hisob_id, 'Patta id'),
    entered_at: enteredAt,
    business_date: businessDate,
    conveyor_snapshot: conveyor,
    deleted_at: deletedAt,
    deleted_by: deletedBy,
    operation_snapshots: operationSnapshots,
    rows,
    depends_on_event_ids: value.depends_on_event_ids.map((id) => requiredString(id, 'dependency event id'))
  }
}

function storedEvent(row: StoredQueueEvent): LocalQueuedEvent {
  if (row.entity_type === 'patta') {
    if (row.operation !== 'CREATE' || row.base_version !== '0') {
      throw new Error('Stored offline Patta event has an unsupported mutation')
    }
    return {
      event_id: row.event_id,
      entity_type: 'patta',
      entity_id: row.entity_id,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: row.client_created_at,
      occurred_at: row.occurred_at,
      reference_cursor: row.reference_cursor,
      payload: parsePattaPayload(row.payload_json)
    }
  }
  if (row.entity_type === 'patta_print_batch' &&
    (row.operation === 'CREATE' || row.operation === 'UPDATE') && row.base_version !== '') {
    return {
      event_id: row.event_id,
      entity_type: 'patta_print_batch',
      entity_id: row.entity_id,
      operation: row.operation,
      base_version: row.base_version,
      client_created_at: row.client_created_at,
      occurred_at: row.occurred_at,
      reference_cursor: row.reference_cursor,
      payload: parsePrintBatchPayload(row.payload_json)
    }
  }
  if (row.entity_type === 'patta_print_event' && row.operation === 'CREATE' && row.base_version === '0') {
    return {
      event_id: row.event_id,
      entity_type: 'patta_print_event',
      entity_id: row.entity_id,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: row.client_created_at,
      occurred_at: row.occurred_at,
      reference_cursor: row.reference_cursor,
      payload: parsePrintEventPayload(row.payload_json)
    }
  }
  if (row.entity_type === 'patta_sheet' &&
    ((row.operation === 'CREATE' && row.base_version === '0') ||
      ((row.operation === 'UPDATE' || row.operation === 'DELETE') && row.base_version !== '0'))) {
    return {
      event_id: row.event_id,
      entity_type: 'patta_sheet',
      entity_id: row.entity_id,
      operation: row.operation as PattaSheetSyncEvent['operation'],
      base_version: row.base_version,
      client_created_at: row.client_created_at,
      occurred_at: row.occurred_at,
      reference_cursor: row.reference_cursor,
      payload: parsePattaSheetPayload(row.payload_json)
    }
  }
  if (row.entity_type === 'model_operation' && row.operation === 'CREATE' && row.base_version === '0') {
    return {
      event_id: row.event_id,
      entity_type: 'model_operation',
      entity_id: row.entity_id,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: row.client_created_at,
      occurred_at: row.occurred_at,
      reference_cursor: row.reference_cursor,
      payload: parseCustomModelOperationPayload(row.payload_json, row.entity_id)
    }
  }
  throw new Error(`Stored sync event has an unsupported entity type or operation: ${row.entity_type}/${row.operation}`)
}

export class SyncQueueRepository {
  constructor(private readonly database: Database.Database) {}

  pendingPrintBatchMutation(entityId: string): {
    event_id: string
    operation: 'CREATE' | 'UPDATE'
    base_version: string
    status: QueueStatus
    ever_sent: number
  } | null {
    const row = this.database.prepare(`
      SELECT event_id, operation, base_version, status, ever_sent
      FROM sync_queue WHERE entity_type = 'patta_print_batch' AND entity_id = ?
        AND status IN ('PENDING', 'SYNCING', 'CONFLICT', 'FAILED')
      ORDER BY created_at, event_id LIMIT 1
    `).get(entityId) as {
      event_id: string
      operation: string
      base_version: string
      status: QueueStatus
      ever_sent: number
    } | undefined
    if (!row) return null
    if (row.operation !== 'CREATE' && row.operation !== 'UPDATE') {
      throw new LocalDomainError('PATTA_BATCH_MUTATION_PENDING', 'Patta to‘plamida noma’lum sinxronlash amali bor')
    }
    return { ...row, operation: row.operation }
  }

  pendingPattaSheetMutation(entityId: string): {
    event_id: string
    operation: 'CREATE' | 'UPDATE' | 'DELETE'
    base_version: string
    status: QueueStatus
    ever_sent: number
  } | null {
    const row = this.database.prepare(`
      SELECT event_id, operation, base_version, status, ever_sent
      FROM sync_queue WHERE entity_type = 'patta_sheet' AND entity_id = ?
        AND status IN ('PENDING', 'SYNCING', 'CONFLICT', 'FAILED')
      ORDER BY created_at, event_id LIMIT 1
    `).get(entityId) as {
      event_id: string; operation: string; base_version: string; status: QueueStatus; ever_sent: number
    } | undefined
    if (!row) return null
    if (row.operation !== 'CREATE' && row.operation !== 'UPDATE' && row.operation !== 'DELETE') {
      throw new LocalDomainError('PATTA_SHEET_MUTATION_PENDING', 'Patta varag‘ida noma’lum sinxronlash amali bor')
    }
    return { ...row, operation: row.operation }
  }

  customOperationPrerequisiteEventIds(operationIds: readonly string[]): readonly string[] {
    if (operationIds.length === 0) return []
    const rows = this.database.prepare(`
      SELECT event_id FROM sync_queue WHERE entity_type = 'model_operation' AND operation = 'CREATE'
        AND entity_id IN (${operationIds.map(() => '?').join(', ')})
      ORDER BY created_at, event_id
    `).all(...operationIds) as Array<{ event_id: string }>
    return rows.map(({ event_id }) => event_id)
  }

  enqueue(event: LocalQueuedEvent): void {
    if (event.base_version === null || event.base_version === '') {
      throw new Error('Sync queue events require a nonempty base version')
    }
    if (event.entity_type === 'patta' && (event.operation !== 'CREATE' || event.base_version !== '0')) {
      throw new Error('Legacy offline Patta queue accepts CREATE events only')
    }
    if (event.entity_type === 'patta_print_batch' &&
      event.operation !== 'CREATE' && event.operation !== 'UPDATE') {
      throw new Error('Print batch queue accepts CREATE and UPDATE events only')
    }
    if (event.entity_type === 'patta_print_batch' && event.operation === 'UPDATE' &&
      (event.base_version === '0' || !event.payload.correction_reason)) {
      throw new Error('Print batch UPDATE requires a server version and correction reason')
    }
    if (event.entity_type === 'patta_print_event' && (event.operation !== 'CREATE' || event.base_version !== '0')) {
      throw new Error('Print event queue accepts CREATE events only')
    }
    if (event.entity_type === 'patta_sheet' && (
      (event.operation === 'CREATE' && event.base_version !== '0') ||
      (event.operation !== 'CREATE' && event.operation !== 'UPDATE' && event.operation !== 'DELETE') ||
      (event.operation !== 'CREATE' && event.base_version === '0')
    )) {
      throw new Error('Patta Sheet queue mutation or base version is invalid')
    }
    if (event.entity_type === 'model_operation' && (event.operation !== 'CREATE' || event.base_version !== '0' ||
      event.entity_id !== event.payload.id)) {
      throw new Error('Custom model operation queue mutation or identity is invalid')
    }

    const payloadJson = serializeLocalJson(event.payload)
    const existing = this.database
      .prepare(
        `
      SELECT event_id, entity_type, entity_id, operation, base_version, client_created_at, occurred_at,
        reference_cursor, payload_json
      FROM sync_queue WHERE event_id = ?
    `
      )
      .get(event.event_id) as StoredQueueEvent | undefined

    if (existing) {
      const sameEvent =
        existing.entity_type === event.entity_type &&
        existing.entity_id === event.entity_id &&
        existing.operation === event.operation &&
        existing.base_version === event.base_version &&
        existing.client_created_at === event.client_created_at &&
        existing.occurred_at === event.occurred_at &&
        existing.reference_cursor === event.reference_cursor &&
        existing.payload_json === payloadJson
      if (!sameEvent) throw new Error('event_id is already bound to a different local event')
      return
    }

    this.database
      .prepare(
        `
      INSERT INTO sync_queue (
        event_id, entity_type, entity_id, operation, base_version, client_created_at,
        occurred_at, reference_cursor, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `
      )
      .run(
        event.event_id,
        event.entity_type,
        event.entity_id,
        event.operation,
        event.base_version,
        event.client_created_at,
        event.occurred_at,
        event.reference_cursor,
        payloadJson,
        event.client_created_at,
        event.client_created_at
      )
    if (event.entity_type === 'patta_print_batch' || event.entity_type === 'patta_sheet') {
      const insertDependency = this.database.prepare(`
        INSERT INTO sync_event_dependencies (event_id, prerequisite_event_id, created_at)
        VALUES (?, ?, ?)
      `)
      for (const prerequisiteEventId of event.payload.depends_on_event_ids) {
        insertDependency.run(event.event_id, prerequisiteEventId, event.client_created_at)
      }
    }
  }

  enqueueOrCoalesceBatchCorrection(event: PattaPrintBatchSyncEvent): string {
    if (!this.database.inTransaction) {
      throw new Error('Patta correction queue writes require the local correction transaction')
    }
    if (event.entity_type !== 'patta_print_batch' || event.operation !== 'UPDATE' ||
      !event.payload.correction_reason) {
      throw new Error('Patta correction queue event is invalid')
    }
    const existingRows = this.database.prepare(`
      SELECT event_id, operation, base_version, status, ever_sent
      FROM sync_queue WHERE entity_type = 'patta_print_batch' AND entity_id = ?
        AND status IN ('PENDING', 'SYNCING', 'CONFLICT', 'FAILED')
      ORDER BY created_at, event_id
    `).all(event.entity_id) as Array<{
      event_id: string
      operation: string
      base_version: string
      status: QueueStatus
      ever_sent: number
    }>
    if (existingRows.length > 1) {
      throw new LocalDomainError('PATTA_BATCH_MUTATION_PENDING', 'Patta to‘plamining oldingi sinxronlash hodisasi hal qilinmagan')
    }
    const existing = existingRows[0]
    if (existing) {
      if (existing.status !== 'PENDING' || existing.ever_sent !== 0 ||
        (existing.operation !== 'CREATE' && existing.operation !== 'UPDATE')) {
        throw new LocalDomainError('PATTA_BATCH_SYNCING', 'Patta to‘plami sinxronlanmoqda yoki nizoda; tuzatish hozircha bloklandi')
      }
      if (existing.operation === 'CREATE') {
        const createPayload = { ...event.payload }
        delete createPayload.correction_reason
        this.database.prepare(`
          UPDATE sync_queue SET payload_json = ?, updated_at = ?
          WHERE event_id = ? AND status = 'PENDING' AND ever_sent = 0
        `).run(serializeLocalJson(createPayload), event.client_created_at, existing.event_id)
        return existing.event_id
      }
      if (event.base_version !== existing.base_version) {
        throw new LocalDomainError('VERSION_CONFLICT', 'Mahalliy tuzatishning asosiy versiyasi o‘zgargan')
      }
      const update = this.database.prepare(`
        UPDATE sync_queue SET payload_json = ?, updated_at = ?
        WHERE event_id = ? AND operation = 'UPDATE' AND base_version = ?
          AND status = 'PENDING' AND ever_sent = 0
      `).run(serializeLocalJson(event.payload), event.client_created_at, existing.event_id, existing.base_version)
      if (update.changes !== 1) {
        throw new LocalDomainError('PATTA_BATCH_SYNCING', 'Patta to‘plami sinxronlash holati o‘zgardi; qayta urinib ko‘ring')
      }
      return existing.event_id
    }
    if (event.base_version === '0') {
      throw new LocalDomainError('PATTA_BATCH_SYNC_REQUIRED', 'Avval Patta to‘plamining serverdagi nusxasini sinxronlang')
    }
    this.enqueue(event)
    return event.event_id
  }

  enqueueOrCoalescePattaSheetMutation(event: PattaSheetSyncEvent): string {
    if (!this.database.inTransaction) {
      throw new Error('Patta Sheet queue writes require the local business transaction')
    }
    if (event.entity_type !== 'patta_sheet' || !event.payload) {
      throw new Error('Patta Sheet queue event is invalid')
    }
    const existingRows = this.database.prepare(`
      SELECT event_id, operation, base_version, status, ever_sent
      FROM sync_queue WHERE entity_type = 'patta_sheet' AND entity_id = ?
        AND status IN ('PENDING', 'SYNCING', 'CONFLICT', 'FAILED')
      ORDER BY created_at, event_id
    `).all(event.entity_id) as Array<{
      event_id: string; operation: string; base_version: string; status: QueueStatus; ever_sent: number
    }>
    if (existingRows.length > 1) {
      throw new LocalDomainError('PATTA_SHEET_MUTATION_PENDING', 'Varaqning oldingi sinxronlash hodisasi hal qilinmagan')
    }
    const existing = existingRows[0]
    if (existing) {
      if (existing.status !== 'PENDING' || existing.ever_sent !== 0 ||
        !['CREATE', 'UPDATE'].includes(existing.operation) || event.operation === 'DELETE') {
        throw new LocalDomainError('PATTA_SHEET_SYNCING', 'Varaq sinxronlanmoqda yoki nizoda; o‘zgarish bloklandi')
      }
      if (existing.operation === 'CREATE') {
        this.updateCoalescedSheetEvent(existing.event_id, existing.operation, '0', event, event.payload)
        return existing.event_id
      }
      if (event.base_version !== existing.base_version) {
        throw new LocalDomainError('VERSION_CONFLICT', 'Mahalliy varaqning asosiy versiyasi o‘zgargan')
      }
      this.updateCoalescedSheetEvent(existing.event_id, existing.operation, existing.base_version, event, event.payload)
      return existing.event_id
    }
    if (event.operation !== 'CREATE' && event.base_version === '0') {
      throw new LocalDomainError('PATTA_SHEET_SYNC_REQUIRED', 'Avval varaqning serverdagi nusxasini sinxronlang')
    }
    this.enqueue(event)
    return event.event_id
  }

  cancelNeverSentPattaSheetCreate(sheetId: string): boolean {
    if (!this.database.inTransaction) throw new Error('Patta Sheet queue cancellation requires a SQLite transaction')
    const row = this.database.prepare(`
      SELECT event_id, operation, status, ever_sent FROM sync_queue
      WHERE entity_type = 'patta_sheet' AND entity_id = ?
      ORDER BY created_at, event_id LIMIT 1
    `).get(sheetId) as { event_id: string; operation: string; status: QueueStatus; ever_sent: number } | undefined
    if (!row) return false
    if (row.operation !== 'CREATE' || row.status !== 'PENDING' || row.ever_sent !== 0) {
      throw new LocalDomainError('PATTA_SHEET_SYNC_REQUIRED', 'Avval varaqning serverdagi holatini sinxronlang')
    }
    this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(row.event_id)
    this.database.prepare('DELETE FROM sync_queue WHERE event_id = ?').run(row.event_id)
    return true
  }

  private updateCoalescedSheetEvent(
    eventId: string,
    operation: string,
    baseVersion: string,
    event: PattaSheetSyncEvent,
    payload: PattaSheetMutationPayload,
  ): void {
    const update = this.database.prepare(`
      UPDATE sync_queue SET operation = ?, base_version = ?, payload_json = ?, updated_at = ?
      WHERE event_id = ? AND entity_type = 'patta_sheet' AND status = 'PENDING' AND ever_sent = 0
    `).run(operation, baseVersion, serializeLocalJson(payload), event.client_created_at, eventId)
    if (update.changes !== 1) {
      throw new LocalDomainError('PATTA_SHEET_SYNCING', 'Varaq sinxronlash holati o‘zgardi; qayta urinib ko‘ring')
    }
    this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(eventId)
    const insertDependency = this.database.prepare(`
      INSERT INTO sync_event_dependencies (event_id, prerequisite_event_id, created_at)
      VALUES (?, ?, ?)
    `)
    for (const dependency of payload.depends_on_event_ids) {
      insertDependency.run(eventId, dependency, event.client_created_at)
    }
  }

  pendingBatch(limit: number, now: string): readonly LocalQueuedEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Local sync queue batch limit must be between 1 and 100')
    }
    const rows = this.database
      .prepare(
        `
      SELECT event_id, entity_type, entity_id, operation, base_version, client_created_at, occurred_at,
        reference_cursor, payload_json
      FROM sync_queue
      WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM sync_event_dependencies AS dependency
          JOIN sync_queue AS prerequisite ON prerequisite.event_id = dependency.prerequisite_event_id
          WHERE dependency.event_id = sync_queue.event_id AND prerequisite.status <> 'SYNCED'
        )
      ORDER BY created_at, event_id
      LIMIT ?
    `
      )
      .all(now, limit) as StoredQueueEvent[]
    return rows.map(storedEvent)
  }

  markSyncing(eventIds: readonly string[], updatedAt: string): number {
    let updatedCount = 0
    for (const eventId of eventIds) {
      const row = this.database
        .prepare(
          `
        SELECT entity_id, entity_type FROM sync_queue WHERE event_id = ? AND status = 'PENDING'
      `
        )
        .get(eventId) as QueueEntityRow | undefined
      if (!row) continue

      const result = this.database
        .prepare(
          `
        UPDATE sync_queue SET status = 'SYNCING', ever_sent = 1, updated_at = ?
        WHERE event_id = ? AND status = 'PENDING'
      `
        )
        .run(updatedAt, eventId)
      if (result.changes === 0) continue
      this.setQueuedEntityOwnership(row.entity_type, row.entity_id, 'SYNCING')
      updatedCount += result.changes
    }
    return updatedCount
  }

  markSynced(
    eventId: string,
    result: Extract<SyncPushResult, { status: 'SYNCED' }>,
    updatedAt: string
  ): boolean {
    if (result.event_id !== eventId)
      throw new Error('Sync response event ID does not match the local queue')
    assertPostgresBigint(result.change_sequence, 'Patta change sequence')
    const queueRow = this.database
      .prepare(
        `
      SELECT event_id, entity_type, entity_id, operation, base_version,
        client_created_at, occurred_at, reference_cursor, payload_json
      FROM sync_queue WHERE event_id = ? AND status = 'SYNCING'
    `
      )
      .get(eventId) as StoredQueueEvent | undefined
    if (!queueRow) return false
    const event = storedEvent(queueRow)
    if (event.entity_type === 'patta_print_event') {
      return this.markPrintEventSynced(event, result, updatedAt)
    }
    if (event.entity_type === 'patta_print_batch') {
      return this.markPrintBatchSynced(event, result, updatedAt)
    }
    if (event.entity_type === 'patta_sheet') {
      return this.markPattaSheetSynced(event, result, updatedAt)
    }
    if (event.entity_type === 'model_operation') {
      return this.markCustomModelOperationSynced(event, result, updatedAt)
    }
    if (result.projection === null) throw new Error('Sync success response is missing the authoritative projection')
    if (result.projection.projection_version !== 1 || result.projection.entity_type !== 'patta_hisob') {
      throw new Error('Offline Patta response contains a different entity projection')
    }
    if (result.entity_version !== result.projection.entity_version) {
      throw new Error('Patta response entity version does not match its projection')
    }
    const projection = result.projection.data
    const patta = this.database
      .prepare(
        `
      SELECT id, partiya_number, patta_number, model_id, model_name_snapshot,
        template_id, konveyer_snapshot, razmer, rang, ish_soni,
        created_device_id, created_from_block_id
      FROM patta_hisob WHERE id = ?
    `
      )
      .get(event.entity_id) as LocalPattaEchoRow | undefined
    if (!patta || !this.matchesLocalPatta(patta, projection)) {
      throw new Error('Server Patta echo does not match the immutable local Patta')
    }

    const localSnapshots = this.database
      .prepare(
        `
      SELECT id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order
      FROM patta_operation_snapshots WHERE patta_hisob_id = ?
      ORDER BY sort_order, operation_id
    `
      )
      .all(event.entity_id) as SyncPattaOperationSnapshotInput[]
    if (!this.sameSnapshots(localSnapshots, event.payload.operations)) {
      throw new Error('Local Patta snapshots differ from the queued immutable payload')
    }

    const queueResult = this.database
      .prepare(
        `
      UPDATE sync_queue SET status = 'SYNCED', result_json = ?,
        last_error_code = NULL, last_error_message = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'SYNCING'
    `
      )
      .run(serializeLocalJson(result), updatedAt, eventId)
    if (queueResult.changes === 0) return false
    this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(eventId)

    this.database
      .prepare(
        `
      UPDATE patta_hisob SET version = ?, ownership_state = 'SERVER_SYNCED',
        server_sequence = ?, created_at = ?, client_created_at = ?, occurred_at = ?
      WHERE id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `
      )
      .run(
        result.entity_version ?? '0',
        result.change_sequence,
        projection.created_at,
        projection.client_created_at,
        projection.occurred_at,
        event.entity_id
      )
    this.database
      .prepare(
        `
      UPDATE patta_operation_snapshots SET ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE patta_hisob_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `
      )
      .run(result.change_sequence, event.entity_id)
    return true
  }

  private markCustomModelOperationSynced(
    event: CustomModelOperationCreateEvent,
    result: Extract<SyncPushResult, { status: 'SYNCED' }>,
    updatedAt: string
  ): boolean {
    if (!result.projection || result.projection.projection_version !== 1 ||
      result.projection.entity_type !== 'model_operations' || result.projection.entity_id !== event.entity_id ||
      result.entity_version !== result.projection.entity_version) {
      throw new Error('Custom operation response does not contain its authoritative projection')
    }
    const operation = result.projection.data
    if (operation.id !== event.entity_id || operation.model_id !== event.payload.model_id ||
      operation.name !== event.payload.name || operation.status !== 'ACTIVE' ||
      operation.sort_order !== event.payload.sort_order) {
      throw new Error('Server custom operation does not match the immutable local operation')
    }
    const update = this.database.prepare(`
      UPDATE model_operations SET version = ?, created_at = ?, updated_at = ?, server_sequence = ?
      WHERE id = ? AND model_id = ? AND name = ? AND status = 'ACTIVE'
    `).run(operation.version, operation.created_at, operation.updated_at, result.change_sequence,
      operation.id, operation.model_id, operation.name)
    if (update.changes !== 1) throw new Error('Local custom operation is missing or differs from server echo')
    const queueResult = this.database.prepare(`
      UPDATE sync_queue SET status = 'SYNCED', result_json = ?, last_error_code = NULL,
        last_error_message = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'SYNCING'
    `).run(serializeLocalJson(result), updatedAt, event.event_id)
    return queueResult.changes === 1
  }

  private markPrintBatchSynced(
    event: PattaPrintBatchSyncEvent,
    result: Extract<SyncPushResult, { status: 'SYNCED' }>,
    updatedAt: string
  ): boolean {
    if (!result.projection || result.projection.projection_version !== 2 || result.projection.entity_type !== 'patta_print_batches') {
      throw new Error('Print batch push response contains a different projection')
    }
    if (result.projection.entity_id !== event.entity_id || result.entity_version !== result.projection.entity_version) {
      throw new Error('Print batch response identity or version does not match the queued event')
    }
    const batch: PattaPrintBatchProjection = result.projection.data
    const localBatch = this.database.prepare(`
      SELECT id, model_id, model_name_snapshot, partiya_number, partiya_block_id,
        ish_soni, rang, status, version, revision
      FROM patta_print_batches WHERE id = ? AND ownership_state = 'SYNCING'
    `).get(event.entity_id) as {
      id: string
      model_id: string
      model_name_snapshot: string
      partiya_number: string
      partiya_block_id: string | null
      ish_soni: number
      rang: string
      status: string
      version: string
      revision: number
    } | undefined
    if (!localBatch || localBatch.id !== batch.id || localBatch.model_id !== batch.model_id ||
      localBatch.model_name_snapshot !== batch.model_name_snapshot ||
      localBatch.partiya_number !== batch.partiya_number ||
      localBatch.partiya_block_id !== batch.partiya_block_id || localBatch.ish_soni !== batch.ish_soni ||
      localBatch.rang !== batch.rang || localBatch.status !== batch.status || localBatch.revision !== batch.revision ||
      (event.operation === 'UPDATE' && localBatch.version !== batch.version)) {
      throw new Error('Server print batch echo does not match the immutable local batch')
    }

    const localSizes = this.database.prepare(`
      SELECT id, print_batch_id, razmer, patta_count, sort_order
      FROM patta_print_batch_sizes WHERE print_batch_id = ? ORDER BY sort_order, razmer
    `).all(event.entity_id) as PattaPrintBatchMutationPayload['size_distribution']
    const expectedSizes = [...event.payload.size_distribution].sort((left, right) =>
      left.sort_order - right.sort_order || left.razmer.localeCompare(right.razmer))
    const returnedSizes = [...batch.size_distribution].sort((left, right) =>
      left.sort_order - right.sort_order || left.razmer.localeCompare(right.razmer))
    if (localSizes.length !== expectedSizes.length || returnedSizes.length !== expectedSizes.length ||
      expectedSizes.some((expected, index) => {
        const local = localSizes[index]
        const echoed = returnedSizes[index]
        return !local || !echoed || local.id !== expected.id || echoed.id !== expected.id ||
          local.razmer !== expected.razmer || echoed.razmer !== expected.razmer ||
          local.patta_count !== expected.patta_count || echoed.patta_count !== expected.patta_count ||
          local.sort_order !== expected.sort_order || echoed.sort_order !== expected.sort_order
      })) {
      throw new Error('Server print batch size echo does not match the queued distribution')
    }

    const localPattas = this.database.prepare(`
      SELECT id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
        konveyer_snapshot, razmer, rang, ish_soni, legacy_operation_count, status, print_batch_id,
        created_device_id, created_from_block_id, created_at, client_created_at, occurred_at, version
      FROM patta_hisob WHERE print_batch_id = ? ORDER BY patta_number
    `).all(event.entity_id) as Array<Record<string, unknown>>
    const expectedActiveLocalPattas = event.operation === 'UPDATE'
      ? localPattas.filter((patta) => patta['status'] === 'ACTIVE')
      : localPattas
    const expectedActiveServerPattas = event.operation === 'UPDATE'
      ? batch.pattas.filter((patta) => patta.status === 'ACTIVE')
      : batch.pattas
    if (localPattas.length !== batch.pattas.length || expectedActiveLocalPattas.length !== event.payload.pattas.length ||
      expectedActiveServerPattas.length !== event.payload.pattas.length) {
      throw new Error('Server print batch Patta count does not match the queued batch')
    }
    for (const queued of event.payload.pattas) {
      const local = localPattas.find((patta) => patta['id'] === queued.id)
      const echoed = batch.pattas.find((patta) => patta.id === queued.id)
      if (!local || !echoed || local['patta_number'] !== queued.patta_number ||
        echoed.patta_number !== queued.patta_number || local['partiya_number'] !== batch.partiya_number ||
        local['model_id'] !== batch.model_id || local['model_name_snapshot'] !== batch.model_name_snapshot ||
        local['ish_soni'] !== batch.ish_soni || echoed.ish_soni !== batch.ish_soni ||
        local['legacy_operation_count'] !== null || echoed.legacy_operation_count !== null ||
        local['status'] !== 'ACTIVE' || echoed.status !== 'ACTIVE' ||
        local['print_batch_id'] !== batch.id || echoed.print_batch_id !== batch.id ||
        local['created_from_block_id'] !== queued.block_id ||
        local['razmer'] !== queued.razmer || echoed.razmer !== queued.razmer) {
        throw new Error('Server Patta echo does not match the immutable local batch item')
      }
      const localSnapshots = this.database.prepare(`
        SELECT id, operation_id, operation_name_snapshot, unit_price_snapshot, sort_order
        FROM patta_operation_snapshots WHERE patta_hisob_id = ? ORDER BY sort_order, operation_id
      `).all(queued.id) as SyncPattaOperationSnapshotInput[]
      const serverSnapshots = [...echoed.operations].sort((left, right) =>
        left.sort_order - right.sort_order || left.operation_id.localeCompare(right.operation_id))
      const queuedSnapshots = [...queued.operation_snapshots].sort((left, right) =>
        left.sort_order - right.sort_order || left.operation_id.localeCompare(right.operation_id))
      if (!this.sameSnapshots(localSnapshots, queuedSnapshots) ||
        serverSnapshots.length !== queuedSnapshots.length || queuedSnapshots.some((snapshot, index) => {
          const returned = serverSnapshots[index]
          return !returned || returned.id !== snapshot.id || returned.patta_hisob_id !== queued.id ||
            returned.operation_id !== snapshot.operation_id ||
            returned.operation_name_snapshot !== snapshot.operation_name_snapshot ||
            returned.unit_price_snapshot !== snapshot.unit_price_snapshot ||
            returned.sort_order !== snapshot.sort_order
        })) {
        throw new Error('Server operation snapshots do not match the queued immutable batch')
      }
    }
    if (event.operation === 'UPDATE') {
      for (const echoed of batch.pattas) {
        const local = localPattas.find((patta) => patta['id'] === echoed.id)
        if (!local || local['status'] !== echoed.status || local['patta_number'] !== echoed.patta_number ||
          local['razmer'] !== echoed.razmer || local['ish_soni'] !== echoed.ish_soni || local['rang'] !== echoed.rang ||
          local['version'] !== echoed.version) {
          throw new Error('Server correction echo does not match the local Patta lifecycle')
        }
      }
    }

    const queueResult = this.database.prepare(`
      UPDATE sync_queue SET status = 'SYNCED', result_json = ?, last_error_code = NULL,
        last_error_message = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'SYNCING'
    `).run(serializeLocalJson(result), updatedAt, event.event_id)
    if (queueResult.changes === 0) return false
    this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(event.event_id)
    this.database.prepare(`
      UPDATE patta_print_batches SET version = ?, revision = ?, updated_at = ?, printed_at = ?,
        ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE id = ? AND ownership_state = 'SYNCING'
    `).run(batch.version, batch.revision, batch.updated_at, batch.printed_at, result.change_sequence, batch.id)
    this.database.prepare(`
      UPDATE patta_print_batch_sizes SET ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE print_batch_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(result.change_sequence, batch.id)
    for (const patta of batch.pattas) {
      this.database.prepare(`
        UPDATE patta_hisob SET version = ?, ownership_state = 'SERVER_SYNCED', server_sequence = ?
        WHERE id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
      `).run(patta.version, result.change_sequence, patta.id)
    }
    this.database.prepare(`
      UPDATE patta_operation_snapshots SET ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE patta_hisob_id IN (SELECT id FROM patta_hisob WHERE print_batch_id = ?)
        AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(result.change_sequence, batch.id)
    return true
  }

  private markPattaSheetSynced(
    event: PattaSheetSyncEvent,
    result: Extract<SyncPushResult, { status: 'SYNCED' }>,
    updatedAt: string
  ): boolean {
    if (event.operation === 'DELETE') {
      if (result.projection !== null || result.entity_version !== null) {
        throw new Error('Purged Patta Sheet response must have a null projection and version')
      }
      const local = this.database.prepare(`
        SELECT id, version, deleted_at, ownership_state
        FROM patta_sheets WHERE id = ?
      `).get(event.entity_id) as {
        id: string; version: string; deleted_at: string | null;
        ownership_state: 'LOCAL_PENDING' | 'SYNCING' | 'SERVER_SYNCED' | 'CONFLICT' | 'FAILED'
      } | undefined
      const purgeTombstone = this.database.prepare(`
        SELECT entity_id FROM sync_tombstones WHERE entity_type = 'patta_sheets' AND entity_id = ?
      `).get(event.entity_id)
      if ((local && (local.deleted_at === null || local.version !== event.base_version || local.ownership_state !== 'SYNCING')) ||
        (!local && !purgeTombstone)) {
        throw new Error('Patta Sheet purge echo does not match a syncing trashed Entry')
      }
      const queueResult = this.database.prepare(`
        UPDATE sync_queue SET status = 'SYNCED', result_json = ?, last_error_code = NULL,
          last_error_message = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE event_id = ? AND status = 'SYNCING'
      `).run(serializeLocalJson(result), updatedAt, event.event_id)
      if (queueResult.changes === 0) return false
      this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(event.event_id)
      this.database.prepare('DELETE FROM patta_sheet_rows WHERE patta_sheet_id = ?').run(event.entity_id)
      this.database.prepare('DELETE FROM patta_sheet_operation_snapshots WHERE patta_sheet_id = ?').run(event.entity_id)
      this.database.prepare('DELETE FROM patta_sheets WHERE id = ?').run(event.entity_id)
      for (const [entityType, entityId] of [
        ...event.payload.rows.map(({ id }) => ['patta_sheet_rows', id] as const),
        ...event.payload.operation_snapshots.map(({ id }) => ['patta_sheet_operation_snapshots', id] as const),
        ['patta_sheets', event.entity_id] as const,
      ]) {
        this.database.prepare(`
          INSERT INTO sync_tombstones (entity_type, entity_id, server_sequence, deleted_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            server_sequence = excluded.server_sequence, deleted_at = excluded.deleted_at
        `).run(entityType, entityId, result.change_sequence, updatedAt)
      }
      return true
    }
    if (result.projection?.projection_version !== 2 || result.projection.entity_type !== 'patta_sheets') {
      throw new Error('Patta Sheet push response contains a different projection')
    }
    const sheet = result.projection.data
    if (result.projection.entity_id !== event.entity_id || sheet.id !== event.entity_id ||
      result.entity_version !== result.projection.entity_version || sheet.version !== result.entity_version ||
      sheet.patta_hisob_id !== event.payload.patta_hisob_id ||
      sheet.entered_at !== event.payload.entered_at || sheet.business_date !== event.payload.business_date ||
      sheet.conveyor_snapshot !== event.payload.conveyor_snapshot ||
      sheet.deleted_at !== event.payload.deleted_at || sheet.deleted_by !== event.payload.deleted_by ||
      (event.operation === 'UPDATE' && sheet.version !== this.localSheetVersion(event.entity_id))) {
      throw new Error('Server Patta Sheet echo does not match the queued aggregate version')
    }
    const local = this.database.prepare(`
      SELECT id, patta_hisob_id, entered_at, business_date, conveyor_snapshot, version,
        deleted_at, deleted_by, ownership_state
      FROM patta_sheets WHERE id = ? AND ownership_state = 'SYNCING'
    `).get(event.entity_id) as {
      id: string; patta_hisob_id: string; entered_at: string; business_date: string;
      conveyor_snapshot: string | null; version: string; deleted_at: string | null;
      deleted_by: string | null; ownership_state: string;
    } | undefined
    if (!local || local.patta_hisob_id !== sheet.patta_hisob_id ||
      Date.parse(local.entered_at) !== Date.parse(sheet.entered_at) || local.business_date !== sheet.business_date ||
      local.conveyor_snapshot !== sheet.conveyor_snapshot || local.deleted_at !== sheet.deleted_at ||
      local.deleted_by !== sheet.deleted_by || (event.operation === 'UPDATE' && local.version !== sheet.version)) {
      throw new Error('Server Patta Sheet echo does not match the local immutable Entry')
    }
    this.assertSheetSnapshotsMatch(event.payload.operation_snapshots, sheet.operation_snapshots)
    this.assertSheetRowsMatch(event.payload.rows, sheet.rows)
    const localProjection = this.readLocalSheetChildren(event.entity_id)
    this.assertSheetSnapshotsMatch(event.payload.operation_snapshots, localProjection.operation_snapshots)
    this.assertSheetRowsMatch(event.payload.rows, localProjection.rows)

    const queueResult = this.database.prepare(`
      UPDATE sync_queue SET status = 'SYNCED', result_json = ?, last_error_code = NULL,
        last_error_message = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'SYNCING'
    `).run(serializeLocalJson(result), updatedAt, event.event_id)
    if (queueResult.changes === 0) return false
    this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(event.event_id)
    this.database.prepare(`
      UPDATE patta_sheets SET version = ?, created_by = ?, created_at = ?, updated_at = ?,
        ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE id = ? AND ownership_state = 'SYNCING'
    `).run(sheet.version, sheet.created_by, sheet.created_at, sheet.updated_at, result.change_sequence, sheet.id)
    this.database.prepare(`
      UPDATE patta_sheet_operation_snapshots SET ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE patta_sheet_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(result.change_sequence, sheet.id)
    this.database.prepare(`
      UPDATE patta_sheet_rows SET ownership_state = 'SERVER_SYNCED', server_sequence = ?
      WHERE patta_sheet_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(result.change_sequence, sheet.id)
    return true
  }

  private localSheetVersion(sheetId: string): string | null {
    const row = this.database.prepare('SELECT version FROM patta_sheets WHERE id = ?').get(sheetId) as
      { version: string } | undefined
    return row?.version ?? null
  }

  private readLocalSheetChildren(sheetId: string): Pick<PattaSheetProjection, 'operation_snapshots' | 'rows'> {
    return {
      operation_snapshots: this.database.prepare(`
        SELECT id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
          operation_name_snapshot, unit_price_snapshot, sort_order, created_at
        FROM patta_sheet_operation_snapshots WHERE patta_sheet_id = ? ORDER BY sort_order, model_operation_id
      `).all(sheetId) as PattaSheetProjection['operation_snapshots'],
      rows: (this.database.prepare(`
        SELECT id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
          nuqson, deleted_at, deleted_by, created_at, updated_at
        FROM patta_sheet_rows WHERE patta_sheet_id = ? ORDER BY created_at, id
      `).all(sheetId) as Array<Omit<PattaSheetProjection['rows'][number], 'nuqson'> & { nuqson: number }>).
        map((row) => ({ ...row, nuqson: Boolean(row.nuqson) }))
    }
  }

  private assertSheetSnapshotsMatch(
    expected: PattaSheetMutationPayload['operation_snapshots'],
    actual: readonly PattaSheetProjection['operation_snapshots'][number][]
  ): void {
    if (expected.length !== actual.length || expected.some((snapshot) => {
      const returned = actual.find(({ id }) => id === snapshot.id)
      return !returned || returned.model_operation_id !== snapshot.model_operation_id ||
        returned.source_type !== snapshot.source_type ||
        returned.source_patta_operation_snapshot_id !== snapshot.source_patta_operation_snapshot_id ||
        returned.operation_name_snapshot !== snapshot.operation_name_snapshot ||
        returned.unit_price_snapshot !== snapshot.unit_price_snapshot || returned.sort_order !== snapshot.sort_order
    })) {
      throw new Error('Server Patta Sheet operation snapshot echo differs from the local aggregate')
    }
  }

  private assertSheetRowsMatch(
    expected: PattaSheetMutationPayload['rows'],
    actual: readonly PattaSheetProjection['rows'][number][]
  ): void {
    if (expected.length !== actual.length || expected.some((row) => {
      const returned = actual.find(({ id }) => id === row.id)
      return !returned || returned.patta_sheet_operation_snapshot_id !== row.patta_sheet_operation_snapshot_id ||
        returned.worker_id !== row.worker_id || returned.quantity_snapshot !== row.quantity_snapshot ||
        returned.nuqson !== row.nuqson || returned.deleted_at !== row.deleted_at || returned.deleted_by !== row.deleted_by
    })) {
      throw new Error('Server Patta Sheet row echo differs from the local aggregate')
    }
  }

  private markPrintEventSynced(
    event: PattaPrintEventSyncEvent,
    result: Extract<SyncPushResult, { status: 'SYNCED' }>,
    updatedAt: string
  ): boolean {
    if (!result.projection || result.projection.projection_version !== 2 || result.projection.entity_type !== 'patta_print_events' ||
      result.projection.entity_id !== event.entity_id) {
      throw new Error('Print event push response contains a different projection')
    }
    const projection = result.projection.data
    const local = this.database.prepare(`
      SELECT id, batch_id, revision, kind, outcome, device_id
      FROM patta_print_events WHERE id = ?
    `).get(event.entity_id) as {
      id: string; batch_id: string; revision: number; kind: string; outcome: string; device_id: string
    } | undefined
    if (!local || local.id !== projection.id || local.batch_id !== projection.batch_id ||
      local.revision !== projection.revision || local.kind !== projection.kind ||
      local.outcome !== projection.outcome || local.device_id !== projection.device_id ||
      event.payload.batch_id !== projection.batch_id || event.payload.revision !== projection.revision ||
      event.payload.kind !== projection.kind || event.payload.outcome !== projection.outcome ||
      event.payload.device_id !== projection.device_id) {
      throw new Error('Server print event echo does not match the immutable local event')
    }
    const update = this.database.prepare(`
      UPDATE sync_queue SET status = 'SYNCED', result_json = ?, last_error_code = NULL,
        last_error_message = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE event_id = ? AND status = 'SYNCING'
    `).run(serializeLocalJson(result), updatedAt, event.event_id)
    if (update.changes === 0) return false
    this.database.prepare(`
      UPDATE patta_print_events SET server_sequence = ?, printed_at = ? WHERE id = ?
    `).run(result.change_sequence, projection.printed_at, projection.id)
    this.database.prepare('DELETE FROM sync_event_dependencies WHERE event_id = ?').run(event.event_id)
    return true
  }

  recoverStaleSyncing(recoveredAt: string): number {
    const recover = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `
        UPDATE sync_queue SET status = 'PENDING', updated_at = ?
        WHERE status = 'SYNCING'
      `
        )
        .run(recoveredAt)
      this.database
        .prepare(
          `
        UPDATE patta_hisob SET ownership_state = 'LOCAL_PENDING'
        WHERE ownership_state = 'SYNCING'
          AND id IN (SELECT entity_id FROM sync_queue WHERE status = 'PENDING' AND entity_type = 'patta')
      `
        )
        .run()
      this.database
        .prepare(
          `
        UPDATE patta_operation_snapshots SET ownership_state = 'LOCAL_PENDING'
        WHERE ownership_state = 'SYNCING'
          AND patta_hisob_id IN (SELECT entity_id FROM sync_queue WHERE status = 'PENDING' AND entity_type = 'patta')
      `
        )
        .run()
      this.database.prepare(`
        UPDATE patta_print_batches SET ownership_state = 'LOCAL_PENDING'
        WHERE ownership_state = 'SYNCING'
          AND id IN (SELECT entity_id FROM sync_queue WHERE status = 'PENDING' AND entity_type = 'patta_print_batch')
      `).run()
      this.database.prepare(`
        UPDATE patta_print_batch_sizes SET ownership_state = 'LOCAL_PENDING'
        WHERE ownership_state = 'SYNCING'
          AND print_batch_id IN (SELECT entity_id FROM sync_queue WHERE status = 'PENDING' AND entity_type = 'patta_print_batch')
      `).run()
      this.database.prepare(`
        UPDATE patta_hisob SET ownership_state = 'LOCAL_PENDING'
        WHERE ownership_state = 'SYNCING'
          AND print_batch_id IN (SELECT entity_id FROM sync_queue WHERE status = 'PENDING' AND entity_type = 'patta_print_batch')
      `).run()
      this.database.prepare(`
        UPDATE patta_operation_snapshots SET ownership_state = 'LOCAL_PENDING'
        WHERE ownership_state = 'SYNCING'
          AND patta_hisob_id IN (
            SELECT id FROM patta_hisob WHERE print_batch_id IN (
              SELECT entity_id FROM sync_queue WHERE status = 'PENDING' AND entity_type = 'patta_print_batch'
            )
          )
      `).run()
      return result.changes
    })
    return recover.immediate()
  }

  deferRetry(
    eventId: string,
    nextAttemptAt: string,
    errorCode: string,
    errorMessage: string,
    updatedAt: string
  ): boolean {
    const row = this.database
      .prepare(
        `
        SELECT entity_id, entity_type FROM sync_queue WHERE event_id = ? AND status = 'SYNCING'
    `
      )
      .get(eventId) as QueueEntityRow | undefined
    if (!row) return false
    const result = this.database
      .prepare(
        `
      UPDATE sync_queue SET status = 'PENDING', attempt_count = attempt_count + 1,
        next_attempt_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE event_id = ? AND status = 'SYNCING'
    `
      )
      .run(nextAttemptAt, errorCode, errorMessage, updatedAt, eventId)
    if (result.changes > 0) this.setQueuedEntityOwnership(row.entity_type, row.entity_id, 'LOCAL_PENDING')
    return result.changes > 0
  }

  markFailed(eventId: string, errorCode: string, errorMessage: string, updatedAt: string): boolean {
    const row = this.database
      .prepare(
        `
        SELECT entity_id, entity_type FROM sync_queue
      WHERE event_id = ? AND status IN ('PENDING', 'SYNCING')
    `
      )
      .get(eventId) as QueueEntityRow | undefined
    if (!row) return false
    const result = this.database
      .prepare(
        `
      UPDATE sync_queue SET status = 'FAILED', last_error_code = ?,
        last_error_message = ?, updated_at = ?
      WHERE event_id = ? AND status IN ('PENDING', 'SYNCING')
    `
      )
      .run(errorCode, errorMessage, updatedAt, eventId)
    if (result.changes > 0) this.setQueuedEntityOwnership(row.entity_type, row.entity_id, 'FAILED')
    return result.changes > 0
  }

  countByStatus(status: QueueStatus): number {
    const row = this.database
      .prepare(
        `
      SELECT COUNT(*) AS count FROM sync_queue WHERE status = ?
    `
      )
      .get(status) as { count: number }
    return row.count
  }

  attemptCount(eventId: string): number {
    const row = this.database
      .prepare(
        `
      SELECT attempt_count FROM sync_queue WHERE event_id = ?
    `
      )
      .get(eventId) as { attempt_count: number } | undefined
    return row?.attempt_count ?? 0
  }

  cleanupSyncedOlderThan(cutoff: string): number {
    const result = this.database
      .prepare(
        `
      DELETE FROM sync_queue
      WHERE status = 'SYNCED' AND updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_event_dependencies dependency
          WHERE dependency.prerequisite_event_id = sync_queue.event_id
        )
      `
      )
      .run(cutoff)
    return result.changes
  }

  refreshPendingDependentCursors(referenceCursor: string, updatedAt: string): number {
    assertPostgresBigint(referenceCursor, 'Updated sync reference cursor')
    return this.database.prepare(`
      UPDATE sync_queue SET reference_cursor = ?, updated_at = ?
      WHERE status = 'PENDING' AND ever_sent = 0
        AND EXISTS (
          SELECT 1 FROM sync_event_dependencies dependency
          WHERE dependency.event_id = sync_queue.event_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sync_event_dependencies dependency
          JOIN sync_queue prerequisite ON prerequisite.event_id = dependency.prerequisite_event_id
          WHERE dependency.event_id = sync_queue.event_id AND prerequisite.status <> 'SYNCED'
        )
    `).run(referenceCursor, updatedAt).changes
  }

  private setPattaOwnership(entityId: string, state: 'SYNCING' | 'LOCAL_PENDING' | 'FAILED'): void {
    const pattaState = state === 'SYNCING' ? 'SYNCING' : state
    const snapshotState = state === 'SYNCING' ? 'SYNCING' : state
    this.database
      .prepare(
        `
      UPDATE patta_hisob SET ownership_state = ?
      WHERE id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `
      )
      .run(pattaState, entityId)
    this.database
      .prepare(
        `
      UPDATE patta_operation_snapshots SET ownership_state = ?
      WHERE patta_hisob_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `
      )
      .run(snapshotState, entityId)
  }

  private setQueuedEntityOwnership(
    entityType: string,
    entityId: string,
    state: 'SYNCING' | 'LOCAL_PENDING' | 'FAILED'
  ): void {
    if (entityType === 'patta') {
      this.setPattaOwnership(entityId, state)
      return
    }
    if (entityType === 'patta_sheet') {
      this.database.prepare(`
        UPDATE patta_sheets SET ownership_state = ?
        WHERE id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
      `).run(state, entityId)
      this.database.prepare(`
        UPDATE patta_sheet_operation_snapshots SET ownership_state = ?
        WHERE patta_sheet_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
      `).run(state, entityId)
      this.database.prepare(`
        UPDATE patta_sheet_rows SET ownership_state = ?
        WHERE patta_sheet_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
      `).run(state, entityId)
      return
    }
    if (entityType !== 'patta_print_batch') return
    this.database.prepare(`
      UPDATE patta_print_batches SET ownership_state = ?
      WHERE id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(state, entityId)
    this.database.prepare(`
      UPDATE patta_print_batch_sizes SET ownership_state = ?
      WHERE print_batch_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(state, entityId)
    this.database.prepare(`
      UPDATE patta_hisob SET ownership_state = ?
      WHERE print_batch_id = ? AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(state, entityId)
    this.database.prepare(`
      UPDATE patta_operation_snapshots SET ownership_state = ?
      WHERE patta_hisob_id IN (SELECT id FROM patta_hisob WHERE print_batch_id = ?)
        AND ownership_state IN ('LOCAL_PENDING', 'SYNCING')
    `).run(state, entityId)
  }

  private matchesLocalPatta(
    local: LocalPattaEchoRow,
    server: ServerPattaProjection['data']
  ): boolean {
    return (
      local.id === server.id &&
      local.partiya_number === server.partiya_number &&
      local.patta_number === server.patta_number &&
      local.model_id === server.model_id &&
      local.model_name_snapshot === server.model_name_snapshot &&
      local.template_id === server.template_id &&
      local.konveyer_snapshot === server.konveyer_snapshot &&
      local.razmer === server.razmer &&
      local.rang === server.rang &&
      local.ish_soni === server.ish_soni &&
      local.created_device_id === server.created_device_id &&
      local.created_from_block_id === server.created_from_block_id
    )
  }

  private sameSnapshots(
    local: readonly SyncPattaOperationSnapshotInput[],
    queued: readonly SyncPattaOperationSnapshotInput[]
  ): boolean {
    return (
      local.length === queued.length &&
      local.every((snapshot, index) => {
        const queuedSnapshot = queued[index]
        return (
          queuedSnapshot !== undefined &&
          snapshot.id === queuedSnapshot.id &&
          snapshot.operation_id === queuedSnapshot.operation_id &&
          snapshot.operation_name_snapshot === queuedSnapshot.operation_name_snapshot &&
          snapshot.unit_price_snapshot === queuedSnapshot.unit_price_snapshot &&
          snapshot.sort_order === queuedSnapshot.sort_order
        )
      })
    )
  }
}
