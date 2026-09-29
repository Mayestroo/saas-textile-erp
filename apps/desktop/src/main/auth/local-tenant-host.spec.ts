import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchWithLocalTenantFallback,
  resolveLocalTenantLoopbackUrl
} from './local-tenant-host'

function dnsError(code: string): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } })
}

describe('local tenant host fallback', () => {
  it('sends a real request over loopback, preserves tenant Host and returns the API response', async () => {
    const observed = {
      remoteAddress: '',
      host: '',
      method: '',
      path: '',
      contentType: '',
      authorization: '',
      body: ''
    }
    const server = createServer((request, response) => {
      observed.remoteAddress = request.socket.remoteAddress ?? ''
      observed.host = request.headers.host ?? ''
      observed.method = request.method ?? ''
      observed.path = request.url ?? ''
      observed.contentType = request.headers['content-type'] ?? ''
      observed.authorization = request.headers.authorization ?? ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { observed.body += chunk })
      request.once('end', () => {
        response.writeHead(207, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ accepted: true, cursor: 8 }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(dnsError('ENOTFOUND'))
      const response = await fetchWithLocalTenantFallback(
        fetcher,
        `http://textile-dev.localhost:${address.port}/api/v1/sync/push?cursor=7&limit=25`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-access-token',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ events: [{ event_id: 'entry-event-1' }] })
        }
      )

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(observed.remoteAddress).toBe('127.0.0.1')
      expect(observed.host).toBe(`textile-dev.localhost:${address.port}`)
      expect(observed.host).not.toBe(`127.0.0.1:${address.port}`)
      expect(observed.method).toBe('POST')
      expect(observed.path).toBe('/api/v1/sync/push?cursor=7&limit=25')
      expect(observed.contentType).toBe('application/json')
      expect(observed.authorization).toBe('Bearer test-access-token')
      expect(JSON.parse(observed.body)).toEqual({ events: [{ event_id: 'entry-event-1' }] })
      expect(response.status).toBe(207)
      expect(response.headers.get('content-type')).toBe('application/json')
      await expect(response.json()).resolves.toEqual({ accepted: true, cursor: 8 })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })

  it.each([
    ['https://textile-dev.localhost:3000', 'ENOTFOUND'],
    ['http://nested.textile-dev.localhost:3000', 'ENOTFOUND'],
    ['http://factory.example.test:3000', 'ENOTFOUND'],
    ['http://textile-dev.localhost:3000', 'ECONNREFUSED']
  ])('does not route unsupported URL/error pair through loopback: %s (%s)', (url, code) => {
    expect(resolveLocalTenantLoopbackUrl(url, dnsError(code))).toBeNull()
  })
})
