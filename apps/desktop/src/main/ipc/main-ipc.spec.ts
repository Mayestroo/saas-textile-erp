import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openSqliteDatabase } from '../database/sqlite-database'
import { LocalUnitOfWork } from '../local/local-unit-of-work'
import { PattaLocalRepository } from '../local/patta-local.repository'
import type { DesktopAuthStatus, DesktopIpcChannel, DesktopSafeSession } from '../../preload/erp-api'
import { createErpApi } from '../../preload/erp-api'
import { createMainProcessIpcServices, registerIpcHandlers } from './register-ipc-handlers'
import type { IpcHandler, MainProcessIpcDependencies } from './register-ipc-handlers'

const databases: Database.Database[] = []
const directories: string[] = []
const timestamp = '2026-09-27T09:00:00.000000Z'

function createDatabase(): Database.Database {
  const directory = mkdtempSync(join(tmpdir(), 'textile-erp-ipc-test-'))
  directories.push(directory)
  const database = openSqliteDatabase(join(directory, 'desktop.sqlite'))
  databases.push(database)
  return database
}

function createAuthService(
  initialState: DesktopAuthStatus['state'] = 'SIGNED_OUT'
): MainProcessIpcDependencies['authService'] {
  let status: DesktopAuthStatus = { state: initialState, errorCode: null, message: null }
  let session: DesktopSafeSession = {
    state: initialState,
    user: initialState === 'SIGNED_OUT' ? null : {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      email: 'operator@example.test',
      full_name: 'Operator One'
    },
    company: initialState === 'SIGNED_OUT' ? null : {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slug: 'atlas'
    },
    tenant_host: initialState === 'SIGNED_OUT' ? null : 'atlas.example.test'
  }
  return {
    status: () => status,
    currentSession: () => session,
    login: async () => {
      status = { state: 'AUTHENTICATED', errorCode: null, message: null }
      session = {
        state: 'AUTHENTICATED',
        user: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          email: 'operator@example.test',
          full_name: 'Operator One'
        },
        company: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'atlas' },
        tenant_host: 'atlas.example.test'
      }
      return status
    },
    logout: async () => {
      status = { state: 'SIGNED_OUT', errorCode: null, message: null }
      session = { state: 'SIGNED_OUT', user: null, company: null, tenant_host: null }
      return status
    },
    refreshAccessToken: async () => false
  }
}

