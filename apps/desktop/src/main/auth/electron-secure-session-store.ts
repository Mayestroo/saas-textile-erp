import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SecureSessionPayload, SecureSessionStore } from './secure-session-store'
import { SecureSessionStoreError } from './secure-session-store'
import { isValidTenantTimezone } from './tenant-timezone'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/
const SESSION_KEYS_V1 = [
  'companyId',
  'companySlug',
  'email',
  'fullName',
  'refreshToken',
  'tenantHost',
  'tenantOrigin',
  'userId',
  'version'
] as const
const SESSION_KEYS_V2 = [
  'companyId',
  'companySlug',
  'email',
  'fullName',
  'refreshToken',
  'tenantHost',
  'tenantOrigin',
  'timezone',
  'userId',
  'version'
] as const
const SESSION_KEYS_V3 = [
  'companyId',
  'companyName',
  'companySlug',
  'email',
  'fullName',
  'permissionCodes',
  'refreshToken',
  'tenantHost',
  'tenantOrigin',
  'timezone',
  'userId',
  'version'
] as const

export interface SafeStorageCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface SecureSessionFileSystem {
  ensureDirectory(path: string): Promise<void>
  readFile(path: string): Promise<Buffer>
  writeSynced(path: string, contents: Buffer): Promise<void>
  atomicReplace(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
}

const nodeFileSystem: SecureSessionFileSystem = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true })
  },
  async readFile(path) {
    return readFile(path)
  },
  async writeSynced(path, contents) {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  async atomicReplace(source, destination) {
    await rename(source, destination)
  },
  async unlink(path) {
    await unlink(path)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function parseSessionPayload(value: unknown): SecureSessionPayload {
  if (!isRecord(value)) throw new Error('Session payload is not an object')
  const keys = Object.keys(value).sort()
  const oldPayload = value.version === 1 && keys.length === SESSION_KEYS_V1.length &&
    keys.every((key, index) => key === SESSION_KEYS_V1[index])
  const previousPayload = value.version === 2 && keys.length === SESSION_KEYS_V2.length &&
    keys.every((key, index) => key === SESSION_KEYS_V2[index])
  const currentPayload = value.version === 3 && keys.length === SESSION_KEYS_V3.length &&
    keys.every((key, index) => key === SESSION_KEYS_V3[index])
  if (!oldPayload && !previousPayload && !currentPayload) {
    throw new Error('Session payload fields do not match the supported version')
  }
  if (!isNonEmptyString(value.refreshToken, 8_192)) throw new Error('Refresh token is invalid')
  if (!isNonEmptyString(value.tenantOrigin, 2_048)) throw new Error('Tenant origin is invalid')
  if (!isNonEmptyString(value.tenantHost, 255)) throw new Error('Tenant host is invalid')
  if (!isNonEmptyString(value.companySlug, 63)) throw new Error('Company slug is invalid')
  if (currentPayload && !isNonEmptyString(value.companyName, 255)) throw new Error('Company name is invalid')
  if (!isNonEmptyString(value.email, 320)) throw new Error('Email is invalid')
  if (!isNonEmptyString(value.fullName, 512)) throw new Error('Display name is invalid')
  const permissionCodes = currentPayload ? value.permissionCodes : []
  if (!Array.isArray(permissionCodes) || permissionCodes.length > 256 ||
    permissionCodes.some((code) => typeof code !== 'string' || !PERMISSION_CODE_PATTERN.test(code))) {
    throw new Error('Permission projection is invalid')
  }
  if (typeof value.companyId !== 'string' || !UUID_PATTERN.test(value.companyId)) {
    throw new Error('Company identity is invalid')
  }
  if (typeof value.userId !== 'string' || !UUID_PATTERN.test(value.userId)) {
    throw new Error('User identity is invalid')
  }
  const timezone = oldPayload ? null : value.timezone
  if (timezone !== null && !isValidTenantTimezone(timezone)) throw new Error('Tenant timezone is invalid')

  const origin = new URL(value.tenantOrigin)
  const loopback =
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.hostname.endsWith('.localhost')
  const hostnameLabels = origin.hostname.toLowerCase().replace(/\.$/, '').split('.')
  if (
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.hostname.toLowerCase().replace(/\.$/, '') !== value.tenantHost.toLowerCase() ||
    hostnameLabels[0]?.toLowerCase() !== value.companySlug.toLowerCase()
  ) {
    throw new Error('Tenant origin metadata is invalid')
  }

  return {
    version: 3,
    refreshToken: value.refreshToken,
    tenantOrigin: origin.origin,
    tenantHost: value.tenantHost.toLowerCase(),
    companyId: value.companyId.toLowerCase(),
    companyName: currentPayload ? value.companyName as string : value.companySlug,
    companySlug: value.companySlug,
    userId: value.userId.toLowerCase(),
    email: value.email,
    fullName: value.fullName,
    timezone,
    permissionCodes: [...new Set(permissionCodes as string[])].sort((left, right) => left.localeCompare(right))
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

export class ElectronSecureSessionStore implements SecureSessionStore {
  constructor(
    private readonly safeStorage: SafeStorageCipher,
    private readonly fileSystem: SecureSessionFileSystem,
    private readonly sessionFilePath: string,
    private readonly temporaryFileId: () => string = randomUUID,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async load(): Promise<SecureSessionPayload | null> {
    this.assertEncryptionAvailable()
    let contents: Buffer
    try {
      contents = await this.fileSystem.readFile(this.sessionFilePath)
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }

    try {
      const envelope: unknown = JSON.parse(contents.toString('utf8'))
      if (
        !isRecord(envelope) ||
        envelope.version !== 1 ||
        typeof envelope.encrypted_payload !== 'string' ||
        envelope.encrypted_payload.length === 0 ||
        envelope.encrypted_payload.length > 32_768 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          envelope.encrypted_payload
        )
      ) {
        throw new Error('Session envelope is invalid')
      }

      const decrypted = this.safeStorage.decryptString(
        Buffer.from(envelope.encrypted_payload, 'base64')
      )
      return parseSessionPayload(JSON.parse(decrypted) as unknown)
    } catch {
      throw new SecureSessionStoreError(
        'SECURE_SESSION_CORRUPT',
        'Saqlangan sessiyani o‘qib bo‘lmadi'
      )
    }
  }

  async save(session: SecureSessionPayload): Promise<void> {
    this.assertEncryptionAvailable()
    const safeSession = parseSessionPayload(session)
    const encrypted = this.safeStorage.encryptString(JSON.stringify(safeSession))
    const envelope = Buffer.from(
      JSON.stringify({ version: 1, encrypted_payload: encrypted.toString('base64') }),
      'utf8'
    )
    const temporaryPath = `${this.sessionFilePath}.${this.temporaryFileId()}.tmp`
    await this.fileSystem.ensureDirectory(dirname(this.sessionFilePath))
    try {
      await this.fileSystem.writeSynced(temporaryPath, envelope)
      await this.fileSystem.atomicReplace(temporaryPath, this.sessionFilePath)
    } catch (error) {
      try {
        await this.fileSystem.unlink(temporaryPath)
      } catch {
        // Best-effort removal does not replace the original write error.
      }
      throw error
    }
  }

  async clear(): Promise<void> {
    try {
      await this.fileSystem.unlink(this.sessionFilePath)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }

  private assertEncryptionAvailable(): void {
    const backend = this.safeStorage.getSelectedStorageBackend?.()
    const insecureLinuxBackend =
      this.platform === 'linux' && (backend === 'basic_text' || backend === 'unknown')
    if (!this.safeStorage.isEncryptionAvailable() || insecureLinuxBackend) {
      throw new SecureSessionStoreError(
        'SECURE_STORAGE_UNAVAILABLE',
        'Qurilmaning xavfsiz saqlash xizmati mavjud emas'
      )
    }
  }
}

export function createElectronSecureSessionFileSystem(): SecureSessionFileSystem {
  return nodeFileSystem
}
