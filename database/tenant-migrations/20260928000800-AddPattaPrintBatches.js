export class AddPattaPrintBatches20260928000800 {
  name = 'AddPattaPrintBatches20260928000800';

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "patta_partiya_number_sequence" (
        "id" smallint NOT NULL,
        "next_number" bigint NOT NULL,
        "version" bigint NOT NULL DEFAULT 1,
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_partiya_number_sequence" PRIMARY KEY ("id"),
        CONSTRAINT "ck_patta_partiya_number_sequence_singleton" CHECK ("id" = 1),
        CONSTRAINT "ck_patta_partiya_number_sequence_next_positive" CHECK ("next_number" > 0),
        CONSTRAINT "ck_patta_partiya_number_sequence_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_partiya_number_sequence_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Partiya number sequence cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."next_number" <= OLD."next_number"
          OR NEW."version" <> OLD."version" + 1 THEN
          RAISE EXCEPTION 'Partiya number sequence must advance monotonically'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_partiya_number_sequence_monotonic"
      BEFORE UPDATE OR DELETE ON "patta_partiya_number_sequence"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_partiya_number_sequence_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "patta_partiya_number_blocks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "device_id" uuid NOT NULL,
        "range_start" bigint NOT NULL,
        "range_end" bigint NOT NULL,
        "allocated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "exhausted_at" timestamptz NULL,
        "reported_used_count" bigint NOT NULL DEFAULT 0,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "created_by" uuid NULL,
        CONSTRAINT "pk_patta_partiya_number_blocks" PRIMARY KEY ("id"),
        CONSTRAINT "fk_patta_partiya_number_blocks_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_partiya_number_blocks_range_start_positive" CHECK ("range_start" > 0),
        CONSTRAINT "ck_patta_partiya_number_blocks_range_valid" CHECK (
          "range_end" >= "range_start" AND "range_end" < 9223372036854775807
        ),
        CONSTRAINT "ck_patta_partiya_number_blocks_usage_count" CHECK (
          "reported_used_count" >= 0 AND
          "reported_used_count" <= ("range_end" - "range_start" + 1)
        ),
        CONSTRAINT "ck_patta_partiya_number_blocks_status" CHECK (
          "status" IN ('ACTIVE', 'EXHAUSTED', 'CANCELLED')
        ),
        CONSTRAINT "ck_patta_partiya_number_blocks_exhausted_at" CHECK (
          ("status" = 'EXHAUSTED') = ("exhausted_at" IS NOT NULL)
        ),
        CONSTRAINT "ck_patta_partiya_number_blocks_full_is_exhausted" CHECK (
          ("reported_used_count" = ("range_end" - "range_start" + 1)) =
          ("status" = 'EXHAUSTED')
        ),
        CONSTRAINT "ex_patta_partiya_number_blocks_no_overlap" EXCLUDE USING gist (
          int8range("range_start", "range_end", '[]') WITH &&
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_patta_partiya_number_blocks_device_status" ON "patta_partiya_number_blocks" ("device_id", "status")',
    );
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_partiya_number_block_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE range_capacity bigint;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Partiya number blocks cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."device_id" IS DISTINCT FROM OLD."device_id"
          OR NEW."range_start" IS DISTINCT FROM OLD."range_start"
          OR NEW."range_end" IS DISTINCT FROM OLD."range_end"
          OR NEW."allocated_at" IS DISTINCT FROM OLD."allocated_at"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
          RAISE EXCEPTION 'Partiya number block allocation identity is immutable'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF OLD."status" <> 'ACTIVE' OR NEW."reported_used_count" < OLD."reported_used_count" THEN
          RAISE EXCEPTION 'Partiya number block usage is monotonic and terminal states are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_partiya_number_blocks_usage_monotonic';
        END IF;
        range_capacity := OLD."range_end" - OLD."range_start" + 1;
        IF NEW."reported_used_count" > range_capacity THEN
          RAISE EXCEPTION 'Partiya number block usage exceeds its range capacity'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_partiya_number_blocks_usage_count';
        END IF;
        IF NEW."reported_used_count" = range_capacity AND NEW."status" <> 'EXHAUSTED' THEN
          RAISE EXCEPTION 'A fully reported Partiya number block must be exhausted'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_partiya_number_blocks_exhausted_at';
        END IF;
        IF NEW."status" = 'EXHAUSTED' THEN
          IF NEW."reported_used_count" <> range_capacity OR NEW."exhausted_at" IS NULL THEN
            RAISE EXCEPTION 'A Partiya block can be exhausted only at full reported capacity'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_partiya_number_blocks_exhausted_at';
          END IF;
        ELSIF NEW."status" = 'CANCELLED' THEN
          IF NEW."reported_used_count" <> OLD."reported_used_count" OR NEW."exhausted_at" IS NOT NULL THEN
            RAISE EXCEPTION 'Partiya block cancellation cannot alter reported usage'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_partiya_number_blocks_cancel_state';
          END IF;
        ELSIF NEW."status" <> 'ACTIVE' OR NEW."exhausted_at" IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid Partiya number block state transition'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_partiya_number_blocks_status_transition';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_partiya_number_blocks_guard_mutation"
      BEFORE UPDATE OR DELETE ON "patta_partiya_number_blocks"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_partiya_number_block_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "patta_print_batches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "model_id" uuid NOT NULL,
        "model_name_snapshot" varchar NOT NULL,
        "partiya_number" varchar NOT NULL,
        "partiya_block_id" uuid NULL,
        "ish_soni" integer NOT NULL,
        "rang" varchar NOT NULL,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "version" bigint NOT NULL DEFAULT 1,
        "revision" integer NOT NULL DEFAULT 1,
        "created_by" uuid NULL,
        "created_device_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "printed_at" timestamptz NULL,
        CONSTRAINT "pk_patta_print_batches" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_print_batches_partiya" UNIQUE ("partiya_number"),
        CONSTRAINT "fk_patta_print_batches_model" FOREIGN KEY ("model_id")
          REFERENCES "models" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_print_batches_partiya_block" FOREIGN KEY ("partiya_block_id")
          REFERENCES "patta_partiya_number_blocks" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_print_batches_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_print_batches_model_name" CHECK (
          "model_name_snapshot" <> '' AND "model_name_snapshot" = "canonicalize_business_name"("model_name_snapshot")
        ),
        CONSTRAINT "ck_patta_print_batches_partiya" CHECK (
          "partiya_number" ~ '^[1-9][0-9]*$'
        ),
        CONSTRAINT "ck_patta_print_batches_quantity" CHECK ("ish_soni" > 0),
        CONSTRAINT "ck_patta_print_batches_rang" CHECK (
          "rang" <> '' AND "rang" = "canonicalize_business_name"("rang")
        ),
        CONSTRAINT "ck_patta_print_batches_status" CHECK ("status" IN ('ACTIVE', 'VOID', 'SUPERSEDED')),
        CONSTRAINT "ck_patta_print_batches_version" CHECK ("version" > 0 AND "revision" > 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_print_batches_model_created" ON "patta_print_batches" ("model_id", "created_at" DESC)');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_print_batch_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE'
          AND OLD."printed_at" IS NULL
          AND NEW."printed_at" IS NOT NULL
          AND NEW."id" IS NOT DISTINCT FROM OLD."id"
          AND NEW."model_id" IS NOT DISTINCT FROM OLD."model_id"
          AND NEW."model_name_snapshot" IS NOT DISTINCT FROM OLD."model_name_snapshot"
          AND NEW."partiya_number" IS NOT DISTINCT FROM OLD."partiya_number"
          AND NEW."partiya_block_id" IS NOT DISTINCT FROM OLD."partiya_block_id"
          AND NEW."ish_soni" IS NOT DISTINCT FROM OLD."ish_soni"
          AND NEW."rang" IS NOT DISTINCT FROM OLD."rang"
          AND NEW."status" IS NOT DISTINCT FROM OLD."status"
          AND NEW."version" IS NOT DISTINCT FROM OLD."version"
          AND NEW."revision" IS NOT DISTINCT FROM OLD."revision"
          AND NEW."created_by" IS NOT DISTINCT FROM OLD."created_by"
          AND NEW."created_device_id" IS NOT DISTINCT FROM OLD."created_device_id"
          AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
          AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
          AND EXISTS (
            SELECT 1 FROM "patta_print_events" event
            WHERE event."batch_id" = OLD."id"
              AND event."revision" = OLD."revision"
              AND event."outcome" = 'SUCCEEDED'
          ) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Patta print batch corrections require the versioned correction workflow'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batches_versioned_correction';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_print_batches_versioned_correction"
      BEFORE UPDATE OR DELETE ON "patta_print_batches"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_print_batch_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "patta_print_batch_sizes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "print_batch_id" uuid NOT NULL,
        "razmer" varchar NOT NULL,
        "patta_count" integer NOT NULL,
        "sort_order" integer NOT NULL,
        CONSTRAINT "pk_patta_print_batch_sizes" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_print_batch_sizes_batch_razmer" UNIQUE ("print_batch_id", "razmer"),
        CONSTRAINT "fk_patta_print_batch_sizes_batch" FOREIGN KEY ("print_batch_id")
          REFERENCES "patta_print_batches" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_print_batch_sizes_razmer" CHECK (
          "razmer" <> '' AND "razmer" = "canonicalize_business_name"("razmer")
        ),
        CONSTRAINT "ck_patta_print_batch_sizes_count" CHECK ("patta_count" > 0),
        CONSTRAINT "ck_patta_print_batch_sizes_sort_order" CHECK ("sort_order" >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_print_batch_sizes_order" ON "patta_print_batch_sizes" ("print_batch_id", "sort_order")');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_print_batch_size_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Patta print batch size rows are immutable outside versioned correction'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batch_sizes_immutable';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_print_batch_sizes_immutable"
      BEFORE UPDATE OR DELETE ON "patta_print_batch_sizes"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_print_batch_size_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "patta_print_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "batch_id" uuid NOT NULL,
        "revision" integer NOT NULL,
        "kind" varchar NOT NULL,
        "outcome" varchar NOT NULL,
        "actor_user_id" uuid NULL,
        "device_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_print_events" PRIMARY KEY ("id"),
        CONSTRAINT "fk_patta_print_events_batch" FOREIGN KEY ("batch_id")
          REFERENCES "patta_print_batches" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_print_events_actor" FOREIGN KEY ("actor_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_print_events_revision" CHECK ("revision" > 0),
        CONSTRAINT "ck_patta_print_events_kind" CHECK ("kind" IN ('INITIAL', 'REPRINT', 'CORRECTED_REPRINT')),
        CONSTRAINT "ck_patta_print_events_outcome" CHECK ("outcome" IN ('REQUESTED', 'SUCCEEDED', 'FAILED'))
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_print_events_batch" ON "patta_print_events" ("batch_id", "created_at")');
    await queryRunner.query(`
      CREATE FUNCTION "reject_patta_print_event_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Patta print events are append-only'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_events_append_only';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_print_events_append_only"
      BEFORE UPDATE OR DELETE ON "patta_print_events"
      FOR EACH ROW EXECUTE FUNCTION "reject_patta_print_event_mutation"()
    `);

    await queryRunner.query(`
      ALTER TABLE "patta_hisob"
        ADD COLUMN "print_batch_id" uuid NULL,
        ADD COLUMN "status" varchar NOT NULL DEFAULT 'ACTIVE',
        ADD CONSTRAINT "fk_patta_hisob_print_batch" FOREIGN KEY ("print_batch_id")
          REFERENCES "patta_print_batches" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
        ADD CONSTRAINT "ck_patta_hisob_status" CHECK ("status" IN ('ACTIVE', 'VOID'))
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_hisob_print_batch" ON "patta_hisob" ("print_batch_id")');

    await queryRunner.query(`
      CREATE FUNCTION "validate_patta_print_batch_contents"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target_batch uuid;
        expected_count bigint;
        active_count bigint;
        batch_status varchar;
      BEGIN
        IF TG_TABLE_NAME = 'patta_print_batches' THEN
          target_batch := COALESCE(NEW."id", OLD."id");
        ELSIF TG_TABLE_NAME = 'patta_print_batch_sizes' THEN
          target_batch := COALESCE(NEW."print_batch_id", OLD."print_batch_id");
        ELSE
          target_batch := COALESCE(NEW."print_batch_id", OLD."print_batch_id");
        END IF;
        IF NOT EXISTS (SELECT 1 FROM "patta_print_batches" WHERE "id" = target_batch) THEN
          RETURN NULL;
        END IF;
        SELECT "status" INTO batch_status FROM "patta_print_batches" WHERE "id" = target_batch;
        SELECT COALESCE(sum("patta_count"), 0) INTO expected_count
        FROM "patta_print_batch_sizes" WHERE "print_batch_id" = target_batch;
        SELECT count(*) INTO active_count FROM "patta_hisob"
        WHERE "print_batch_id" = target_batch AND "status" = 'ACTIVE';
        IF (batch_status = 'ACTIVE' AND (expected_count <= 0 OR expected_count <> active_count))
          OR (batch_status <> 'ACTIVE' AND active_count <> 0) THEN
          RAISE EXCEPTION 'Patta print batch size distribution must match active Pattas'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_print_batch_contents_match';
        END IF;
        IF EXISTS (
          SELECT 1 FROM "patta_print_batches" batch
          JOIN "patta_hisob" patta ON patta."print_batch_id" = batch."id"
          WHERE batch."id" = target_batch AND patta."status" = 'ACTIVE'
            AND (patta."model_id" <> batch."model_id"
              OR patta."model_name_snapshot" <> batch."model_name_snapshot"
              OR patta."partiya_number" <> batch."partiya_number"
              OR patta."ish_soni" <> batch."ish_soni"
              OR patta."rang" <> batch."rang")
        ) THEN
          RAISE EXCEPTION 'Active Pattas must match their print batch snapshot'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_print_batch_patta_snapshot';
        END IF;
        RETURN NULL;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_patta_print_batches_contents"
      AFTER INSERT OR UPDATE ON "patta_print_batches" DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "validate_patta_print_batch_contents"()
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_patta_print_batch_sizes_contents"
      AFTER INSERT OR UPDATE OR DELETE ON "patta_print_batch_sizes" DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "validate_patta_print_batch_contents"()
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_patta_print_batch_pattas_contents"
      AFTER INSERT OR UPDATE ON "patta_hisob" DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW."print_batch_id" IS NOT NULL)
      EXECUTE FUNCTION "validate_patta_print_batch_contents"()
    `);

    await queryRunner.query(`
      INSERT INTO "permissions" ("code", "description")
      VALUES ('patta.chiqarish.correct', 'Patta chiqarilgan yozuvlarini tuzatish')
      ON CONFLICT ("code") DO UPDATE SET "description" = EXCLUDED."description"
    `);
    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT role."id", permission."id"
      FROM "roles" AS role CROSS JOIN "permissions" AS permission
      WHERE role."name" = 'Korxona administratori'
        AND permission."code" = 'patta.chiqarish.correct'
      ON CONFLICT ("role_id", "permission_id") DO NOTHING
    `);

    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
        ADD CONSTRAINT "ck_audit_log_entity_type" CHECK ("entity_type" IN (
          'model', 'operation', 'worker', 'badge', 'patta_template', 'patta_number_block',
          'patta', 'patta_partiya_number_block', 'patta_print_batch', 'patta_print_event'
        )),
        ADD CONSTRAINT "ck_audit_log_action" CHECK ("action" IN (
          'model.create', 'model.update', 'model.deactivate',
          'operation.create', 'operation.update', 'operation.deactivate', 'operation.price_change',
          'worker.create', 'worker.update', 'worker.deactivate',
          'badge.assign', 'badge.reassign', 'badge.close', 'badge.release',
          'patta_template.create', 'patta_template.update', 'patta_template.deactivate',
          'patta_number_block.allocate', 'patta_number_block.cancel', 'patta.create',
          'patta_partiya_number_block.allocate', 'patta_partiya_number_block.cancel',
          'patta_print_batch.create', 'patta_print_batch.correct', 'patta_print_batch.void',
          'patta_print_event.record'
        ))
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "patta_print_batches")
          OR EXISTS (SELECT 1 FROM "patta_print_batch_sizes")
          OR EXISTS (SELECT 1 FROM "patta_print_events")
          OR EXISTS (SELECT 1 FROM "patta_partiya_number_blocks")
          OR EXISTS (SELECT 1 FROM "patta_hisob" WHERE "print_batch_id" IS NOT NULL OR "status" <> 'ACTIVE')
          OR EXISTS (SELECT 1 FROM "patta_partiya_number_sequence" WHERE "version" <> 1)
          OR EXISTS (SELECT 1 FROM "audit_log" WHERE "entity_type" IN (
            'patta_partiya_number_block', 'patta_print_batch', 'patta_print_event'
          )) THEN
          RAISE EXCEPTION 'cannot revert Patta print batch schema while business or audit rows exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_patta_print_batches_empty_before_revert';
        END IF;
      END $$
    `);
    await queryRunner.query('DROP TRIGGER "trg_patta_print_events_append_only" ON "patta_print_events"');
    await queryRunner.query('DROP FUNCTION "reject_patta_print_event_mutation"()');
    await queryRunner.query('DROP TABLE "patta_print_events"');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batch_pattas_contents" ON "patta_hisob"');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batch_sizes_contents" ON "patta_print_batch_sizes"');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batches_contents" ON "patta_print_batches"');
    await queryRunner.query('DROP FUNCTION "validate_patta_print_batch_contents"()');
    await queryRunner.query('DROP INDEX IF EXISTS "ix_patta_hisob_print_batch"');
    await queryRunner.query('ALTER TABLE "patta_hisob" DROP CONSTRAINT "ck_patta_hisob_status"');
    await queryRunner.query('ALTER TABLE "patta_hisob" DROP CONSTRAINT "fk_patta_hisob_print_batch"');
    await queryRunner.query('ALTER TABLE "patta_hisob" DROP COLUMN "status", DROP COLUMN "print_batch_id"');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batch_sizes_immutable" ON "patta_print_batch_sizes"');
    await queryRunner.query('DROP FUNCTION "guard_patta_print_batch_size_mutation"()');
    await queryRunner.query('DROP TABLE "patta_print_batch_sizes"');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batches_versioned_correction" ON "patta_print_batches"');
    await queryRunner.query('DROP FUNCTION "guard_patta_print_batch_mutation"()');
    await queryRunner.query('DROP TABLE "patta_print_batches"');
    await queryRunner.query('DROP TRIGGER "trg_patta_partiya_number_blocks_guard_mutation" ON "patta_partiya_number_blocks"');
    await queryRunner.query('DROP FUNCTION "guard_patta_partiya_number_block_mutation"()');
    await queryRunner.query('DROP TABLE "patta_partiya_number_blocks"');
    await queryRunner.query('DROP TRIGGER "trg_patta_partiya_number_sequence_monotonic" ON "patta_partiya_number_sequence"');
    await queryRunner.query('DROP FUNCTION "guard_patta_partiya_number_sequence_mutation"()');
    await queryRunner.query('DROP TABLE "patta_partiya_number_sequence"');

    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
        ADD CONSTRAINT "ck_audit_log_entity_type" CHECK ("entity_type" IN (
          'model', 'operation', 'worker', 'badge', 'patta_template', 'patta_number_block', 'patta'
        )),
        ADD CONSTRAINT "ck_audit_log_action" CHECK ("action" IN (
          'model.create', 'model.update', 'model.deactivate',
          'operation.create', 'operation.update', 'operation.deactivate', 'operation.price_change',
          'worker.create', 'worker.update', 'worker.deactivate',
          'badge.assign', 'badge.reassign', 'badge.close', 'badge.release',
          'patta_template.create', 'patta_template.update', 'patta_template.deactivate',
          'patta_number_block.allocate', 'patta_number_block.cancel', 'patta.create'
        ))
    `);
  }
}
