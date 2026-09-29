import type { PersistedLocalPatta } from '../local/local-patta.types'
import type { DesktopAuthService } from '../auth/desktop-auth.service'
import type { DesktopTenantRuntime } from '../auth/desktop-tenant-runtime'
import { normalizeTenantOrigin } from '../auth/tenant-auth-api-client'
import { AuthenticatedHttpError } from '../sync/authenticated-http-client'
import type { PattaPrintBatchProjection } from '@textile/sync-protocol'
import type {
  DesktopModelOption,
  DesktopPattaLookup,
  DesktopPattaPrintBatchInput,
  DesktopPattaPrintBatchCorrectionInput,
  DesktopPattaPrintBatchResult,
  DesktopPattaPrintEvent,
  DesktopPattaPrintEventInput,
  DesktopPattaSheetCreateInput,
  DesktopPattaSheetLookup,
  DesktopPattaSheetUpdateInput,
  DesktopPattaSheetHistoryItem,
  DesktopPattaSheetRowDetail,
  DesktopModelAccountSheet,
  DesktopSyncRunResult,
  DesktopSyncStatus,
  DesktopIpcChannel
} from '../../preload/erp-api'

const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]*$/
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

export interface IpcMainHandlerRegistrar {
  handle(channel: DesktopIpcChannel, listener: IpcHandler): void
}

export interface MainProcessIpcServices {
  getAppVersion(): string
  login(input: unknown): Promise<ReturnType<DesktopAuthService['status']>>
  logout(): Promise<ReturnType<DesktopAuthService['status']>>
  authStatus(): ReturnType<DesktopAuthService['status']>
  authSession(): ReturnType<DesktopAuthService['currentSession']>
  getSyncStatus(): DesktopSyncStatus
  runSync(): Promise<DesktopSyncRunResult>
  lookupPatta(input: unknown): DesktopPattaLookup | null
  listPattaPrintModels(): readonly DesktopModelOption[]
  createPattaPrintBatch(input: unknown): DesktopPattaPrintBatchResult
  correctPattaPrintBatch(input: unknown): DesktopPattaPrintBatchResult
  getPattaPrintBatch(batchId: unknown): DesktopPattaPrintBatchResult | null
  recordPattaPrintEvent(input: unknown): DesktopPattaPrintEvent
  printPattaBatch(batchId: unknown): Promise<{ batch: DesktopPattaPrintBatchResult; event: DesktopPattaPrintEvent }>
  lookupPattaSheet(input: unknown): Promise<DesktopPattaSheetLookup | null>
  resolvePattaSheetBadge(input: unknown): { worker_id: string; full_name: string } | null
  listPattaSheetModels(): readonly DesktopModelOption[]
  createPattaSheet(input: unknown): import('@textile/sync-protocol').PattaSheetProjection
  updatePattaSheet(input: unknown): import('@textile/sync-protocol').PattaSheetProjection
  trashPattaSheet(input: unknown): import('@textile/sync-protocol').PattaSheetProjection
  restorePattaSheet(input: unknown): import('@textile/sync-protocol').PattaSheetProjection
  purgePattaSheet(input: unknown): void
  listPattaSheetHistory(input: unknown): readonly DesktopPattaSheetHistoryItem[]
  getModelAccountSheet(input: unknown): DesktopModelAccountSheet
}

export interface MainProcessIpcDependencies {
  appVersion: () => string
  printPattaBatch?: (batch: PattaPrintBatchProjection) => Promise<void>
  authService: Pick<
    DesktopAuthService,
    'login' | 'logout' | 'status' | 'currentSession' | 'refreshAccessToken'
  >
  tenantRuntime: Pick<
    DesktopTenantRuntime,
    'getSyncStatus' | 'runSync' | 'activePattaRepository' | 'activeSyncRuntime'
  >
}

interface PattaLookupInput {
  partiyaNumber: string
  pattaNumber: string
}

