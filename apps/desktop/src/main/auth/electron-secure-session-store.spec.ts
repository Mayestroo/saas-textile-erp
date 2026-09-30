import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SecureSessionFileSystem,
  SafeStorageCipher
} from './electron-secure-session-store'
import {
  createElectronSecureSessionFileSystem,
  ElectronSecureSessionStore
} from './electron-secure-session-store'
import type { SecureSessionPayload } from './secure-session-store'

const SESSION: SecureSessionPayload = {
  version: 3,
  refreshToken: 'refresh-secret-1',
  tenantOrigin: 'https://atlas.example.test',
  tenantHost: 'atlas.example.test',
  companyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  companyName: 'Atlas Textile',
  companySlug: 'atlas',
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'operator@example.test',
  fullName: 'Operator One',
  timezone: 'Asia/Tashkent',
  permissionCodes: ['models.manage', 'patta.hisob.view']
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class TestSafeStorage implements SafeStorageCipher {
  available = true
  backend = 'gnome_libsecret'

  isEncryptionAvailable(): boolean {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  encryptString(value: string): Buffer {
    return Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`)
  }

  decryptString(value: Buffer): string {
    const encoded = value.toString('utf8').replace(/^cipher:/, '')
    return Buffer.from(encoded, 'base64').toString('utf8')
  }
}

class MemorySessionFileSystem implements SecureSessionFileSystem {
  readonly files = new Map<string, Buffer>()
  failReplace = false

  ensureDirectory(): Promise<void> {
    return Promise.resolve()
  }

  async readFile(path: string): Promise<Buffer> {
    const contents = this.files.get(path)
    if (!contents) throw Object.assign(new Error('Not found'), { code: 'ENOENT' })
    return Buffer.from(contents)
  }

  async writeSynced(path: string, contents: Buffer): Promise<void> {
    this.files.set(path, Buffer.from(contents))
  }

  async atomicReplace(source: string, destination: string): Promise<void> {
    if (this.failReplace) throw new Error('replace failed')
    const contents = this.files.get(source)
    if (!contents) throw new Error('temporary file missing')
    this.files.set(destination, Buffer.from(contents))
    this.files.delete(source)
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(path)
  }
}

describe('Electron secure session store', () => {
  it('saves and loads an encrypted versioned session, then clears it', async () => {
    const cipher = new TestSafeStorage()
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(cipher, fileSystem, 'session.bin', () => 'tmp-1')

    await store.save(SESSION)

    const bytes = fileSystem.files.get('session.bin')
    expect(bytes).toBeDefined()
    expect(bytes?.toString('utf8')).not.toContain(SESSION.refreshToken)
    expect(bytes?.toString('utf8')).not.toContain(SESSION.email)
    await expect(store.load()).resolves.toEqual(SESSION)

    await store.clear()
    await expect(store.load()).resolves.toBeNull()
  })

  it('fails closed when OS encryption is unavailable and writes no file', async () => {
    const cipher = new TestSafeStorage()
    cipher.available = false
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(cipher, fileSystem, 'session.bin', () => 'tmp-1')

    await expect(store.save(SESSION)).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' })
    await expect(store.load()).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' })
    expect(fileSystem.files.size).toBe(0)
  })

  it('rejects Linux basic-text storage even when Electron reports encryption as available', async () => {
    const cipher = new TestSafeStorage()
    cipher.backend = 'basic_text'
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(
      cipher,
      fileSystem,
      'session.bin',
      () => 'tmp-1',
      'linux'
    )

    await expect(store.save(SESSION)).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' })
    expect(fileSystem.files.size).toBe(0)
  })

  it('rejects corrupt and unsupported envelopes', async () => {
    const cipher = new TestSafeStorage()
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(cipher, fileSystem, 'session.bin', () => 'tmp-1')

    fileSystem.files.set('session.bin', Buffer.from('{"version":9,"encrypted_payload":"AA=="}'))
    await expect(store.load()).rejects.toMatchObject({ code: 'SECURE_SESSION_CORRUPT' })

    fileSystem.files.set('session.bin', Buffer.from('{not-json'))
    await expect(store.load()).rejects.toMatchObject({ code: 'SECURE_SESSION_CORRUPT' })
  })

  it('upgrades a valid v1 encrypted session without inventing timezone or permissions', async () => {
    const cipher = new TestSafeStorage()
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(cipher, fileSystem, 'session.bin', () => 'tmp-1')
    const legacy = {
      version: 1,
      refreshToken: SESSION.refreshToken,
      tenantOrigin: SESSION.tenantOrigin,
      tenantHost: SESSION.tenantHost,
      companyId: SESSION.companyId,
      companySlug: SESSION.companySlug,
      userId: SESSION.userId,
      email: SESSION.email,
      fullName: SESSION.fullName
    }
    const encrypted = cipher.encryptString(JSON.stringify(legacy)).toString('base64')
    fileSystem.files.set('session.bin', Buffer.from(JSON.stringify({ version: 1, encrypted_payload: encrypted })))

    await expect(store.load()).resolves.toMatchObject({
      version: 3,
      timezone: null,
      companyName: SESSION.companySlug,
      permissionCodes: [],
      companyId: SESSION.companyId
    })
  })

  it('upgrades a valid v2 encrypted session with a safe company-name fallback and no cached permissions', async () => {
    const cipher = new TestSafeStorage()
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(cipher, fileSystem, 'session.bin', () => 'tmp-1')
    const legacy = {
      version: 2,
      refreshToken: SESSION.refreshToken,
      tenantOrigin: SESSION.tenantOrigin,
      tenantHost: SESSION.tenantHost,
      companyId: SESSION.companyId,
      companySlug: SESSION.companySlug,
      userId: SESSION.userId,
      email: SESSION.email,
      fullName: SESSION.fullName,
      timezone: SESSION.timezone
    }
    const encrypted = cipher.encryptString(JSON.stringify(legacy)).toString('base64')
    fileSystem.files.set('session.bin', Buffer.from(JSON.stringify({ version: 1, encrypted_payload: encrypted })))

    await expect(store.load()).resolves.toMatchObject({
      version: 3,
      companyName: SESSION.companySlug,
      permissionCodes: [],
      timezone: SESSION.timezone
    })
  })

  it('keeps the prior encrypted session if atomic replacement fails', async () => {
    const cipher = new TestSafeStorage()
    const fileSystem = new MemorySessionFileSystem()
    const store = new ElectronSecureSessionStore(cipher, fileSystem, 'session.bin', () => 'tmp-1')
    await store.save(SESSION)
    const previous = Buffer.from(fileSystem.files.get('session.bin') ?? Buffer.alloc(0))
    fileSystem.failReplace = true

    await expect(store.save({ ...SESSION, refreshToken: 'refresh-secret-2' })).rejects.toThrow(
      'replace failed'
    )
    expect(fileSystem.files.get('session.bin')).toEqual(previous)
    await expect(store.load()).resolves.toEqual(SESSION)
  })

  it('atomically replaces an existing file through the operating-system filesystem', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'textile-secure-session-'))
    temporaryDirectories.push(directory)
    const store = new ElectronSecureSessionStore(
      new TestSafeStorage(),
      createElectronSecureSessionFileSystem(),
      join(directory, 'auth', 'session.bin'),
      () => 'fixed-temp-id'
    )

    await store.save(SESSION)
    await store.save({ ...SESSION, refreshToken: 'refresh-secret-rotated' })

    await expect(store.load()).resolves.toMatchObject({
      refreshToken: 'refresh-secret-rotated'
    })
  })
})
