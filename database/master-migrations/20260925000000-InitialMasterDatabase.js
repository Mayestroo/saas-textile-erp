export class InitialMasterDatabase20260925000000 {
  name = 'InitialMasterDatabase20260925000000';

  async up(queryRunner) {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "citext"');

    await queryRunner.query(`
      CREATE TABLE "companies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "slug" varchar NOT NULL,
        "status" varchar NOT NULL,
        "db_name" varchar NOT NULL,
        "db_connection_ciphertext" text NULL,
        "schema_version" varchar NULL,
        "timezone" varchar NOT NULL DEFAULT 'Asia/Tashkent',
        "provisioning_status" varchar NULL,
        "last_migration_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_companies" PRIMARY KEY ("id"),
        CONSTRAINT "uq_companies_slug" UNIQUE ("slug"),
        CONSTRAINT "uq_companies_db_name" UNIQUE ("db_name"),
        CONSTRAINT "ck_companies_status" CHECK ("status" IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'FAILED', 'ARCHIVED')),
        CONSTRAINT "ck_companies_name_not_empty" CHECK (length(trim("name")) > 0),
        CONSTRAINT "ck_companies_slug_not_empty" CHECK (length(trim("slug")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "platform_users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" citext NOT NULL,
        "password_hash" text NOT NULL,
        "status" varchar NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_platform_users" PRIMARY KEY ("id"),
        CONSTRAINT "uq_platform_users_email" UNIQUE ("email"),
        CONSTRAINT "ck_platform_users_status" CHECK ("status" IN ('ACTIVE', 'BLOCKED')),
        CONSTRAINT "ck_platform_users_email_not_empty" CHECK (length(trim("email"::text)) > 0),
        CONSTRAINT "ck_platform_users_password_hash_not_empty" CHECK (length(trim("password_hash")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "platform_roles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        CONSTRAINT "pk_platform_roles" PRIMARY KEY ("id"),
        CONSTRAINT "uq_platform_roles_name" UNIQUE ("name"),
        CONSTRAINT "ck_platform_roles_name_not_empty" CHECK (length(trim("name")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "platform_permissions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" varchar NOT NULL,
        "description" varchar NULL,
        CONSTRAINT "pk_platform_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_platform_permissions_code" UNIQUE ("code"),
        CONSTRAINT "ck_platform_permissions_code_not_empty" CHECK (length(trim("code")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "platform_role_permissions" (
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        CONSTRAINT "pk_platform_role_permissions" PRIMARY KEY ("role_id", "permission_id"),
        CONSTRAINT "fk_platform_role_permissions_role_id" FOREIGN KEY ("role_id")
          REFERENCES "platform_roles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "fk_platform_role_permissions_permission_id" FOREIGN KEY ("permission_id")
          REFERENCES "platform_permissions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "platform_user_roles" (
        "user_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        CONSTRAINT "pk_platform_user_roles" PRIMARY KEY ("user_id", "role_id"),
        CONSTRAINT "fk_platform_user_roles_user_id" FOREIGN KEY ("user_id")
          REFERENCES "platform_users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "fk_platform_user_roles_role_id" FOREIGN KEY ("role_id")
          REFERENCES "platform_roles" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL,
        "installation_id" uuid NOT NULL,
        "hardware_fingerprint_hash" text NOT NULL,
        "device_name" varchar NOT NULL,
        "status" varchar NOT NULL,
        "first_seen_at" timestamptz NOT NULL,
        "last_seen_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_devices" PRIMARY KEY ("id"),
        CONSTRAINT "uq_devices_installation_id" UNIQUE ("installation_id"),
        CONSTRAINT "uq_devices_id_company_id" UNIQUE ("id", "company_id"),
        CONSTRAINT "fk_devices_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_devices_status" CHECK ("status" IN ('ACTIVE', 'BLOCKED', 'REPLACED')),
        CONSTRAINT "ck_devices_seen_order" CHECK ("last_seen_at" >= "first_seen_at"),
        CONSTRAINT "ck_devices_fingerprint_not_empty" CHECK (length(trim("hardware_fingerprint_hash")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "licenses" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "signed_license" text NOT NULL,
        "issued_at" timestamptz NOT NULL,
        "valid_until" timestamptz NOT NULL,
        "offline_grace_until" timestamptz NOT NULL,
        "status" varchar NOT NULL,
        "revoked_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_licenses" PRIMARY KEY ("id"),
        CONSTRAINT "fk_licenses_company_id" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_licenses_device_company" FOREIGN KEY ("device_id", "company_id")
          REFERENCES "devices" ("id", "company_id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_licenses_status" CHECK ("status" IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
        CONSTRAINT "ck_licenses_valid_dates" CHECK (
          "valid_until" >= "issued_at" AND "offline_grace_until" >= "valid_until"
        ),
        CONSTRAINT "ck_licenses_revoked_at" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL)),
        CONSTRAINT "ck_licenses_signed_license_not_empty" CHECK (length(trim("signed_license")) > 0)
      )
    `);
  }

  async down(queryRunner) {
    await queryRunner.query('DROP TABLE IF EXISTS "licenses"');
    await queryRunner.query('DROP TABLE IF EXISTS "devices"');
    await queryRunner.query('DROP TABLE IF EXISTS "platform_user_roles"');
    await queryRunner.query('DROP TABLE IF EXISTS "platform_role_permissions"');
    await queryRunner.query('DROP TABLE IF EXISTS "platform_permissions"');
    await queryRunner.query('DROP TABLE IF EXISTS "platform_roles"');
    await queryRunner.query('DROP TABLE IF EXISTS "platform_users"');
    await queryRunner.query('DROP TABLE IF EXISTS "companies"');
    // Keep citext: it is a shared database extension and may predate this migration.
  }
}
