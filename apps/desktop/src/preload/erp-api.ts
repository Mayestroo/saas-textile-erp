import type {
  ConveyorAccountRow,
  DesktopModelOperationOption,
  ModelAccountAdjustmentProjection,
  ModelAccountSheetV3,
  ModelAccountWorkerDetail,
  OperationPriceChangeProjection,
  PattaSheetProjectionV3
} from '@textile/sync-protocol'

export type DesktopIpcChannel =
  | 'app:get-version'
  | 'sync:status'
  | 'sync:run'
  | 'patta:lookup'
  | 'patta-print:models'
  | 'patta-print:create-batch'
  | 'patta-print:correct-batch'
  | 'patta-print:get-batch'
  | 'patta-print:print-batch'
  | 'patta-print:record-event'
  | 'patta-sheet:lookup'
  | 'patta-sheet:get'
  | 'patta-sheet:resolve-badge'
  | 'patta-sheet:models'
  | 'patta-sheet:history-models'
  | 'patta-sheet:model-operations'
  | 'patta-sheet:create'
  | 'patta-sheet:update'
  | 'patta-sheet:trash'
  | 'patta-sheet:restore'
  | 'patta-sheet:purge'
  | 'patta-sheet:history'
  | 'model-account:get'
  | 'model-account:models'
  | 'model-account:add-manual'
  | 'model-account:workers'
  | 'model-account:update-manual'
  | 'model-account:trash-manual'
  | 'model-account:restore-manual'
  | 'model-account:worker-details'
  | 'model-account:conveyor-account'
  | 'model-account:change-price'
  | 'model-account:manual-operations'
  | 'auth:login'
  | 'auth:logout'
  | 'auth:status'
  | 'auth:session'

export type DesktopAuthState =
  | 'SIGNED_OUT'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'REFRESHING'
  | 'OFFLINE_SESSION_PENDING'
  | 'ERROR'

export interface DesktopAuthStatus {
  state: DesktopAuthState
  errorCode: string | null
  message: string | null
}

export interface DesktopSafeSession {
  state: DesktopAuthState
  user: { id: string; email: string; full_name: string } | null
  company: { id: string; name: string; slug: string; timezone: string | null } | null
  tenant_host: string | null
  permission_codes: readonly string[]
}

export interface DesktopLoginInput {
  tenantUrl: string
  email: string
  password: string
}

export type DesktopConnectivity = 'ONLINE' | 'OFFLINE' | 'AUTH_REQUIRED' | 'DEVICE_NOT_CONFIGURED'
export type DesktopSyncResult =
  | 'COMPLETED'
  | 'OFFLINE'
  | 'AUTH_REQUIRED'
  | 'DEVICE_NOT_CONFIGURED'
  | 'FAILED'

export interface DesktopSyncStatus {
  connectivity: DesktopConnectivity
  unsyncedCount: number
  conflictCount: number
  lastSuccessfulSyncAt: string | null
  errorCode: string | null
}

export interface DesktopSyncRunResult {
  status: DesktopSyncResult
  bootstrapped: boolean
  pushed: number
  pulled: number
  errorCode?: string | null
}

export interface DesktopPattaLookup {
  id: string
  partiya_number: string
  patta_number: string
  model_id: string
  model_name_snapshot: string
  template_id: string | null
  print_batch_id: string | null
  printed_at: string | null
  konveyer_snapshot: string | null
  razmer: string | null
  rang: string | null
  ish_soni: number | null
  legacy_operation_count: number | null
  status: 'ACTIVE' | 'VOID'
  created_at: string
  operations: readonly {
    id: string
    operation_id: string
    operation_name_snapshot: string
    unit_price_snapshot: string
    sort_order: number
  }[]
}

export interface DesktopModelOption {
  id: string
  name: string
}

export interface DesktopPattaPrintBatchInput {
  model_id: string
  ish_soni: number
  rang: string
  size_distribution: readonly { razmer: string; patta_count: number; sort_order: number }[]
}

export interface DesktopPattaPrintBatchCorrectionInput {
  batch_id: string
  expected_version: string
  correction_reason: string
  ish_soni: number
  rang: string
  size_distribution: readonly { razmer: string; patta_count: number; sort_order: number }[]
}

export interface DesktopPattaPrintBatchResult {
  id: string
  model_id: string
  model_name_snapshot: string
  partiya_number: string
  partiya_block_id: string | null
  ish_soni: number
  rang: string
  status: 'ACTIVE' | 'VOID' | 'SUPERSEDED'
  version: string
  revision: number
  corrected_from_batch_id: string | null
  created_by: string | null
  created_device_id: string
  created_at: string
  updated_at: string
  printed_at: string | null
  size_distribution: readonly {
    id: string
    print_batch_id: string
    razmer: string
    patta_count: number
    sort_order: number
  }[]
  pattas: readonly DesktopPattaLookup[]
}

export interface DesktopPattaPrintEventInput {
  batch_id: string
  revision: number
  kind: 'INITIAL' | 'REPRINT' | 'CORRECTED_REPRINT'
  outcome: 'REQUESTED' | 'SUCCEEDED' | 'FAILED'
}

export interface DesktopPattaPrintEvent {
  id: string
  batch_id: string
  revision: number
  kind: DesktopPattaPrintEventInput['kind']
  outcome: DesktopPattaPrintEventInput['outcome']
  actor_user_id: string | null
  device_id: string
  created_at: string
  printed_at: string | null
}

export interface DesktopPattaSheetLinkedCreateInput {
  entry_kind?: 'PATTA_LINKED'
  partiya_number: string
  patta_number: string
  conveyor_snapshot: string | null
  assignments: readonly { model_operation_id: string; badge_number: string; nuqson: boolean }[]
  custom_operations?: readonly { id: string; name: string; initial_price: string }[]
}

