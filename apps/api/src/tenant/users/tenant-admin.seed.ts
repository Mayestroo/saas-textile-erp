import { hash, argon2id } from 'argon2';
import { DataSource, EntityManager } from 'typeorm';
import { TENANT_ADMIN_ROLE_NAME } from '../rbac/tenant-permission.seed.js';

export interface DefaultTenantAdminInput {
  email: string;
  fullName: string;
  password: string;
}

interface TenantAdminRoleRow {
  id: string;
}

interface ExistingTenantAdminRow {
  id: string;
  role_id: string;
}

function normalizeAndValidateAdmin(input: DefaultTenantAdminInput): DefaultTenantAdminInput {
  const email = input.email.trim().toLocaleLowerCase('en-US');
  const fullName = input.fullName.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Default tenant administrator email is invalid');
  }
  if (fullName.length === 0 || fullName.length > 200) {
    throw new Error('Default tenant administrator full name is invalid');
  }
  if (input.password.length < 12 || input.password.length > 1024) {
    throw new Error('Default tenant administrator password must contain 12 to 1024 characters');
  }

  return { email, fullName, password: input.password };
}

async function seedAdmin(
  manager: EntityManager,
  input: DefaultTenantAdminInput,
): Promise<void> {
  const normalized = normalizeAndValidateAdmin(input);
  const roleRows: TenantAdminRoleRow[] = await manager.query(
    'SELECT "id" FROM "roles" WHERE "name" = $1 AND "is_system" = true',
    [TENANT_ADMIN_ROLE_NAME],
  );
  const role = roleRows[0];
  if (!role) {
    throw new Error('Tenant administrator role must be seeded before the default administrator');
  }

  const existingRows: ExistingTenantAdminRow[] = await manager.query(
    'SELECT "id", "role_id" FROM "users" WHERE lower("email") = $1',
    [normalized.email],
  );
  const existingUser = existingRows[0];
  if (existingUser) {
    if (existingUser.role_id !== role.id) {
      throw new Error('Default tenant administrator email is already assigned to a different role');
    }
    return;
  }

  const passwordHash = await hash(normalized.password, { type: argon2id });
  await manager.query(
    `INSERT INTO "users" ("role_id", "email", "full_name", "password_hash", "status")
     VALUES ($1, $2, $3, $4, 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [role.id, normalized.email, normalized.fullName, passwordHash],
  );

  const insertedRows: ExistingTenantAdminRow[] = await manager.query(
    'SELECT "id", "role_id" FROM "users" WHERE lower("email") = $1',
    [normalized.email],
  );
  if (insertedRows[0]?.role_id !== role.id) {
    throw new Error('Default tenant administrator could not be assigned to the administrator role');
  }
}

export async function seedDefaultTenantAdmin(
  dataSource: DataSource,
  input: DefaultTenantAdminInput,
): Promise<void> {
  await dataSource.transaction(async (manager) => seedAdmin(manager, input));
}
