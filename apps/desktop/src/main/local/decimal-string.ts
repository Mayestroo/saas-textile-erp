const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/

export function parsePostgresBigint(value: string, label: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical non-negative decimal string`)
  }
  const parsed = BigInt(value)
  if (parsed > MAX_POSTGRES_BIGINT) {
    throw new Error(`${label} exceeds the PostgreSQL BIGINT range`)
  }
  return parsed
}

export function assertPostgresBigint(value: string, label: string): string {
  parsePostgresBigint(value, label)
  return value
}

export function compareDecimalStrings(left: string, right: string, label: string): number {
  const leftValue = parsePostgresBigint(left, `${label} left value`)
  const rightValue = parsePostgresBigint(right, `${label} right value`)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}
