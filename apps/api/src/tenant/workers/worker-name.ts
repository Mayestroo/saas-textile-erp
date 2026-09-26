const WHITESPACE = /\s+/gu;

export function canonicalizeWorkerName(value: string): string {
  return value.replace(WHITESPACE, ' ').trim();
}
