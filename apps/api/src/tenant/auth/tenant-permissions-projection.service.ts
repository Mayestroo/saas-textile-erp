import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { isTenantPermissionCode } from '../rbac/tenant-permission.seed.js';

interface PermissionCodeRow {
  code: string;
}

export interface TenantPermissionsProjection {
  permission_codes: readonly string[];
}

@Injectable()
export class TenantPermissionsProjectionService {
  async listForUser(
    dataSource: DataSource,
    userId: string,
  ): Promise<TenantPermissionsProjection> {
    let rows: PermissionCodeRow[];
    try {
      rows = await dataSource.query(
        `SELECT DISTINCT permission."code"
         FROM "users" AS user_account
         INNER JOIN "roles" AS role ON role."id" = user_account."role_id"
         INNER JOIN "role_permissions" AS assignment ON assignment."role_id" = role."id"
         INNER JOIN "permissions" AS permission ON permission."id" = assignment."permission_id"
         WHERE user_account."id" = $1 AND user_account."status" = 'ACTIVE'
         ORDER BY permission."code"`,
        [userId],
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTHORIZATION_UNAVAILABLE',
        message: 'Ruxsatlar ro‘yxatini olib bo‘lmadi',
        details: {},
      });
    }

    return {
      permission_codes: [...new Set(rows
        .map(({ code }) => code)
        .filter(isTenantPermissionCode))]
        .sort((left, right) => left.localeCompare(right)),
    };
  }
}
