import { randomUUID } from 'node:crypto'
import type {
  CustomModelOperationCreateEvent,
  DesktopModelOperationOption,
  PattaSheetProjectionV3,
  PattaSheetSyncEventV3
} from '@textile/sync-protocol'
import { LocalDomainError } from './local-errors'
import { assertPostgresBigint } from './decimal-string'
import { LocalUnitOfWork } from './local-unit-of-work'
import { BadgeLocalRepository } from './badge-local.repository'
import type { PattaLocalRepository } from './patta-local.repository'
import type { PattaSheetRepository } from './patta-sheet.repository'
import type { SyncQueueRepository } from './sync-queue.repository'
import type { SyncStateRepository } from './sync-state.repository'
import type { PattaSheetCustomOperationRepository, CustomOperationDraft, LocalCustomOperation } from './patta-sheet-custom-operation.repository'
import type { ModelLocalRepository } from './model-local.repository'
import { canonicalUtcTimestamp } from './utc-timestamp'
import { isValidTenantTimezone } from '../auth/tenant-timezone'

const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface PattaSheetAssignmentInput {
  model_operation_id: string
  badge_number: string
  nuqson: boolean
  worker_id?: string
}

export interface CreateLinkedPattaSheetInput {
  entry_kind?: 'PATTA_LINKED'
  partiya_number: string
  patta_number: string
  conveyor_snapshot: string | null
  assignments: readonly PattaSheetAssignmentInput[]
  custom_operations?: readonly CustomOperationDraft[]
}

export interface CreateStandalonePattaSheetInput {
  entry_kind: 'STANDALONE'
  entered_at: string
  model_id: string
  ish_soni: number
  partiya_number_snapshot: string | null
  patta_number_snapshot: string | null
  rang_snapshot: string | null
  razmer_snapshot: string | null
  conveyor_snapshot: string | null
  assignments: readonly PattaSheetAssignmentInput[]
  custom_operations?: readonly CustomOperationDraft[]
}

export type CreatePattaSheetInput = CreateLinkedPattaSheetInput | CreateStandalonePattaSheetInput

export interface UpdatePattaSheetInput {
  sheet_id: string
  expected_version: string
  conveyor_snapshot: string | null
  assignments: readonly PattaSheetAssignmentInput[]
  clear_operation_ids?: readonly string[]
}

export interface PattaSheetBadgePreview {
  worker_id: string
  full_name: string
}

export interface PattaSheetServiceDependencies {
  unitOfWork: LocalUnitOfWork
  pattaRepository: Pick<PattaLocalRepository, 'findByBusinessKey' | 'getById'>
  modelRepository: Pick<ModelLocalRepository, 'snapshotAt'>
  sheetRepository: Pick<PattaSheetRepository,
    'createLocal' | 'updateLocal' | 'getById' | 'findByPatta' | 'ownershipState' | 'purgeLocal' | 'badgeEvidence'>
  badgeRepository: Pick<BadgeLocalRepository, 'resolveWorker'>
  queueRepository: Pick<SyncQueueRepository,
    'enqueue' | 'enqueueOrCoalescePattaSheetMutation' | 'pendingPattaSheetMutation' |
    'cancelNeverSentPattaSheetCreate' | 'customOperationPrerequisiteEventIds'>
  customOperationRepository: Pick<PattaSheetCustomOperationRepository, 'createOrReuse'>
  syncStateRepository: Pick<SyncStateRepository, 'lastServerCursor' | 'tenantTimezone'>
  deviceId: string
  clock: { nowIsoUtc(): string }
  idFactory?: () => string
  maxOperations?: number
}

function canonical(value: string): string {
  return value.replace(ASCII_WHITESPACE, ' ').trim()
}

function uuid(factory: () => string, label: string): string {
  const id = factory()
  if (!UUID_PATTERN.test(id)) throw new LocalDomainError('LOCAL_ID_INVALID', 'Mahalliy UUID formati noto‘g‘ri', { field: label })
  return id.toLowerCase()
}

function businessDate(enteredAt: string, timezone: string): string {
  const parsed = new Date(enteredAt)
  if (!Number.isFinite(parsed.getTime())) throw new LocalDomainError('PATTA_SHEET_ENTERED_AT_INVALID', 'Kiritilgan sana yaroqsiz')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(parsed)
  const values = new Map(parts.map(({ type, value }) => [type, value]))
  const year = values.get('year')
  const month = values.get('month')
  const day = values.get('day')
  if (!year || !month || !day) throw new LocalDomainError('TENANT_TIMEZONE_UNAVAILABLE', 'Mahalliy ish sanasini aniqlab bo‘lmadi')
  return `${year}-${month}-${day}`
}

export class PattaSheetService {
  private readonly idFactory: () => string
  private readonly maxOperations: number

  constructor(private readonly dependencies: PattaSheetServiceDependencies) {
    this.idFactory = dependencies.idFactory ?? randomUUID
    this.maxOperations = dependencies.maxOperations ?? 100
  }

  resolveBadge(badgeNumberInput: string, enteredAtInput?: string): PattaSheetBadgePreview | null {
    const badgeNumber = canonical(badgeNumberInput)
    if (!badgeNumber || badgeNumber.length > 48) {
      throw new LocalDomainError('PATTA_SHEET_BADGE_REQUIRED', 'Ishchi Jetonini kiriting')
    }
    const enteredAt = canonicalUtcTimestamp(
      enteredAtInput ?? this.dependencies.clock.nowIsoUtc(),
      'Jeton tekshirilgan vaqt'
    )
    const resolved = this.dependencies.badgeRepository.resolveWorker(badgeNumber, enteredAt)
    return resolved ? { worker_id: resolved.worker_id, full_name: resolved.full_name } : null
  }

