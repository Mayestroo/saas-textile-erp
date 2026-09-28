import { describe, expect, it } from 'vitest'
import type {
  AuthenticatedHttpClient,
  AuthenticatedHttpRequest
} from './authenticated-sync-transport'
import { RestSyncTransport } from './rest-sync-transport'
import { SyncProtocolValidationError } from './sync-protocol.validation'

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

    expect(client.requests.map(({ method, url }) => [method, url])).toEqual([
      ['POST', 'https://factory.example/api/v1/sync/push'],
      [
        'GET',
        'https://factory.example/api/v1/sync/pull?device_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&cursor=16&limit=20'
      ],
      ['POST', 'https://factory.example/api/v1/sync/bootstrap'],
      [
        'GET',
        `https://factory.example/api/v1/sync/bootstrap/${sessionId}?device_id=${deviceId}&limit=250`
      ],
      ['POST', `https://factory.example/api/v1/sync/bootstrap/${sessionId}/complete`],
      ['POST', 'https://factory.example/api/v1/patta-number-blocks/allocate'],
      [
        'POST',
        'https://factory.example/api/v1/patta-number-blocks/cccccccc-cccc-4ccc-8ccc-cccccccccccc/usage'
      ]
    ])
    expect(client.requests.every((request) => !('authorization' in request))).toBe(true)
    expect(client.requests[0]?.body).toEqual({ device_id: deviceId, events: [] })
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
