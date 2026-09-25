export function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization ?? '');
  return match?.[1] ?? null;
}
