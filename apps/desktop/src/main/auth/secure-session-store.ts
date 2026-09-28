export interface SecureSessionPayload {
  version: 1
  refreshToken: string
  tenantOrigin: string
  tenantHost: string
  companyId: string
  companySlug: string
  userId: string
  email: string
  fullName: string
}

export interface SecureSessionStore {
  load(): Promise<SecureSessionPayload | null>
  save(session: SecureSessionPayload): Promise<void>
  clear(): Promise<void>
}

export class SecureSessionStoreError extends Error {
  constructor(
    readonly code: 'SECURE_STORAGE_UNAVAILABLE' | 'SECURE_SESSION_CORRUPT',
    message: string
  ) {
    super(message)
    this.name = 'SecureSessionStoreError'
  }
}