export interface DesktopPattaSheetStandaloneCreateInput {
  entry_kind: 'STANDALONE'
  entered_at: string
  model_id: string
  ish_soni: number
  partiya_number_snapshot: string | null
  patta_number_snapshot: string | null
  rang_snapshot: string | null
  razmer_snapshot: string | null
  conveyor_snapshot: string | null
  assignments: readonly { model_operation_id: string; badge_number: string; nuqson: boolean }[]
  custom_operations?: readonly { id: string; name: string; initial_price: string }[]
}

export type DesktopPattaSheetCreateInput =
  | DesktopPattaSheetLinkedCreateInput
  | DesktopPattaSheetStandaloneCreateInput

export interface DesktopPattaSheetUpdateInput {
  sheet_id: string
  expected_version: string
  conveyor_snapshot: string | null
  assignments: readonly { model_operation_id: string; badge_number: string; nuqson: boolean }[]
  clear_operation_ids?: readonly string[]
}

export interface DesktopPattaSheetLookup {
  patta: DesktopPattaLookup
  sheet: PattaSheetProjectionV3 | null
  rows: readonly DesktopPattaSheetRowDetail[]
}

export interface DesktopPattaSheetRowDetail {
  row_id: string
  model_operation_id: string
  worker_id: string
  worker_name: string
  badge_number: string | null
  nuqson: boolean
  deleted_at: string | null
}

export interface DesktopPattaSheetHistoryItem {
  patta: DesktopPattaLookup | null
  sheet: PattaSheetProjectionV3
  rows: readonly DesktopPattaSheetRowDetail[]
}

export interface DesktopManualAdjustmentCreateInput {
  model_id: string
  model_operation_id: string
  worker_id: string
  quantity: number
}

export interface DesktopOperationPriceChangeInput {
  operation_id: string
  expected_version: string
  price: string
}

export type DesktopModelAccountSheet = ModelAccountSheetV3

export interface ErpApi {
  app: {
    getVersion(): Promise<string>
  }
  sync: {
    status(): Promise<DesktopSyncStatus>
    run(): Promise<DesktopSyncRunResult>
  }
  patta: {
    lookup(partiyaNumber: string, pattaNumber: string): Promise<DesktopPattaLookup | null>
  }
  pattaPrint: {
    models(): Promise<readonly DesktopModelOption[]>
    createBatch(input: DesktopPattaPrintBatchInput): Promise<DesktopPattaPrintBatchResult>
    correctBatch(input: DesktopPattaPrintBatchCorrectionInput): Promise<DesktopPattaPrintBatchResult>
    getBatch(batchId: string): Promise<DesktopPattaPrintBatchResult | null>
    printBatch(batchId: string): Promise<{ batch: DesktopPattaPrintBatchResult; event: DesktopPattaPrintEvent }>
    recordEvent(input: DesktopPattaPrintEventInput): Promise<DesktopPattaPrintEvent>
  }
  pattaSheet: {
    models(): Promise<readonly DesktopModelOption[]>
    historyModels(): Promise<readonly DesktopModelOption[]>
    modelOperations(modelId: string, enteredAt: string): Promise<readonly DesktopModelOperationOption[]>
    lookup(partiyaNumber: string, pattaNumber: string): Promise<DesktopPattaSheetLookup | null>
    get(sheetId: string): Promise<DesktopPattaSheetHistoryItem | null>
    resolveBadge(badgeNumber: string, enteredAt?: string): Promise<{ worker_id: string; full_name: string } | null>
    create(input: DesktopPattaSheetCreateInput): Promise<PattaSheetProjectionV3>
    update(input: DesktopPattaSheetUpdateInput): Promise<PattaSheetProjectionV3>
    trash(sheetId: string, expectedVersion: string): Promise<PattaSheetProjectionV3>
    restore(sheetId: string, expectedVersion: string): Promise<PattaSheetProjectionV3>
    purge(sheetId: string, expectedVersion: string): Promise<void>
    history(modelId: string, includeDeleted?: boolean): Promise<readonly DesktopPattaSheetHistoryItem[]>
  }
  modelAccount: {
    models(): Promise<readonly DesktopModelOption[]>
    get(modelId: string): Promise<DesktopModelAccountSheet>
    manualOperations(modelId: string, enteredAt: string): Promise<readonly DesktopModelOperationOption[]>
    changePrice(input: DesktopOperationPriceChangeInput): Promise<OperationPriceChangeProjection>
    workers(): Promise<readonly DesktopModelOption[]>
    addManual(input: DesktopManualAdjustmentCreateInput): Promise<ModelAccountAdjustmentProjection>
    updateManual(adjustmentId: string, expectedVersion: string, quantity: number): Promise<ModelAccountAdjustmentProjection>
    trashManual(adjustmentId: string, expectedVersion: string): Promise<ModelAccountAdjustmentProjection>
    restoreManual(adjustmentId: string, expectedVersion: string): Promise<ModelAccountAdjustmentProjection>
    workerDetails(workerId: string): Promise<readonly ModelAccountWorkerDetail[]>
    conveyorAccount(): Promise<readonly ConveyorAccountRow[]>
  }
  auth: {
    login(input: DesktopLoginInput): Promise<DesktopAuthStatus>
    logout(): Promise<DesktopAuthStatus>
    status(): Promise<DesktopAuthStatus>
    session(): Promise<DesktopSafeSession>
  }
}

export interface NarrowIpcInvoker {
  invoke(channel: DesktopIpcChannel, payload?: unknown): Promise<unknown>
}

export interface IpcRendererInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createNarrowIpcInvoker(ipcRenderer: IpcRendererInvoker): NarrowIpcInvoker {
  return {
    invoke(channel, payload) {
      return payload === undefined
        ? ipcRenderer.invoke(channel)
        : ipcRenderer.invoke(channel, payload)
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid IPC response field: ${field}`)
  return value
}

function countValue(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid IPC response field: ${field}`)
  }
  return value as number
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  return stringValue(value, field)
}

function parsePermissionCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid safe session permissions')
  const codes: string[] = []
  for (const code of value as unknown[]) {
    if (typeof code !== 'string' || !PERMISSION_CODE_PATTERN.test(code)) {
      throw new Error('Invalid safe session permissions')
    }
    codes.push(code)
  }
  return [...new Set(codes)].sort((left, right) => left.localeCompare(right))
}

function parseSyncStatus(value: unknown): DesktopSyncStatus {
  if (!record(value)) throw new Error('Invalid sync status response')
  const connectivity = value.connectivity
  if (
    connectivity !== 'ONLINE' &&
    connectivity !== 'OFFLINE' &&
    connectivity !== 'AUTH_REQUIRED' &&
    connectivity !== 'DEVICE_NOT_CONFIGURED'
  ) {
    throw new Error('Invalid sync connectivity response')
  }
  const lastSuccessfulSyncAt = value.lastSuccessfulSyncAt
  if (lastSuccessfulSyncAt !== null && typeof lastSuccessfulSyncAt !== 'string') {
    throw new Error('Invalid last sync timestamp response')
  }
  const errorCode = value.errorCode
  if (errorCode !== null && typeof errorCode !== 'string') {
    throw new Error('Invalid sync error code response')
  }
  return {
    connectivity,
    unsyncedCount: countValue(value.unsyncedCount, 'unsyncedCount'),
    conflictCount: countValue(value.conflictCount, 'conflictCount'),
    lastSuccessfulSyncAt,
    errorCode
  }
}

function parseSyncRunResult(value: unknown): DesktopSyncRunResult {
  if (!record(value)) throw new Error('Invalid sync result response')
  const status = value.status
  if (
    status !== 'COMPLETED' &&
    status !== 'OFFLINE' &&
    status !== 'AUTH_REQUIRED' &&
    status !== 'DEVICE_NOT_CONFIGURED' &&
    status !== 'FAILED'
  ) {
    throw new Error('Invalid sync result status')
  }
  if (typeof value.bootstrapped !== 'boolean') throw new Error('Invalid bootstrap result')
  return {
    status,
    bootstrapped: value.bootstrapped,
    pushed: countValue(value.pushed, 'pushed'),
    pulled: countValue(value.pulled, 'pulled'),
    ...(value.errorCode === undefined
      ? {}
      : { errorCode: value.errorCode === null ? null : stringValue(value.errorCode, 'errorCode') })
  }
}

const AUTH_STATES: readonly DesktopAuthState[] = [
  'SIGNED_OUT',
  'AUTHENTICATING',
  'AUTHENTICATED',
  'REFRESHING',
  'OFFLINE_SESSION_PENDING',
  'ERROR'
]
const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/

function authState(value: unknown): DesktopAuthState {
  if (typeof value !== 'string' || !AUTH_STATES.includes(value as DesktopAuthState)) {
    throw new Error('Invalid authentication state response')
  }
  return value as DesktopAuthState
}

function parseAuthStatus(value: unknown): DesktopAuthStatus {
  if (!record(value) || Object.keys(value).length !== 3) {
    throw new Error('Invalid authentication status response')
  }
  const errorCode = value.errorCode
  const message = value.message
  if ((errorCode !== null && typeof errorCode !== 'string') || (message !== null && typeof message !== 'string')) {
    throw new Error('Invalid authentication status fields')
  }
  return { state: authState(value.state), errorCode, message }
}

function parseSafeSession(value: unknown): DesktopSafeSession {
  const safeSessionKeys = ['company', 'permission_codes', 'state', 'tenant_host', 'user']
  if (!record(value) || Object.keys(value).sort().join(',') !== safeSessionKeys.join(',')) {
    throw new Error('Invalid safe session response')
  }
  const permissionCodes = parsePermissionCodes(value.permission_codes)
  const userValue = value.user
  const companyValue = value.company
  const tenantHost = value.tenant_host
  let user: DesktopSafeSession['user'] = null
  let company: DesktopSafeSession['company'] = null
  if (userValue !== null) {
    if (!record(userValue) || Object.keys(userValue).length !== 3) {
      throw new Error('Invalid safe session user')
    }
    user = {
      id: stringValue(userValue.id, 'user.id'),
      email: stringValue(userValue.email, 'user.email'),
      full_name: stringValue(userValue.full_name, 'user.full_name')
    }
  }
  if (companyValue !== null) {
    if (!record(companyValue) || Object.keys(companyValue).length !== 4 ||
      typeof companyValue.name !== 'string' || companyValue.name.length === 0 || companyValue.name.length > 255 ||
      (companyValue.timezone !== null && typeof companyValue.timezone !== 'string')) {
      throw new Error('Invalid safe session company')
    }
    company = {
      id: stringValue(companyValue.id, 'company.id'),
      name: stringValue(companyValue.name, 'company.name'),
      slug: stringValue(companyValue.slug, 'company.slug'),
      timezone: nullableString(companyValue.timezone, 'company.timezone')
    }
  }
  if (tenantHost !== null && typeof tenantHost !== 'string') {
    throw new Error('Invalid safe session tenant host')
  }
  return {
    state: authState(value.state),
    user,
    company,
    tenant_host: tenantHost,
    permission_codes: permissionCodes
  }
}

function loginInput(value: unknown): DesktopLoginInput {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.tenantUrl !== 'string' ||
    typeof value.email !== 'string' ||
    typeof value.password !== 'string'
  ) {
    throw new Error('Kirish ma’lumotlari yaroqsiz')
  }
  const tenantUrl = value.tenantUrl.trim()
  const email = value.email.trim()
  const password = value.password
  if (
    tenantUrl.length === 0 ||
    tenantUrl.length > 2_048 ||
    email.length === 0 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length === 0 ||
    password.length > 1_024
  ) {
    throw new Error('Kirish ma’lumotlari yaroqsiz')
  }
  return { tenantUrl, email, password }
}