function createTenantRuntime(
  pattaRepository: PattaLocalRepository
): MainProcessIpcDependencies['tenantRuntime'] {
  return {
    getSyncStatus: (state: DesktopAuthStatus['state']) => ({
      connectivity: state === 'SIGNED_OUT' ? 'AUTH_REQUIRED' as const : 'OFFLINE' as const,
      unsyncedCount: 0,
      conflictCount: 0,
      lastSuccessfulSyncAt: null,
      errorCode: state === 'SIGNED_OUT' ? 'AUTH_REQUIRED' : 'NETWORK_ERROR'
    }),
    runSync: async (state: DesktopAuthStatus['state']) => ({
      status: state === 'SIGNED_OUT' ? 'AUTH_REQUIRED' as const : 'OFFLINE' as const,
      bootstrapped: false,
      pushed: 0,
      pulled: 0
    }),
    activePattaRepository: () => pattaRepository
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('narrow renderer IPC bridge', () => {
  it('exposes only typed fixed operations and sends validated lookup arguments', async () => {
    const calls: Array<{ channel: DesktopIpcChannel; payload: unknown }> = []
    const api = createErpApi({
      invoke: async (channel, payload) => {
        calls.push({ channel, payload })
        if (channel === 'app:get-version') return '1.2.3'
        if (channel === 'sync:status') {
          return {
            connectivity: 'OFFLINE',
            unsyncedCount: 2,
            conflictCount: 1,
            lastSuccessfulSyncAt: timestamp,
            errorCode: null
          }
        }
        if (channel === 'sync:run') {
          return { status: 'COMPLETED', bootstrapped: true, pushed: 2, pulled: 4 }
        }
        if (channel === 'auth:login' || channel === 'auth:logout' || channel === 'auth:status') {
          if (channel === 'auth:logout') {
            return { state: 'SIGNED_OUT', errorCode: null, message: null }
          }
          return { state: 'AUTHENTICATED', errorCode: null, message: null }
        }
        if (channel === 'auth:session') {
          return {
            state: 'AUTHENTICATED',
            user: {
              id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              email: 'operator@example.test',
              full_name: 'Operator One'
            },
            company: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'atlas' },
            tenant_host: 'atlas.example.test'
          }
        }
        return {
          partiya_number: 'PARTIYA-1',
          patta_number: '100',
          model_name_snapshot: 'Atlas',
          konveyer_snapshot: 'Line A',
          razmer: null,
          rang: null,
          ish_soni: 1,
          created_at: timestamp,
          operations: [
            {
              operation_name_snapshot: 'Sewing',
              unit_price_snapshot: '12.50',
              sort_order: 0
            }
          ]
        }
      }
    })

    expect(Object.keys(api).sort()).toEqual(['app', 'auth', 'patta', 'sync'])
    expect(await api.app.getVersion()).toBe('1.2.3')
    expect(await api.sync.status()).toMatchObject({ unsyncedCount: 2, conflictCount: 1 })
    expect(await api.sync.run()).toMatchObject({ status: 'COMPLETED', pulled: 4 })
    expect(await api.patta.lookup('PARTIYA-1', '100')).toMatchObject({
      partiya_number: 'PARTIYA-1',
      patta_number: '100',
      operations: [{ unit_price_snapshot: '12.50' }]
    })
    expect(await api.auth.login({
      tenantUrl: 'atlas.example.test',
      email: 'operator@example.test',
      password: 'password-value'
    })).toEqual({ state: 'AUTHENTICATED', errorCode: null, message: null })
    expect(await api.auth.status()).toMatchObject({ state: 'AUTHENTICATED' })
    expect(await api.auth.session()).not.toHaveProperty('accessToken')
    expect(await api.auth.logout()).toMatchObject({ state: 'SIGNED_OUT' })
    expect(calls.map(({ channel }) => channel)).toEqual([
      'app:get-version',
      'sync:status',
      'sync:run',
      'patta:lookup',
      'auth:login',
      'auth:status',
      'auth:session',
      'auth:logout'
    ])
    expect(calls.at(4)?.payload).toEqual({
      tenantUrl: 'atlas.example.test',
      email: 'operator@example.test',
      password: 'password-value'
    })
    expect(api).not.toHaveProperty('ipcRenderer')
    expect(api).not.toHaveProperty('process')
    expect(api).not.toHaveProperty('database')
  })

  it('rejects malformed main-process values before returning them to React', async () => {
    const api = createErpApi({
      invoke: async (channel) => {
        if (channel === 'sync:status') {
          return {
            connectivity: 'ONLINE',
            unsyncedCount: -1,
            conflictCount: 0,
            lastSuccessfulSyncAt: null,
            errorCode: null
          }
        }
        if (channel === 'patta:lookup') return { malformed: true }
        return null
      }
    })

    await expect(api.sync.status()).rejects.toThrow('unsyncedCount')
    await expect(api.patta.lookup('PARTIYA-1', '100')).rejects.toThrow('Invalid local Patta')
    const malformedLoginInput = {
      tenantUrl: 'atlas.example.test',
      email: 'operator@example.test',
      password: 'password',
      tenant_id: 'not-authority'
    }
    await expect(api.auth.login(malformedLoginInput as never)).rejects.toThrow(
      'Kirish ma’lumotlari yaroqsiz'
    )
    await expect(api.auth.session()).rejects.toThrow('Invalid safe session response')

    const tokenLeakingApi = createErpApi({
      invoke: async () => ({
        state: 'AUTHENTICATED',
        user: null,
        company: null,
        tenant_host: null,
        accessToken: 'must-never-cross-ipc'
      })
    })
    await expect(tokenLeakingApi.auth.session()).rejects.toThrow('Invalid safe session response')
  })
})

describe('main-process IPC handlers', () => {
  it('registers only the approved auth, version, sync, and sanitized local Patta handlers', async () => {
    const database = createDatabase()
    const pattaRepository = new PattaLocalRepository(database)
    const authService = createAuthService()
    const handlers = new Map<DesktopIpcChannel, IpcHandler>()
    const services = createMainProcessIpcServices({
      appVersion: () => '1.2.3',
      authService,
      tenantRuntime: createTenantRuntime(pattaRepository)
    })
    registerIpcHandlers(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      services
    )

    expect([...handlers.keys()].sort()).toEqual([
      'app:get-version',
      'auth:login',
      'auth:logout',
      'auth:session',
      'auth:status',
      'patta:lookup',
      'sync:run',
      'sync:status'
    ])
    expect(await handlers.get('app:get-version')?.({})).toBe('1.2.3')
    expect(await handlers.get('sync:status')?.({})).toMatchObject({
      connectivity: 'AUTH_REQUIRED',
      unsyncedCount: 0,
      conflictCount: 0
    })
    expect(await handlers.get('sync:run')?.({})).toMatchObject({
      status: 'AUTH_REQUIRED',
      pushed: 0,
      pulled: 0
    })
    expect(await handlers.get('auth:status')?.({})).toEqual({
      state: 'SIGNED_OUT', errorCode: null, message: null
    })
    expect(await handlers.get('auth:session')?.({})).toEqual({
      state: 'SIGNED_OUT', user: null, company: null, tenant_host: null
    })
    await expect(handlers.get('auth:login')?.({}, {
      tenantUrl: 'https://atlas.example.test',
      email: 'operator@example.test',
      password: 'p',
      company_id: 'must-not-be-authority'
    })).rejects.toThrow('Kirish ma’lumotlari yaroqsiz')
    await expect(handlers.get('auth:logout')?.({}, 'extra')).rejects.toThrow('Chiqish so‘rovi yaroqsiz')
    await expect(handlers.get('auth:login')?.({}, {
      tenantUrl: 'atlas.example.test',
      email: 'operator@example.test',
      password: 'one-time-password'
    })).resolves.toMatchObject({ state: 'AUTHENTICATED' })
    expect(await handlers.get('auth:session')?.({})).toMatchObject({
      state: 'AUTHENTICATED',
      company: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'atlas' }
    })
    expect(await handlers.get('auth:logout')?.({})).toMatchObject({ state: 'SIGNED_OUT' })
    expect(
      await handlers.get('patta:lookup')?.(
        {},
        {
          partiyaNumber: 'PARTIYA-1',
          pattaNumber: '100'
        }
      )
    ).toBeNull()
    await expect(
      handlers.get('patta:lookup')?.(
        {},
        {
          partiyaNumber: 'PARTIYA-1',
          pattaNumber: '0'
        }
      )
    ).rejects.toThrow('Patta raqami yaroqsiz')
  })

  it('removes tenant/device identifiers and internal row fields from Patta lookup results', () => {
    const database = createDatabase()
    const unitOfWork = new LocalUnitOfWork(database)
    unitOfWork.transaction((connection) => {
      connection
        .prepare(
          `
        INSERT INTO models (id, name, status, version, created_at, updated_at)
        VALUES ('model-1', 'Atlas', 'ACTIVE', '1', ?, ?)
      `
        )
        .run(timestamp, timestamp)
      connection
        .prepare(
          `
        INSERT INTO model_operations (
          id, model_id, name, sort_order, status, version, created_at, updated_at
        ) VALUES ('operation-1', 'model-1', 'Sewing', 0, 'ACTIVE', '1', ?, ?)
      `
        )
        .run(timestamp, timestamp)
      connection
        .prepare(
          `
        INSERT INTO patta_hisob (
          id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
          konveyer_snapshot, razmer, rang, ish_soni, created_device_id,
          created_from_block_id, created_at, client_created_at, occurred_at,
          version, ownership_state
        ) VALUES (
          'patta-1', 'PARTIYA-1', '100', 'model-1', 'Atlas', NULL,
          'Line A', NULL, NULL, 1, 'device-secret-id', NULL, ?, ?, ?, '1', 'SERVER_SYNCED'
        )
      `
        )
        .run(timestamp, timestamp, timestamp)
      connection
        .prepare(
          `
        INSERT INTO patta_operation_snapshots (
          id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
          sort_order, created_at, ownership_state
        ) VALUES ('snapshot-1', 'patta-1', 'operation-1', 'Sewing', '12.50', 0, ?, 'SERVER_SYNCED')
      `
        )
        .run(timestamp)
    })
    const services = createMainProcessIpcServices({
      appVersion: () => '1.2.3',
      authService: createAuthService('AUTHENTICATED'),
      tenantRuntime: createTenantRuntime(new PattaLocalRepository(database))
    })

    const record = services.lookupPatta({ partiyaNumber: 'PARTIYA-1', pattaNumber: '100' })
    expect(record).toEqual({
      partiya_number: 'PARTIYA-1',
      patta_number: '100',
      model_name_snapshot: 'Atlas',
      konveyer_snapshot: 'Line A',
      razmer: null,
      rang: null,
      ish_soni: 1,
      created_at: timestamp,
      operations: [
        {
          operation_name_snapshot: 'Sewing',
          unit_price_snapshot: '12.50',
          sort_order: 0
        }
      ]
    })
    expect(record).not.toHaveProperty('created_device_id')
    expect(record).not.toHaveProperty('server_sequence')
  })
})