function pattaSheetBadgeInput(value: unknown): { badge_number: string; entered_at?: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => !['badge_number', 'entered_at'].includes(key)) ||
    typeof value.badge_number !== 'string' || value.badge_number.length > 48 ||
    (value.entered_at !== undefined && typeof value.entered_at !== 'string')) {
    throw new Error('Patta varag‘i Jeton ma’lumoti yaroqsiz')
  }
  return {
    badge_number: value.badge_number,
    ...(typeof value.entered_at === 'string' ? { entered_at: value.entered_at } : {})
  }
}

function printBatchInput(value: unknown): DesktopPattaPrintBatchInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['model_id', 'ish_soni', 'rang', 'size_distribution'].includes(key)) ||
    typeof value.model_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.model_id) ||
    typeof value.ish_soni !== 'number' || !Number.isSafeInteger(value.ish_soni) || value.ish_soni <= 0 ||
    typeof value.rang !== 'string' || !Array.isArray(value.size_distribution) || value.size_distribution.length === 0) {
    throw new Error('Patta bosma to‘plami ma’lumoti yaroqsiz')
  }
  const sizeRows = value.size_distribution.map((row) => {
    if (!isRecord(row) || Object.keys(row).some((key) => !['razmer', 'patta_count', 'sort_order'].includes(key)) ||
      typeof row.razmer !== 'string' || !Number.isSafeInteger(row.patta_count) ||
      (row.patta_count as number) <= 0 || !Number.isSafeInteger(row.sort_order) ||
      (row.sort_order as number) < 0) {
      throw new Error('Patta razmer qatori yaroqsiz')
    }
    return { razmer: row.razmer, patta_count: row.patta_count as number, sort_order: row.sort_order as number }
  })
  return { model_id: value.model_id, ish_soni: value.ish_soni, rang: value.rang, size_distribution: sizeRows }
}

function correctionInput(value: unknown): DesktopPattaPrintBatchCorrectionInput {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'batch_id', 'expected_version', 'correction_reason', 'ish_soni', 'rang', 'size_distribution'
  ].includes(key)) || typeof value.batch_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.batch_id) ||
    typeof value.expected_version !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.expected_version) ||
    typeof value.correction_reason !== 'string' || canonicalizeCorrectionReason(value.correction_reason).length < 3 ||
    canonicalizeCorrectionReason(value.correction_reason).length > 500 ||
    typeof value.ish_soni !== 'number' || !Number.isSafeInteger(value.ish_soni) || value.ish_soni < 1 ||
    typeof value.rang !== 'string' || !Array.isArray(value.size_distribution) || value.size_distribution.length === 0) {
    throw new Error('Patta tuzatish ma’lumoti yaroqsiz')
  }
  const sizeDistribution = value.size_distribution.map((row) => {
    if (!isRecord(row) || Object.keys(row).some((key) => !['razmer', 'patta_count', 'sort_order'].includes(key)) ||
      typeof row.razmer !== 'string' || !Number.isSafeInteger(row.patta_count) || (row.patta_count as number) < 1 ||
      !Number.isSafeInteger(row.sort_order) || (row.sort_order as number) < 0) {
      throw new Error('Patta tuzatish razmer qatori yaroqsiz')
    }
    return { razmer: row.razmer, patta_count: row.patta_count as number, sort_order: row.sort_order as number }
  })
  return {
    batch_id: value.batch_id.toLowerCase(),
    expected_version: value.expected_version,
    correction_reason: canonicalizeCorrectionReason(value.correction_reason),
    ish_soni: value.ish_soni,
    rang: value.rang,
    size_distribution: sizeDistribution
  }
}

function canonicalizeCorrectionReason(value: string): string {
  return value.replace(ASCII_WHITESPACE, ' ').trim()
}

function printEventInput(value: unknown): DesktopPattaPrintEventInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !['batch_id', 'revision', 'kind', 'outcome'].includes(key)) ||
    typeof value.batch_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.batch_id) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
    !['INITIAL', 'REPRINT', 'CORRECTED_REPRINT'].includes(String(value.kind)) ||
    !['REQUESTED', 'SUCCEEDED', 'FAILED'].includes(String(value.outcome))) {
    throw new Error('Chop etish hodisasi ma’lumoti yaroqsiz')
  }
  return {
    batch_id: value.batch_id.toLowerCase(),
    revision: value.revision as number,
    kind: value.kind as DesktopPattaPrintEventInput['kind'],
    outcome: value.outcome as DesktopPattaPrintEventInput['outcome']
  }
}

