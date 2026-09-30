import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedHttpClient,
  AuthenticatedHttpRequest
} from './authenticated-sync-transport'
import { RestSyncTransport } from './rest-sync-transport'
import { parseSyncProjection, SyncProtocolValidationError } from './sync-protocol.validation'

const deviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

class RecordingHttpClient implements AuthenticatedHttpClient {
  readonly requests: AuthenticatedHttpRequest[] = []
  readonly responses: unknown[] = []

  request(request: AuthenticatedHttpRequest): Promise<unknown> {
    this.requests.push(request)
    return Promise.resolve(this.responses.shift())
  }
}

describe('REST sync transport', () => {
  it('uses the authenticated client for push, pull, bootstrap, block allocation, and usage reporting', async () => {
    const client = new RecordingHttpClient()
    client.responses.push(
      { results: [] },
      { changes: [], next_cursor: '16', has_more: false },
      {
        id: sessionId,
        device_id: deviceId,
        watermark: '17',
        status: 'ACTIVE',
        expires_at: '2026-09-27T10:00:00.000000Z'
      },
      { session_id: sessionId, watermark: '17', items: [], next_order_key: null, has_more: false },
      { session_id: sessionId, status: 'COMPLETED' },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        device_id: deviceId,
        range_start: '1000',
        range_end: '1999',
        reported_used_count: '0',
        status: 'ACTIVE',
        allocated_at: '2026-09-27T09:00:00.000000Z',
        exhausted_at: null
      },
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        device_id: deviceId,
        range_start: '1000',
        range_end: '1999',
        reported_used_count: '80',
        status: 'ACTIVE',
        allocated_at: '2026-09-27T09:00:00.000000Z',
        exhausted_at: null
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        device_id: deviceId,
        range_start: '1',
        range_end: '1000',
        reported_used_count: '0',
        status: 'ACTIVE',
        allocated_at: '2026-09-27T09:00:00.000000Z',
        exhausted_at: null
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        device_id: deviceId,
        range_start: '1',
        range_end: '1000',
        reported_used_count: '80',
        status: 'ACTIVE',
        allocated_at: '2026-09-27T09:00:00.000000Z',
        exhausted_at: null
      }
    )
    const transport = new RestSyncTransport(
      client,
      { deviceId: () => deviceId },
      'https://factory.example/'
    )

    expect(await transport.push({ events: [] })).toEqual({ results: [] })
    expect(await transport.pull({ cursor: '16', limit: 20 })).toEqual({
      changes: [],
      next_cursor: '16',
      has_more: false
    })
    expect((await transport.createBootstrap()).id).toBe(sessionId)
    expect((await transport.bootstrapPage(sessionId, null, 250)).items).toEqual([])
    await transport.completeBootstrap(sessionId)
    expect((await transport.allocatePattaNumberBlock()).range_start).toBe('1000')
    expect(
      (await transport.reportPattaBlockUsage('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '80'))
        .reported_used_count
    ).toBe('80')
    expect((await transport.allocatePattaPartiyaNumberBlock?.())?.range_start).toBe('1')
    expect(
      (await transport.reportPattaPartiyaBlockUsage?.('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '80'))
        ?.reported_used_count
    ).toBe('80')

    expect(client.requests.map(({ method, url }) => [method, url])).toEqual([
      ['POST', 'https://factory.example/api/v1/sync/push'],
      [
        'GET',
        'https://factory.example/api/v1/sync/pull?device_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&cursor=16&protocol_version=3&limit=20'
      ],
      ['POST', 'https://factory.example/api/v1/sync/bootstrap'],
      [
        'GET',
        `https://factory.example/api/v1/sync/bootstrap/${sessionId}?device_id=${deviceId}&limit=250&protocol_version=3`
      ],
      ['POST', `https://factory.example/api/v1/sync/bootstrap/${sessionId}/complete`],
      ['POST', 'https://factory.example/api/v1/patta-number-blocks/allocate'],
      [
        'POST',
        'https://factory.example/api/v1/patta-number-blocks/cccccccc-cccc-4ccc-8ccc-cccccccccccc/usage'
      ],
      ['POST', 'https://factory.example/api/v2/patta-partiya-number-blocks/allocate'],
      [
        'POST',
        'https://factory.example/api/v2/patta-partiya-number-blocks/dddddddd-dddd-4ddd-8ddd-dddddddddddd/usage'
      ]
    ])
    expect(client.requests.every((request) => !('authorization' in request))).toBe(true)
    expect(client.requests[0]?.body).toEqual({ device_id: deviceId, protocol_version: 3, events: [] })
  })

  it('rejects malformed authenticated server responses before they reach SQLite', async () => {
    const client = new RecordingHttpClient()
    client.responses.push({
      changes: [{ sequence_id: 'not-a-cursor' }],
      next_cursor: '0',
      has_more: false
    })
    const transport = new RestSyncTransport(
      client,
      { deviceId: () => deviceId },
      'https://factory.example'
    )

    await expect(transport.pull({ cursor: '0' })).rejects.toBeInstanceOf(
      SyncProtocolValidationError
    )
  })

  it('routes an online operation price update through the authenticated HTTP client', async () => {
    const client = new RecordingHttpClient()
    client.responses.push({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      price: '30.00',
      valid_from: '2026-09-28T10:00:00.000000Z',
      valid_to: null,
      created_by: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      created_at: '2026-09-28T10:00:00.000000Z',
      operation_version: '2'
    })
    const transport = new RestSyncTransport(client, { deviceId: () => deviceId }, 'https://factory.example')

    await expect(transport.changeOperationPrice?.(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '1', '30.00'
    )).resolves.toMatchObject({ price: '30.00', operation_version: '2' })
    expect(client.requests[0]).toEqual({
      method: 'POST',
      url: 'https://factory.example/api/v1/operations/dddddddd-dddd-4ddd-8ddd-dddddddddddd/price',
      body: { expected_version: '1', price: '30.00' }
    })
  })

  it('accepts a strict v2 Patta projection with unknown actual quantity and a separate legacy count', () => {
    const id = '77777777-7777-4777-8777-777777777777'
    const projection = parseSyncProjection({
      projection_version: 2,
      entity_type: 'patta_hisob',
      entity_id: id,
      entity_version: '1',
      data: {
        id,
        partiya_number: '15',
        patta_number: '9007199254740993',
        model_id: 'model-1',
        model_name_snapshot: 'Atlas',
        template_id: null,
        konveyer_snapshot: null,
        razmer: 'S',
        rang: 'Qora',
        ish_soni: null,
        legacy_operation_count: 13,
        status: 'ACTIVE',
        print_batch_id: null,
        created_device_id: deviceId,
        created_from_block_id: null,
        created_at: '2026-09-28T10:00:00.000000Z',
        client_created_at: null,
        occurred_at: null
      }
    })
    expect(projection).toMatchObject({
      projection_version: 2,
      data: { ish_soni: null, legacy_operation_count: 13 }
    })
    expect(() => parseSyncProjection({
      ...projection,
      data: { ...projection.data, ish_soni: 13, operation_count: 13 }
    })).toThrow(SyncProtocolValidationError)
  })

  it('loads and strictly validates the authenticated Patta v2 fallback mirror', async () => {
    const pattaId = '77777777-7777-4777-8777-777777777777'
    const operationSnapshotId = '88888888-8888-4888-8888-888888888888'
    const client = new RecordingHttpClient()
    client.responses.push({
      server_sequence: '17',
      batch: null,
      patta: {
        id: pattaId,
        partiya_number: 'LEGACY-1',
        patta_number: '15',
        model_id: 'model-1',
        model_name_snapshot: 'Atlas',
        template_id: null,
        konveyer_snapshot: null,
        razmer: 'S',
        rang: 'Qora',
        ish_soni: null,
        legacy_operation_count: 1,
        status: 'ACTIVE',
        version: '1',
        print_batch_id: null,
        created_device_id: deviceId,
        created_from_block_id: null,
        created_at: '2026-09-28T10:00:00.000000Z',
        client_created_at: null,
        occurred_at: null,
        operations: [{
          id: operationSnapshotId,
          patta_hisob_id: pattaId,
          operation_id: 'operation-1',
          operation_name_snapshot: 'Tikish',
          unit_price_snapshot: '1.00',
          sort_order: 0,
          created_at: '2026-09-28T10:00:00.000000Z'
        }]
      }
    })
    const transport = new RestSyncTransport(client, { deviceId: () => deviceId }, 'https://factory.example')

    const result = await transport.lookupPattaV2('LEGACY 1', '15')

    expect(result).toMatchObject({
      server_sequence: '17',
      patta: { id: pattaId, ish_soni: null, legacy_operation_count: 1 },
      batch: null
    })
    expect(client.requests).toEqual([{
      method: 'GET',
      url: 'https://factory.example/api/v2/patta/lookup?partiya_number=LEGACY+1&patta_number=15'
    }])
  })

  it('allows HTTP only for loopback development and rejects insecure remote API URLs', () => {
    const client = new RecordingHttpClient()
    expect(
      () => new RestSyncTransport(client, { deviceId: () => deviceId }, 'http://factory.example')
    ).toThrow('must use HTTPS')
    expect(
      () => new RestSyncTransport(client, { deviceId: () => deviceId }, 'http://127.0.0.1:3000')
    ).not.toThrow()
  })
})
