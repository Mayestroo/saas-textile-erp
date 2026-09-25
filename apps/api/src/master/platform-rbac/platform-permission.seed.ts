import { DataSource, EntityManager } from 'typeorm';

export const PLATFORM_PERMISSION_SEEDS = [
  { code: 'companies.view', description: 'Kompaniyalarni ko‘rish' },
  { code: 'companies.create', description: 'Kompaniya yaratish' },
  { code: 'companies.suspend', description: 'Kompaniya faoliyatini to‘xtatish' },
  { code: 'companies.migrate', description: 'Kompaniya bazasini migratsiya qilish' },
  { code: 'licenses.view', description: 'Litsenziyalarni ko‘rish' },
  { code: 'licenses.create', description: 'Litsenziya yaratish' },
  { code: 'licenses.revoke', description: 'Litsenziyani bekor qilish' },
  { code: 'platform_users.manage', description: 'Platforma foydalanuvchilarini boshqarish' },
] as const;

const SUPERADMIN_ROLE_NAME = 'Superadmin';

async function insertPlatformPermissionSeeds(manager: EntityManager): Promise<void> {
  for (const permission of PLATFORM_PERMISSION_SEEDS) {
    await manager.query(
      `INSERT INTO "platform_permissions" ("code", "description")
       VALUES ($1, $2)
       ON CONFLICT ("code") DO UPDATE SET "description" = EXCLUDED."description"`,
      [permission.code, permission.description],
    );
  }

  await manager.query(
    `INSERT INTO "platform_roles" ("name")
     VALUES ($1)
     ON CONFLICT ("name") DO NOTHING`,
    [SUPERADMIN_ROLE_NAME],
  );

  const roleRows: Array<{ id: string }> = await manager.query(
    'SELECT "id" FROM "platform_roles" WHERE "name" = $1',
    [SUPERADMIN_ROLE_NAME],
  );
  const role = roleRows[0];
  if (!role) {
    throw new Error('Superadmin role seed did not produce a platform role');
  }

  await manager.query(
    `INSERT INTO "platform_role_permissions" ("role_id", "permission_id")
     SELECT $1, permission."id"
     FROM "platform_permissions" AS permission
     ON CONFLICT ("role_id", "permission_id") DO NOTHING`,
    [role.id],
  );
}

export async function seedPlatformPermissions(dataSource: DataSource): Promise<void> {
  await dataSource.transaction(async (manager) => insertPlatformPermissionSeeds(manager));
}
