const SENSITIVE_FIELD_PATTERN = /authorization|token|password|passwd|secret|credential|privatekey|jwt/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\bBearer\s+[A-Za-z0-9._~-]+/gi,
      'Bearer [REDACTED]'
    )
  }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  if (Buffer.isBuffer(value)) return '[BINARY]'

  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen))
  if (value instanceof Error) {
    return { name: value.name, message: '[REDACTED]' }
  }
  if (!isRecord(value)) return '[OBJECT]'

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : sanitize(entry, seen)
    ])
  )
}

export function sanitizeStructuredFields(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>())
}