function pattaSheetInput(value: unknown): DesktopPattaSheetCreateInput {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'partiya_number', 'patta_number', 'conveyor_snapshot', 'assignments', 'custom_operations'
  ].includes(key)) || typeof value.partiya_number !== 'string' ||
    typeof value.patta_number !== 'string' || !POSITIVE_BIGINT_PATTERN.test(value.patta_number) ||
    !(value.conveyor_snapshot === null || typeof value.conveyor_snapshot === 'string') ||
    !Array.isArray(value.assignments) ||
    (value.custom_operations !== undefined && !Array.isArray(value.custom_operations))) {
    throw new Error('Patta varag‘i ma’lumoti yaroqsiz')
  }
  const assignments = value.assignments.map((assignment) => {
    if (!isRecord(assignment) || Object.keys(assignment).some((key) => ![
      'model_operation_id', 'badge_number', 'nuqson'
    ].includes(key)) || typeof assignment.model_operation_id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(assignment.model_operation_id) ||
      typeof assignment.badge_number !== 'string' || typeof assignment.nuqson !== 'boolean') {
      throw new Error('Patta varag‘i ishchi topshirig‘i yaroqsiz')
    }
    return {
      model_operation_id: assignment.model_operation_id.toLowerCase(),
      badge_number: assignment.badge_number,
      nuqson: assignment.nuqson
    }
  })
  const customOperations = value.custom_operations?.map((operation) => {
    if (!isRecord(operation) || Object.keys(operation).some((key) => !['id', 'name', 'initial_price'].includes(key)) ||
      typeof operation.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(operation.id) ||
      typeof operation.name !== 'string' || operation.name.length > 500 ||
      typeof operation.initial_price !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(operation.initial_price)) {
      throw new Error('Yangi model operatsiyasi ma’lumoti yaroqsiz')
    }
    return { id: operation.id.toLowerCase(), name: operation.name, initial_price: operation.initial_price }
  })
  return {
    partiya_number: value.partiya_number,
    patta_number: value.patta_number,
    conveyor_snapshot: value.conveyor_snapshot,
    assignments,
    ...(customOperations === undefined ? {} : { custom_operations: customOperations })
  }
}

function pattaSheetUpdateInput(value: unknown): DesktopPattaSheetUpdateInput {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    'sheet_id', 'expected_version', 'conveyor_snapshot', 'assignments', 'clear_operation_ids'
  ].includes(key)) || typeof value.sheet_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.sheet_id) ||
    typeof value.expected_version !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.expected_version) ||
    !(value.conveyor_snapshot === null || typeof value.conveyor_snapshot === 'string') ||
    !Array.isArray(value.assignments) ||
    (value.clear_operation_ids !== undefined && !Array.isArray(value.clear_operation_ids))) {
    throw new Error('Patta varag‘i tahrirlash ma’lumoti yaroqsiz')
  }
  const assignments = value.assignments.map((assignment) => {
    if (!isRecord(assignment) || Object.keys(assignment).some((key) => ![
      'model_operation_id', 'badge_number', 'nuqson'
    ].includes(key)) || typeof assignment.model_operation_id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(assignment.model_operation_id) || typeof assignment.badge_number !== 'string' ||
      assignment.badge_number.length > 48 || typeof assignment.nuqson !== 'boolean') {
      throw new Error('Patta varag‘i ishchi topshirig‘i yaroqsiz')
    }
    return {
      model_operation_id: assignment.model_operation_id.toLowerCase(),
      badge_number: assignment.badge_number,
      nuqson: assignment.nuqson
    }
  })
  const clearOperationIds = value.clear_operation_ids?.map((id) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error('Patta varag‘i operatsiya identifikatori yaroqsiz')
    }
    return id.toLowerCase()
  })
  return {
    sheet_id: value.sheet_id.toLowerCase(),
    expected_version: value.expected_version,
    conveyor_snapshot: value.conveyor_snapshot,
    assignments,
    ...(clearOperationIds === undefined ? {} : { clear_operation_ids: clearOperationIds })
  }
}

