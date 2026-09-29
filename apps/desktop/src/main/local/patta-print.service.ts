import { randomUUID } from 'node:crypto'
import type {
  PattaPrintBatchProjection,
  PattaPrintBatchSyncEvent,
  PattaPrintEventProjection,
  PattaPrintEventSyncEvent
} from '@textile/sync-protocol'
import { assertPostgresBigint, compareDecimalStrings } from './decimal-string'
import { LocalDomainError } from './local-errors'
import { LocalUnitOfWork } from './local-unit-of-work'
import type { ModelLocalRepository, LocalPattaReferenceSnapshot } from './model-local.repository'
import type { PattaNumberBlockRepository } from './patta-number-block.repository'
import type { PattaPartiyaNumberBlockRepository } from './patta-partiya-number-block.repository'
import type { PattaPrintBatchRepository } from './patta-print-batch.repository'
import type { SyncStateRepository } from './sync-state.repository'

const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n

export interface PattaPrintClock {
  nowIsoUtc(): string
}

export interface PattaPrintQueueWriter {
  enqueue(event: PattaPrintBatchSyncEvent | PattaPrintEventSyncEvent): void
  enqueueOrCoalesceBatchCorrection?(event: PattaPrintBatchSyncEvent): string
  pendingPrintBatchMutation?(entityId: string): {
    event_id: string
    operation: 'CREATE' | 'UPDATE'
    base_version: string
    status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'CONFLICT' | 'FAILED'
    ever_sent: number
  } | null
}

export interface PattaPrintBatchInput {
  model_id: string
  ish_soni: number
  rang: string
  size_distribution: readonly { razmer: string; patta_count: number; sort_order: number }[]
}

export interface PattaPrintBatchCreateResult {
  batch: PattaPrintBatchProjection
  should_prefetch: boolean
}

export interface PattaPrintBatchCorrectionInput {
  batch_id: string
  expected_version: string
  correction_reason: string
  ish_soni: number
  rang: string
  size_distribution: readonly { razmer: string; patta_count: number; sort_order: number }[]
}

export interface PattaPrintEventInput {
  batch_id: string
  revision: number
  kind: PattaPrintEventProjection['kind']
  outcome: PattaPrintEventProjection['outcome']
}

export interface PattaPrintServiceDependencies {
  unitOfWork: LocalUnitOfWork
  partiyaBlocks: Pick<PattaPartiyaNumberBlockRepository, 'consumeNext'>
  pattaBlocks: Pick<PattaNumberBlockRepository, 'consumeNext'>
  modelRepository: Pick<ModelLocalRepository, 'snapshotAt'>
  batchRepository: Pick<PattaPrintBatchRepository,
    'createLocal' | 'correctLocal' | 'getById' | 'ownershipState' | 'pattaIdsWithEntries' | 'recordPrintEventLocal'>
  queueRepository: PattaPrintQueueWriter
  syncStateRepository: Pick<SyncStateRepository, 'lastServerCursor'>
  deviceId: string
  clock: PattaPrintClock
  idFactory?: () => string
  maxBatchSize?: number
}

interface NormalizedSize {
  razmer: string
  patta_count: number
  sort_order: number
}

function canonicalize(value: string): string {
  return value.replace(ASCII_WHITESPACE, ' ').trim()
}

function uuid(idFactory: () => string, label: string): string {
  const value = idFactory()
  if (!UUID_PATTERN.test(value)) {
    throw new LocalDomainError('LOCAL_ID_INVALID', 'Mahalliy UUID formati noto‘g‘ri', { field: label })
  }
  return value.toLowerCase()
}

function normalizeSizes(input: PattaPrintBatchInput['size_distribution'], maximum: number): NormalizedSize[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new LocalDomainError('PATTA_SIZE_DISTRIBUTION_INVALID', 'Kamida bitta razmer qatori kerak')
  }
  const sizes = new Set<string>()
  const orders = new Set<number>()
  const normalized = input.map((row) => {
    const razmer = canonicalize(row.razmer)
    if (!razmer || !Number.isSafeInteger(row.patta_count) || row.patta_count <= 0 ||
      !Number.isSafeInteger(row.sort_order) || row.sort_order < 0 ||
      sizes.has(razmer) || orders.has(row.sort_order)) {
      throw new LocalDomainError('PATTA_SIZE_DISTRIBUTION_INVALID', 'Razmer taqsimoti noto‘g‘ri')
    }
    sizes.add(razmer)
    orders.add(row.sort_order)
    return { razmer, patta_count: row.patta_count, sort_order: row.sort_order }
  }).sort((left, right) => left.sort_order - right.sort_order || left.razmer.localeCompare(right.razmer))
  const total = normalized.reduce((count, size) => count + size.patta_count, 0)
  if (!Number.isSafeInteger(total) || total > maximum) {
    throw new LocalDomainError('PATTA_BATCH_SIZE_INVALID', 'Patta soni ruxsat etilgan chegaradan oshdi', { maximum: String(maximum) })
  }
  return normalized
}

