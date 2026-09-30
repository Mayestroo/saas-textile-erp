import { createErpApi } from '../../../preload/erp-api'
import type { DesktopIpcChannel, ErpApi } from '../../../preload/erp-api'
import { vi } from 'vitest'

export type IpcTestHandler = (payload?: unknown) => unknown

export type IpcTestHandlers = Partial<Record<DesktopIpcChannel, IpcTestHandler>>

const DEFAULT_HANDLERS: IpcTestHandlers = {
  'app:get-version': () => 'test-version',
  'auth:status': () => ({ state: 'SIGNED_OUT', errorCode: null, message: null }),
  'auth:session': () => ({
    state: 'SIGNED_OUT',
    user: null,
    company: null,
    tenant_host: null,
    permission_codes: []
  }),
  'sync:status': () => ({
    connectivity: 'OFFLINE',
    unsyncedCount: 0,
    conflictCount: 0,
    lastSuccessfulSyncAt: null,
    errorCode: null
  })
}

export function createTestErp(overrides: IpcTestHandlers = {}): {
  api: ErpApi
  invoke: ReturnType<typeof vi.fn>
} {
  const handlers: IpcTestHandlers = { ...DEFAULT_HANDLERS, ...overrides }
  const invoke = vi.fn(async (channel: DesktopIpcChannel, payload?: unknown): Promise<unknown> => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`Unexpected IPC channel: ${channel}`)
    return handler(payload)
  })
  return { api: createErpApi({ invoke }), invoke }
}

export function installTestErp(api: ErpApi): void {
  window.erp = api
}
