export class AddWorkersAndBadgeHistory20260926000400 {
  name = 'AddWorkersAndBadgeHistory20260926000400';

  async up(queryRunner) {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "btree_gist"');

    await queryRunner.query('ALTER TABLE "audit_log" ADD COLUMN "entity_key" varchar');
    await queryRunner.query('DROP TRIGGER "trg_audit_log_append_only" ON "audit_log"');
    await queryRunner.query('UPDATE "audit_log" SET "entity_key" = "entity_id"::text');
    await queryRunner.query('ALTER TABLE "audit_log" ALTER COLUMN "entity_key" SET NOT NULL');
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_log_append_only"
      BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION "reject_audit_log_mutation"()
    `);
    await queryRunner.query('ALTER TABLE "audit_log" ALTER COLUMN "entity_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "ck_audit_log_entity_type"
        CHECK ("entity_type" IN ('model', 'operation', 'worker', 'badge')),
      ADD CONSTRAINT "ck_audit_log_action" CHECK (
        "action" IN (
          'model.create', 'model.update', 'model.deactivate',
          'operation.create', 'operation.update', 'operation.deactivate',
          'operation.price_change',
          'worker.create', 'worker.update', 'worker.deactivate',
          'badge.assign', 'badge.reassign', 'badge.close', 'badge.release'
        )
      ),
      ADD CONSTRAINT "ck_audit_log_entity_key_not_empty"
        CHECK ("entity_key" <> '')
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_audit_log_entity_key" ON "audit_log" ("entity_type", "entity_key")',
    );

    await queryRunner.query(`
      CREATE TABLE "workers" (
        "id" bigint GENERATED ALWAYS AS IDENTITY,
        "full_name" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "version" bigint NOT NULL DEFAULT 1,
        CONSTRAINT "pk_workers" PRIMARY KEY ("id"),
        CONSTRAINT "ck_workers_full_name_canonical" CHECK (
          "full_name" <> '' AND
          "full_name" = "canonicalize_business_name"("full_name")
        ),
        CONSTRAINT "ck_workers_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT "ck_workers_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_workers_status" ON "workers" ("status")');
    await queryRunner.query(`
      CREATE FUNCTION "reject_worker_historical_delete"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'worker and badge history rows cannot be deleted'
          USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_workers_no_delete"
      BEFORE DELETE ON "workers"
      FOR EACH ROW EXECUTE FUNCTION "reject_worker_historical_delete"()
    `);

    await queryRunner.query(`
      CREATE TABLE "worker_badge_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "badge_number" varchar NOT NULL,
        "worker_id" bigint NOT NULL,
        "valid_from" timestamptz NOT NULL,
        "valid_to" timestamptz NULL,
        "created_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_worker_badge_history" PRIMARY KEY ("id"),
        CONSTRAINT "fk_worker_badge_history_worker_id" FOREIGN KEY ("worker_id")
          REFERENCES "workers" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_worker_badge_history_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_worker_badge_history_badge_number" CHECK (
          "badge_number" <> '' AND
          "badge_number" = btrim("badge_number", E' \\011\\012\\013\\014\\015')
        ),
        CONSTRAINT "ck_worker_badge_history_interval"
          CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
        CONSTRAINT "ex_worker_badge_history_no_overlap" EXCLUDE USING gist (
          "badge_number" WITH =,
          tstzrange(
            "valid_from",
            COALESCE("valid_to", 'infinity'::timestamptz),
            '[)'
          ) WITH &&
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_worker_badge_history_worker_id" ON "worker_badge_history" ("worker_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_worker_badge_history_badge_number" ON "worker_badge_history" ("badge_number")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_worker_badge_history_valid_from" ON "worker_badge_history" ("valid_from")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_worker_badge_history_worker_timeline" ON "worker_badge_history" ("worker_id", "valid_from", "id")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_worker_badge_history_badge_timeline" ON "worker_badge_history" ("badge_number", "valid_from" DESC)',
    );
    await queryRunner.query(`
      CREATE FUNCTION "guard_worker_badge_history_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'worker badge history cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;

        IF OLD."valid_to" IS NOT NULL
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."badge_number" IS DISTINCT FROM OLD."badge_number"
          OR NEW."worker_id" IS DISTINCT FROM OLD."worker_id"
          OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."valid_to" IS NULL
          OR NEW."valid_to" <= OLD."valid_from" THEN
          RAISE EXCEPTION 'badge history is immutable except closing an open interval'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;

        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_worker_badge_history_close_only"
      BEFORE UPDATE OR DELETE ON "worker_badge_history"
      FOR EACH ROW EXECUTE FUNCTION "guard_worker_badge_history_mutation"()
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "workers")
          OR EXISTS (SELECT 1 FROM "worker_badge_history") THEN
          RAISE EXCEPTION 'cannot revert workers and badge history migration while feature rows exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_workers_badges_empty_before_revert';
        END IF;

        IF EXISTS (
          SELECT 1 FROM "audit_log"
          WHERE "entity_key" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ) THEN
          RAISE EXCEPTION 'cannot revert audit entity_key: an identifier is not representable as legacy UUID'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_audit_log_entity_key_reversible';
        END IF;

        IF EXISTS (
          SELECT 1 FROM "audit_log"
          WHERE "entity_id" IS NULL
            OR "entity_id"::text IS DISTINCT FROM "entity_key"
        ) THEN
          RAISE EXCEPTION 'cannot revert audit entity_key: legacy UUID identity is missing or different'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_audit_log_legacy_entity_id_matches';
        END IF;

        IF EXISTS (
          SELECT 1 FROM "audit_log"
          WHERE "entity_type" NOT IN ('model', 'operation')
            OR "action" NOT IN (
              'model.create', 'model.update', 'model.deactivate',
              'operation.create', 'operation.update', 'operation.deactivate',
              'operation.price_change'
            )
        ) THEN
          RAISE EXCEPTION 'cannot revert audit checks while worker or badge audit events exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_audit_log_legacy_values';
        END IF;
      END
      $$
    `);

    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_worker_badge_history_close_only" ON "worker_badge_history"');
    await queryRunner.query('DROP TABLE IF EXISTS "worker_badge_history"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "guard_worker_badge_history_mutation"()');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_workers_no_delete" ON "workers"');
    await queryRunner.query('DROP TABLE IF EXISTS "workers"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "reject_worker_historical_delete"()');

    await queryRunner.query('DROP INDEX IF EXISTS "ix_audit_log_entity_key"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_key_not_empty"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "ck_audit_log_entity_type"
        CHECK ("entity_type" IN ('model', 'operation')),
      ADD CONSTRAINT "ck_audit_log_action" CHECK (
        "action" IN (
          'model.create', 'model.update', 'model.deactivate',
          'operation.create', 'operation.update', 'operation.deactivate',
          'operation.price_change'
        )
      )
    `);
    await queryRunner.query('ALTER TABLE "audit_log" ALTER COLUMN "entity_id" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "audit_log" DROP COLUMN "entity_key"');
  }
}
