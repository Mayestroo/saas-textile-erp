import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

interface DeviceAccessRow {
  id: string;
  company_id: string;
  status: 'ACTIVE' | 'BLOCKED' | 'REPLACED';
}

export interface ValidatedDeviceAccess {
  id: string;
  companyId: string;
}

function deviceNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'DEVICE_NOT_FOUND',
    message: 'Qurilma topilmadi',
    details: {},
  });
}

function deviceTenantMismatch(): ForbiddenException {
  return new ForbiddenException({
    code: 'DEVICE_TENANT_MISMATCH',
    message: 'Qurilma bu korxonaga tegishli emas',
    details: {},
  });
}

function deviceNotActive(): ForbiddenException {
  return new ForbiddenException({
    code: 'DEVICE_NOT_ACTIVE',
    message: 'Qurilma faol emas',
    details: {},
  });
}

@Injectable()
export class DeviceAccessService {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
  ) {}

  async assertActiveDevice(companyId: string, deviceId: string): Promise<ValidatedDeviceAccess> {
    let rows: DeviceAccessRow[];
    try {
      rows = await this.masterDataSource.query(
        `SELECT "id"::text AS "id", "company_id"::text AS "company_id", "status"
         FROM "devices" WHERE "id" = $1`,
        [deviceId],
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEVICE_VALIDATION_UNAVAILABLE',
        message: 'Qurilmani tekshirish xizmati vaqtincha ishlamayapti',
        details: {},
      });
    }

    const device = rows[0];
    if (!device) {
      throw deviceNotFound();
    }
    if (device.company_id !== companyId) {
      throw deviceTenantMismatch();
    }
    if (device.status !== 'ACTIVE') {
      throw deviceNotActive();
    }

    return { id: device.id, companyId: device.company_id };
  }
}
