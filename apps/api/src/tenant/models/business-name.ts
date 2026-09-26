const ASCII_WHITESPACE = /[ \t\n\v\f\r]+/g;

export function canonicalizeBusinessName(value: string): string {
  return value.replace(ASCII_WHITESPACE, ' ').trim();
}
