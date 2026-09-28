import type Database from 'better-sqlite3'
import type {
  OfflinePattaCreateEvent,
  SyncPattaCreatePayload,
  SyncPattaOperationSnapshotInput,
  SyncProjection,
  SyncPushResult
} from '@textile/sync-protocol'
import { isJsonObject, parseLocalJson, serializeLocalJson } from './local-json'
import { assertPostgresBigint } from './decimal-string'

interface StoredQueueEvent {
  event_id: string
  entity_id: string
  base_version: string
  client_created_at: string
  occurred_at: string
  reference_cursor: string
  payload_json: string
}

interface QueueEntityRow {
  entity_id: string
}

interface LocalPattaEchoRow {
  id: string
  partiya_number: string
  patta_number: string
  model_id: string
  model_name_snapshot: string
  template_id: string | null
  konveyer_snapshot: string
  razmer: string | null
  rang: string | null
  ish_soni: number
  created_device_id: string
  created_from_block_id: string | null
}

type ServerPattaProjection = Extract<SyncProjection, { entity_type: 'patta_hisob' }>

type QueueStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'CONFLICT' | 'FAILED'

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
    partiya_number: requiredString(value.partiya_number, 'partiya number'),
    patta_number: requiredString(value.patta_number, 'Patta number'),
    model_id: requiredString(value.model_id, 'model id'),
    model_name_snapshot: requiredString(value.model_name_snapshot, 'model name snapshot'),
    template_id: nullableString(value.template_id, 'template id'),
    konveyer_snapshot: requiredString(value.konveyer_snapshot, 'conveyor snapshot'),
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

function storedEvent(row: StoredQueueEvent): OfflinePattaCreateEvent {
  if (row.base_version !== '0') {
    throw new Error('Stored offline Patta event has an unsupported base version')
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

export class SyncQueueRepository {
  constructor(private readonly database: Database.Database) {}

  enqueue(event: OfflinePattaCreateEvent): void {
    if (
      event.entity_type !== 'patta' ||
      event.operation !== 'CREATE' ||
      event.base_version !== '0'
    ) {
      throw new Error('Only offline Patta create events may enter the local sync queue')
    }

    const payloadJson = serializeLocalJson(event.payload)
    const existing = this.database
      .prepare(
        `
      SELECT event_id, entity_id, base_version, client_created_at, occurred_at,
        reference_cursor, payload_json
      FROM sync_queue WHERE event_id = ?
    `
      )
      .get(event.event_id) as StoredQueueEvent | undefined

    if (existing) {
      const sameEvent =
        existing.entity_id === event.entity_id &&
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
      ) VALUES (?, 'patta', ?, 'CREATE', ?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `
      )
      .run(
        event.event_id,
        event.entity_id,
        event.base_version,
        event.client_created_at,
        event.occurred_at,
        event.reference_cursor,
        payloadJson,
        event.client_created_at,
        event.client_created_at
      )
  }

  pendingBatch(limit: number, now: string): readonly OfflinePattaCreateEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Local sync queue batch limit must be between 1 and 100')
    }
    const rows = this.database
      .prepare(
        `
      SELECT event_id, entity_id, base_version, client_created_at, occurred_at,
        reference_cursor, payload_json
      FROM sync_queue
      WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
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
        SELECT entity_id FROM sync_queue WHERE event_id = ? AND status = 'PENDING'
      `
        )
        .get(eventId) as QueueEntityRow | undefined
      if (!row) continue

      const result = this.database
        .prepare(
          `
        UPDATE sync_queue SET status = 'SYNCING', updated_at = ?
        WHERE event_id = ? AND status = 'PENDING'
      `
        )
        .run(updatedAt, eventId)
      if (result.changes === 0) continue
      this.setPattaOwnership(row.entity_id, 'SYNCING')
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
    if (result.projection.entity_type !== 'patta_hisob') {
      throw new Error('Offline Patta response contains a different entity projection')
    }
    if (result.entity_version !== result.projection.entity_version) {
      throw new Error('Patta response entity version does not match its projection')
    }

    const queueRow = this.database
      .prepare(
        `
      SELECT event_id, entity_id, base_version, client_created_at, occurred_at,
        reference_cursor, payload_json
      FROM sync_queue WHERE event_id = ? AND status = 'SYNCING'
    `
      )
      .get(eventId) as StoredQueueEvent | undefined
    if (!queueRow) return false
    const event = storedEvent(queueRow)
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
      SELECT entity_id FROM sync_queue WHERE event_id = ? AND status = 'SYNCING'
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
    if (result.changes > 0) this.setPattaOwnership(row.entity_id, 'LOCAL_PENDING')
    return result.changes > 0
  }

  markFailed(eventId: string, errorCode: string, errorMessage: string, updatedAt: string): boolean {
    const row = this.database
      .prepare(
        `
      SELECT entity_id FROM sync_queue
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
    if (result.changes > 0) this.setPattaOwnership(row.entity_id, 'FAILED')
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
      DELETE FROM sync_queue WHERE status = 'SYNCED' AND updated_at < ?
    `
      )
      .run(cutoff)
    return result.changes
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