function parsePattaLookup(value: unknown): DesktopPattaLookup | null {
  if (value === null) return null
  if (!record(value) || !Array.isArray(value.operations)) {
    throw new Error('Invalid local Patta lookup response')
  }
  const razmer = value.razmer
  const rang = value.rang
  const ishSoni = value.ish_soni
  const legacyOperationCount = value.legacy_operation_count
  const konveyer = value.konveyer_snapshot
  const printBatchId = value.print_batch_id
  const printedAt = value.printed_at
  if (
    (razmer !== null && typeof razmer !== 'string') ||
    (rang !== null && typeof rang !== 'string') ||
    (ishSoni !== null && (!Number.isSafeInteger(ishSoni) || (ishSoni as number) <= 0)) ||
    (legacyOperationCount !== null &&
      (!Number.isSafeInteger(legacyOperationCount) || (legacyOperationCount as number) <= 0)) ||
    (konveyer !== null && typeof konveyer !== 'string') ||
    (printBatchId !== null && typeof printBatchId !== 'string') ||
    (printedAt !== null && typeof printedAt !== 'string') ||
    (value.status !== 'ACTIVE' && value.status !== 'VOID')
  ) {
    throw new Error('Invalid local Patta lookup values')
  }
  const operations = value.operations.map((operation) => {
    if (
      !record(operation) ||
      !Number.isSafeInteger(operation.sort_order) ||
      (operation.sort_order as number) < 0
    ) {
      throw new Error('Invalid local Patta operation snapshot')
    }
    return {
      id: stringValue(operation.id, 'operation_snapshot_id'),
      operation_id: stringValue(operation.operation_id, 'operation_id'),
      operation_name_snapshot: stringValue(
        operation.operation_name_snapshot,
        'operation_name_snapshot'
      ),
      unit_price_snapshot: stringValue(operation.unit_price_snapshot, 'unit_price_snapshot'),
      sort_order: operation.sort_order as number
    }
  })
  return {
    id: stringValue(value.id, 'id'),
    partiya_number: stringValue(value.partiya_number, 'partiya_number'),
    patta_number: stringValue(value.patta_number, 'patta_number'),
    model_id: stringValue(value.model_id, 'model_id'),
    model_name_snapshot: stringValue(value.model_name_snapshot, 'model_name_snapshot'),
    template_id: nullableString(value.template_id, 'template_id'),
    print_batch_id: nullableString(printBatchId, 'print_batch_id'),
    printed_at: nullableString(printedAt, 'printed_at'),
    konveyer_snapshot: nullableString(konveyer, 'konveyer_snapshot'),
    razmer,
    rang,
    ish_soni: ishSoni as number | null,
    legacy_operation_count: legacyOperationCount as number | null,
    status: value.status as 'ACTIVE' | 'VOID',
    created_at: stringValue(value.created_at, 'created_at'),
    operations
  }
}

function parseModelOptions(value: unknown): readonly DesktopModelOption[] {
  if (!Array.isArray(value)) throw new Error('Invalid Patta print model list')
  return value.map((model) => {
    if (!record(model) || Object.keys(model).some((key) => key !== 'id' && key !== 'name')) {
      throw new Error('Invalid Patta print model option')
    }
    return { id: stringValue(model.id, 'model.id'), name: stringValue(model.name, 'model.name') }
  })
}

function parsePattaPrintBatch(value: unknown): DesktopPattaPrintBatchResult {
  if (!record(value) || !Array.isArray(value.size_distribution) || !Array.isArray(value.pattas)) {
    throw new Error('Invalid Patta print batch response')
  }
  const status = value.status
  if (status !== 'ACTIVE' && status !== 'VOID' && status !== 'SUPERSEDED') {
    throw new Error('Invalid Patta print batch status')
  }
  const sizes = value.size_distribution.map((size) => {
    if (!record(size) || !Number.isSafeInteger(size.patta_count) ||
      (size.patta_count as number) <= 0 || !Number.isSafeInteger(size.sort_order) ||
      (size.sort_order as number) < 0) {
      throw new Error('Invalid Patta print size row')
    }
    return {
      id: stringValue(size.id, 'size.id'),
      print_batch_id: stringValue(size.print_batch_id, 'size.print_batch_id'),
      razmer: stringValue(size.razmer, 'size.razmer'),
      patta_count: size.patta_count as number,
      sort_order: size.sort_order as number
    }
  })
  const pattas = value.pattas.map((patta) => {
    if (!record(patta)) throw new Error('Invalid Patta print item')
    return parsePattaLookup({ ...patta, printed_at: value.printed_at })
  })
  if (pattas.some((patta) => patta === null)) throw new Error('Invalid Patta print item')
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('Invalid Patta print revision')
  return {
    id: stringValue(value.id, 'batch.id'),
    model_id: stringValue(value.model_id, 'batch.model_id'),
    model_name_snapshot: stringValue(value.model_name_snapshot, 'batch.model_name_snapshot'),
    partiya_number: stringValue(value.partiya_number, 'batch.partiya_number'),
    partiya_block_id: nullableString(value.partiya_block_id, 'batch.partiya_block_id'),
    ish_soni: countValue(value.ish_soni, 'batch.ish_soni'),
    rang: stringValue(value.rang, 'batch.rang'),
    status,
    version: stringValue(value.version, 'batch.version'),
    revision: revision as number,
    corrected_from_batch_id: nullableString(value.corrected_from_batch_id, 'batch.corrected_from_batch_id'),
    created_by: nullableString(value.created_by, 'batch.created_by'),
    created_device_id: stringValue(value.created_device_id, 'batch.created_device_id'),
    created_at: stringValue(value.created_at, 'batch.created_at'),
    updated_at: stringValue(value.updated_at, 'batch.updated_at'),
    printed_at: nullableString(value.printed_at, 'batch.printed_at'),
    size_distribution: sizes,
    pattas: pattas as DesktopPattaLookup[]
  }
}

