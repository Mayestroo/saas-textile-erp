export type DesktopIpcChannel = 'app:get-version' | 'sync:status' | 'sync:run' | 'patta:lookup'

export type DesktopConnectivity = 'ONLINE' | 'OFFLINE' | 'AUTH_REQUIRED'
export type DesktopSyncResult = 'COMPLETED' | 'OFFLINE' | 'AUTH_REQUIRED' | 'FAILED'

export interface DesktopSyncStatus {
  connectivity: DesktopConnectivity
  unsyncedCount: number
  conflictCount: number
  lastSuccessfulSyncAt: string | null
}

export interface DesktopSyncRunResult {
  status: DesktopSyncResult
  bootstrapped: boolean
  pushed: number
  pulled: number
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
  if (connectivity !== 'ONLINE' && connectivity !== 'OFFLINE' && connectivity !== 'AUTH_REQUIRED') {
    throw new Error('Invalid sync connectivity response')
  }
  const lastSuccessfulSyncAt = value.lastSuccessfulSyncAt
  if (lastSuccessfulSyncAt !== null && typeof lastSuccessfulSyncAt !== 'string') {
    throw new Error('Invalid last sync timestamp response')
  }
  return {
    connectivity,
    unsyncedCount: countValue(value.unsyncedCount, 'unsyncedCount'),
    conflictCount: countValue(value.conflictCount, 'conflictCount'),
    lastSuccessfulSyncAt
  }
}

function parseSyncRunResult(value: unknown): DesktopSyncRunResult {
  if (!record(value)) throw new Error('Invalid sync result response')
  const status = value.status
  if (
    status !== 'COMPLETED' &&
    status !== 'OFFLINE' &&
    status !== 'AUTH_REQUIRED' &&
    status !== 'FAILED'
  ) {
    throw new Error('Invalid sync result status')
  }
  if (typeof value.bootstrapped !== 'boolean') throw new Error('Invalid bootstrap result')
  return {
    status,
    bootstrapped: value.bootstrapped,
    pushed: countValue(value.pushed, 'pushed'),
    pulled: countValue(value.pulled, 'pulled')
  }
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
    }
  }
}
