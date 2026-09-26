export class AddPattaFoundation20260926000500 {
  name = 'AddPattaFoundation20260926000500';

  async up(queryRunner) {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "btree_gist"');

    await queryRunner.query(`
      CREATE TABLE "patta_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "name_normalized" text GENERATED ALWAYS AS (
          lower("canonicalize_business_name"("name"))
        ) STORED,
        "model_id" uuid NOT NULL,
        "konveyer" varchar NOT NULL,
        "razmer" varchar NULL,
        "rang" varchar NULL,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "version" bigint NOT NULL DEFAULT 1,
        "created_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_templates" PRIMARY KEY ("id"),
        CONSTRAINT "fk_patta_templates_model_id" FOREIGN KEY ("model_id")
          REFERENCES "models" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_patta_templates_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_patta_templates_name_canonical" CHECK (
          "name" <> '' AND "name" = "canonicalize_business_name"("name")
        ),
        CONSTRAINT "ck_patta_templates_konveyer_canonical" CHECK (
          "konveyer" <> '' AND "konveyer" = "canonicalize_business_name"("konveyer")
        ),
        CONSTRAINT "ck_patta_templates_razmer_canonical" CHECK (
          "razmer" IS NULL OR (
            "razmer" <> '' AND "razmer" = "canonicalize_business_name"("razmer")
          )
        ),
        CONSTRAINT "ck_patta_templates_rang_canonical" CHECK (
          "rang" IS NULL OR (
            "rang" <> '' AND "rang" = "canonicalize_business_name"("rang")
          )
        ),
        CONSTRAINT "ck_patta_templates_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT "ck_patta_templates_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_patta_templates_active_name"
       ON "patta_templates" ("name_normalized") WHERE "status" = 'ACTIVE'`,
    );
    await queryRunner.query(
      'CREATE INDEX "ix_patta_templates_model_status" ON "patta_templates" ("model_id", "status")',
    );

    await queryRunner.query(`
      CREATE TABLE "patta_number_sequence" (
        "id" smallint NOT NULL,
        "next_number" bigint NOT NULL,
        "version" bigint NOT NULL DEFAULT 1,
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_number_sequence" PRIMARY KEY ("id"),
        CONSTRAINT "ck_patta_number_sequence_singleton" CHECK ("id" = 1),
        CONSTRAINT "ck_patta_number_sequence_next_positive" CHECK ("next_number" > 0),
        CONSTRAINT "ck_patta_number_sequence_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_number_sequence_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Patta number sequence cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."next_number" <= OLD."next_number"
          OR NEW."version" <> OLD."version" + 1 THEN
          RAISE EXCEPTION 'Patta number sequence must advance monotonically'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_number_sequence_monotonic"
      BEFORE UPDATE OR DELETE ON "patta_number_sequence"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_number_sequence_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "patta_number_blocks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "device_id" uuid NOT NULL,
        "range_start" bigint NOT NULL,
        "range_end" bigint NOT NULL,
        "allocated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "exhausted_at" timestamptz NULL,
        "reported_used_count" bigint NOT NULL DEFAULT 0,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "created_by" uuid NULL,
        CONSTRAINT "pk_patta_number_blocks" PRIMARY KEY ("id"),
        CONSTRAINT "fk_patta_number_blocks_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_patta_number_blocks_range_start_positive" CHECK ("range_start" > 0),
        CONSTRAINT "ck_patta_number_blocks_range_valid" CHECK (
          "range_end" >= "range_start" AND "range_end" < 9223372036854775807
        ),
        CONSTRAINT "ck_patta_number_blocks_usage_count" CHECK (
          "reported_used_count" >= 0 AND
          "reported_used_count" <= ("range_end" - "range_start" + 1)
        ),
        CONSTRAINT "ck_patta_number_blocks_status" CHECK (
          "status" IN ('ACTIVE', 'EXHAUSTED', 'CANCELLED')
        ),
        CONSTRAINT "ck_patta_number_blocks_exhausted_at" CHECK (
          ("status" = 'EXHAUSTED') = ("exhausted_at" IS NOT NULL)
        ),
        CONSTRAINT "ck_patta_number_blocks_full_is_exhausted" CHECK (
          ("reported_used_count" = ("range_end" - "range_start" + 1)) =
          ("status" = 'EXHAUSTED')
        ),
        CONSTRAINT "ex_patta_number_blocks_no_overlap" EXCLUDE USING gist (
          int8range("range_start", "range_end", '[]') WITH &&
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_patta_number_blocks_device_status" ON "patta_number_blocks" ("device_id", "status")',
    );
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_number_block_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        range_capacity bigint;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Patta number blocks cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."device_id" IS DISTINCT FROM OLD."device_id"
          OR NEW."range_start" IS DISTINCT FROM OLD."range_start"
          OR NEW."range_end" IS DISTINCT FROM OLD."range_end"
          OR NEW."allocated_at" IS DISTINCT FROM OLD."allocated_at"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
          RAISE EXCEPTION 'Patta number block allocation identity is immutable'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF OLD."status" <> 'ACTIVE' THEN
          RAISE EXCEPTION 'Exhausted and cancelled Patta number blocks are terminal'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;
        IF NEW."reported_used_count" < OLD."reported_used_count" THEN
          RAISE EXCEPTION 'Patta number block usage reports cannot decrease'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_number_blocks_usage_monotonic';
        END IF;

        range_capacity := OLD."range_end" - OLD."range_start" + 1;
        IF NEW."reported_used_count" > range_capacity THEN
          RAISE EXCEPTION 'Patta number block usage exceeds its range capacity'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_number_blocks_usage_count';
        END IF;
        IF NEW."reported_used_count" = range_capacity AND NEW."status" <> 'EXHAUSTED' THEN
          RAISE EXCEPTION 'A fully reported Patta number block must be exhausted'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_number_blocks_exhausted_at';
        END IF;
        IF NEW."status" = 'EXHAUSTED' THEN
          IF NEW."reported_used_count" <> range_capacity
            OR NEW."exhausted_at" IS NULL THEN
            RAISE EXCEPTION 'A block can be exhausted only at full reported capacity'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_number_blocks_exhausted_at';
          END IF;
        ELSIF NEW."status" = 'CANCELLED' THEN
          IF NEW."reported_used_count" <> OLD."reported_used_count"
            OR NEW."exhausted_at" IS NOT NULL THEN
            RAISE EXCEPTION 'Block cancellation cannot alter reported usage'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_number_blocks_cancel_state';
          END IF;
        ELSIF NEW."status" <> 'ACTIVE' OR NEW."exhausted_at" IS NOT NULL THEN
          RAISE EXCEPTION 'Invalid Patta number block state transition'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_number_blocks_status_transition';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_number_blocks_guard_mutation"
      BEFORE UPDATE OR DELETE ON "patta_number_blocks"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_number_block_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "patta_hisob" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "partiya_number" varchar NOT NULL,
        "patta_number" bigint NOT NULL,
        "model_id" uuid NOT NULL,
        "model_name_snapshot" varchar NOT NULL,
        "template_id" uuid NULL,
        "konveyer_snapshot" varchar NOT NULL,
        "razmer" varchar NULL,
        "rang" varchar NULL,
        "ish_soni" integer NOT NULL,
        "created_device_id" uuid NOT NULL,
        "created_from_block_id" uuid NULL,
        "created_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "version" bigint NOT NULL DEFAULT 1,
        CONSTRAINT "pk_patta_hisob" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_hisob_partiya_patta" UNIQUE ("partiya_number", "patta_number"),
        CONSTRAINT "fk_patta_hisob_model_id" FOREIGN KEY ("model_id")
          REFERENCES "models" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_patta_hisob_template_id" FOREIGN KEY ("template_id")
          REFERENCES "patta_templates" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_patta_hisob_block_id" FOREIGN KEY ("created_from_block_id")
          REFERENCES "patta_number_blocks" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_patta_hisob_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_patta_hisob_partiya_canonical" CHECK (
          "partiya_number" <> '' AND
          "partiya_number" = "canonicalize_business_name"("partiya_number")
        ),
        CONSTRAINT "ck_patta_hisob_patta_number_positive" CHECK ("patta_number" > 0),
        CONSTRAINT "ck_patta_hisob_model_name_snapshot" CHECK (
          "model_name_snapshot" <> '' AND
          "model_name_snapshot" = "canonicalize_business_name"("model_name_snapshot")
        ),
        CONSTRAINT "ck_patta_hisob_konveyer_snapshot" CHECK (
          "konveyer_snapshot" <> '' AND
          "konveyer_snapshot" = "canonicalize_business_name"("konveyer_snapshot")
        ),
        CONSTRAINT "ck_patta_hisob_razmer_canonical" CHECK (
          "razmer" IS NULL OR (
            "razmer" <> '' AND "razmer" = "canonicalize_business_name"("razmer")
          )
        ),
        CONSTRAINT "ck_patta_hisob_rang_canonical" CHECK (
          "rang" IS NULL OR (
            "rang" <> '' AND "rang" = "canonicalize_business_name"("rang")
          )
        ),
        CONSTRAINT "ck_patta_hisob_ish_soni_positive" CHECK ("ish_soni" > 0),
        CONSTRAINT "ck_patta_hisob_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_hisob_model_id" ON "patta_hisob" ("model_id")');
    await queryRunner.query('CREATE INDEX "ix_patta_hisob_created_at" ON "patta_hisob" ("created_at")');
    await queryRunner.query(
      'CREATE INDEX "ix_patta_hisob_list_order" ON "patta_hisob" ("created_at" DESC, "id" DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE "patta_operation_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "patta_hisob_id" uuid NOT NULL,
        "operation_id" uuid NOT NULL,
        "operation_name_snapshot" varchar NOT NULL,
        "unit_price_snapshot" numeric(14,2) NOT NULL,
        "sort_order" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_operation_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_operation_snapshots_patta_operation"
          UNIQUE ("patta_hisob_id", "operation_id"),
        CONSTRAINT "fk_patta_operation_snapshots_patta_id" FOREIGN KEY ("patta_hisob_id")
          REFERENCES "patta_hisob" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT "fk_patta_operation_snapshots_operation_id" FOREIGN KEY ("operation_id")
          REFERENCES "model_operations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_patta_operation_snapshots_name_canonical" CHECK (
          "operation_name_snapshot" <> '' AND
          "operation_name_snapshot" = "canonicalize_business_name"("operation_name_snapshot")
        ),
        CONSTRAINT "ck_patta_operation_snapshots_price_nonnegative"
          CHECK ("unit_price_snapshot" >= 0),
        CONSTRAINT "ck_patta_operation_snapshots_sort_nonnegative" CHECK ("sort_order" >= 0)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_patta_operation_snapshots_operation_id" ON "patta_operation_snapshots" ("operation_id")',
    );

    await queryRunner.query(`
      CREATE FUNCTION "reject_patta_historical_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'Patta historical rows cannot be updated or deleted'
          USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_templates_no_delete"
      BEFORE DELETE ON "patta_templates"
      FOR EACH ROW EXECUTE FUNCTION "reject_patta_historical_mutation"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_hisob_immutable"
      BEFORE UPDATE OR DELETE ON "patta_hisob"
      FOR EACH ROW EXECUTE FUNCTION "reject_patta_historical_mutation"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_operation_snapshots_immutable"
      BEFORE UPDATE OR DELETE ON "patta_operation_snapshots"
      FOR EACH ROW EXECUTE FUNCTION "reject_patta_historical_mutation"()
    `);

    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
      ADD CONSTRAINT "ck_audit_log_entity_type"
        CHECK ("entity_type" IN (
          'model', 'operation', 'worker', 'badge',
          'patta_template', 'patta_number_block', 'patta'
        )),
      ADD CONSTRAINT "ck_audit_log_action" CHECK (
        "action" IN (
          'model.create', 'model.update', 'model.deactivate',
          'operation.create', 'operation.update', 'operation.deactivate',
          'operation.price_change',
          'worker.create', 'worker.update', 'worker.deactivate',
          'badge.assign', 'badge.reassign', 'badge.close', 'badge.release',
          'patta_template.create', 'patta_template.update', 'patta_template.deactivate',
          'patta_number_block.allocate', 'patta_number_block.cancel', 'patta.create'
        )
      )
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "patta_templates")
          OR EXISTS (SELECT 1 FROM "patta_number_blocks")
          OR EXISTS (SELECT 1 FROM "patta_hisob")
          OR EXISTS (SELECT 1 FROM "patta_operation_snapshots")
          OR EXISTS (SELECT 1 FROM "patta_number_sequence" WHERE "version" <> 1)
          OR EXISTS (
            SELECT 1 FROM "audit_log"
            WHERE "entity_type" IN ('patta_template', 'patta_number_block', 'patta')
               OR "action" IN (
                 'patta_template.create', 'patta_template.update', 'patta_template.deactivate',
                 'patta_number_block.allocate', 'patta_number_block.cancel', 'patta.create'
               )
          ) THEN
          RAISE EXCEPTION 'cannot revert Patta foundation while business or audit rows exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_patta_foundation_empty_before_revert';
        END IF;
      END
      $$
    `);

    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_patta_operation_snapshots_immutable" ON "patta_operation_snapshots"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_patta_hisob_immutable" ON "patta_hisob"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_patta_templates_no_delete" ON "patta_templates"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "reject_patta_historical_mutation"()');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_patta_number_blocks_guard_mutation" ON "patta_number_blocks"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "guard_patta_number_block_mutation"()');
    await queryRunner.query('DROP TABLE IF EXISTS "patta_operation_snapshots"');
    await queryRunner.query('DROP TABLE IF EXISTS "patta_hisob"');
    await queryRunner.query('DROP TABLE IF EXISTS "patta_number_blocks"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_patta_number_sequence_monotonic" ON "patta_number_sequence"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "guard_patta_number_sequence_mutation"()');
    await queryRunner.query('DROP TABLE IF EXISTS "patta_number_sequence"');
    await queryRunner.query('DROP INDEX IF EXISTS "ix_patta_templates_model_status"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_patta_templates_active_name"');
    await queryRunner.query('DROP TABLE IF EXISTS "patta_templates"');

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
      )
    `);
  }
}
