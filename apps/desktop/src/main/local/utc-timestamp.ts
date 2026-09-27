const ISO_TIMESTAMP_WITH_OFFSET =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i

export function canonicalUtcTimestamp(value: string, label: string): string {
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(value)
  const epochMilliseconds = Date.parse(value)
  if (!match || !Number.isFinite(epochMilliseconds)) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp with an offset`)
  }

  const utcMilliseconds = new Date(epochMilliseconds).toISOString()
  const fractionalMicroseconds = (match[2] ?? '').slice(3, 6).padEnd(3, '0')
  const microseconds = `${utcMilliseconds.slice(20, 23)}${fractionalMicroseconds}`
  return `${utcMilliseconds.slice(0, 19)}.${microseconds}Z`
}
