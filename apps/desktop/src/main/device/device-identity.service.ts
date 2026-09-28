import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalDomainError } from '../local/local-errors'
import type { DeviceIdentity } from '../sync/authenticated-sync-transport'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface DeviceConfigFileReader {
  readFile(path: string): Promise<string>
}

export type DeviceIdentityStatus =
  | { state: 'CONFIGURED'; deviceId: string }
  | { state: 'DEVICE_NOT_CONFIGURED'; reason: 'MISSING' | 'INVALID' | 'UNREADABLE' }

const nodeConfigReader: DeviceConfigFileReader = {
  async readFile(path) {
    return readFile(path, 'utf8')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

export class DeviceIdentityService implements DeviceIdentity {
  private status: DeviceIdentityStatus = { state: 'DEVICE_NOT_CONFIGURED', reason: 'MISSING' }

  constructor(
    private readonly userDataPath: string,
    private readonly fileReader: DeviceConfigFileReader = nodeConfigReader
  ) {}

  async load(): Promise<DeviceIdentityStatus> {
    let contents: string
    try {
      contents = await this.fileReader.readFile(join(this.userDataPath, 'device-config.json'))
    } catch (error) {
      this.status = {
        state: 'DEVICE_NOT_CONFIGURED',
        reason: isMissingFile(error) ? 'MISSING' : 'UNREADABLE'
      }
      return this.status
    }

    try {
      const config: unknown = JSON.parse(contents)
      if (
        !isRecord(config) ||
        Object.keys(config).length !== 2 ||
        config.version !== 1 ||
        typeof config.device_id !== 'string' ||
        !UUID_PATTERN.test(config.device_id)
      ) {
        throw new Error('Device config is invalid')
      }
      this.status = { state: 'CONFIGURED', deviceId: config.device_id.toLowerCase() }
    } catch {
      this.status = { state: 'DEVICE_NOT_CONFIGURED', reason: 'INVALID' }
    }
    return this.status
  }

  requireDeviceId(): string {
    if (this.status.state !== 'CONFIGURED') {
      throw new LocalDomainError(
        'DEVICE_NOT_CONFIGURED',
        'Qurilma ro‘yxatdan o‘tkazilmagan'
      )
    }
    return this.status.deviceId
  }

  deviceId(): string {
    return this.requireDeviceId()
  }
}
