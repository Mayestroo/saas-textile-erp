import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { isTenantPermissionCode } from './tenant-permission.seed.js';

interface PermissionQueryRow {
  allowed: boolean;
}

interface PermissionCodeRow {
  code: string;
}

interface TenantRoleRow {
  id: string;
  is_system: boolean;
}

@Injectable()
export class TenantRbacService {
  async hasAllPermissions(
    dataSource: DataSource,
    userId: string,
    permissionCodes: readonly string[],
  ): Promise<boolean> {
    const required = [...new Set(permissionCodes)];
    if (required.length === 0 || required.some((code) => !isTenantPermissionCode(code))) {
      return false;
    }

    try {
      const rows: PermissionQueryRow[] = await dataSource.query(
        `SELECT count(DISTINCT permission."code") = cardinality($2::varchar[]) AS "allowed"
         FROM "users" AS user_account
         INNER JOIN "roles" AS role ON role."id" = user_account."role_id"
         INNER JOIN "role_permissions" AS assignment ON assignment."role_id" = role."id"
         INNER JOIN "permissions" AS permission ON permission."id" = assignment."permission_id"
         WHERE user_account."id" = $1 AND user_account."status" = 'ACTIVE'
           AND permission."code" = ANY($2::varchar[])`,
        [userId, required],
      );
      return rows[0]?.allowed === true;
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTHORIZATION_UNAVAILABLE',
        message: 'Ruxsatlarni tekshirish xizmati vaqtincha ishlamayapti',
        details: {},
      });
    }
  }

  async grantRolePermissions(
    dataSource: DataSource,
    roleId: string,
    permissionCodes: readonly string[],
  ): Promise<void> {
    const requested = [...new Set(permissionCodes)];
    if (requested.length === 0 || requested.some((code) => !isTenantPermissionCode(code))) {
      throw new ForbiddenException({
        code: 'TENANT_PERMISSION_NOT_ALLOWED',
        message: 'Faqat korxona ruxsatlarini berish mumkin',
        details: {},
      });
    }

    try {
      await dataSource.transaction(async (manager) => {
        await this.insertPermissions(manager, roleId, requested);
      });
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof BadRequestException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        code: 'TENANT_ROLE_UPDATE_UNAVAILABLE',
        message: 'Korxona rollarini yangilash xizmati vaqtincha ishlamayapti',
        details: {},
      });
    }
  }

  private async insertPermissions(
    manager: EntityManager,
    roleId: string,
    permissionCodes: string[],
  ): Promise<void> {
    const roles: TenantRoleRow[] = await manager.query(
      'SELECT "id", "is_system" FROM "roles" WHERE "id" = $1 FOR UPDATE',
      [roleId],
    );
    const role = roles[0];
    if (!role) {
      throw new BadRequestException({
        code: 'TENANT_ROLE_NOT_FOUND',
        message: 'Korxona roli topilmadi',
        details: {},
      });
    }
    if (role.is_system) {
      throw new ForbiddenException({
        code: 'TENANT_SYSTEM_ROLE_PROTECTED',
        message: 'Tizim rolini o‘zgartirib bo‘lmaydi',
        details: {},
      });
    }

    const rows: PermissionCodeRow[] = await manager.query(
      `SELECT "code" FROM "permissions" WHERE "code" = ANY($1::varchar[])`,
      [permissionCodes],
    );
    if (rows.length !== permissionCodes.length) {
      throw new BadRequestException({
        code: 'TENANT_PERMISSION_NOT_FOUND',
        message: 'Korxona ruxsati topilmadi',
        details: {},
      });
    }
    await manager.query(
      `INSERT INTO "role_permissions" ("role_id", "permission_id")
       SELECT $1, permission."id" FROM "permissions" AS permission
       WHERE permission."code" = ANY($2::varchar[])
       ON CONFLICT ("role_id", "permission_id") DO NOTHING`,
      [roleId, permissionCodes],
    );
  }
}
