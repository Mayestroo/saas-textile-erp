export class AddTenantAuthInfrastructure20260926000200 {
  name = 'AddTenantAuthInfrastructure20260926000200';

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "refresh_token_hash" varchar(64) NOT NULL,
        "device_id" uuid NULL,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_used_at" timestamptz NULL,
        CONSTRAINT "pk_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_auth_sessions_refresh_token_hash" UNIQUE ("refresh_token_hash"),
        CONSTRAINT "fk_auth_sessions_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "ck_auth_sessions_refresh_token_hash"
          CHECK ("refresh_token_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_auth_sessions_expiry" CHECK ("expires_at" > "created_at"),
        CONSTRAINT "ck_auth_sessions_revoked_at"
          CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at"),
        CONSTRAINT "ck_auth_sessions_last_used_at"
          CHECK ("last_used_at" IS NULL OR "last_used_at" >= "created_at")
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_auth_sessions_user_id" ON "auth_sessions" ("user_id")');
    await queryRunner.query('CREATE INDEX "ix_auth_sessions_expires_at" ON "auth_sessions" ("expires_at")');

    await queryRunner.query(`
      CREATE TABLE "login_rate_limits" (
        "bucket_hash" varchar(64) NOT NULL,
        "window_started_at" timestamptz NOT NULL,
        "attempt_count" integer NOT NULL,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "pk_login_rate_limits" PRIMARY KEY ("bucket_hash"),
        CONSTRAINT "ck_login_rate_limits_bucket_hash"
          CHECK ("bucket_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_login_rate_limits_attempt_count" CHECK ("attempt_count" > 0),
        CONSTRAINT "ck_login_rate_limits_expiry" CHECK ("expires_at" > "window_started_at")
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_login_rate_limits_expires_at" ON "login_rate_limits" ("expires_at")');
  }

  async down(queryRunner) {
    await queryRunner.query('DROP TABLE IF EXISTS "login_rate_limits"');
    await queryRunner.query('DROP TABLE IF EXISTS "auth_sessions"');
  }
}
