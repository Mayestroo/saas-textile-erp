import { randomUUID } from 'node:crypto'
import type {
  OfflinePattaCreateEvent,
  SyncPattaCreatePayload,
  SyncPattaOperationSnapshotInput
} from '@textile/sync-protocol'
import { assertPostgresBigint } from './decimal-string'
import { LocalDomainError } from './local-errors'
import type {
  LocalPattaReferenceInput,
  LocalPattaReferenceSnapshot
} from './model-local.repository'
import type { LocalBlockConsumption } from './patta-number-block.repository'
import type { LocalPattaRecord, PersistedLocalPatta } from './local-patta.types'
import type { PattaNumberBlockRepository } from './patta-number-block.repository'
import type { ModelLocalRepository } from './model-local.repository'
import type { PattaLocalRepository } from './patta-local.repository'
import { LocalUnitOfWork } from './local-unit-of-work'
import type { SyncStateRepository } from './sync-state.repository'
import { canonicalUtcTimestamp } from './utc-timestamp'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g

export interface Clock {
  nowIsoUtc(): string
}

export interface LocalSyncQueueWriter {
  enqueue(event: OfflinePattaCreateEvent): void
}

export interface PattaCreateEventFactory {
  pattaCreate(input: {
    eventId: string
    patta: LocalPattaRecord
    referenceCursor: string
    clientCreatedAt: string
    occurredAt: string
  }): OfflinePattaCreateEvent
}

export interface CreateOfflinePattaInput extends LocalPattaReferenceInput {
  partiya_number: string
}

export interface OfflinePattaCreateResult {
  patta: PersistedLocalPatta
  should_prefetch: boolean
}

export interface OfflinePattaServiceDependencies {
  unitOfWork: LocalUnitOfWork
  blockRepository: Pick<PattaNumberBlockRepository, 'consumeNext'>
  modelRepository: Pick<ModelLocalRepository, 'snapshotAt'>
  pattaRepository: Pick<PattaLocalRepository, 'createLocal'>
  syncQueueRepository: LocalSyncQueueWriter
  syncStateRepository: Pick<SyncStateRepository, 'lastServerCursor'>
  deviceId: string
  clock: Clock
  idFactory?: () => string
  eventFactory?: PattaCreateEventFactory
}

export class DefaultPattaCreateEventFactory implements PattaCreateEventFactory {
  pattaCreate(input: {
    eventId: string
    patta: LocalPattaRecord
    referenceCursor: string
    clientCreatedAt: string
    occurredAt: string
  }): OfflinePattaCreateEvent {
    const { patta } = input
    const payload: SyncPattaCreatePayload = {
      partiya_number: patta.partiya_number,
      patta_number: patta.patta_number,
      model_id: patta.model_id,
      model_name_snapshot: patta.model_name_snapshot,
      template_id: patta.template_id,
      konveyer_snapshot: patta.konveyer_snapshot,
      razmer: patta.razmer,
      rang: patta.rang,
      block_id: patta.created_from_block_id,
      ...(patta.template_overrides === undefined
        ? {}
        : { template_overrides: patta.template_overrides }),
      reference_versions: patta.reference_versions,
      operations: patta.operations.map((snapshot): SyncPattaOperationSnapshotInput => ({
        id: snapshot.id,
        operation_id: snapshot.operation_id,
        operation_name_snapshot: snapshot.operation_name_snapshot,
        unit_price_snapshot: snapshot.unit_price_snapshot,
        sort_order: snapshot.sort_order
      }))
    }
    return {
      event_id: input.eventId,
      entity_type: 'patta',
      entity_id: patta.id,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: input.clientCreatedAt,
      occurred_at: input.occurredAt,
      reference_cursor: input.referenceCursor,
      payload
    }
  }
}

function canonicalPartiyaNumber(value: string): string {
  const canonical = value.replace(ASCII_WHITESPACE, ' ').trim()
  if (!canonical) {
    throw new LocalDomainError(
      'INVALID_PARTIYA_NUMBER',
      'Partiya raqami bo‘sh bo‘lishi mumkin emas',
      { field: 'partiya_number' }
    )
  }
  return canonical
}

function assertUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new LocalDomainError('LOCAL_ID_INVALID', 'Mahalliy UUID formati noto‘g‘ri', {
      field: label
    })
  }
  return value.toLowerCase()
}

function assertTimestamp(value: string, label: string): string {
  try {
    return canonicalUtcTimestamp(value, label)
  } catch {
    throw new LocalDomainError('LOCAL_TIMESTAMP_INVALID', 'Sana va vaqt formati noto‘g‘ri', {
      field: label
    })
  }
}

function snapshotFingerprint(snapshot: LocalPattaReferenceSnapshot): string {
  return JSON.stringify(snapshot)
}

