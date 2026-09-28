import type { PersistedLocalPatta } from '../local/local-patta.types'
import type { DesktopAuthService } from '../auth/desktop-auth.service'
import type { DesktopTenantRuntime } from '../auth/desktop-tenant-runtime'
import { normalizeTenantOrigin } from '../auth/tenant-auth-api-client'
import type {
  DesktopPattaLookup,
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
}

export interface MainProcessIpcDependencies {
  appVersion: () => string
  authService: Pick<
    DesktopAuthService,
    'login' | 'logout' | 'status' | 'currentSession' | 'refreshAccessToken'
  >
  tenantRuntime: Pick<
    DesktopTenantRuntime,
    'getSyncStatus' | 'runSync' | 'activePattaRepository'
  >
}

interface PattaLookupInput {
  partiyaNumber: string
  pattaNumber: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    partiya_number: patta.partiya_number,
    patta_number: patta.patta_number,
    model_name_snapshot: patta.model_name_snapshot,
    konveyer_snapshot: patta.konveyer_snapshot,
    razmer: patta.razmer,
    rang: patta.rang,
    ish_soni: patta.ish_soni,
    created_at: patta.created_at,
    operations: patta.operations.map((operation) => ({
      operation_name_snapshot: operation.operation_name_snapshot,
      unit_price_snapshot: operation.unit_price_snapshot,
      sort_order: operation.sort_order
    }))
  }
}

export function createMainProcessIpcServices(
  dependencies: MainProcessIpcDependencies
): MainProcessIpcServices {
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
    }
  }
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
    if (args.length > 0) throw new Error('Chiqish so‘rovi yaroqsiz')
    return services.logout()
  })
  ipcMain.handle('auth:status', async (_event, ...args) => {
    if (args.length > 0) throw new Error('Sessiya holati so‘rovi yaroqsiz')
    return services.authStatus()
  })
  ipcMain.handle('auth:session', async (_event, ...args) => {
    if (args.length > 0) throw new Error('Sessiya ma’lumoti so‘rovi yaroqsiz')
    return services.authSession()
  })
  ipcMain.handle('sync:status', async (_event, ...args) => {
    if (args.length > 0) throw new Error('Sinxronlash holati so‘rovi yaroqsiz')
    return services.getSyncStatus()
  })
  ipcMain.handle('sync:run', async (_event, ...args) => {
    if (args.length > 0) throw new Error('Sinxronlash so‘rovi yaroqsiz')
    return services.runSync()
  })
  ipcMain.handle('patta:lookup', async (_event, ...args) => {
    if (args.length !== 1) throw new Error('Patta qidiruv ma’lumoti yaroqsiz')
    return services.lookupPatta(args[0])
  })
}
