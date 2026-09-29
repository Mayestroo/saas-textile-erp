import { request as httpRequest } from 'node:http'

const LOCAL_TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/i

export interface LoopbackTenantUrl {
  url: string
  host: string
}

export function resolveLocalTenantLoopbackUrl(url: string, error: unknown): LoopbackTenantUrl | null {
  if (!(error instanceof Error) || typeof error.cause !== 'object' || error.cause === null) return null
  const errorCode = Reflect.get(error.cause, 'code')
  if (errorCode !== 'ENOTFOUND' && errorCode !== 'EAI_AGAIN' && errorCode !== 'ERR_NAME_NOT_RESOLVED') {
    return null
  }

  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !LOCAL_TENANT_HOSTNAME.test(parsed.hostname)) return null
  const host = parsed.host
  parsed.hostname = '127.0.0.1'
  return { url: parsed.toString(), host }
}

function fallbackRequest(target: LoopbackTenantUrl, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(target.url)
    const headers = new Headers(options.headers)
    headers.set('Host', target.host)
    const outgoingHeaders: Record<string, string> = {}
    headers.forEach((value, name) => { outgoingHeaders[name] = value })
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: targetUrl.port ? Number(targetUrl.port) : 80,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: options.method ?? 'GET',
      setHost: false,
      headers: outgoingHeaders,
      signal: options.signal ?? undefined
    }, (response) => {
      if (options.redirect === 'error' && response.statusCode !== undefined &&
        response.statusCode >= 300 && response.statusCode < 400) {
        response.resume()
        reject(new Error('Local tenant API redirected the request'))
        return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer | Uint8Array | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.once('error', reject)
      response.once('end', () => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item)
          } else {
            responseHeaders.set(name, value)
          }
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders
        }))
      })
    })
    request.once('error', reject)
    if (typeof options.body === 'string' || options.body instanceof Uint8Array) {
      request.write(options.body)
    } else if (options.body !== undefined && options.body !== null) {
      reject(new Error('Local tenant fallback only supports string or byte request bodies'))
      request.destroy()
      return
    }
    request.end()
  })
}

export async function fetchWithLocalTenantFallback(
  fetcher: typeof fetch,
  url: string,
  options: RequestInit
): Promise<Response> {
  try {
    return await fetcher(url, options)
  } catch (error) {
    const fallback = resolveLocalTenantLoopbackUrl(url, error)
    if (!fallback) throw error
    return fallbackRequest(fallback, options)
  }
}