function parsePattaPrintEvent(value: unknown): DesktopPattaPrintEvent {
  if (!record(value)) throw new Error('Invalid Patta print event')
  const kind = value.kind
  const outcome = value.outcome
  if ((kind !== 'INITIAL' && kind !== 'REPRINT' && kind !== 'CORRECTED_REPRINT') ||
    (outcome !== 'REQUESTED' && outcome !== 'SUCCEEDED' && outcome !== 'FAILED')) {
    throw new Error('Invalid Patta print event kind or outcome')
  }
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error('Invalid Patta print event revision')
  return {
    id: stringValue(value.id, 'event.id'),
    batch_id: stringValue(value.batch_id, 'event.batch_id'),
    revision: revision as number,
    kind,
    outcome,
    actor_user_id: nullableString(value.actor_user_id, 'event.actor_user_id'),
    device_id: stringValue(value.device_id, 'event.device_id'),
    created_at: stringValue(value.created_at, 'event.created_at'),
    printed_at: nullableString(value.printed_at, 'event.printed_at')
  }
}

function parsePattaSheetProjection(value: unknown): PattaSheetProjectionV3 {
  if (!record(value) || !Array.isArray(value.operation_snapshots) || !Array.isArray(value.rows)) {
    throw new Error('Invalid Patta Sheet response')
  }
  const operationSnapshots = value.operation_snapshots.map((snapshot) => {
    if (!record(snapshot) || !Number.isSafeInteger(snapshot.sort_order) || (snapshot.sort_order as number) < 0 ||
      !['PATTA', 'MODEL', 'CUSTOM'].includes(String(snapshot.source_type))) {
      throw new Error('Invalid Patta Sheet operation snapshot')
    }
    return {
      id: stringValue(snapshot.id, 'sheet.operation_snapshot.id'),
      patta_sheet_id: stringValue(snapshot.patta_sheet_id, 'sheet.operation_snapshot.patta_sheet_id'),
      model_operation_id: stringValue(snapshot.model_operation_id, 'sheet.operation_snapshot.model_operation_id'),
      source_type: snapshot.source_type as 'PATTA' | 'MODEL' | 'CUSTOM',
      source_patta_operation_snapshot_id: nullableString(snapshot.source_patta_operation_snapshot_id, 'sheet.operation_snapshot.source_id'),
      operation_name_snapshot: stringValue(snapshot.operation_name_snapshot, 'sheet.operation_snapshot.operation_name_snapshot'),
      unit_price_snapshot: stringValue(snapshot.unit_price_snapshot, 'sheet.operation_snapshot.unit_price_snapshot'),
      sort_order: snapshot.sort_order as number,
      created_at: stringValue(snapshot.created_at, 'sheet.operation_snapshot.created_at')
    }
  })
  const rows = value.rows.map((row) => {
    if (!record(row) || !Number.isSafeInteger(row.quantity_snapshot) || (row.quantity_snapshot as number) < 1 ||
      typeof row.nuqson !== 'boolean') {
      throw new Error('Invalid Patta Sheet assignment row')
    }
    return {
      id: stringValue(row.id, 'sheet.row.id'),
      patta_sheet_id: stringValue(row.patta_sheet_id, 'sheet.row.patta_sheet_id'),
      patta_sheet_operation_snapshot_id: stringValue(row.patta_sheet_operation_snapshot_id, 'sheet.row.snapshot_id'),
      worker_id: stringValue(row.worker_id, 'sheet.row.worker_id'),
      quantity_snapshot: row.quantity_snapshot as number,
      nuqson: row.nuqson,
      deleted_at: nullableString(row.deleted_at, 'sheet.row.deleted_at'),
      deleted_by: nullableString(row.deleted_by, 'sheet.row.deleted_by'),
      created_at: stringValue(row.created_at, 'sheet.row.created_at'),
      updated_at: stringValue(row.updated_at, 'sheet.row.updated_at')
    }
  })
  if (!/^(0|[1-9][0-9]*)$/.test(String(value.version))) {
    throw new Error('Invalid Patta Sheet version')
  }
  const entryKind = value.entry_kind
  if (entryKind !== 'PATTA_LINKED' && entryKind !== 'STANDALONE') {
    throw new Error('Invalid Patta Sheet entry kind')
  }
  const quantity = value.ish_soni
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1) {
    throw new Error('Invalid Patta Sheet quantity')
  }
  return {
    id: stringValue(value.id, 'sheet.id'),
    entry_kind: entryKind,
    patta_hisob_id: nullableString(value.patta_hisob_id, 'sheet.patta_hisob_id'),
    model_id: stringValue(value.model_id, 'sheet.model_id'),
    model_name_snapshot: stringValue(value.model_name_snapshot, 'sheet.model_name_snapshot'),
    ish_soni: quantity as number,
    partiya_number_snapshot: nullableString(value.partiya_number_snapshot, 'sheet.partiya_number_snapshot'),
    patta_number_snapshot: nullableString(value.patta_number_snapshot, 'sheet.patta_number_snapshot'),
    rang_snapshot: nullableString(value.rang_snapshot, 'sheet.rang_snapshot'),
    razmer_snapshot: nullableString(value.razmer_snapshot, 'sheet.razmer_snapshot'),
    entered_at: stringValue(value.entered_at, 'sheet.entered_at'),
    business_date: stringValue(value.business_date, 'sheet.business_date'),
    conveyor_snapshot: nullableString(value.conveyor_snapshot, 'sheet.conveyor_snapshot'),
    version: stringValue(value.version, 'sheet.version'),
    created_by: nullableString(value.created_by, 'sheet.created_by'),
    created_at: stringValue(value.created_at, 'sheet.created_at'),
    updated_at: stringValue(value.updated_at, 'sheet.updated_at'),
    deleted_at: nullableString(value.deleted_at, 'sheet.deleted_at'),
    deleted_by: nullableString(value.deleted_by, 'sheet.deleted_by'),
    deleted_by_name_snapshot: nullableString(value.deleted_by_name_snapshot, 'sheet.deleted_by_name_snapshot'),
    operation_snapshots: operationSnapshots,
    rows
  }
}

