import type {
  PattaNumberBlockProjection,
  OperationPriceChangeProjection,
  PattaPartiyaNumberBlockProjection,
  PattaV2LookupMirror,
  SyncBootstrapPage,
  SyncBootstrapSession,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse
} from '@textile/sync-protocol'
import { assertPostgresBigint } from '../local/decimal-string'
import { LocalDomainError } from '../local/local-errors'
import type {
  AuthenticatedHttpClient,
  AuthenticatedHttpRequest,
  AuthenticatedSyncTransport,
  DeviceIdentity
} from './authenticated-sync-transport'
import {
  parsePattaNumberBlock,
  parsePattaPartiyaNumberBlock,
  parsePattaV2LookupMirror,
  parseSyncBootstrapComplete,
  parseSyncBootstrapPage,
  parseSyncBootstrapSession,
  parseSyncPullResponse,
  parseSyncPushResponse,
  SyncProtocolValidationError
} from './sync-protocol.validation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class RestSyncTransport implements AuthenticatedSyncTransport {
  private readonly apiBaseUrl: string

  constructor(
    private readonly httpClient: AuthenticatedHttpClient,
    private readonly deviceIdentity: DeviceIdentity,
    apiBaseUrl: string
  ) {
    const parsedBaseUrl = new URL(apiBaseUrl)
    const isLoopbackHttp =
      parsedBaseUrl.protocol === 'http:' &&
      (['localhost', '127.0.0.1', '[::1]'].includes(parsedBaseUrl.hostname) ||
        parsedBaseUrl.hostname.endsWith('.localhost'))
    if (parsedBaseUrl.protocol !== 'https:' && !isLoopbackHttp) {
      throw new Error('Tenant API base URL must use HTTPS outside loopback testing')
    }
    if (
      parsedBaseUrl.username !== '' ||
      parsedBaseUrl.password !== '' ||
      parsedBaseUrl.search !== '' ||
      parsedBaseUrl.hash !== ''
    ) {
      throw new Error('Tenant API base URL cannot contain credentials, query, or fragment')
    }
    this.apiBaseUrl = `${parsedBaseUrl.origin}${parsedBaseUrl.pathname.replace(/\/+$/, '')}`
  }

  deviceId(): string {
    const id = this.deviceIdentity.deviceId()
    if (!UUID_PATTERN.test(id)) {
      throw new LocalDomainError('DEVICE_ID_INVALID', 'Qurilma identifikatori yaroqsiz')
    }
    return id.toLowerCase()
  }

  async push(request: Omit<SyncPushRequest, 'device_id'>): Promise<SyncPushResponse> {
    const response = await this.request('POST', '/api/v1/sync/push', {
      device_id: this.deviceId(),
      protocol_version: 3,
      events: request.events
    })
    return parseSyncPushResponse(response)
  }

  async pull(request: Omit<SyncPullRequest, 'device_id'>): Promise<SyncPullResponse> {
    const query = new URLSearchParams({
      device_id: this.deviceId(),
      cursor: request.cursor,
      protocol_version: '3'
    })
    if (request.limit !== undefined) query.set('limit', String(request.limit))
    const response = await this.request('GET', `/api/v1/sync/pull?${query.toString()}`)
    return parseSyncPullResponse(response)
  }

  async createBootstrap(): Promise<SyncBootstrapSession> {
    const response = await this.request('POST', '/api/v1/sync/bootstrap', {
      device_id: this.deviceId(),
      protocol_version: 3
    })
    const session = parseSyncBootstrapSession(response)
    if (session.device_id.toLowerCase() !== this.deviceId()) {
      throw new SyncProtocolValidationError('bootstrap device identity')
    }
    return session
  }

  async bootstrapPage(
    sessionId: string,
    after: string | null,
    limit: number
  ): Promise<SyncBootstrapPage> {
    if (!UUID_PATTERN.test(sessionId)) {
      throw new LocalDomainError('BOOTSTRAP_SESSION_ID_INVALID', 'Sinxronlash sessiyasi yaroqsiz')
    }
    const query = new URLSearchParams({
      device_id: this.deviceId(),
      limit: String(limit),
      protocol_version: '3'
    })
    if (after !== null) query.set('after', assertPostgresBigint(after, 'Bootstrap order cursor'))
    const response = await this.request(
      'GET',
      `/api/v1/sync/bootstrap/${encodeURIComponent(sessionId)}?${query.toString()}`
    )
    const page = parseSyncBootstrapPage(response)
    if (page.session_id.toLowerCase() !== sessionId.toLowerCase()) {
      throw new SyncProtocolValidationError('bootstrap session identity')
    }
    return page
  }

  async completeBootstrap(sessionId: string): Promise<void> {
    if (!UUID_PATTERN.test(sessionId)) {
      throw new LocalDomainError('BOOTSTRAP_SESSION_ID_INVALID', 'Sinxronlash sessiyasi yaroqsiz')
    }
    const response = await this.request(
      'POST',
      `/api/v1/sync/bootstrap/${encodeURIComponent(sessionId)}/complete`,
      { device_id: this.deviceId() }
    )
    const completed = parseSyncBootstrapComplete(response)
    if (completed.session_id.toLowerCase() !== sessionId.toLowerCase()) {
      throw new SyncProtocolValidationError('bootstrap completion identity')
    }
  }

  async allocatePattaNumberBlock(): Promise<PattaNumberBlockProjection> {
    const response = await this.request('POST', '/api/v1/patta-number-blocks/allocate', {
      device_id: this.deviceId()
    })
    const block = parsePattaNumberBlock(response)
    if (block.device_id.toLowerCase() !== this.deviceId()) {
      throw new SyncProtocolValidationError('allocated block device identity')
    }
    return block
  }

  async reportPattaBlockUsage(
    blockId: string,
    reportedUsedCount: string
  ): Promise<PattaNumberBlockProjection> {
    if (!UUID_PATTERN.test(blockId)) {
      throw new LocalDomainError(
        'PATTA_BLOCK_ID_INVALID',
        'Patta raqamlar bloki identifikatori yaroqsiz'
      )
    }
    const response = await this.request(
      'POST',
      `/api/v1/patta-number-blocks/${encodeURIComponent(blockId)}/usage`,
      {
        device_id: this.deviceId(),
        reported_used_count: assertPostgresBigint(reportedUsedCount, 'Patta block usage count')
      }
    )
    const block = parsePattaNumberBlock(response)
    if (
      block.id.toLowerCase() !== blockId.toLowerCase() ||
      block.device_id.toLowerCase() !== this.deviceId()
    ) {
      throw new SyncProtocolValidationError('reported block identity')
    }
    return block
  }

  async allocatePattaPartiyaNumberBlock(): Promise<PattaPartiyaNumberBlockProjection> {
    const response = await this.request('POST', '/api/v2/patta-partiya-number-blocks/allocate', {
      device_id: this.deviceId()
    })
    const block = parsePattaPartiyaNumberBlock(response)
    if (block.device_id.toLowerCase() !== this.deviceId()) {
      throw new SyncProtocolValidationError('allocated Partiya block device identity')
    }
    return block
  }

  async reportPattaPartiyaBlockUsage(
    blockId: string,
    reportedUsedCount: string
  ): Promise<PattaPartiyaNumberBlockProjection> {
    if (!UUID_PATTERN.test(blockId)) {
      throw new LocalDomainError('PARTIYA_BLOCK_ID_INVALID', 'Partiya raqamlar bloki identifikatori yaroqsiz')
    }
    const response = await this.request(
      'POST',
      `/api/v2/patta-partiya-number-blocks/${encodeURIComponent(blockId)}/usage`,
      { device_id: this.deviceId(), reported_used_count: assertPostgresBigint(reportedUsedCount, 'Partiya block usage count') }
    )
    const block = parsePattaPartiyaNumberBlock(response)
    if (block.id.toLowerCase() !== blockId.toLowerCase() || block.device_id.toLowerCase() !== this.deviceId()) {
      throw new SyncProtocolValidationError('reported Partiya block identity')
    }
    return block
  }

  async lookupPattaV2(partiyaNumber: string, pattaNumber: string): Promise<PattaV2LookupMirror> {
    const query = new URLSearchParams({
      partiya_number: partiyaNumber,
      patta_number: pattaNumber
    })
    return parsePattaV2LookupMirror(await this.request('GET', `/api/v2/patta/lookup?${query.toString()}`))
  }

  async changeOperationPrice(
    operationId: string,
    expectedVersion: string,
    price: string
  ): Promise<OperationPriceChangeProjection> {
    if (!UUID_PATTERN.test(operationId) || !/^[1-9][0-9]*$/.test(expectedVersion) ||
      !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(price)) {
      throw new LocalDomainError('OPERATION_PRICE_INPUT_INVALID', 'Operatsiya narxini o‘zgartirish ma’lumoti yaroqsiz')
    }
    const response = await this.request(
      'POST',
      `/api/v1/operations/${encodeURIComponent(operationId.toLowerCase())}/price`,
      { expected_version: expectedVersion, price }
    )
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new SyncProtocolValidationError('operation price change response')
    }
    const id = Reflect.get(response, 'id')
    const operation_id = Reflect.get(response, 'operation_id')
    const nextPrice = Reflect.get(response, 'price')
    const valid_from = Reflect.get(response, 'valid_from')
    const valid_to = Reflect.get(response, 'valid_to')
    const created_by = Reflect.get(response, 'created_by')
    const created_at = Reflect.get(response, 'created_at')
    const operation_version = Reflect.get(response, 'operation_version')
    if (typeof id !== 'string' || !UUID_PATTERN.test(id) || typeof operation_id !== 'string' ||
      operation_id.toLowerCase() !== operationId.toLowerCase() || typeof nextPrice !== 'string' ||
      !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(nextPrice) || typeof valid_from !== 'string' ||
      !Number.isFinite(Date.parse(valid_from)) || (valid_to !== null && typeof valid_to !== 'string') ||
      (created_by !== null && typeof created_by !== 'string') || typeof created_at !== 'string' ||
      !Number.isFinite(Date.parse(created_at)) || typeof operation_version !== 'string' ||
      !/^[1-9][0-9]*$/.test(operation_version)) {
      throw new SyncProtocolValidationError('operation price change response')
    }
    return { id, operation_id, price: nextPrice, valid_from, valid_to, created_by, created_at, operation_version }
  }

  private request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const request: AuthenticatedHttpRequest = {
      method,
      url: `${this.apiBaseUrl}${path}`,
      ...(body === undefined ? {} : { body })
    }
    return this.httpClient.request(request)
  }
}