function pattaSheetLifecycleInput(value: unknown): { sheet_id: string; expected_version: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2 || typeof value.sheet_id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.sheet_id) || typeof value.expected_version !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.expected_version)) {
    throw new Error('Patta varag‘i holatini o‘zgartirish ma’lumoti yaroqsiz')
  }
  return { sheet_id: value.sheet_id.toLowerCase(), expected_version: value.expected_version }
}

function pattaSheetHistoryInput(value: unknown): { model_id: string; include_deleted: boolean } {
  if (!isRecord(value) || Object.keys(value).some((key) => !['model_id', 'include_deleted'].includes(key)) ||
    typeof value.model_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.model_id) ||
    (value.include_deleted !== undefined && typeof value.include_deleted !== 'boolean')) {
    throw new Error('Patta varaq tarixi so‘rovi yaroqsiz')
  }
  return { model_id: value.model_id.toLowerCase(), include_deleted: value.include_deleted === true }
}

function publicPrintBatch(batch: PattaPrintBatchProjection): DesktopPattaPrintBatchResult {
  return {
    ...batch,
    pattas: batch.pattas.map((patta) => ({ ...patta, printed_at: batch.printed_at }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNoPayload(args: readonly unknown[]): boolean {
  return args.length === 0 || (args.length === 1 && args[0] === undefined)
}

function lookupInput(value: unknown): PattaLookupInput {
  if (
    !isRecord(value) ||
    typeof value.partiyaNumber !== 'string' ||
    typeof value.pattaNumber !== 'string'
  ) {
    throw new Error('Patta qidiruv ma’lumoti yaroqsiz')
  }
  const partiyaNumber = value.partiyaNumber.replace(ASCII_WHITESPACE, ' ').trim()
  if (!partiyaNumber || partiyaNumber.length > 256) {
    throw new Error('Partiya raqami yaroqsiz')
  }
  if (!POSITIVE_BIGINT_PATTERN.test(value.pattaNumber)) {
    throw new Error('Patta raqami yaroqsiz')
  }
  const pattaNumber = BigInt(value.pattaNumber)
  if (pattaNumber > MAX_POSTGRES_BIGINT) throw new Error('Patta raqami juda katta')
  return { partiyaNumber, pattaNumber: pattaNumber.toString() }
}

function loginInput(value: unknown): { tenantUrl: string; email: string; password: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.tenantUrl !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.password !== 'string'
  ) {
    throw new Error('Kirish ma’lumotlari yaroqsiz')
  }
  const tenantUrl = value.tenantUrl.trim()
  const email = value.email.trim()
  if (
    tenantUrl.length === 0 ||
    tenantUrl.length > 2_048 ||
    email.length === 0 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    value.password.length === 0 ||
    value.password.length > 1_024
  ) {
    throw new Error('Kirish ma’lumotlari yaroqsiz')
  }
  normalizeTenantOrigin(tenantUrl)
  return { tenantUrl, email, password: value.password }
}

function publicPatta(patta: PersistedLocalPatta): DesktopPattaLookup {
  return {
    id: patta.id,
    partiya_number: patta.partiya_number,
    patta_number: patta.patta_number,
    model_id: patta.model_id,
    model_name_snapshot: patta.model_name_snapshot,
    template_id: patta.template_id,
    print_batch_id: patta.print_batch_id,
    printed_at: patta.printed_at,
    konveyer_snapshot: patta.konveyer_snapshot,
    razmer: patta.razmer,
    rang: patta.rang,
    ish_soni: patta.ish_soni,
    legacy_operation_count: patta.legacy_operation_count,
    status: patta.status,
    created_at: patta.created_at,
    operations: patta.operations.map((operation) => ({
      id: operation.id,
      operation_id: operation.operation_id,
      operation_name_snapshot: operation.operation_name_snapshot,
      unit_price_snapshot: operation.unit_price_snapshot,
      sort_order: operation.sort_order
    }))
  }
}

export function createMainProcessIpcServices(
  dependencies: MainProcessIpcDependencies
): MainProcessIpcServices {
  const activePrintRuntime = (): NonNullable<
    ReturnType<MainProcessIpcDependencies['tenantRuntime']['activeSyncRuntime']>
  > => {
    const authState = dependencies.authService.status().state
    if (authState !== 'AUTHENTICATED' && authState !== 'OFFLINE_SESSION_PENDING') {
      throw new Error('Patta chiqarish uchun korxona sessiyasiga kiring')
    }
    const runtime = dependencies.tenantRuntime.activeSyncRuntime()
    if (!runtime) throw new Error('Mahalliy Patta ma’lumotlari hali yuklanmagan')
    return runtime
  }
  const publicSheetRows = (
    runtime: ReturnType<typeof activePrintRuntime>,
    sheet: import('@textile/sync-protocol').PattaSheetProjection
  ): readonly DesktopPattaSheetRowDetail[] => {
    const badgeEvidence = runtime.repositories.sheets.badgeEvidence(sheet.id)
    const snapshotsById = new Map(sheet.operation_snapshots.map((snapshot) => [snapshot.id, snapshot]))
    return sheet.rows.map((row) => {
      const snapshot = snapshotsById.get(row.patta_sheet_operation_snapshot_id)
      const worker = runtime.repositories.workers.getById(row.worker_id)
      if (!snapshot) throw new Error('Patta varag‘i operatsiya snapshoti topilmadi')
      return {
        row_id: row.id,
        model_operation_id: snapshot.model_operation_id,
        worker_id: row.worker_id,
        worker_name: worker?.full_name ?? row.worker_id,
        badge_number: badgeEvidence.get(row.id) ?? null,
        nuqson: row.nuqson,
        deleted_at: row.deleted_at
      }
    })
  }
  return {
    getAppVersion: dependencies.appVersion,
    login: (input) => dependencies.authService.login(loginInput(input)),
    logout: () => dependencies.authService.logout(),
    authStatus: () => dependencies.authService.status(),
    authSession: () => dependencies.authService.currentSession(),
    getSyncStatus: () => dependencies.tenantRuntime.getSyncStatus(dependencies.authService.status().state),
    runSync: async () => {
      let authStatus = dependencies.authService.status()
      if (authStatus.state === 'OFFLINE_SESSION_PENDING') {
        try {
          await dependencies.authService.refreshAccessToken()
        } catch {
          // A transient refresh failure remains offline; local operations stay available.
        }
        authStatus = dependencies.authService.status()
      }
      return dependencies.tenantRuntime.runSync(authStatus.state)
    },
    lookupPatta: (input) => {
      const { partiyaNumber, pattaNumber } = lookupInput(input)
      const authState = dependencies.authService.status().state
      if (authState !== 'AUTHENTICATED' && authState !== 'OFFLINE_SESSION_PENDING') return null
      const repository = dependencies.tenantRuntime.activePattaRepository()
      if (!repository) return null
      const patta = repository.findByBusinessKey(partiyaNumber, pattaNumber)
      return patta ? publicPatta(patta) : null
    },
    listPattaPrintModels: () => activePrintRuntime().repositories.models.listActiveModels(),
    lookupPattaSheet: async (input) => {
      const { partiyaNumber, pattaNumber } = lookupInput(input)
      const runtime = activePrintRuntime()
      let patta = runtime.repositories.pattas.findByBusinessKey(partiyaNumber, pattaNumber)
      if (!patta) {
        try {
          const mirror = await runtime.lookupPattaV2(partiyaNumber, pattaNumber)
          patta = runtime.repositories.pattas.getById(mirror.patta.id)
        } catch (error) {
          if (error instanceof AuthenticatedHttpError && error.status === 404) return null
          throw error
        }
      }
      if (!patta) return null
      const sheet = runtime.repositories.sheets.findByPatta(patta.id)
      return {
        patta: publicPatta(patta),
        sheet,
        rows: sheet ? publicSheetRows(runtime, sheet) : [],
      }
    },
    resolvePattaSheetBadge: (input) => {
      const { badge_number, entered_at } = pattaSheetBadgeInput(input)
      return activePrintRuntime().pattaSheetService.resolveBadge(badge_number, entered_at)
    },
    listPattaSheetModels: () => activePrintRuntime().repositories.models.listModelsWithPattaHistory(),
    createPattaSheet: (input) => {
      const runtime = activePrintRuntime()
      const actorUserId = dependencies.authService.currentSession().user?.id
      if (!actorUserId) throw new Error('Patta varag‘i kiritish uchun sessiya foydalanuvchisi kerak')
      return runtime.pattaSheetService.create(pattaSheetInput(input), actorUserId)
    },
    updatePattaSheet: (input) => activePrintRuntime().pattaSheetService.update(
      pattaSheetUpdateInput(input), requireActorId(dependencies.authService.currentSession().user?.id)
    ),
    trashPattaSheet: (input) => {
      const { sheet_id, expected_version } = pattaSheetLifecycleInput(input)
      return activePrintRuntime().pattaSheetService.trash(
        sheet_id, expected_version, requireActorId(dependencies.authService.currentSession().user?.id)
      )
    },
    restorePattaSheet: (input) => {
      const { sheet_id, expected_version } = pattaSheetLifecycleInput(input)
      return activePrintRuntime().pattaSheetService.restore(
        sheet_id, expected_version, requireActorId(dependencies.authService.currentSession().user?.id)
      )
    },
    purgePattaSheet: (input) => {
      const { sheet_id, expected_version } = pattaSheetLifecycleInput(input)
      activePrintRuntime().pattaSheetService.purge(sheet_id, expected_version)
    },
    listPattaSheetHistory: (input) => {
      const { model_id, include_deleted } = pattaSheetHistoryInput(input)
      const runtime = activePrintRuntime()
      return runtime.repositories.sheets.listForModel(model_id, include_deleted).flatMap((sheet) => {
        const patta = runtime.repositories.pattas.getById(sheet.patta_hisob_id)
        return patta ? [{ patta: publicPatta(patta), sheet, rows: publicSheetRows(runtime, sheet) }] : []
      })
    },
    getModelAccountSheet: (input) => {
      const { model_id } = pattaSheetHistoryInput({ model_id: isRecord(input) ? input.model_id : null })
      return activePrintRuntime().repositories.modelAccount.getModelAccountSheet(model_id)
    },
    createPattaPrintBatch: (input) => publicPrintBatch(
      activePrintRuntime().pattaPrintService.createBatch(printBatchInput(input)).batch
    ),
    correctPattaPrintBatch: (input) => publicPrintBatch(
      activePrintRuntime().pattaPrintService.correctBatch(correctionInput(input)).batch
    ),
    getPattaPrintBatch: (batchId) => {
      if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) {
        throw new Error('Patta bosma to‘plami identifikatori yaroqsiz')
      }
      const batch = activePrintRuntime().repositories.printBatches.getById(batchId.toLowerCase())
      return batch ? publicPrintBatch(batch) : null
    },
    recordPattaPrintEvent: (input) => activePrintRuntime().pattaPrintService.recordPrintEvent(
      printEventInput(input)
    ),
    printPattaBatch: async (batchId) => {
      if (typeof batchId !== 'string' || !/^[0-9a-f-]{36}$/i.test(batchId)) {
        throw new Error('Patta bosma to‘plami identifikatori yaroqsiz')
      }
      const runtime = activePrintRuntime()
      const batch = runtime.repositories.printBatches.getById(batchId.toLowerCase())
      if (!batch || batch.status !== 'ACTIVE') throw new Error('Faol Patta bosma to‘plami topilmadi')
      const kind = batch.printed_at === null
        ? 'INITIAL'
        : batch.revision > 1 ? 'CORRECTED_REPRINT' : 'REPRINT'
      try {
        if (!dependencies.printPattaBatch) throw new Error('Chop etish xizmati mavjud emas')
        await dependencies.printPattaBatch(batch)
      } catch (error) {
        runtime.pattaPrintService.recordPrintEvent({
          batch_id: batch.id,
          revision: batch.revision,
          kind,
          outcome: 'FAILED'
        })
        throw error
      }
      const event = runtime.pattaPrintService.recordPrintEvent({
        batch_id: batch.id,
        revision: batch.revision,
        kind,
        outcome: 'SUCCEEDED'
      })
      return {
        batch: publicPrintBatch(runtime.repositories.printBatches.getById(batch.id) ?? batch),
        event: {
          ...event,
          actor_user_id: null
        }
      }
    }
  }
}

function requireActorId(userId: string | null | undefined): string {
  if (!userId) throw new Error('Patta varag‘i amalini bajarish uchun sessiya foydalanuvchisi kerak')
  return userId
}

export function registerIpcHandlers(
  ipcMain: IpcMainHandlerRegistrar,
  services: MainProcessIpcServices
): void {
  ipcMain.handle('app:get-version', () => services.getAppVersion())
  ipcMain.handle('auth:login', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Kirish ma’lumotlari yaroqsiz')
    return services.login(args[0])
  })
  ipcMain.handle('auth:logout', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Chiqish so‘rovi yaroqsiz')
    return services.logout()
  })
  ipcMain.handle('auth:status', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Sessiya holati so‘rovi yaroqsiz')
    return services.authStatus()
  })
  ipcMain.handle('auth:session', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Sessiya ma’lumoti so‘rovi yaroqsiz')
    return services.authSession()
  })
  ipcMain.handle('sync:status', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Sinxronlash holati so‘rovi yaroqsiz')
    return services.getSyncStatus()
  })
  ipcMain.handle('sync:run', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Sinxronlash so‘rovi yaroqsiz')
    return services.runSync()
  })
  ipcMain.handle('patta:lookup', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta qidiruv ma’lumoti yaroqsiz')
    return services.lookupPatta(args[0])
  })
  ipcMain.handle('patta-print:models', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Model ro‘yxati so‘rovi yaroqsiz')
    return services.listPattaPrintModels()
  })
  ipcMain.handle('patta-sheet:lookup', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varag‘i qidiruv so‘rovi yaroqsiz')
    return services.lookupPattaSheet(args[0])
  })
  ipcMain.handle('patta-sheet:resolve-badge', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Jeton tekshirish so‘rovi yaroqsiz')
    return services.resolvePattaSheetBadge(args[0])
  })
  ipcMain.handle('patta-sheet:models', async (_event, ...args) => {
    if (!hasNoPayload(args)) throw new Error('Varaq modellari so‘rovi yaroqsiz')
    return services.listPattaSheetModels()
  })
  ipcMain.handle('patta-sheet:create', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varag‘i yaratish so‘rovi yaroqsiz')
    return services.createPattaSheet(args[0])
  })
  ipcMain.handle('patta-sheet:update', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varag‘i tahrirlash so‘rovi yaroqsiz')
    return services.updatePattaSheet(args[0])
  })
  ipcMain.handle('patta-sheet:trash', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varag‘ini Korzinkaga yuborish so‘rovi yaroqsiz')
    return services.trashPattaSheet(args[0])
  })
  ipcMain.handle('patta-sheet:restore', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varag‘ini tiklash so‘rovi yaroqsiz')
    return services.restorePattaSheet(args[0])
  })
  ipcMain.handle('patta-sheet:purge', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varag‘ini butunlay o‘chirish so‘rovi yaroqsiz')
    return services.purgePattaSheet(args[0])
  })
  ipcMain.handle('patta-sheet:history', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta varaq tarixi so‘rovi yaroqsiz')
    return services.listPattaSheetHistory(args[0])
  })
  ipcMain.handle('model-account:get', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Model hisob so‘rovi yaroqsiz')
    return services.getModelAccountSheet(args[0])
  })
  ipcMain.handle('patta-print:create-batch', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta bosma to‘plami so‘rovi yaroqsiz')
    return services.createPattaPrintBatch(args[0])
  })
  ipcMain.handle('patta-print:correct-batch', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta tuzatish so‘rovi yaroqsiz')
    return services.correctPattaPrintBatch(args[0])
  })
  ipcMain.handle('patta-print:get-batch', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta qidiruv so‘rovi yaroqsiz')
    return services.getPattaPrintBatch(args[0])
  })
  ipcMain.handle('patta-print:print-batch', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta chop etish so‘rovi yaroqsiz')
    return services.printPattaBatch(args[0])
  })
  ipcMain.handle('patta-print:record-event', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Chop etish hodisasi so‘rovi yaroqsiz')
    return services.recordPattaPrintEvent(args[0])
  })
}
