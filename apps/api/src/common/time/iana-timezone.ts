export function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 128) {
    return false;
  }
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
    return resolved.length > 0;
  } catch {
    return false;
  }
}
