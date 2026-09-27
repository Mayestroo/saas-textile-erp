import type { SyncEngine } from '../sync/sync-engine'
import type { PattaLocalRepository } from '../local/patta-local.repository'
import type { PersistedLocalPatta } from '../local/local-patta.types'
import type { NetworkStatusService } from '../sync/network-status.service'
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
  getSyncStatus(): DesktopSyncStatus
  runSync(): Promise<DesktopSyncRunResult>
  lookupPatta(input: unknown): DesktopPattaLookup | null
}

export interface MainProcessIpcDependencies {
  appVersion: () => string
  getSyncEngine: () => Pick<SyncEngine, 'runOnce'> | null
  networkStatus: Pick<NetworkStatusService, 'snapshot'>
  pattaRepository: Pick<PattaLocalRepository, 'findByBusinessKey'>
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
    getSyncStatus: () => {
      const status = dependencies.networkStatus.snapshot()
      return {
        connectivity: dependencies.getSyncEngine() ? status.connectivity : 'AUTH_REQUIRED',
        unsyncedCount: status.unsyncedCount,
        conflictCount: status.conflictCount,
        lastSuccessfulSyncAt: status.lastSuccessfulSyncAt
      }
    },
    runSync: async () => {
      const syncEngine = dependencies.getSyncEngine()
      if (!syncEngine) {
        return { status: 'AUTH_REQUIRED', bootstrapped: false, pushed: 0, pulled: 0 }
      }
      try {
        return await syncEngine.runOnce()
      } catch {
        return { status: 'FAILED', bootstrapped: false, pushed: 0, pulled: 0 }
      }
    },
    lookupPatta: (input) => {
      const { partiyaNumber, pattaNumber } = lookupInput(input)
      const patta = dependencies.pattaRepository.findByBusinessKey(partiyaNumber, pattaNumber)
      return patta ? publicPatta(patta) : null
    }
  }
}

export function registerIpcHandlers(
  ipcMain: IpcMainHandlerRegistrar,
  services: MainProcessIpcServices
): void {
  ipcMain.handle('app:get-version', () => services.getAppVersion())
  ipcMain.handle('sync:status', () => services.getSyncStatus())
  ipcMain.handle('sync:run', () => services.runSync())
  ipcMain.handle('patta:lookup', async (_event, input) => services.lookupPatta(input))
}
