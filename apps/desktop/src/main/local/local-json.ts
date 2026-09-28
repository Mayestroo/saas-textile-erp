export function serializeLocalJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('Value cannot be represented as JSON')
  return serialized
}

export function parseLocalJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