function parsePattaSheetHistory(value: unknown): readonly DesktopPattaSheetHistoryItem[] {
  if (!Array.isArray(value)) throw new Error('Invalid Patta Sheet history response')
  return value.map((item) => {
    if (!record(item)) throw new Error('Invalid Patta Sheet history item')
    const patta = item.patta === null ? null : parsePattaLookup(item.patta)
    if (item.patta !== null && !patta) throw new Error('Invalid Patta Sheet history Patta')
    if (!Array.isArray(item.rows)) throw new Error('Invalid Patta Sheet history rows')
    return { patta, sheet: parsePattaSheetProjection(item.sheet), rows: parsePattaSheetRowDetails(item.rows) }
  })
}

function parseModelOperationOptions(value: unknown): readonly DesktopModelOperationOption[] {
  if (!Array.isArray(value)) throw new Error('Invalid model operation options')
  return value.map((operation) => {
    if (!record(operation) || !Number.isSafeInteger(operation.sort_order) || (operation.sort_order as number) < 0) {
      throw new Error('Invalid model operation option')
    }
    return {
      model_operation_id: stringValue(operation.model_operation_id, 'operation.id'),
      operation_name_snapshot: stringValue(operation.operation_name_snapshot, 'operation.name'),
      unit_price_snapshot: stringValue(operation.unit_price_snapshot, 'operation.price'),
      sort_order: operation.sort_order as number,
      version: stringValue(operation.version, 'operation.version')
    }
  })
}

function parsePattaSheetRowDetails(value: unknown): readonly DesktopPattaSheetRowDetail[] {
  if (!Array.isArray(value)) throw new Error('Invalid Patta Sheet row details')
  return value.map((row) => {
    if (!record(row) || typeof row.nuqson !== 'boolean') throw new Error('Invalid Patta Sheet row details')
    return {
      row_id: stringValue(row.row_id, 'row.row_id'),
      model_operation_id: stringValue(row.model_operation_id, 'row.model_operation_id'),
      worker_id: stringValue(row.worker_id, 'row.worker_id'),
      worker_name: stringValue(row.worker_name, 'row.worker_name'),
      badge_number: nullableString(row.badge_number, 'row.badge_number'),
      nuqson: row.nuqson,
      deleted_at: nullableString(row.deleted_at, 'row.deleted_at')
    }
  })
}

function parseModelAccountSheet(value: unknown): DesktopModelAccountSheet {
  if (!record(value) || !Array.isArray(value.operations) || !Array.isArray(value.rows)) {
    throw new Error('Invalid Model hisob response')
  }
  const operations = value.operations.map((operation) => {
    if (!record(operation) || !Number.isSafeInteger(operation.sort_order) || (operation.sort_order as number) < 0 ||
      !validIntegerString(operation.quantity) || !validIntegerString(operation.patta_quantity) ||
      !validIntegerString(operation.standalone_quantity) || !validIntegerString(operation.manual_quantity) ||
      !validMoneyString(operation.patta_amount) || !validMoneyString(operation.standalone_amount) ||
      !validMoneyString(operation.manual_amount) || !validMoneyString(operation.gross_amount) ||
      (operation.status !== 'ACTIVE' && operation.status !== 'INACTIVE') ||
      (operation.current_price !== null && !validMoneyString(operation.current_price))) {
      throw new Error('Invalid Model hisob operation')
    }
    const status: 'ACTIVE' | 'INACTIVE' = operation.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
    return {
      model_operation_id: stringValue(operation.model_operation_id, 'operation.model_operation_id'),
      operation_name: stringValue(operation.operation_name, 'operation.operation_name'),
      sort_order: operation.sort_order as number,
      version: stringValue(operation.version, 'operation.version'),
      status,
      current_price: nullableString(operation.current_price, 'operation.current_price'),
      quantity: operation.quantity,
      patta_quantity: operation.patta_quantity,
      standalone_quantity: operation.standalone_quantity,
      manual_quantity: operation.manual_quantity,
      gross_amount: operation.gross_amount,
      patta_amount: operation.patta_amount,
      standalone_amount: operation.standalone_amount,
      manual_amount: operation.manual_amount
    }
  })
  const rows = value.rows.map((row) => {
    if (!record(row) || !validIntegerString(row.patta_quantity) || !validIntegerString(row.standalone_quantity) ||
      !validIntegerString(row.manual_quantity) ||
      !validIntegerString(row.total_quantity) || !validMoneyString(row.patta_amount) ||
      !validMoneyString(row.standalone_amount) || !validMoneyString(row.manual_amount) ||
      !validMoneyString(row.gross_amount)) {
      throw new Error('Invalid Model hisob worker total')
    }
    return {
      worker_id: stringValue(row.worker_id, 'row.worker_id'),
      worker_name: stringValue(row.worker_name, 'row.worker_name'),
      model_operation_id: stringValue(row.model_operation_id, 'row.model_operation_id'),
      patta_quantity: row.patta_quantity,
      standalone_quantity: row.standalone_quantity,
      manual_quantity: row.manual_quantity,
      total_quantity: row.total_quantity,
      patta_amount: row.patta_amount,
      standalone_amount: row.standalone_amount,
      manual_amount: row.manual_amount,
      gross_amount: row.gross_amount
    }
  })
  return {
    model_id: stringValue(value.model_id, 'model_id'),
    model_name: stringValue(value.model_name, 'model_name'),
    operations,
    rows
  }
}

function validIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}

function validMoneyString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)
}

function parseManualAdjustment(value: unknown): ModelAccountAdjustmentProjection {
  if (!record(value) || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1 ||
    !/^[1-9][0-9]*$/.test(String(value.version)) || !validMoneyString(value.unit_price_snapshot)) {
    throw new Error('Invalid Model hisob manual adjustment')
  }
  return {
    id: stringValue(value.id, 'adjustment.id'),
    model_id: stringValue(value.model_id, 'adjustment.model_id'),
    model_operation_id: stringValue(value.model_operation_id, 'adjustment.model_operation_id'),
    worker_id: stringValue(value.worker_id, 'adjustment.worker_id'),
    quantity: value.quantity as number,
    unit_price_snapshot: value.unit_price_snapshot,
    entered_at: stringValue(value.entered_at, 'adjustment.entered_at'),
    business_date: stringValue(value.business_date, 'adjustment.business_date'),
    version: stringValue(value.version, 'adjustment.version'),
    created_by: stringValue(value.created_by, 'adjustment.created_by'),
    created_device_id: stringValue(value.created_device_id, 'adjustment.created_device_id'),
    created_at: stringValue(value.created_at, 'adjustment.created_at'),
    updated_at: stringValue(value.updated_at, 'adjustment.updated_at'),
    deleted_at: nullableString(value.deleted_at, 'adjustment.deleted_at'),
    deleted_by: nullableString(value.deleted_by, 'adjustment.deleted_by')
  }
}

function parseOperationPriceChange(value: unknown): OperationPriceChangeProjection {
  if (!record(value) || !validMoneyString(value.price) || !/^[1-9][0-9]*$/.test(String(value.operation_version))) {
    throw new Error('Invalid operation price change response')
  }
  return {
    id: stringValue(value.id, 'price.id'),
    operation_id: stringValue(value.operation_id, 'price.operation_id'),
    price: value.price,
    valid_from: stringValue(value.valid_from, 'price.valid_from'),
    valid_to: nullableString(value.valid_to, 'price.valid_to'),
    created_at: stringValue(value.created_at, 'price.created_at'),
    created_by: nullableString(value.created_by, 'price.created_by'),
    operation_version: stringValue(value.operation_version, 'price.operation_version')
  }
}

function parseWorkerDetails(value: unknown): readonly ModelAccountWorkerDetail[] {
  if (!Array.isArray(value)) throw new Error('Invalid worker Model hisob details')
  return value.map((row) => {
    if (!record(row) || !['PATTA', 'STANDALONE', 'MANUAL'].includes(String(row.source)) ||
      !validIntegerString(row.quantity) || !validMoneyString(row.unit_price_snapshot) || !validMoneyString(row.gross_amount)) {
      throw new Error('Invalid worker Model hisob detail row')
    }
    return {
      model_id: stringValue(row.model_id, 'detail.model_id'),
      model_name: stringValue(row.model_name, 'detail.model_name'),
      model_operation_id: stringValue(row.model_operation_id, 'detail.model_operation_id'),
      operation_name: stringValue(row.operation_name, 'detail.operation_name'),
      source: row.source as 'PATTA' | 'STANDALONE' | 'MANUAL',
      quantity: row.quantity,
      unit_price_snapshot: row.unit_price_snapshot,
      gross_amount: row.gross_amount,
      entered_at: stringValue(row.entered_at, 'detail.entered_at'),
      manual_adjustment_id: nullableString(row.manual_adjustment_id, 'detail.manual_adjustment_id'),
      version: nullableString(row.version, 'detail.version'),
      deleted_at: nullableString(row.deleted_at, 'detail.deleted_at'),
      deleted_by: nullableString(row.deleted_by, 'detail.deleted_by')
    }
  })
}

function parseConveyorAccount(value: unknown): readonly ConveyorAccountRow[] {
  if (!Array.isArray(value)) throw new Error('Invalid Konveyer hisobi')
  return value.map((row) => {
    if (!record(row) || !validIntegerString(row.patta_count) || !validIntegerString(row.standalone_entry_count) ||
      !validIntegerString(row.manual_adjustment_count) || !validIntegerString(row.ish_soni)) {
      throw new Error('Invalid Konveyer hisob qatori')
    }
    return {
      conveyor_label: stringValue(row.conveyor_label, 'conveyor.label'),
      model_id: stringValue(row.model_id, 'conveyor.model_id'),
      model_name: stringValue(row.model_name, 'conveyor.model_name'),
      patta_count: row.patta_count,
      standalone_entry_count: row.standalone_entry_count,
      manual_adjustment_count: row.manual_adjustment_count,
      ish_soni: row.ish_soni
    }
  })
}