function sameSnapshot(left: LocalPattaReferenceSnapshot, right: LocalPattaReferenceSnapshot): boolean {
  return left.model_id === right.model_id && left.model_name === right.model_name &&
    left.model_version === right.model_version && left.template_id === right.template_id &&
    left.konveyer === right.konveyer && left.rang === right.rang &&
    JSON.stringify(left.reference_versions) === JSON.stringify(right.reference_versions) &&
    JSON.stringify(left.operations) === JSON.stringify(right.operations)
}

export class PattaPrintService {
  private readonly idFactory: () => string
  private readonly maxBatchSize: number

  constructor(private readonly dependencies: PattaPrintServiceDependencies) {
    this.idFactory = dependencies.idFactory ?? randomUUID
    this.maxBatchSize = dependencies.maxBatchSize ?? 100
  }

  createBatch(input: PattaPrintBatchInput): PattaPrintBatchCreateResult {
    if (!Number.isSafeInteger(input.ish_soni) || input.ish_soni <= 0) {
      throw new LocalDomainError('PATTA_QUANTITY_INVALID', 'Ish soni 0 dan katta butun son bo‘lishi kerak')
    }
    const rang = canonicalize(input.rang)
    if (!rang) throw new LocalDomainError('PATTA_COLOR_REQUIRED', 'Rangni kiriting')
    const sizes = normalizeSizes(input.size_distribution, this.maxBatchSize)
    const referenceCursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (referenceCursor === null) {
      throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Bosma to‘plam yaratishdan oldin ma’lumotnomalarni sinxronlang')
    }
    assertPostgresBigint(referenceCursor, 'Server change cursor')
    const createdAt = this.dependencies.clock.nowIsoUtc()
    const batchId = uuid(this.idFactory, 'batch_id')
    const eventId = uuid(this.idFactory, 'event_id')
    const sizeIds = sizes.map((_, index) => uuid(this.idFactory, `size.${index}.id`))
    const allocatedIds = [batchId, eventId, ...sizeIds]
    if (new Set(allocatedIds).size !== allocatedIds.length) {
      throw new LocalDomainError('LOCAL_ID_COLLISION', 'Yangi mahalliy UUID takrorlandi')
    }

    return this.dependencies.unitOfWork.transaction(() => {
      const partiyaAllocation = this.dependencies.partiyaBlocks.consumeNext()
      const pattaAllocations = sizes.flatMap((size) =>
        Array.from({ length: size.patta_count }, () => this.dependencies.pattaBlocks.consumeNext())
      )
      const firstSize = sizes[0]
      if (!firstSize) throw new LocalDomainError('PATTA_SIZE_DISTRIBUTION_INVALID', 'Razmer taqsimoti bo‘sh')
      const firstSnapshot = this.dependencies.modelRepository.snapshotAt({
        model_id: input.model_id,
        razmer: firstSize.razmer,
        rang,
        occurred_at: createdAt
      })
      if (firstSnapshot.operations.length === 0) {
        throw new LocalDomainError('PATTA_MODEL_HAS_NO_OPERATIONS', 'Modelda faol operatsiyalar yo‘q')
      }

      const snapshotBySize = sizes.map((size) => {
        const snapshot = this.dependencies.modelRepository.snapshotAt({
          model_id: input.model_id,
          razmer: size.razmer,
          rang,
          occurred_at: createdAt
        })
        if (!sameSnapshot(firstSnapshot, snapshot)) {
          throw new LocalDomainError('LOCAL_REFERENCE_CHANGED', 'Model snapshotlari razmerlar orasida farq qildi')
        }
        return snapshot
      })

      let allocationIndex = 0
      const pattas: PattaPrintBatchProjection['pattas'][number][] = []
      const queuePattas: PattaPrintBatchSyncEvent['payload']['pattas'][number][] = []
      const sizeDistribution = sizes.map((size, sizeIndex) => ({
        id: sizeIds[sizeIndex]!,
        print_batch_id: batchId,
        ...size
      }))
      const queueSizeDistribution = sizeDistribution.map(({ id, razmer, patta_count, sort_order }) => ({
        id,
        razmer,
        patta_count,
        sort_order
      }))
      for (const [sizeIndex, size] of sizes.entries()) {
        const snapshot = snapshotBySize[sizeIndex]
        if (!snapshot) throw new LocalDomainError('LOCAL_REFERENCE_CHANGED', 'Razmer snapshoti topilmadi')
        for (let index = 0; index < size.patta_count; index += 1) {
          const allocation = pattaAllocations[allocationIndex]
          if (!allocation) throw new LocalDomainError('PATTA_NUMBER_BLOCKS_EXHAUSTED', 'Patta raqam bloki tugadi')
          allocationIndex += 1
          const pattaId = uuid(this.idFactory, `patta.${allocationIndex}.id`)
          const operationSnapshots = snapshot.operations.map((operation, operationIndex) => ({
            id: uuid(this.idFactory, `patta.${allocationIndex}.operation.${operationIndex}.id`),
            patta_hisob_id: pattaId,
            operation_id: operation.operation_id,
            operation_name_snapshot: operation.operation_name,
            unit_price_snapshot: operation.unit_price,
            sort_order: operation.sort_order,
            created_at: createdAt
          }))
          const projectionPatta: PattaPrintBatchProjection['pattas'][number] = {
            id: pattaId,
            partiya_number: partiyaAllocation.partiyaNumber,
            patta_number: allocation.pattaNumber,
            model_id: snapshot.model_id,
            model_name_snapshot: snapshot.model_name,
            template_id: null,
            konveyer_snapshot: null,
            razmer: size.razmer,
            rang,
            ish_soni: input.ish_soni,
            legacy_operation_count: null,
            status: 'ACTIVE',
            version: '0',
            print_batch_id: batchId,
            created_device_id: this.dependencies.deviceId,
            created_from_block_id: allocation.blockId,
            created_at: createdAt,
            client_created_at: createdAt,
            occurred_at: createdAt,
            operations: operationSnapshots
          }
          pattas.push(projectionPatta)
          queuePattas.push({
            id: pattaId,
            patta_number: allocation.pattaNumber,
            block_id: allocation.blockId,
            razmer: size.razmer,
            operation_snapshots: operationSnapshots.map((operation) => ({
              id: operation.id,
              operation_id: operation.operation_id,
              operation_name_snapshot: operation.operation_name_snapshot,
              unit_price_snapshot: operation.unit_price_snapshot,
              sort_order: operation.sort_order
            }))
          })
        }
      }
      const batch: PattaPrintBatchProjection = {
        id: batchId,
        model_id: firstSnapshot.model_id,
        model_name_snapshot: firstSnapshot.model_name,
        partiya_number: partiyaAllocation.partiyaNumber,
        partiya_block_id: partiyaAllocation.blockId,
        ish_soni: input.ish_soni,
        rang,
        status: 'ACTIVE',
        version: '0',
        revision: 1,
        corrected_from_batch_id: null,
        created_by: null,
        created_device_id: this.dependencies.deviceId,
        created_at: createdAt,
        updated_at: createdAt,
        printed_at: null,
        size_distribution: sizeDistribution,
        pattas
      }
      this.dependencies.batchRepository.createLocal(batch)
      const event: PattaPrintBatchSyncEvent = {
        event_id: eventId,
        entity_type: 'patta_print_batch',
        entity_id: batchId,
        operation: 'CREATE',
        base_version: '0',
        client_created_at: createdAt,
        occurred_at: createdAt,
        reference_cursor: referenceCursor,
        payload: {
          model_id: batch.model_id,
          model_name_snapshot: batch.model_name_snapshot,
          partiya_block_id: partiyaAllocation.blockId,
          partiya_number: partiyaAllocation.partiyaNumber,
          ish_soni: input.ish_soni,
          rang,
          size_distribution: queueSizeDistribution,
          pattas: queuePattas,
          depends_on_event_ids: []
        }
      }
      this.dependencies.queueRepository.enqueue(event)
      return {
        batch,
        should_prefetch: partiyaAllocation.shouldPrefetch || pattaAllocations.some((allocation) => allocation.shouldPrefetch)
      }
    })
  }

