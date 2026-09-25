import { DataSource, EntityManager } from 'typeorm';

export const TENANT_PERMISSION_SEEDS = [
  { code: 'models.view', description: 'Modellarni ko‘rish' },
  { code: 'models.manage', description: 'Modellarni boshqarish' },
  { code: 'workers.view', description: 'Ishchilarni ko‘rish' },
  { code: 'workers.manage', description: 'Ishchilarni boshqarish' },
  { code: 'workers.badge.manage', description: 'Ishchi jetonlarini boshqarish' },
  { code: 'patta.chiqarish.view', description: 'Patta chiqarishni ko‘rish' },
  { code: 'patta.chiqarish.create', description: 'Patta yaratish' },
  { code: 'patta.hisob.view', description: 'Patta hisobini ko‘rish' },
  { code: 'patta_varaq.view', description: 'Patta varag‘ini ko‘rish' },
  { code: 'patta_varaq.create', description: 'Patta varag‘i yaratish' },
  { code: 'patta_varaq.edit', description: 'Patta varag‘ini tahrirlash' },
  { code: 'patta_varaq.finalize', description: 'Patta varag‘ini yakunlash' },
  { code: 'patta_varaq.reopen', description: 'Patta varag‘ini qayta ochish' },
  { code: 'users.view', description: 'Foydalanuvchilarni ko‘rish' },
  { code: 'users.manage', description: 'Foydalanuvchilarni boshqarish' },
  { code: 'roles.view', description: 'Rollarni ko‘rish' },
  { code: 'roles.manage', description: 'Rollarni boshqarish' },
  { code: 'reports.view', description: 'Hisobotlarni ko‘rish' },
  { code: 'payroll.view', description: 'Ish haqi ma’lumotlarini ko‘rish' },
  { code: 'license.view', description: 'Litsenziya ma’lumotlarini ko‘rish' },
  { code: 'audit.view', description: 'Audit yozuvlarini ko‘rish' },
] as const;

export const TENANT_PERMISSION_CODES = TENANT_PERMISSION_SEEDS.map(({ code }) => code);
const TENANT_PERMISSION_CODE_SET = new Set<string>(TENANT_PERMISSION_CODES);

export function isTenantPermissionCode(code: string): boolean {
  return TENANT_PERMISSION_CODE_SET.has(code);
}

export const TENANT_ADMIN_ROLE_NAME = 'Korxona administratori';

async function insertTenantPermissionSeeds(manager: EntityManager): Promise<void> {
  for (const permission of TENANT_PERMISSION_SEEDS) {
    await manager.query(
      `INSERT INTO "permissions" ("code", "description")
       VALUES ($1, $2)
       ON CONFLICT ("code") DO UPDATE SET "description" = EXCLUDED."description"`,
      [permission.code, permission.description],
    );
  }

  await manager.query(
    `INSERT INTO "roles" ("name", "is_system")
     VALUES ($1, true)
     ON CONFLICT ("name") DO UPDATE SET "is_system" = true`,
    [TENANT_ADMIN_ROLE_NAME],
  );

  const roleRows: Array<{ id: string }> = await manager.query(
    'SELECT "id" FROM "roles" WHERE "name" = $1',
    [TENANT_ADMIN_ROLE_NAME],
  );
  const role = roleRows[0];
  if (!role) {
    throw new Error('Tenant administrator role seed did not produce a role');
  }

  await manager.query(
    `INSERT INTO "role_permissions" ("role_id", "permission_id")
     SELECT $1, permission."id"
     FROM "permissions" AS permission
     ON CONFLICT ("role_id", "permission_id") DO NOTHING`,
    [role.id],
  );
}

export async function seedTenantPermissions(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => insertTenantPermissionSeeds(manager));
}