export function createErpApi(invoker: NarrowIpcInvoker): ErpApi {
  return {
    app: {
      async getVersion() {
        return stringValue(await invoker.invoke('app:get-version'), 'version')
      }
    },
    sync: {
      async status() {
        return parseSyncStatus(await invoker.invoke('sync:status'))
      },
      async run() {
        return parseSyncRunResult(await invoker.invoke('sync:run'))
      }
    },
    patta: {
      async lookup(partiyaNumber, pattaNumber) {
        return parsePattaLookup(
          await invoker.invoke('patta:lookup', {
            partiyaNumber,
            pattaNumber
          })
        )
      }
    },
    pattaSheet: {
      async models() {
        return parseModelOptions(await invoker.invoke('patta-sheet:models'))
      },
      async historyModels() {
        return parseModelOptions(await invoker.invoke('patta-sheet:history-models'))
      },
      async modelOperations(modelId, enteredAt) {
        return parseModelOperationOptions(await invoker.invoke('patta-sheet:model-operations', {
          model_id: modelId,
          entered_at: enteredAt
        }))
      },
      async lookup(partiyaNumber, pattaNumber) {
        const result = await invoker.invoke('patta-sheet:lookup', { partiyaNumber, pattaNumber })
        if (result === null) return null
        if (!record(result) || !Array.isArray(result.rows)) throw new Error('Invalid Patta Sheet lookup response')
        const patta = parsePattaLookup(result.patta)
        if (!patta) return null
        const rows = parsePattaSheetRowDetails(result.rows)
        return { patta, sheet: result.sheet === null ? null : parsePattaSheetProjection(result.sheet), rows }
      },
      async get(sheetId) {
        const result = await invoker.invoke('patta-sheet:get', sheetId)
        if (result === null) return null
        return parsePattaSheetHistory([result])[0] ?? null
      },
      async resolveBadge(badgeNumber, enteredAt) {
        const result = await invoker.invoke('patta-sheet:resolve-badge', {
          badge_number: badgeNumber,
          ...(enteredAt === undefined ? {} : { entered_at: enteredAt })
        })
        if (result === null) return null
        if (!record(result)) throw new Error('Invalid badge resolution response')
        return {
          worker_id: stringValue(result.worker_id, 'badge.worker_id'),
          full_name: stringValue(result.full_name, 'badge.full_name')
        }
      },
      async create(input) {
        const result = await invoker.invoke('patta-sheet:create', input)
        return parsePattaSheetProjection(result)
      },
      async update(input) {
        return parsePattaSheetProjection(await invoker.invoke('patta-sheet:update', input))
      },
      async trash(sheetId, expectedVersion) {
        return parsePattaSheetProjection(await invoker.invoke('patta-sheet:trash', { sheet_id: sheetId, expected_version: expectedVersion }))
      },
      async restore(sheetId, expectedVersion) {
        return parsePattaSheetProjection(await invoker.invoke('patta-sheet:restore', { sheet_id: sheetId, expected_version: expectedVersion }))
      },
      async purge(sheetId, expectedVersion) {
        await invoker.invoke('patta-sheet:purge', { sheet_id: sheetId, expected_version: expectedVersion })
      },
      async history(modelId, includeDeleted = false) {
        return parsePattaSheetHistory(await invoker.invoke('patta-sheet:history', { model_id: modelId, include_deleted: includeDeleted }))
      }
    },
    modelAccount: {
      async models() {
        return parseModelOptions(await invoker.invoke('model-account:models'))
      },
      async get(modelId) {
        return parseModelAccountSheet(await invoker.invoke('model-account:get', { model_id: modelId }))
      },
      async manualOperations(modelId, enteredAt) {
        return parseModelOperationOptions(await invoker.invoke('model-account:manual-operations', {
          model_id: modelId,
          entered_at: enteredAt
        }))
      },
      async changePrice(input) {
        return parseOperationPriceChange(await invoker.invoke('model-account:change-price', input))
      },
      async workers() {
        return parseModelOptions(await invoker.invoke('model-account:workers'))
      },
      async addManual(input) {
        return parseManualAdjustment(await invoker.invoke('model-account:add-manual', input))
      },
      async updateManual(adjustmentId, expectedVersion, quantity) {
        return parseManualAdjustment(await invoker.invoke('model-account:update-manual', {
          adjustment_id: adjustmentId,
          expected_version: expectedVersion,
          quantity
        }))
      },
      async trashManual(adjustmentId, expectedVersion) {
        return parseManualAdjustment(await invoker.invoke('model-account:trash-manual', {
          adjustment_id: adjustmentId,
          expected_version: expectedVersion
        }))
      },
      async restoreManual(adjustmentId, expectedVersion) {
        return parseManualAdjustment(await invoker.invoke('model-account:restore-manual', {
          adjustment_id: adjustmentId,
          expected_version: expectedVersion
        }))
      },
      async workerDetails(workerId) {
        return parseWorkerDetails(await invoker.invoke('model-account:worker-details', { worker_id: workerId }))
      },
      async conveyorAccount() {
        return parseConveyorAccount(await invoker.invoke('model-account:conveyor-account'))
      }
    },
    pattaPrint: {
      async models() {
        return parseModelOptions(await invoker.invoke('patta-print:models'))
      },
      async createBatch(input) {
        return parsePattaPrintBatch(await invoker.invoke('patta-print:create-batch', input))
      },
      async correctBatch(input) {
        return parsePattaPrintBatch(await invoker.invoke('patta-print:correct-batch', input))
      },
      async getBatch(batchId) {
        const result = await invoker.invoke('patta-print:get-batch', batchId)
        return result === null ? null : parsePattaPrintBatch(result)
      },
      async printBatch(batchId) {
        const result = await invoker.invoke('patta-print:print-batch', batchId)
        if (!record(result)) throw new Error('Invalid Patta print result')
        return {
          batch: parsePattaPrintBatch(result.batch),
          event: parsePattaPrintEvent(result.event)
        }
      },
      async recordEvent(input) {
        return parsePattaPrintEvent(await invoker.invoke('patta-print:record-event', input))
      }
    },
    auth: {
      async login(input) {
        return parseAuthStatus(await invoker.invoke('auth:login', loginInput(input)))
      },
      async logout() {
        return parseAuthStatus(await invoker.invoke('auth:logout'))
      },
      async status() {
        return parseAuthStatus(await invoker.invoke('auth:status'))
      },
      async session() {
        return parseSafeSession(await invoker.invoke('auth:session'))
      }
    }
  }
}