export class OfflinePattaService {
  private readonly idFactory: () => string
  private readonly eventFactory: PattaCreateEventFactory

  constructor(private readonly dependencies: OfflinePattaServiceDependencies) {
    this.idFactory = dependencies.idFactory ?? randomUUID
    this.eventFactory = dependencies.eventFactory ?? new DefaultPattaCreateEventFactory()
  }

  create(input: CreateOfflinePattaInput): OfflinePattaCreateResult {
    const partiyaNumber = canonicalPartiyaNumber(input.partiya_number)
    const occurredAt = assertTimestamp(input.occurred_at, 'occurred_at')
    const clientCreatedAt = assertTimestamp(
      this.dependencies.clock.nowIsoUtc(),
      'client_created_at'
    )
    const referenceCursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (referenceCursor === null) {
      throw new LocalDomainError(
        'SYNC_BOOTSTRAP_REQUIRED',
        'Patta yaratishdan oldin ma’lumotnomalarni sinxronlang'
      )
    }
    assertPostgresBigint(referenceCursor, 'Server change cursor')

    const referenceInput: LocalPattaReferenceInput = {
      model_id: input.model_id,
      template_id: input.template_id,
      konveyer: input.konveyer,
      razmer: input.razmer,
      rang: input.rang,
      occurred_at: occurredAt
    }
    const initialSnapshot = this.dependencies.modelRepository.snapshotAt(referenceInput)
    const eventId = assertUuid(this.idFactory(), 'event_id')
    const pattaId = assertUuid(this.idFactory(), 'patta_id')
    const snapshotIds = new Map(
      initialSnapshot.operations.map((operation) => [
        operation.operation_id,
        assertUuid(this.idFactory(), `operation_snapshot.${operation.operation_id}`)
      ])
    )
    if (new Set([eventId, pattaId, ...snapshotIds.values()]).size !== snapshotIds.size + 2) {
      throw new LocalDomainError('LOCAL_ID_COLLISION', 'Yangi mahalliy UUID takrorlandi')
    }
    const initialSnapshotFingerprint = snapshotFingerprint(initialSnapshot)

    return this.dependencies.unitOfWork.transaction(() => {
      const allocation: LocalBlockConsumption = this.dependencies.blockRepository.consumeNext()
      const currentSnapshot = this.dependencies.modelRepository.snapshotAt(referenceInput)
      if (snapshotFingerprint(currentSnapshot) !== initialSnapshotFingerprint) {
        throw new LocalDomainError(
          'LOCAL_REFERENCE_CHANGED',
          'Model ma’lumotlari Patta yaratilayotgan vaqtda o‘zgardi'
        )
      }

      const operations = currentSnapshot.operations.map((operation) => {
        const snapshotId = snapshotIds.get(operation.operation_id)
        if (!snapshotId) {
          throw new LocalDomainError(
            'LOCAL_OPERATION_SNAPSHOT_ID_MISSING',
            'Operatsiya snapshoti uchun UUID tayyorlanmadi',
            { operation_id: operation.operation_id }
          )
        }
        return {
          id: snapshotId,
          operation_id: operation.operation_id,
          operation_name_snapshot: operation.operation_name,
          unit_price_snapshot: operation.unit_price,
          sort_order: operation.sort_order
        }
      })
      const patta: LocalPattaRecord = {
        id: pattaId,
        partiya_number: partiyaNumber,
        patta_number: allocation.pattaNumber,
        model_id: currentSnapshot.model_id,
        model_name_snapshot: currentSnapshot.model_name,
        template_id: currentSnapshot.template_id,
        konveyer_snapshot: currentSnapshot.konveyer,
        razmer: currentSnapshot.razmer,
        rang: currentSnapshot.rang,
        ish_soni: operations.length,
        created_device_id: this.dependencies.deviceId,
        created_from_block_id: allocation.blockId,
        created_at: clientCreatedAt,
        client_created_at: clientCreatedAt,
        occurred_at: occurredAt,
        version: '0',
        ownership_state: 'LOCAL_PENDING',
        reference_versions: currentSnapshot.reference_versions,
        ...(currentSnapshot.template_overrides === undefined
          ? {}
          : { template_overrides: currentSnapshot.template_overrides }),
        operations
      }

      const persistedPatta = this.dependencies.pattaRepository.createLocal(patta)
      const event = this.eventFactory.pattaCreate({
        eventId,
        patta,
        referenceCursor,
        clientCreatedAt,
        occurredAt
      })
      this.dependencies.syncQueueRepository.enqueue(event)
      return { patta: persistedPatta, should_prefetch: allocation.shouldPrefetch }
    })
  }
}
