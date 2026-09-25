export class InitialTenantFoundation20260926000000 {
  name = 'InitialTenantFoundation20260926000000';

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "is_system" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_roles" PRIMARY KEY ("id"),
        CONSTRAINT "uq_roles_name" UNIQUE ("name"),
        CONSTRAINT "ck_roles_name_not_empty" CHECK (length(trim("name")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" varchar NOT NULL,
        "description" varchar NULL,
        CONSTRAINT "pk_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_permissions_code" UNIQUE ("code"),
        CONSTRAINT "ck_permissions_code_not_empty" CHECK (length(trim("code")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_id" uuid NOT NULL,
        "email" varchar NOT NULL,
        "full_name" varchar NOT NULL,
        "password_hash" text NOT NULL,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_users" PRIMARY KEY ("id"),
        CONSTRAINT "fk_users_role_id" FOREIGN KEY ("role_id")
          REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_users_status" CHECK ("status" IN ('ACTIVE', 'BLOCKED')),
        CONSTRAINT "ck_users_email_not_empty" CHECK (length(trim("email")) > 0),
        CONSTRAINT "ck_users_full_name_not_empty" CHECK (length(trim("full_name")) > 0),
        CONSTRAINT "ck_users_password_hash_not_empty" CHECK (length(trim("password_hash")) > 0)
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX "uq_users_email_ci" ON "users" (lower("email"))',
    );

    await queryRunner.query(`
      CREATE TABLE "role_permissions" (
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        CONSTRAINT "pk_role_permissions" PRIMARY KEY ("role_id", "permission_id"),
        CONSTRAINT "fk_role_permissions_role_id" FOREIGN KEY ("role_id")
          REFERENCES "roles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "fk_role_permissions_permission_id" FOREIGN KEY ("permission_id")
          REFERENCES "permissions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  async down(queryRunner) {
    await queryRunner.query('DROP TABLE IF EXISTS "role_permissions"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_users_email_ci"');
    await queryRunner.query('DROP TABLE IF EXISTS "users"');
    await queryRunner.query('DROP TABLE IF EXISTS "permissions"');
    await queryRunner.query('DROP TABLE IF EXISTS "roles"');
  }
}