  modelOperations(modelIdInput: string, enteredAtInput: string): readonly DesktopModelOperationOption[] {
    const modelId = modelIdInput.toLowerCase()
    if (!UUID_PATTERN.test(modelId)) throw new LocalDomainError('MODEL_ID_INVALID', 'Model identifikatori yaroqsiz')
    const enteredAt = canonicalUtcTimestamp(enteredAtInput, 'Operatsiya narxi tekshirilgan vaqt')
    const snapshot = this.dependencies.modelRepository.snapshotAt({ model_id: modelId, occurred_at: enteredAt })
    return snapshot.operations.map((operation) => ({
      model_operation_id: operation.operation_id,
      operation_name_snapshot: operation.operation_name,
      unit_price_snapshot: operation.unit_price,
      sort_order: operation.sort_order,
      version: operation.version
    }))
  }

  create(input: CreatePattaSheetInput, actorUserId: string | null = null): PattaSheetProjectionV3 {
    if (input.entry_kind === 'STANDALONE') return this.createStandalone(input, actorUserId)
    const partiyaNumber = canonical(input.partiya_number)
    const pattaNumber = input.patta_number
    if (!partiyaNumber || partiyaNumber.length > 256 || !/^[1-9][0-9]*$/.test(pattaNumber) || pattaNumber.length > 19) {
      throw new LocalDomainError('PATTA_NUMBER_INVALID', 'Partiya yoki Patta raqami yaroqsiz')
    }
    const conveyor = input.conveyor_snapshot === null ? null : canonical(input.conveyor_snapshot)
    if (input.conveyor_snapshot !== null && !conveyor) {
      throw new LocalDomainError('PATTA_SHEET_CONVEYOR_INVALID', 'Konveyer qiymati bo‘sh bo‘lishi mumkin emas')
    }
    const timezone = this.dependencies.syncStateRepository.tenantTimezone()
    if (!isValidTenantTimezone(timezone)) {
      throw new LocalDomainError('TENANT_TIMEZONE_UNAVAILABLE', 'Yangi varaq kiritishdan oldin korxona vaqt mintaqasini yangilang')
    }
    const enteredAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Varaq kiritilgan vaqt')
    const localDate = businessDate(enteredAt, timezone)
    const cursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (cursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new LocalDomainError('SYNC_CURSOR_INVALID', 'Server sinxronlash cursor qiymati yaroqsiz')

    return this.dependencies.unitOfWork.transaction(() => {
      const patta = this.dependencies.pattaRepository.findByBusinessKey(partiyaNumber, pattaNumber)
      if (!patta) throw new LocalDomainError('PATTA_NOT_FOUND', 'Patta topilmadi')
      if (patta.status !== 'ACTIVE') throw new LocalDomainError('PATTA_INACTIVE', 'VOID qilingan Patta uchun varaq kiritib bo‘lmaydi')
      if (patta.ish_soni === null || patta.ish_soni < 1) {
        throw new LocalDomainError('PATTA_QUANTITY_UNKNOWN', 'Patta haqiqiy miqdori tuzatilmaguncha varaq kiritib bo‘lmaydi')
      }
      const existing = this.dependencies.sheetRepository.findByPatta(patta.id)
      if (existing) {
        throw new LocalDomainError(existing.deleted_at ? 'PATTA_SHEET_TRASHED' : 'PATTA_SHEET_ALREADY_EXISTS',
          existing.deleted_at ? 'Varaq Korzinkada; avval tiklang' : 'Ushbu Patta uchun varaq allaqachon kiritilgan')
      }
      const customDrafts = input.custom_operations ?? []
      if (patta.operations.length === 0 || patta.operations.length + customDrafts.length > this.maxOperations) {
        throw new LocalDomainError('PATTA_SNAPSHOT_MISMATCH', 'Patta operatsiya snapshotlari yaroqsiz')
      }
      if (new Set(customDrafts.map(({ id }) => id.toLowerCase())).size !== customDrafts.length) {
        throw new LocalDomainError('CUSTOM_OPERATION_INVALID', 'Yangi operatsiya identifikatori takrorlangan')
      }
      const customOperations: LocalCustomOperation[] = []
      const nextSortOrder = patta.operations.reduce((next, operation) => Math.max(next, operation.sort_order + 1), 0)
      for (const [index, draft] of customDrafts.entries()) {
        const operation = this.dependencies.customOperationRepository.createOrReuse(
          patta.model_id, enteredAt, draft, nextSortOrder + index
        )
        customOperations.push(operation)
        if (operation.is_new) {
          const operationEvent: CustomModelOperationCreateEvent = {
            event_id: operation.id,
            entity_type: 'model_operation',
            entity_id: operation.id,
            operation: 'CREATE',
            base_version: '0',
            client_created_at: enteredAt,
            occurred_at: enteredAt,
            reference_cursor: cursor,
            payload: {
              id: operation.id,
              model_id: operation.model_id,
              name: operation.name,
              initial_price: operation.unit_price,
              sort_order: operation.sort_order,
              effective_from: enteredAt
            }
          }
          this.dependencies.queueRepository.enqueue(operationEvent)
        }
      }
      const operationCatalog = [
        ...patta.operations.map((operation) => ({
          model_operation_id: operation.operation_id,
          name: operation.operation_name_snapshot,
          unit_price: operation.unit_price_snapshot,
          sort_order: operation.sort_order,
          source_type: 'PATTA' as const,
          source_patta_operation_snapshot_id: operation.id
        })),
        ...customOperations.map((operation) => ({
          model_operation_id: operation.id,
          name: operation.name,
          unit_price: operation.unit_price,
          sort_order: operation.sort_order,
          source_type: 'CUSTOM' as const,
          source_patta_operation_snapshot_id: null
        }))
      ]
      if (input.assignments.length !== operationCatalog.length) {
        throw new LocalDomainError('PATTA_SHEET_ASSIGNMENTS_INCOMPLETE', 'Har bir operatsiya uchun Jeton kiriting')
      }
      const assignmentsByOperation = new Map<string, PattaSheetAssignmentInput>()
      for (const assignment of input.assignments) {
        const operationId = assignment.model_operation_id.toLowerCase()
        if (!UUID_PATTERN.test(assignment.model_operation_id) || assignmentsByOperation.has(operationId) ||
          typeof assignment.nuqson !== 'boolean') {
          throw new LocalDomainError('PATTA_SHEET_ASSIGNMENT_INVALID', 'Operatsiya topshirig‘i yaroqsiz')
        }
        const badge = assignment.badge_number.trim()
        if (!badge) throw new LocalDomainError('PATTA_SHEET_BADGE_REQUIRED', 'Ishchi Jetonini kiriting')
        assignmentsByOperation.set(operationId, { ...assignment, model_operation_id: operationId, badge_number: badge })
      }

      const sheetId = uuid(this.idFactory, 'sheet_id')
      const eventId = uuid(this.idFactory, 'event_id')
      const snapshots = operationCatalog.map((operation, index) => ({
        id: uuid(this.idFactory, `sheet_operation.${index}.id`),
        patta_sheet_id: sheetId,
        model_operation_id: operation.model_operation_id,
        source_type: operation.source_type,
        source_patta_operation_snapshot_id: operation.source_patta_operation_snapshot_id,
        operation_name_snapshot: operation.name,
        unit_price_snapshot: operation.unit_price,
        sort_order: operation.sort_order,
        created_at: enteredAt
      }))
      const rows = snapshots.map((snapshot) => {
        const assignment = assignmentsByOperation.get(snapshot.model_operation_id)
        if (!assignment) throw new LocalDomainError('PATTA_SHEET_ASSIGNMENTS_INCOMPLETE', 'Har bir operatsiya uchun Jeton kiriting')
        const resolved = this.dependencies.badgeRepository.resolveWorker(assignment.badge_number, enteredAt)
        if (!resolved) throw new LocalDomainError('BADGE_NOT_FOUND', 'Jeton Kiritilgan vaqtda topilmadi', {
          badge_number: assignment.badge_number
        })
        return {
          id: uuid(this.idFactory, `sheet_row.${snapshot.sort_order}.id`),
          patta_sheet_id: sheetId,
          patta_sheet_operation_snapshot_id: snapshot.id,
          worker_id: resolved.worker_id,
          quantity_snapshot: patta.ish_soni as number,
          nuqson: assignment.nuqson,
          deleted_at: null,
          deleted_by: null,
          created_at: enteredAt,
          updated_at: enteredAt,
          entered_badge_number: assignment.badge_number
        }
      })
      const batchProjection: PattaSheetProjectionV3 = {
        id: sheetId,
        entry_kind: 'PATTA_LINKED',
        patta_hisob_id: patta.id,
        model_id: patta.model_id,
        model_name_snapshot: patta.model_name_snapshot,
        ish_soni: patta.ish_soni,
        partiya_number_snapshot: patta.partiya_number,
        patta_number_snapshot: patta.patta_number,
        rang_snapshot: patta.rang,
        razmer_snapshot: patta.razmer,
        entered_at: enteredAt,
        business_date: localDate,
        conveyor_snapshot: conveyor,
        version: '0',
        created_by: actorUserId,
        created_at: enteredAt,
        updated_at: enteredAt,
        deleted_at: null,
        deleted_by: null,
        deleted_by_name_snapshot: null,
        operation_snapshots: snapshots,
        rows: rows.map(({ id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
          nuqson, deleted_at, deleted_by, created_at, updated_at }) => ({
          id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
          nuqson, deleted_at, deleted_by, created_at, updated_at
        }))
      }
      this.dependencies.sheetRepository.createLocal(
        batchProjection,
        new Map(rows.map(({ id, entered_badge_number }) => [id, entered_badge_number])),
      )
      const event: PattaSheetSyncEventV3 = {
        event_id: eventId,
        entity_type: 'patta_sheet',
        entity_id: sheetId,
        operation: 'CREATE',
        base_version: '0',
        client_created_at: enteredAt,
        occurred_at: enteredAt,
        reference_cursor: cursor,
        payload: {
          entry_kind: batchProjection.entry_kind,
          patta_hisob_id: patta.id,
          model_id: patta.model_id,
          model_name_snapshot: patta.model_name_snapshot,
          ish_soni: patta.ish_soni,
          partiya_number_snapshot: patta.partiya_number,
          patta_number_snapshot: patta.patta_number,
          rang_snapshot: patta.rang,
          razmer_snapshot: patta.razmer,
          entered_at: enteredAt,
          business_date: localDate,
          conveyor_snapshot: conveyor,
          deleted_at: null,
          deleted_by: null,
          deleted_by_name_snapshot: null,
          operation_snapshots: snapshots.map((snapshot) => ({
            id: snapshot.id,
            model_operation_id: snapshot.model_operation_id,
            source_type: snapshot.source_type,
            source_patta_operation_snapshot_id: snapshot.source_patta_operation_snapshot_id,
            operation_name_snapshot: snapshot.operation_name_snapshot,
            unit_price_snapshot: snapshot.unit_price_snapshot,
            sort_order: snapshot.sort_order
          })),
          rows: rows.map((row) => ({
            id: row.id,
            patta_sheet_operation_snapshot_id: row.patta_sheet_operation_snapshot_id,
            worker_id: row.worker_id,
            quantity_snapshot: row.quantity_snapshot,
            nuqson: row.nuqson,
            deleted_at: row.deleted_at,
            deleted_by: row.deleted_by,
            entered_badge_number: row.entered_badge_number
          })),
           depends_on_event_ids: this.dependencies.queueRepository.customOperationPrerequisiteEventIds(
             customOperations.map(({ id }) => id)
           )
        }
      }
      this.dependencies.queueRepository.enqueue(event)
      return batchProjection
    })
  }

  private createStandalone(
    input: CreateStandalonePattaSheetInput,
    actorUserId: string | null,
  ): PattaSheetProjectionV3 {
    const modelId = input.model_id.toLowerCase()
    if (!UUID_PATTERN.test(modelId)) throw new LocalDomainError('MODEL_ID_INVALID', 'Model identifikatori yaroqsiz')
    if (!Number.isSafeInteger(input.ish_soni) || input.ish_soni < 1 || input.ish_soni > 2_147_483_647) {
      throw new LocalDomainError('PATTA_SHEET_QUANTITY_INVALID', 'Ish soni musbat butun son bo‘lishi kerak')
    }
    const conveyor = input.conveyor_snapshot === null ? null : canonical(input.conveyor_snapshot)
    if (input.conveyor_snapshot !== null && !conveyor) {
      throw new LocalDomainError('PATTA_SHEET_CONVEYOR_INVALID', 'Konveyer qiymati bo‘sh bo‘lishi mumkin emas')
    }
    const partiya = input.partiya_number_snapshot === null ? null : canonical(input.partiya_number_snapshot)
    const pattaNumber = input.patta_number_snapshot === null ? null : canonical(input.patta_number_snapshot)
    const rang = input.rang_snapshot === null ? null : canonical(input.rang_snapshot)
    const razmer = input.razmer_snapshot === null ? null : canonical(input.razmer_snapshot)
    if (partiya === '' || rang === '' || razmer === '' ||
      (pattaNumber !== null && (!/^[1-9][0-9]*$/.test(pattaNumber) || pattaNumber.length > 19))) {
      throw new LocalDomainError('PATTA_SHEET_SNAPSHOT_INVALID', 'Mahsulot ma’lumotlaridan biri yaroqsiz')
    }
    const timezone = this.dependencies.syncStateRepository.tenantTimezone()
    if (!isValidTenantTimezone(timezone)) {
      throw new LocalDomainError('TENANT_TIMEZONE_UNAVAILABLE', 'Yangi varaq kiritishdan oldin korxona vaqt mintaqasini yangilang')
    }
    const enteredAt = canonicalUtcTimestamp(input.entered_at, 'Varaq kiritilgan vaqt')
    const localDate = businessDate(enteredAt, timezone)
    const cursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (cursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new LocalDomainError('SYNC_CURSOR_INVALID', 'Server sinxronlash cursor qiymati yaroqsiz')

    return this.dependencies.unitOfWork.transaction(() => {
      const reference = this.dependencies.modelRepository.snapshotAt({ model_id: modelId, occurred_at: enteredAt })
      const customDrafts = input.custom_operations ?? []
      if (reference.operations.length === 0 || reference.operations.length + customDrafts.length > this.maxOperations) {
        throw new LocalDomainError('MODEL_HAS_NO_ACTIVE_OPERATIONS', 'Tanlangan modelda faol operatsiyalar yo‘q')
      }
      if (new Set(customDrafts.map(({ id }) => id.toLowerCase())).size !== customDrafts.length) {
        throw new LocalDomainError('CUSTOM_OPERATION_INVALID', 'Yangi operatsiya identifikatori takrorlangan')
      }
      const customOperations: LocalCustomOperation[] = []
      const nextSortOrder = reference.operations.reduce((next, operation) => Math.max(next, operation.sort_order + 1), 0)
      for (const [index, draft] of customDrafts.entries()) {
        const operation = this.dependencies.customOperationRepository.createOrReuse(
          modelId, enteredAt, draft, nextSortOrder + index
        )
        customOperations.push(operation)
        if (operation.is_new) {
          const operationEvent: CustomModelOperationCreateEvent = {
            event_id: operation.id,
            entity_type: 'model_operation',
            entity_id: operation.id,
            operation: 'CREATE',
            base_version: '0',
            client_created_at: enteredAt,
            occurred_at: enteredAt,
            reference_cursor: cursor,
            payload: {
              id: operation.id,
              model_id: operation.model_id,
              name: operation.name,
              initial_price: operation.unit_price,
              sort_order: operation.sort_order,
              effective_from: enteredAt
            }
          }
          this.dependencies.queueRepository.enqueue(operationEvent)
        }
      }
      const operationCatalog = [
        ...reference.operations.map((operation) => ({
          model_operation_id: operation.operation_id,
          name: operation.operation_name,
          unit_price: operation.unit_price,
          sort_order: operation.sort_order,
          source_type: 'MODEL' as const,
          source_patta_operation_snapshot_id: null
        })),
        ...customOperations.map((operation) => ({
          model_operation_id: operation.id,
          name: operation.name,
          unit_price: operation.unit_price,
          sort_order: operation.sort_order,
          source_type: 'CUSTOM' as const,
          source_patta_operation_snapshot_id: null
        }))
      ]
      const assignmentsByOperation = new Map<string, PattaSheetAssignmentInput>()
      for (const assignment of input.assignments) {
        const operationId = assignment.model_operation_id.toLowerCase()
        if (!UUID_PATTERN.test(assignment.model_operation_id) || assignmentsByOperation.has(operationId) ||
          typeof assignment.nuqson !== 'boolean') {
          throw new LocalDomainError('PATTA_SHEET_ASSIGNMENT_INVALID', 'Operatsiya topshirig‘i yaroqsiz')
        }
        const badge = canonical(assignment.badge_number)
        if (!badge) throw new LocalDomainError('PATTA_SHEET_BADGE_REQUIRED', 'Ishchi Jetonini kiriting')
        assignmentsByOperation.set(operationId, { ...assignment, model_operation_id: operationId, badge_number: badge })
      }
      if (assignmentsByOperation.size !== operationCatalog.length ||
        operationCatalog.some((operation) => !assignmentsByOperation.has(operation.model_operation_id))) {
        throw new LocalDomainError('PATTA_SHEET_ASSIGNMENTS_INCOMPLETE', 'Har bir operatsiya uchun Jeton kiriting')
      }

      const sheetId = uuid(this.idFactory, 'sheet_id')
      const eventId = uuid(this.idFactory, 'event_id')
      const snapshots: PattaSheetProjectionV3['operation_snapshots'][number][] = operationCatalog.map((operation, index) => ({
        id: uuid(this.idFactory, `sheet_operation.${index}.id`),
        patta_sheet_id: sheetId,
        model_operation_id: operation.model_operation_id,
        source_type: operation.source_type,
        source_patta_operation_snapshot_id: null,
        operation_name_snapshot: operation.name,
        unit_price_snapshot: operation.unit_price,
        sort_order: operation.sort_order,
        created_at: enteredAt
      }))
      const badgeEvidence = new Map<string, string>()
      const rows = snapshots.map((snapshot) => {
        const assignment = assignmentsByOperation.get(snapshot.model_operation_id)
        if (!assignment) throw new LocalDomainError('PATTA_SHEET_ASSIGNMENTS_INCOMPLETE', 'Har bir operatsiya uchun Jeton kiriting')
        const resolution = this.dependencies.badgeRepository.resolveWorker(assignment.badge_number, enteredAt)
        if (!resolution) throw new LocalDomainError('BADGE_NOT_FOUND', 'Jeton Kiritilgan vaqtda topilmadi', {
          badge_number: assignment.badge_number
        })
        const rowId = uuid(this.idFactory, `sheet_row.${snapshot.sort_order}.id`)
        badgeEvidence.set(rowId, assignment.badge_number)
        return {
          id: rowId,
          patta_sheet_id: sheetId,
          patta_sheet_operation_snapshot_id: snapshot.id,
          worker_id: resolution.worker_id,
          quantity_snapshot: input.ish_soni,
          nuqson: assignment.nuqson,
          deleted_at: null,
          deleted_by: null,
          created_at: enteredAt,
          updated_at: enteredAt
        }
      })
      const sheet: PattaSheetProjectionV3 = {
        id: sheetId,
        entry_kind: 'STANDALONE',
        patta_hisob_id: null,
        model_id: reference.model_id,
        model_name_snapshot: reference.model_name,
        ish_soni: input.ish_soni,
        partiya_number_snapshot: partiya || null,
        patta_number_snapshot: pattaNumber,
        rang_snapshot: rang || null,
        razmer_snapshot: razmer || null,
        entered_at: enteredAt,
        business_date: localDate,
        conveyor_snapshot: conveyor,
        version: '0',
        created_by: actorUserId,
        created_at: enteredAt,
        updated_at: enteredAt,
        deleted_at: null,
        deleted_by: null,
        deleted_by_name_snapshot: null,
        operation_snapshots: snapshots,
        rows
      }
      this.dependencies.sheetRepository.createLocal(sheet, badgeEvidence)
      this.dependencies.queueRepository.enqueue({
        event_id: eventId,
        entity_type: 'patta_sheet',
        entity_id: sheetId,
        operation: 'CREATE',
        base_version: '0',
        client_created_at: enteredAt,
        occurred_at: enteredAt,
        reference_cursor: cursor,
        payload: {
          entry_kind: sheet.entry_kind,
          patta_hisob_id: null,
          model_id: sheet.model_id,
          model_name_snapshot: sheet.model_name_snapshot,
          ish_soni: sheet.ish_soni,
          partiya_number_snapshot: sheet.partiya_number_snapshot,
          patta_number_snapshot: sheet.patta_number_snapshot,
          rang_snapshot: sheet.rang_snapshot,
          razmer_snapshot: sheet.razmer_snapshot,
          entered_at: enteredAt,
          business_date: localDate,
          conveyor_snapshot: conveyor,
          deleted_at: null,
          deleted_by: null,
          deleted_by_name_snapshot: null,
          operation_snapshots: snapshots.map(({ id, model_operation_id, source_type,
            source_patta_operation_snapshot_id, operation_name_snapshot, unit_price_snapshot, sort_order }) => ({
            id, model_operation_id, source_type, source_patta_operation_snapshot_id,
            operation_name_snapshot, unit_price_snapshot, sort_order
          })),
          rows: rows.map((row) => ({
            id: row.id,
            patta_sheet_operation_snapshot_id: row.patta_sheet_operation_snapshot_id,
            worker_id: row.worker_id,
            quantity_snapshot: row.quantity_snapshot,
            nuqson: row.nuqson,
            deleted_at: null,
            deleted_by: null,
            entered_badge_number: badgeEvidence.get(row.id) ?? ''
          })),
          depends_on_event_ids: this.dependencies.queueRepository.customOperationPrerequisiteEventIds(
            customOperations.map(({ id }) => id)
          )
        }
      } satisfies PattaSheetSyncEventV3)
      return sheet
    })
  }

  update(input: UpdatePattaSheetInput, actorUserId: string): PattaSheetProjectionV3 {
    const sheetId = input.sheet_id.toLowerCase()
    if (!UUID_PATTERN.test(sheetId) || !/^(0|[1-9][0-9]*)$/.test(input.expected_version)) {
      throw new LocalDomainError('PATTA_SHEET_UPDATE_INVALID', 'Varaq tahrirlash ma’lumoti yaroqsiz')
    }
    const conveyor = input.conveyor_snapshot === null ? null : canonical(input.conveyor_snapshot)
    if (input.conveyor_snapshot !== null && !conveyor) {
      throw new LocalDomainError('PATTA_SHEET_CONVEYOR_INVALID', 'Konveyer qiymati bo‘sh bo‘lishi mumkin emas')
    }
    const referenceCursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (referenceCursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(referenceCursor, 'Server change cursor')
    const occurredAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Varaq tahrirlangan vaqt')

    return this.dependencies.unitOfWork.transaction(() => {
      const sheet = this.dependencies.sheetRepository.getById(sheetId)
      if (!sheet) throw new LocalDomainError('PATTA_SHEET_NOT_FOUND', 'Patta varag‘i topilmadi')
      if (sheet.deleted_at !== null) throw new LocalDomainError('PATTA_SHEET_TRASHED', 'Korzinkadagi varaqni tahrirlab bo‘lmaydi')
      if (sheet.version !== input.expected_version) {
        throw new LocalDomainError('VERSION_CONFLICT', 'Patta varag‘i boshqa foydalanuvchi tomonidan o‘zgartirilgan', {
          expected_version: input.expected_version,
          current_version: sheet.version
        })
      }
      let expectedQuantity = sheet.ish_soni
      if (sheet.entry_kind === 'PATTA_LINKED') {
        if (sheet.patta_hisob_id === null) throw new LocalDomainError('PATTA_SHEET_PATTA_UNAVAILABLE', 'Linked varaqda Patta ID yo‘q')
        const patta = this.dependencies.pattaRepository.getById(sheet.patta_hisob_id)
        if (!patta || patta.status !== 'ACTIVE' || patta.ish_soni === null) {
          throw new LocalDomainError('PATTA_SHEET_PATTA_UNAVAILABLE', 'Varaqning Patta miqdori yoki holati yaroqsiz')
        }
        expectedQuantity = patta.ish_soni
      }
      const state = this.dependencies.sheetRepository.ownershipState(sheet.id)
      const queued = this.dependencies.queueRepository.pendingPattaSheetMutation(sheet.id)
      let eventBaseVersion = sheet.version
      let nextVersion: string
      if (state === 'SERVER_SYNCED') {
        nextVersion = (BigInt(sheet.version) + 1n).toString()
      } else if (state === 'LOCAL_PENDING' && sheet.version === '0' && queued?.operation === 'CREATE' &&
        queued.status === 'PENDING' && queued.ever_sent === 0) {
        eventBaseVersion = '0'
        nextVersion = '0'
      } else if (state === 'LOCAL_PENDING' && queued?.operation === 'UPDATE' &&
        queued.status === 'PENDING' && queued.ever_sent === 0) {
        eventBaseVersion = queued.base_version
        nextVersion = sheet.version
      } else {
        throw new LocalDomainError('PATTA_SHEET_SYNC_REQUIRED', 'Varaq tahrirlashdan oldin oldingi o‘zgarishni sinxronlang')
      }
      if (BigInt(nextVersion) > 9_223_372_036_854_775_807n) {
        throw new LocalDomainError('VERSION_EXHAUSTED', 'Varaq versiyasi tugadi')
      }

      const snapshotsByOperation = new Map(sheet.operation_snapshots.map((snapshot) => [snapshot.model_operation_id, snapshot]))
      const assignments = new Map<string, PattaSheetAssignmentInput>()
      for (const item of input.assignments) {
        const operationId = item.model_operation_id.toLowerCase()
        if (!UUID_PATTERN.test(item.model_operation_id) || !snapshotsByOperation.has(operationId) ||
          assignments.has(operationId) || typeof item.nuqson !== 'boolean') {
          throw new LocalDomainError('PATTA_SHEET_ASSIGNMENT_INVALID', 'Operatsiya topshirig‘i yaroqsiz')
        }
        const badge = canonical(item.badge_number)
        assignments.set(operationId, { ...item, model_operation_id: operationId, badge_number: badge })
      }
      const activeRows = sheet.rows.filter((row) => row.deleted_at === null)
      const activeByOperation = new Map(activeRows.map((row) => [row.patta_sheet_operation_snapshot_id, row]))
      const existingRowIds = new Set(sheet.rows.map(({ id }) => id))
      const nextRows = sheet.rows.filter((row) => row.deleted_at !== null).map((row) => ({ ...row }))
      const badgeEvidence = new Map<string, string>()
      const existingEvidence = this.dependencies.sheetRepository.badgeEvidence(sheet.id)
      const clearOperationIds = new Set((input.clear_operation_ids ?? []).map((id) => id.toLowerCase()))
      if ([...clearOperationIds].some((operationId) => !snapshotsByOperation.has(operationId))) {
        throw new LocalDomainError('PATTA_SHEET_ASSIGNMENT_INVALID', 'Tozalash uchun operatsiya varaqda yo‘q')
      }
      for (const [operationId, snapshot] of snapshotsByOperation) {
        const assignment = assignments.get(operationId)
        const oldRow = activeByOperation.get(snapshot.id)
        if (!assignment && !clearOperationIds.has(operationId)) {
          if (oldRow) nextRows.push({ ...oldRow })
          continue
        }
        if (clearOperationIds.has(operationId)) {
          if (oldRow) nextRows.push({
            ...oldRow,
            deleted_at: occurredAt,
            deleted_by: actorUserId,
            updated_at: occurredAt
          })
          continue
        }
        if (!assignment) continue
        const badgeNumber = canonical(assignment.badge_number)
        let workerId: string
        if (!badgeNumber && oldRow) {
          if (assignment.worker_id && assignment.worker_id !== oldRow.worker_id) {
            throw new LocalDomainError('PATTA_SHEET_BADGE_REQUIRED', 'Ishchi o‘zgarganda Jetonni kiriting')
          }
          workerId = oldRow.worker_id
        } else {
          if (!badgeNumber) throw new LocalDomainError('PATTA_SHEET_BADGE_REQUIRED', 'Yangi ishchi topshirig‘i uchun Jeton kiriting')
          const resolved = this.dependencies.badgeRepository.resolveWorker(badgeNumber, sheet.entered_at)
          if (!resolved) {
            throw new LocalDomainError('BADGE_NOT_FOUND', 'Jeton Kiritilgan vaqtda topilmadi', { badge_number: badgeNumber })
          }
          if (assignment.worker_id && assignment.worker_id !== resolved.worker_id) {
            throw new LocalDomainError('CONFLICT_BADGE_ASSIGNMENT', 'Jeton tanlangan ishchiga mos emas')
          }
          workerId = resolved.worker_id
        }
        const rowId = oldRow?.id ?? uuid(this.idFactory, `sheet_row.${operationId}.id`)
        if (!oldRow && existingRowIds.has(rowId)) throw new LocalDomainError('LOCAL_ID_COLLISION', 'Mahalliy varaq qatori UUID takrorlandi')
        const row = {
          id: rowId,
          patta_sheet_id: sheet.id,
          patta_sheet_operation_snapshot_id: snapshot.id,
          worker_id: workerId,
          quantity_snapshot: expectedQuantity,
          nuqson: assignment.nuqson,
          deleted_at: null,
          deleted_by: null,
          created_at: oldRow?.created_at ?? occurredAt,
          updated_at: occurredAt
        }
        nextRows.push(row)
        const evidence = badgeNumber || existingEvidence.get(oldRow?.id ?? '')
        if (evidence) badgeEvidence.set(rowId, evidence)
      }
      if ([...assignments.keys()].some((operationId) => !snapshotsByOperation.has(operationId))) {
        throw new LocalDomainError('PATTA_SHEET_ASSIGNMENT_INVALID', 'Varaqda bo‘lmagan operatsiyaga topshiriq yuborildi')
      }
      const updated: PattaSheetProjectionV3 = {
        ...sheet,
        conveyor_snapshot: conveyor,
        version: nextVersion,
        updated_at: occurredAt,
        rows: nextRows
      }
      this.dependencies.sheetRepository.updateLocal(updated, badgeEvidence)
      const event = this.toSyncEvent(updated, eventBaseVersion, 'UPDATE', occurredAt, referenceCursor, badgeEvidence)
    this.dependencies.queueRepository.enqueueOrCoalescePattaSheetMutation(event)
      return updated
    })
  }

  trash(sheetIdInput: string, expectedVersion: string, actorUserId: string, actorName: string): PattaSheetProjectionV3 {
    return this.changeLifecycle(sheetIdInput, expectedVersion, actorUserId, true, actorName)
  }

  restore(sheetIdInput: string, expectedVersion: string, actorUserId: string): PattaSheetProjectionV3 {
    return this.changeLifecycle(sheetIdInput, expectedVersion, actorUserId, false)
  }

  purge(sheetIdInput: string, expectedVersion: string): void {
    const sheetId = sheetIdInput.toLowerCase()
    if (!UUID_PATTERN.test(sheetId)) throw new LocalDomainError('PATTA_SHEET_ID_INVALID', 'Varaq identifikatori yaroqsiz')
    const referenceCursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (referenceCursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(referenceCursor, 'Server change cursor')
    const purgedAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Varaq butunlay o‘chirilgan vaqt')
    this.dependencies.unitOfWork.transaction(() => {
      const sheet = this.dependencies.sheetRepository.getById(sheetId)
      if (!sheet || sheet.deleted_at === null) {
        throw new LocalDomainError('PATTA_SHEET_PURGE_REQUIRES_TRASH', 'Butunlay o‘chirishdan oldin varaqni Korzinkaga yuboring')
      }
      if (sheet.version !== expectedVersion) {
        throw new LocalDomainError('VERSION_CONFLICT', 'Patta varag‘i boshqa foydalanuvchi tomonidan o‘zgartirilgan', {
          expected_version: expectedVersion,
          current_version: sheet.version
        })
      }
      const state = this.dependencies.sheetRepository.ownershipState(sheet.id)
      const queued = this.dependencies.queueRepository.pendingPattaSheetMutation(sheet.id)
      if (state === 'LOCAL_PENDING' && queued?.operation === 'CREATE' && queued.status === 'PENDING' && queued.ever_sent === 0) {
        this.dependencies.queueRepository.cancelNeverSentPattaSheetCreate(sheet.id)
        this.dependencies.sheetRepository.purgeLocal(sheet.id, referenceCursor, purgedAt)
        return
      }
      if (state !== 'SERVER_SYNCED' || queued) {
        throw new LocalDomainError('PATTA_SHEET_SYNC_REQUIRED', 'Varaqning oldingi o‘zgarishini sinxronlang, so‘ng butunlay o‘chiring')
      }
      const event: PattaSheetSyncEventV3 = this.toSyncEvent(
        sheet, sheet.version, 'DELETE', purgedAt, referenceCursor,
        new Map(sheet.rows.map((row) => [row.id, '']))
      )
      this.dependencies.queueRepository.enqueue(event)
      this.dependencies.sheetRepository.purgeLocal(sheet.id, referenceCursor, purgedAt)
    })
  }

  private changeLifecycle(
    sheetIdInput: string,
    expectedVersion: string,
    actorUserId: string,
    trashed: boolean,
    actorName?: string
  ): PattaSheetProjectionV3 {
    const sheetId = sheetIdInput.toLowerCase()
    if (!UUID_PATTERN.test(sheetId)) throw new LocalDomainError('PATTA_SHEET_ID_INVALID', 'Varaq identifikatori yaroqsiz')
    const cursor = this.dependencies.syncStateRepository.lastServerCursor()
    if (cursor === null) throw new LocalDomainError('SYNC_BOOTSTRAP_REQUIRED', 'Avval ma’lumotnomalarni sinxronlang')
    assertPostgresBigint(cursor, 'Server change cursor')
    const occurredAt = canonicalUtcTimestamp(this.dependencies.clock.nowIsoUtc(), 'Varaq lifecycle vaqti')
    return this.dependencies.unitOfWork.transaction(() => {
      const sheet = this.dependencies.sheetRepository.getById(sheetId)
      if (!sheet) throw new LocalDomainError('PATTA_SHEET_NOT_FOUND', 'Patta varag‘i topilmadi')
      if (sheet.version !== expectedVersion || (sheet.deleted_at !== null) === trashed) {
        throw new LocalDomainError(sheet.version !== expectedVersion ? 'VERSION_CONFLICT' : 'PATTA_SHEET_LIFECYCLE_CONFLICT',
          sheet.version !== expectedVersion ? 'Patta varag‘i boshqa foydalanuvchi tomonidan o‘zgartirilgan' : 'Varaq holati o‘zgargan')
      }
      const state = this.dependencies.sheetRepository.ownershipState(sheet.id)
      const queued = this.dependencies.queueRepository.pendingPattaSheetMutation(sheet.id)
      let baseVersion = sheet.version
      let nextVersion = sheet.version
      if (state === 'SERVER_SYNCED') {
        nextVersion = (BigInt(sheet.version) + 1n).toString()
      } else if (state === 'LOCAL_PENDING' && sheet.version === '0' && queued?.operation === 'CREATE' &&
        queued.status === 'PENDING' && queued.ever_sent === 0) {
        baseVersion = '0'
        nextVersion = '0'
      } else if (state === 'LOCAL_PENDING' && queued?.operation === 'UPDATE' && queued.status === 'PENDING' && queued.ever_sent === 0) {
        baseVersion = queued.base_version
      } else {
        throw new LocalDomainError('PATTA_SHEET_SYNC_REQUIRED', 'Varaq holatini o‘zgartirishdan oldin sinxronlang')
      }
      if (trashed && !canonical(actorName ?? '')) {
        throw new LocalDomainError('ACTOR_NAME_REQUIRED', 'Korzinkaga yuborish uchun foydalanuvchi nomi kerak')
      }
      const updated: PattaSheetProjectionV3 = {
        ...sheet,
        version: nextVersion,
        updated_at: occurredAt,
        deleted_at: trashed ? occurredAt : null,
        deleted_by: trashed ? actorUserId : null,
        deleted_by_name_snapshot: trashed ? canonical(actorName ?? '') : null
      }
      this.dependencies.sheetRepository.updateLocal(updated)
      this.dependencies.queueRepository.enqueueOrCoalescePattaSheetMutation(
        this.toSyncEvent(updated, baseVersion, 'UPDATE', occurredAt, cursor, new Map()),
      )
      return updated
    })
  }

  private toSyncEvent(
    sheet: PattaSheetProjectionV3,
    baseVersion: string,
    operation: PattaSheetSyncEventV3['operation'],
    occurredAt: string,
    referenceCursor: string,
    badgeEvidence: ReadonlyMap<string, string>
  ): PattaSheetSyncEventV3 {
    const eventId = uuid(this.idFactory, `patta_sheet.${operation}.event_id`)
    return {
      event_id: eventId,
      entity_type: 'patta_sheet',
      entity_id: sheet.id,
      operation,
      base_version: baseVersion,
      client_created_at: occurredAt,
      occurred_at: occurredAt,
      reference_cursor: referenceCursor,
      payload: {
        entry_kind: sheet.entry_kind,
        patta_hisob_id: sheet.patta_hisob_id,
        model_id: sheet.model_id,
        model_name_snapshot: sheet.model_name_snapshot,
        ish_soni: sheet.ish_soni,
        partiya_number_snapshot: sheet.partiya_number_snapshot,
        patta_number_snapshot: sheet.patta_number_snapshot,
        rang_snapshot: sheet.rang_snapshot,
        razmer_snapshot: sheet.razmer_snapshot,
        entered_at: sheet.entered_at,
        business_date: sheet.business_date,
        conveyor_snapshot: sheet.conveyor_snapshot,
        deleted_at: sheet.deleted_at,
        deleted_by: sheet.deleted_by,
        deleted_by_name_snapshot: sheet.deleted_by_name_snapshot,
        operation_snapshots: sheet.operation_snapshots.map((snapshot) => ({
          id: snapshot.id,
          model_operation_id: snapshot.model_operation_id,
          source_type: snapshot.source_type,
          source_patta_operation_snapshot_id: snapshot.source_patta_operation_snapshot_id,
          operation_name_snapshot: snapshot.operation_name_snapshot,
          unit_price_snapshot: snapshot.unit_price_snapshot,
          sort_order: snapshot.sort_order
        })),
        rows: sheet.rows.map((row) => ({
          id: row.id,
          patta_sheet_operation_snapshot_id: row.patta_sheet_operation_snapshot_id,
          worker_id: row.worker_id,
          quantity_snapshot: row.quantity_snapshot,
          nuqson: row.nuqson,
          deleted_at: row.deleted_at,
          deleted_by: row.deleted_by,
          entered_badge_number: badgeEvidence.get(row.id) ?? ''
        })),
        depends_on_event_ids: this.dependencies.queueRepository.customOperationPrerequisiteEventIds(
          sheet.operation_snapshots.filter(({ source_type }) => source_type === 'CUSTOM')
            .map(({ model_operation_id }) => model_operation_id)
        )
      }
    }
  }
}
