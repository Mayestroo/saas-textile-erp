export type DesktopIpcChannel =
  | 'app:get-version'
  | 'sync:status'
  | 'sync:run'
  | 'patta:lookup'
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
  company: { id: string; slug: string } | null
  tenant_host: string | null
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
  partiya_number: string
  patta_number: string
  model_name_snapshot: string
  konveyer_snapshot: string
  razmer: string | null
  rang: string | null
  ish_soni: number
  created_at: string
  operations: readonly {
    operation_name_snapshot: string
    unit_price_snapshot: string
    sort_order: number
  }[]
}

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
  if (!record(value) || Object.keys(value).length !== 4) {
    throw new Error('Invalid safe session response')
  }
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
    if (!record(companyValue) || Object.keys(companyValue).length !== 2) {
      throw new Error('Invalid safe session company')
    }
    company = {
      id: stringValue(companyValue.id, 'company.id'),
      slug: stringValue(companyValue.slug, 'company.slug')
    }
  }
  if (tenantHost !== null && typeof tenantHost !== 'string') {
    throw new Error('Invalid safe session tenant host')
  }
  return { state: authState(value.state), user, company, tenant_host: tenantHost }
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
  if (
    (razmer !== null && typeof razmer !== 'string') ||
    (rang !== null && typeof rang !== 'string')
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
      operation_name_snapshot: stringValue(
        operation.operation_name_snapshot,
        'operation_name_snapshot'
      ),
      unit_price_snapshot: stringValue(operation.unit_price_snapshot, 'unit_price_snapshot'),
      sort_order: operation.sort_order as number
    }
  })
  return {
    partiya_number: stringValue(value.partiya_number, 'partiya_number'),
    patta_number: stringValue(value.patta_number, 'patta_number'),
    model_name_snapshot: stringValue(value.model_name_snapshot, 'model_name_snapshot'),
    konveyer_snapshot: stringValue(value.konveyer_snapshot, 'konveyer_snapshot'),
    razmer,
    rang,
    ish_soni: countValue(value.ish_soni, 'ish_soni'),
    created_at: stringValue(value.created_at, 'created_at'),
    operations
  }
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