  correctBatch(input: PattaPrintBatchCorrectionInput): PattaPrintBatchCreateResult {
    const batchId = input.batch_id.toLowerCase()
    if (!UUID_PATTERN.test(batchId) || !/^(0|[1-9][0-9]*)$/.test(input.expected_version) ||
      BigInt(input.expected_version) > MAX_POSTGRES_BIGINT) {
      throw new LocalDomainError('PATTA_CORRECTION_INPUT_INVALID', 'Patta tuzatish versiyasi yaroqsiz')
    }
    const correctionReason = canonicalize(input.correction_reason)
    if (correctionReason.length < 3 || correctionReason.length > 500) {
      throw new LocalDomainError('PATTA_CORRECTION_REASON_REQUIRED', 'Tuzatish sababini kiriting')
    }
    if (!Number.isSafeInteger(input.ish_soni) || input.ish_soni < 1 || input.ish_soni > 2_147_483_647) {
      throw new LocalDomainError('PATTA_QUANTITY_INVALID', 'Ish soni noto‘g‘ri')
    }
    const rang = canonicalize(input.rang)
    if (!rang) throw new LocalDomainError('PATTA_COLOR_REQUIRED', 'Rangni kiriting')
    const sizes = normalizeSizes(input.size_distribution, this.maxBatchSize)
    const referenceCursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (referenceCursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(referenceCursor, 'Server change cursor')
    const occurredAt = this.dependencies.clock.nowIsoUtc()

    return this.dependencies.unitOfWork.transaction(() => {
      const batch = this.dependencies.batchRepository.getById(batchId)
      if (!batch || batch.status !== 'ACTIVE') {
        throw new LocalDomainError('PATTA_PRINT_BATCH_NOT_FOUND', 'Faol Patta bosma to‘plami topilmadi')
      }
      if (batch.version !== input.expected_version) {
        throw new LocalDomainError('VERSION_CONFLICT', 'Patta to‘plami boshqa foydalanuvchi tomonidan o‘zgartirilgan', {
          expected_version: input.expected_version,
          current_version: batch.version
        })
      }
      const ownership = this.dependencies.batchRepository.ownershipState(batch.id)
      const queuedMutation = this.dependencies.queueRepository.pendingPrintBatchMutation?.(batch.id) ?? null
      let mode: 'SERVER_UPDATE' | 'COALESCE_CREATE' | 'COALESCE_UPDATE'
      let baseVersion = batch.version
      let nextVersion: string
      let nextRevision: number
      let bumpChildAndEntryVersions = true
      if (ownership === 'SERVER_SYNCED') {
        mode = 'SERVER_UPDATE'
        const version = BigInt(batch.version) + 1n
        if (version > MAX_POSTGRES_BIGINT) throw new LocalDomainError('PATTA_VERSION_EXHAUSTED', 'Patta versiyasi tugadi')
        nextVersion = version.toString()
        nextRevision = batch.revision + 1
      } else if (ownership === 'LOCAL_PENDING' && batch.version === '0' && queuedMutation?.operation === 'CREATE') {
        if (queuedMutation.status !== 'PENDING' || queuedMutation.ever_sent !== 0) {
          throw new LocalDomainError('PATTA_BATCH_SYNCING', 'Patta to‘plami sinxronlanmoqda; tuzatish bloklandi')
        }
        mode = 'COALESCE_CREATE'
        baseVersion = '0'
        nextVersion = '0'
        nextRevision = batch.revision
        bumpChildAndEntryVersions = false
      } else if (ownership === 'LOCAL_PENDING' && batch.version !== '0' && queuedMutation?.operation === 'UPDATE') {
        if (queuedMutation.status !== 'PENDING' || queuedMutation.ever_sent !== 0) {
          throw new LocalDomainError('PATTA_BATCH_SYNCING', 'Patta to‘plami sinxronlanmoqda; tuzatish bloklandi')
        }
        mode = 'COALESCE_UPDATE'
        baseVersion = queuedMutation.base_version
        nextVersion = batch.version
        nextRevision = batch.revision
        bumpChildAndEntryVersions = false
      } else {
        throw new LocalDomainError('PATTA_BATCH_SYNC_REQUIRED', 'Tuzatishdan oldin Patta to‘plamining holatini sinxronlang')
      }
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
        throw new LocalDomainError('PATTA_REVISION_EXHAUSTED', 'Patta tahrirlari soni tugadi')
      }

      const activePattas = batch.pattas.filter((patta) => patta.status === 'ACTIVE')
        .slice()
        .sort((left, right) => compareDecimalStrings(left.patta_number, right.patta_number, 'Patta raqami'))
      const remaining = new Map(sizes.map((size) => [size.razmer, size.patta_count]))
      const assignments = new Map<string, string>()
      const unmatched: PattaPrintBatchProjection['pattas'][number][] = []
      for (const patta of activePattas) {
        const available = patta.razmer === null ? 0 : (remaining.get(patta.razmer) ?? 0)
        if (available > 0 && patta.razmer !== null) {
          assignments.set(patta.id, patta.razmer)
          remaining.set(patta.razmer, available - 1)
        } else {
          unmatched.push(patta)
        }
      }
      const targetSlots = sizes.flatMap((size) =>
        Array.from({ length: remaining.get(size.razmer) ?? 0 }, () => size.razmer)
      )
      const remappedCount = Math.min(unmatched.length, targetSlots.length)
      for (let index = 0; index < remappedCount; index += 1) {
        const patta = unmatched[index]
        const size = targetSlots[index]
        if (patta && size) assignments.set(patta.id, size)
      }
      const surplus = unmatched.slice(remappedCount)
      const deficits = targetSlots.slice(remappedCount)
      const affectedIds = new Set([
        ...[...assignments.entries()]
          .filter(([id, size]) => activePattas.find((patta) => patta.id === id)?.razmer !== size)
          .map(([id]) => id),
        ...surplus.map(({ id }) => id)
      ])
      const inUse = this.dependencies.batchRepository.pattaIdsWithEntries([...affectedIds])
      if ([...affectedIds].some((id) => inUse.has(id))) {
        throw new LocalDomainError('PATTA_ALREADY_IN_USE', 'Kiritilgan yoki Korzinkadagi Patta razmeri/raqamini tuzatib bo‘lmaydi', {
          patta_ids: [...affectedIds].filter((id) => inUse.has(id)).join(',')
        })
      }
      const entryIds = this.dependencies.batchRepository.pattaIdsWithEntries(activePattas.map(({ id }) => id))
      const sizeIdByName = new Map(batch.size_distribution.map(({ id, razmer }) => [razmer, id]))
      const sizesWithIds = sizes.map((size, index) => ({
        id: sizeIdByName.get(size.razmer) ?? uuid(this.idFactory, `correction.size.${index}.id`),
        print_batch_id: batch.id,
        ...size
      }))
      const nextPattaVersion = (patta: PattaPrintBatchProjection['pattas'][number]): string => {
        if (!bumpChildAndEntryVersions) return patta.version
        const version = BigInt(patta.version) + 1n
        if (version > MAX_POSTGRES_BIGINT) throw new LocalDomainError('PATTA_VERSION_EXHAUSTED', 'Patta versiyasi tugadi')
        return version.toString()
      }
      const nextPattas = batch.pattas.map((patta) => {
        if (patta.status === 'VOID') return patta
        const assignedSize = assignments.get(patta.id)
        if (assignedSize) {
          return {
            ...patta,
            razmer: assignedSize,
            rang,
            ish_soni: input.ish_soni,
            version: nextPattaVersion(patta)
          }
        }
        return { ...patta, status: 'VOID' as const, version: nextPattaVersion(patta) }
      })
      let shouldPrefetch = false
      for (const [index, sizeName] of deficits.entries()) {
        const allocation = this.dependencies.pattaBlocks.consumeNext()
        shouldPrefetch ||= allocation.shouldPrefetch
        const id = uuid(this.idFactory, `correction.patta.${index}.id`)
        const source = activePattas[0]
        if (!source) throw new LocalDomainError('PATTA_SNAPSHOT_MISMATCH', 'Yangi Patta uchun operatsiya tarixi topilmadi')
        const operations = source.operations.map((operation, operationIndex) => ({
          ...operation,
          id: uuid(this.idFactory, `correction.patta.${index}.operation.${operationIndex}.id`),
          patta_hisob_id: id,
          created_at: occurredAt
        }))
        nextPattas.push({
          id,
          partiya_number: batch.partiya_number,
          patta_number: allocation.pattaNumber,
          model_id: batch.model_id,
          model_name_snapshot: batch.model_name_snapshot,
          template_id: null,
          konveyer_snapshot: null,
          razmer: sizeName,
          rang,
          ish_soni: input.ish_soni,
          legacy_operation_count: null,
          status: 'ACTIVE',
          version: mode === 'COALESCE_CREATE' ? '0' : '1',
          print_batch_id: batch.id,
          created_device_id: this.dependencies.deviceId,
          created_from_block_id: allocation.blockId,
          created_at: occurredAt,
          client_created_at: occurredAt,
          occurred_at: occurredAt,
          operations
        })
      }
      const corrected: PattaPrintBatchProjection = {
        ...batch,
        ish_soni: input.ish_soni,
        rang,
        version: nextVersion,
        revision: nextRevision,
        updated_at: occurredAt,
        size_distribution: sizesWithIds,
        pattas: nextPattas
      }
      this.dependencies.batchRepository.correctLocal(
        corrected,
        bumpChildAndEntryVersions && entryIds.size > 0 && batch.ish_soni !== input.ish_soni
      )
      const event: PattaPrintBatchSyncEvent = {
        event_id: uuid(this.idFactory, 'correction.event_id'),
        entity_type: 'patta_print_batch',
        entity_id: batch.id,
        operation: 'UPDATE',
        base_version: baseVersion,
        client_created_at: occurredAt,
        occurred_at: occurredAt,
        reference_cursor: referenceCursor,
        payload: {
          model_id: batch.model_id,
          model_name_snapshot: batch.model_name_snapshot,
          partiya_block_id: batch.partiya_block_id,
          partiya_number: batch.partiya_number,
          ish_soni: corrected.ish_soni,
          rang: corrected.rang,
          size_distribution: corrected.size_distribution.map(({ id, razmer, patta_count, sort_order }) => ({
            id, razmer, patta_count, sort_order
          })),
          pattas: corrected.pattas.filter(({ status }) => status === 'ACTIVE').map((patta) => ({
            id: patta.id,
            patta_number: patta.patta_number,
            block_id: patta.created_from_block_id,
            razmer: patta.razmer ?? '',
            operation_snapshots: patta.operations.map((operation) => ({
              id: operation.id,
              operation_id: operation.operation_id,
              operation_name_snapshot: operation.operation_name_snapshot,
              unit_price_snapshot: operation.unit_price_snapshot,
              sort_order: operation.sort_order
            }))
          })),
          depends_on_event_ids: [],
          correction_reason: correctionReason
        }
      }
      if (this.dependencies.queueRepository.enqueueOrCoalesceBatchCorrection) {
        this.dependencies.queueRepository.enqueueOrCoalesceBatchCorrection(event)
      } else {
        this.dependencies.queueRepository.enqueue(event)
      }
      return { batch: corrected, should_prefetch: shouldPrefetch }
    })
  }

