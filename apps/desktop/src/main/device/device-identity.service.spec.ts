import { describe, expect, it } from 'vitest'
import { DeviceIdentityService } from './device-identity.service'
import type { DeviceConfigFileReader } from './device-identity.service'

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

class TestConfigReader implements DeviceConfigFileReader {
  content: string | null = JSON.stringify({ version: 1, device_id: DEVICE_ID })
  failure: Error | null = null
  requestedPath = ''

  async readFile(path: string): Promise<string> {
    this.requestedPath = path
    if (this.failure) throw this.failure
    if (this.content === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return this.content
  }
}

describe('DeviceIdentityService', () => {
  it('loads only the provisioned version-1 device UUID from userData', async () => {
    const reader = new TestConfigReader()
    const service = new DeviceIdentityService('C:\\Users\\operator\\AppData\\Roaming\\ERP', reader)

    await expect(service.load()).resolves.toEqual({ state: 'CONFIGURED', deviceId: DEVICE_ID })
    expect(service.deviceId()).toBe(DEVICE_ID)
    expect(reader.requestedPath).toBe(
      'C:\\Users\\operator\\AppData\\Roaming\\ERP\\device-config.json'
    )
  })

  it.each([
    ['missing', null],
    ['corrupt JSON', '{not-json'],
    ['unsupported version', JSON.stringify({ version: 2, device_id: DEVICE_ID })],
    ['missing UUID', JSON.stringify({ version: 1 })],
    ['invalid UUID', JSON.stringify({ version: 1, device_id: 'random-id' })],
    ['extra tenant authority', JSON.stringify({ version: 1, device_id: DEVICE_ID, company_id: 'x' })]
  ])('blocks sync when device config is %s without generating an ID', async (_label, content) => {
    const reader = new TestConfigReader()
    reader.content = content
    const service = new DeviceIdentityService('C:\\erp', reader)

    await expect(service.load()).resolves.toMatchObject({ state: 'DEVICE_NOT_CONFIGURED' })
    expect(() => service.requireDeviceId()).toThrow(
      expect.objectContaining({ code: 'DEVICE_NOT_CONFIGURED' })
    )
    expect(() => service.deviceId()).toThrow('Qurilma ro‘yxatdan o‘tkazilmagan')
  })

  it('fails closed when the device config cannot be read', async () => {
    const reader = new TestConfigReader()
    reader.failure = new Error('access denied')
    const service = new DeviceIdentityService('C:\\erp', reader)

    await expect(service.load()).resolves.toEqual({ state: 'DEVICE_NOT_CONFIGURED', reason: 'UNREADABLE' })
    expect(() => service.deviceId()).toThrow('Qurilma ro‘yxatdan o‘tkazilmagan')
  })
})
