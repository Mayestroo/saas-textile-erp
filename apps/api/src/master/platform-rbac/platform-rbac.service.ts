import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { MASTER_DATA_SOURCE_NAME } from '../../database/master/master-database.config.js';

interface PermissionQueryRow {
  allowed: boolean;
}

@Injectable()
export class PlatformRbacService {
  constructor(
    @InjectDataSource(MASTER_DATA_SOURCE_NAME) private readonly masterDataSource: DataSource,
  ) {}

  async hasAllPermissions(userId: string, permissionCodes: readonly string[]): Promise<boolean> {
    const required = [...new Set(permissionCodes)];
    if (required.length === 0) {
      return false;
    }

    let rows: PermissionQueryRow[];
    try {
      rows = await this.masterDataSource.query(
        `SELECT count(DISTINCT permission."code") = cardinality($2::varchar[]) AS "allowed"
         FROM "platform_user_roles" AS assignment
         INNER JOIN "platform_role_permissions" AS role_permission
           ON role_permission."role_id" = assignment."role_id"
         INNER JOIN "platform_permissions" AS permission
           ON permission."id" = role_permission."permission_id"
         WHERE assignment."user_id" = $1 AND permission."code" = ANY($2::varchar[])`,
        [userId, required],
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTHORIZATION_UNAVAILABLE',
        message: 'Ruxsatlarni tekshirish xizmati vaqtincha ishlamayapti',
        details: {},
      });
    }
    return rows[0]?.allowed === true;
  }
}
