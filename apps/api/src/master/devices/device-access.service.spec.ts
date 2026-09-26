import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { DeviceAccessService } from './device-access.service.js';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function serviceWithRows(rows: unknown[]) {
  const query = vi.fn(async () => rows);
  const dataSource = { query } as unknown as DataSource;
  return { service: new DeviceAccessService(dataSource), query };
}

describe('DeviceAccessService', () => {
  it('returns only the Master-validated active device identity', async () => {
    const { service, query } = serviceWithRows([{
      id: deviceId,
      company_id: companyId,
      status: 'ACTIVE',
    }]);

    await expect(service.assertActiveDevice(companyId, deviceId)).resolves.toEqual({
      id: deviceId,
      companyId,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM "devices" WHERE "id" = $1'), [deviceId]);
  });

  it('rejects unknown devices with DEVICE_NOT_FOUND', async () => {
    const { service } = serviceWithRows([]);
    await expect(service.assertActiveDevice(companyId, deviceId))
      .rejects.toMatchObject({ response: { code: 'DEVICE_NOT_FOUND' } });
  });

  it('rejects a device owned by another company before checking its status', async () => {
    const { service } = serviceWithRows([{
      id: deviceId,
      company_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'BLOCKED',
    }]);
    await expect(service.assertActiveDevice(companyId, deviceId))
      .rejects.toMatchObject({ response: { code: 'DEVICE_TENANT_MISMATCH' } });
  });

  it.each(['BLOCKED', 'REPLACED'] as const)('rejects %s devices', async (status) => {
    const { service } = serviceWithRows([{ id: deviceId, company_id: companyId, status }]);
    await expect(service.assertActiveDevice(companyId, deviceId))
      .rejects.toMatchObject({ response: { code: 'DEVICE_NOT_ACTIVE' } });
  });

  it('fails closed when Master lookup is unavailable', async () => {
    const dataSource = { query: vi.fn(async () => { throw new Error('database unavailable'); }) };
    const service = new DeviceAccessService(dataSource as unknown as DataSource);
    await expect(service.assertActiveDevice(companyId, deviceId))
      .rejects.toMatchObject({ response: { code: 'DEVICE_VALIDATION_UNAVAILABLE' } });
  });
});
