import { randomUUID } from 'node:crypto'
import type {
  DesktopModelOperationOption,
  ModelAccountAdjustmentProjection,
  ModelAccountAdjustmentSyncEvent,
} from '@textile/sync-protocol'
import { LocalDomainError } from './local-errors'
import { assertPostgresBigint } from './decimal-string'
import { LocalUnitOfWork } from './local-unit-of-work'
import type { ModelLocalRepository } from './model-local.repository'
import type { ModelAccountAdjustmentRepository } from './model-account-adjustment.repository'
import type { WorkerLocalRepository } from './worker-local.repository'
import type { SyncQueueRepository } from './sync-queue.repository'
import type { SyncStateRepository } from './sync-state.repository'
import { canonicalUtcTimestamp } from './utc-timestamp'
import { isValidTenantTimezone } from '../auth/tenant-timezone'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n

export interface CreateManualAdjustmentInput {
  model_id: string
  model_operation_id: string
  worker_id: string
  quantity: number
}

export interface ModelAccountAdjustmentServiceDependencies {
  unitOfWork: LocalUnitOfWork
  modelRepository: Pick<ModelLocalRepository, 'snapshotAt'>
  workerRepository: Pick<WorkerLocalRepository, 'getById'>
  adjustmentRepository: Pick<ModelAccountAdjustmentRepository,
    'createLocal' | 'updateLocal' | 'getById' | 'ownershipState'>
  queueRepository: Pick<SyncQueueRepository,
    'enqueue' | 'enqueueOrCoalesceAdjustmentMutation' | 'pendingAdjustmentMutation' |
    'customOperationPrerequisiteEventIds'>
  syncStateRepository: Pick<SyncStateRepository, 'lastServerCursor' | 'tenantTimezone'>
  deviceId: string
  clock: { nowIsoUtc(): string }
  idFactory?: () => string
}

function localBusinessDate(enteredAt: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(enteredAt))
  const values = new Map(parts.map(({ type, value }) => [type, value]))
  const year = values.get('year')
  const month = values.get('month')
  const day = values.get('day')
  if (!year || !month || !day) throw new LocalDomainError('TENANT_TIMEZONE_UNAVAILABLE', 'Ish sanasini aniqlab bo‘lmadi')
  return `${year}-${month}-${day}`
}

export class ModelAccountAdjustmentService {
  private readonly idFactory: () => string

  constructor(private readonly dependencies: ModelAccountAdjustmentServiceDependencies) {
    this.idFactory = dependencies.idFactory ?? randomUUID
  }

  availableOperations(modelIdInput: string, enteredAtInput: string): readonly DesktopModelOperationOption[] {
    const modelId = modelIdInput.toLowerCase()
    if (!UUID_PATTERN.test(modelId)) throw new LocalDomainError('MODEL_ID_INVALID', 'Model identifikatori yaroqsiz')
    const occurredAt = canonicalUtcTimestamp(enteredAtInput, 'Narx tekshirilgan vaqt')
    const reference = this.dependencies.modelRepository.snapshotAt({ model_id: modelId, occurred_at: occurredAt })
    return reference.operations.map((operation) => ({
      model_operation_id: operation.operation_id,
      operation_name_snapshot: operation.operation_name,
      unit_price_snapshot: operation.unit_price,
      sort_order: operation.sort_order,
      version: operation.version
    }))
  }