  recordPrintEvent(input: PattaPrintEventInput): PattaPrintEventProjection {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new LocalDomainError('PATTA_PRINT_REVISION_INVALID', 'Patta bosma versiyasi noto‘g‘ri')
    }
    const batchId = input.batch_id.toLowerCase()
    const batch = this.dependencies.batchRepository.getById(batchId)
    if (!batch) throw new LocalDomainError('PATTA_PRINT_BATCH_NOT_FOUND', 'Patta bosma to‘plami topilmadi')
    if (batch.revision !== input.revision) {
      throw new LocalDomainError('PATTA_PRINT_REVISION_CONFLICT', 'Patta to‘plami boshqa versiyada')
    }
    const referenceCursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (referenceCursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(referenceCursor, 'Server change cursor')
    const createdAt = this.dependencies.clock.nowIsoUtc()
    const eventId = uuid(this.idFactory, 'print_event_id')
    const printedAt = input.outcome === 'SUCCEEDED' ? (batch.printed_at ?? createdAt) : batch.printed_at
    const event: PattaPrintEventProjection = {
      id: eventId,
      batch_id: batch.id,
      revision: input.revision,
      kind: input.kind,
      outcome: input.outcome,
      actor_user_id: null,
      device_id: this.dependencies.deviceId,
      created_at: createdAt,
      printed_at: printedAt
    }
    const queued: PattaPrintEventSyncEvent = {
      event_id: eventId,
      entity_type: 'patta_print_event',
      entity_id: eventId,
      operation: 'CREATE',
      base_version: '0',
      client_created_at: createdAt,
      occurred_at: createdAt,
      reference_cursor: referenceCursor,
      payload: {
        batch_id: batch.id,
        revision: input.revision,
        kind: input.kind,
        outcome: input.outcome,
        device_id: this.dependencies.deviceId
      }
    }
    this.dependencies.unitOfWork.transaction(() => {
      this.dependencies.batchRepository.recordPrintEventLocal(event)
      this.dependencies.queueRepository.enqueue(queued)
    })
    return event
  }
}