  create(input: CreateManualAdjustmentInput, actorUserId: string): ModelAccountAdjustmentProjection {
    this.validateCreateInput(input)
    const timezone = this.dependencies.syncStateRepository.tenantTimezone()
    if (!isValidTenantTimezone(timezone)) {
      throw new LocalDomainError('TENANT_TIMEZONE_UNAVAILABLE', 'Qo‘shimcha kiritishdan oldin korxona vaqt mintaqasini yangilang')
    }
    const enteredAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Qo‘shimcha kiritilgan vaqt')
    const businessDate = localBusinessDate(enteredAt, timezone)
    const cursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (cursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(cursor, 'Server change cursor')
    const modelId = input.model_id.toLowerCase()
    const operationId = input.model_operation_id.toLowerCase()
    const workerId = input.worker_id

    return this.dependencies.unitOfWork.transaction(() => {
      const worker = this.dependencies.workerRepository.getById(workerId)
      if (!worker || worker.status !== 'ACTIVE') {
        throw new LocalDomainError('WORKER_NOT_FOUND', 'Faol ishchi topilmadi', { worker_id: workerId })
      }
      const reference = this.dependencies.modelRepository.snapshotAt({ model_id: modelId, occurred_at: enteredAt })
      const operation = reference.operations.find(({ operation_id }) => operation_id === operationId)
      if (!operation) {
        throw new LocalDomainError('OPERATION_NOT_FOUND', 'Tanlangan model operatsiyasi shu vaqtda faol emas', {
          model_operation_id: operationId
        })
      }
      const id = this.uuid('model_account_adjustment.id')
      const now = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Qo‘shimcha yaratilgan vaqt')
      const adjustment: ModelAccountAdjustmentProjection = {
        id,
        model_id: reference.model_id,
        model_operation_id: operation.operation_id,
        worker_id: workerId,
        quantity: input.quantity,
        unit_price_snapshot: operation.unit_price,
        entered_at: enteredAt,
        business_date: businessDate,
        version: '0',
        created_by: actorUserId,
        created_device_id: this.dependencies.deviceId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        deleted_by: null
      }
      this.dependencies.adjustmentRepository.createLocal(adjustment)
      this.dependencies.queueRepository.enqueue(this.toEvent(
        adjustment,
        this.uuid('model_account_adjustment.event_id'),
        'CREATE',
        '0',
        now,
        cursor
      ))
      return adjustment
    })
  }

  update(adjustmentIdInput: string, expectedVersion: string, quantity: number): ModelAccountAdjustmentProjection {
    const adjustmentId = adjustmentIdInput.toLowerCase()
    if (!UUID_PATTERN.test(adjustmentId) || !/^(0|[1-9][0-9]*)$/.test(expectedVersion) ||
      BigInt(expectedVersion) > MAX_POSTGRES_BIGINT || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) {
      throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_UPDATE_INVALID', 'Qo‘shimchani tahrirlash ma’lumoti yaroqsiz')
    }
    const cursor = this.cursor()
    const occurredAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Qo‘shimcha tahrirlangan vaqt')
    return this.dependencies.unitOfWork.transaction(() => {
      const current = this.getEditable(adjustmentId, expectedVersion)
      if (current.deleted_at !== null) {
        throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_TRASHED', 'Korzinkadagi qo‘shimchani tahrirlab bo‘lmaydi')
      }
      const { baseVersion, nextVersion } = this.prepareMutationVersion(current.id, current.version)
      const updated: ModelAccountAdjustmentProjection = {
        ...current,
        quantity,
        version: nextVersion,
        updated_at: occurredAt
      }
      this.dependencies.adjustmentRepository.updateLocal(updated)
      this.dependencies.queueRepository.enqueueOrCoalesceAdjustmentMutation(
        this.toEvent(updated, this.uuid('model_account_adjustment.event_id'), 'UPDATE', baseVersion, occurredAt, cursor)
      )
      return updated
    })
  }

  trash(adjustmentIdInput: string, expectedVersion: string, actorUserId: string): ModelAccountAdjustmentProjection {
    return this.setTrashed(adjustmentIdInput, expectedVersion, actorUserId, true)
  }

  restore(adjustmentIdInput: string, expectedVersion: string): ModelAccountAdjustmentProjection {
    return this.setTrashed(adjustmentIdInput, expectedVersion, null, false)
  }

  private setTrashed(
    adjustmentIdInput: string,
    expectedVersion: string,
    actorUserId: string | null,
    trashed: boolean
  ): ModelAccountAdjustmentProjection {
    const adjustmentId = adjustmentIdInput.toLowerCase()
    if (!UUID_PATTERN.test(adjustmentId) || !/^(0|[1-9][0-9]*)$/.test(expectedVersion) ||
      BigInt(expectedVersion) > MAX_POSTGRES_BIGINT || (trashed && !actorUserId)) {
      throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_LIFECYCLE_INVALID', 'Qo‘shimcha holatini o‘zgartirish ma’lumoti yaroqsiz')
    }
    const cursor = this.cursor()
    const occurredAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Qo‘shimcha holati o‘zgargan vaqt')
    return this.dependencies.unitOfWork.transaction(() => {
      const current = this.getEditable(adjustmentId, expectedVersion)
      if ((current.deleted_at !== null) === trashed) {
        throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_LIFECYCLE_CONFLICT',
          trashed ? 'Qo‘shimcha allaqachon Korzinkada' : 'Qo‘shimcha Korzinkada emas')
      }
      const { baseVersion, nextVersion } = this.prepareMutationVersion(current.id, current.version)
      const updated: ModelAccountAdjustmentProjection = {
        ...current,
        version: nextVersion,
        updated_at: occurredAt,
        deleted_at: trashed ? occurredAt : null,
        deleted_by: trashed ? actorUserId : null
      }
      this.dependencies.adjustmentRepository.updateLocal(updated)
      this.dependencies.queueRepository.enqueueOrCoalesceAdjustmentMutation(
        this.toEvent(updated, this.uuid('model_account_adjustment.event_id'), 'UPDATE', baseVersion, occurredAt, cursor)
      )
      return updated
    })
  }

  private getEditable(adjustmentId: string, expectedVersion: string): ModelAccountAdjustmentProjection {
    const current = this.dependencies.adjustmentRepository.getById(adjustmentId)
    if (!current) throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_NOT_FOUND', 'Qo‘lda qo‘shilgan yozuv topilmadi')
    if (current.version !== expectedVersion) {
      throw new LocalDomainError('VERSION_CONFLICT', 'Model hisob yozuvi boshqa foydalanuvchi tomonidan o‘zgartirilgan', {
        expected_version: expectedVersion,
        current_version: current.version
      })
    }
    return current
  }

  private prepareMutationVersion(
    adjustmentId: string,
    currentVersion: string
  ): { baseVersion: string; nextVersion: string } {
    const state = this.dependencies.adjustmentRepository.ownershipState(adjustmentId)
    const queued = this.dependencies.queueRepository.pendingAdjustmentMutation(adjustmentId)
    if (state === 'SERVER_SYNCED') {
      const next = BigInt(currentVersion) + 1n
      if (next > MAX_POSTGRES_BIGINT) throw new LocalDomainError('VERSION_EXHAUSTED', 'Qo‘shimcha versiyasi tugadi')
      return { baseVersion: currentVersion, nextVersion: next.toString() }
    }
    if (state === 'LOCAL_PENDING' && currentVersion === '0' && queued?.operation === 'CREATE' &&
      queued.status === 'PENDING' && queued.ever_sent === 0) {
      return { baseVersion: '0', nextVersion: '0' }
    }
    if (state === 'LOCAL_PENDING' && queued?.operation === 'UPDATE' &&
      queued.status === 'PENDING' && queued.ever_sent === 0) {
      return { baseVersion: queued.base_version, nextVersion: currentVersion }
    }
    throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_SYNC_REQUIRED', 'Oldingi qo‘shimcha o‘zgarishini avval sinxronlang')
  }

  private toEvent(
    adjustment: ModelAccountAdjustmentProjection,
    eventId: string,
    operation: 'CREATE' | 'UPDATE',
    baseVersion: string,
    occurredAt: string,
    cursor: string
  ): ModelAccountAdjustmentSyncEvent {
    return {
      event_id: eventId,
      entity_type: 'model_account_adjustment',
      entity_id: adjustment.id,
      operation,
      base_version: baseVersion,
      client_created_at: occurredAt,
      occurred_at: occurredAt,
      reference_cursor: cursor,
      payload: {
        model_id: adjustment.model_id,
        model_operation_id: adjustment.model_operation_id,
        worker_id: adjustment.worker_id,
        quantity: adjustment.quantity,
        unit_price_snapshot: adjustment.unit_price_snapshot,
        entered_at: adjustment.entered_at,
        business_date: adjustment.business_date,
        deleted_at: adjustment.deleted_at,
        deleted_by: adjustment.deleted_by,
        depends_on_event_ids: this.dependencies.queueRepository.customOperationPrerequisiteEventIds([
          adjustment.model_operation_id
        ])
      }
    }
  }

  private cursor(): string {
    const cursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (cursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(cursor, 'Server change cursor')
    return cursor
  }

  private validateCreateInput(input: CreateManualAdjustmentInput): void {
    if (!UUID_PATTERN.test(input.model_id) || !UUID_PATTERN.test(input.model_operation_id) ||
      !/^[1-9][0-9]*$/.test(input.worker_id) || BigInt(input.worker_id) > MAX_POSTGRES_BIGINT ||
      !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 2_147_483_647) {
      throw new LocalDomainError('MODEL_ACCOUNT_ADJUSTMENT_INPUT_INVALID', 'Qo‘lda qo‘shish ma’lumoti yaroqsiz')
    }
  }

  private uuid(field: string): string {
    const id = this.idFactory()
    if (!UUID_PATTERN.test(id)) throw new LocalDomainError('LOCAL_ID_INVALID', 'Mahalliy UUID formati noto‘g‘ri', { field })
    return id.toLowerCase()
  }
}
