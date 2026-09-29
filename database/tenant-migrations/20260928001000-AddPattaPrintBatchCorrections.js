export class AddPattaPrintBatchCorrections20260928001000 {
  name = 'AddPattaPrintBatchCorrections20260928001000';

  async up(queryRunner) {
    await queryRunner.query('ALTER TABLE "patta_print_batches" ADD COLUMN "corrected_from_batch_id" uuid NULL');
    await queryRunner.query(`
      ALTER TABLE "patta_print_batches"
        ADD CONSTRAINT "fk_patta_print_batches_corrected_from" FOREIGN KEY ("corrected_from_batch_id")
          REFERENCES "patta_print_batches" ("id") ON DELETE RESTRICT
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_print_batches_corrected_from" ON "patta_print_batches" ("corrected_from_batch_id") WHERE "corrected_from_batch_id" IS NOT NULL');
    await queryRunner.query(`
      CREATE TABLE "patta_print_batch_corrections" (
        "id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "from_version" bigint NOT NULL,
        "to_version" bigint NOT NULL,
        "from_revision" integer NOT NULL,
        "to_revision" integer NOT NULL,
        "reason" varchar NOT NULL,
        "before_json" jsonb NOT NULL,
        "after_json" jsonb NOT NULL,
        "actor_user_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "event_id" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_print_batch_corrections" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_print_batch_corrections_version" UNIQUE ("batch_id", "to_version"),
        CONSTRAINT "uq_patta_print_batch_corrections_revision" UNIQUE ("batch_id", "to_revision"),
        CONSTRAINT "uq_patta_print_batch_corrections_event" UNIQUE ("event_id"),
        CONSTRAINT "fk_patta_print_batch_corrections_batch" FOREIGN KEY ("batch_id")
          REFERENCES "patta_print_batches" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_print_batch_corrections_actor" FOREIGN KEY ("actor_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_print_batch_corrections_version" CHECK (
          "from_version" > 0 AND "to_version" = "from_version" + 1
        ),
        CONSTRAINT "ck_patta_print_batch_corrections_revision" CHECK (
          "from_revision" > 0 AND "to_revision" = "from_revision" + 1
        ),
        CONSTRAINT "ck_patta_print_batch_corrections_reason" CHECK (
          "reason" <> '' AND "reason" = "canonicalize_business_name"("reason")
        )
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "patta_legacy_quantity_corrections" (
        "id" uuid NOT NULL,
        "patta_hisob_id" uuid NOT NULL,
        "from_version" bigint NOT NULL,
        "to_version" bigint NOT NULL,
        "legacy_operation_count" integer NOT NULL,
        "ish_soni" integer NOT NULL,
        "reason" varchar NOT NULL,
        "actor_user_id" uuid NOT NULL,
        "device_id" uuid NOT NULL,
        "event_id" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_legacy_quantity_corrections" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_legacy_quantity_corrections_patta" UNIQUE ("patta_hisob_id"),
        CONSTRAINT "uq_patta_legacy_quantity_corrections_event" UNIQUE ("event_id"),
        CONSTRAINT "fk_patta_legacy_quantity_corrections_patta" FOREIGN KEY ("patta_hisob_id")
          REFERENCES "patta_hisob" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_legacy_quantity_corrections_actor" FOREIGN KEY ("actor_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_legacy_quantity_corrections_version" CHECK (
          "from_version" > 0 AND "to_version" = "from_version" + 1
        ),
        CONSTRAINT "ck_patta_legacy_quantity_corrections_counts" CHECK (
          "legacy_operation_count" > 0 AND "ish_soni" > 0
        ),
        CONSTRAINT "ck_patta_legacy_quantity_corrections_reason" CHECK (
          "reason" <> '' AND "reason" = "canonicalize_business_name"("reason")
        )
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION "reject_patta_correction_ledger_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Patta correction history is append-only'
          USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_print_batch_corrections_immutable"
      BEFORE UPDATE OR DELETE ON "patta_print_batch_corrections"
      FOR EACH ROW EXECUTE FUNCTION "reject_patta_correction_ledger_mutation"()
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_legacy_quantity_corrections_immutable"
      BEFORE UPDATE OR DELETE ON "patta_legacy_quantity_corrections"
      FOR EACH ROW EXECUTE FUNCTION "reject_patta_correction_ledger_mutation"()
    `);

    await queryRunner.query('DROP TRIGGER "trg_patta_print_batches_versioned_correction" ON "patta_print_batches"');
    await queryRunner.query('DROP FUNCTION "guard_patta_print_batch_mutation"()');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_print_batch_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Patta print batches cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batches_versioned_correction';
        END IF;
        IF OLD."printed_at" IS NULL AND NEW."printed_at" IS NOT NULL
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
            WHERE event."batch_id" = OLD."id" AND event."revision" = OLD."revision"
              AND event."outcome" = 'SUCCEEDED'
          ) THEN
          RETURN NEW;
        END IF;
        IF NEW."id" IS NOT DISTINCT FROM OLD."id"
          AND NEW."model_id" IS NOT DISTINCT FROM OLD."model_id"
          AND NEW."model_name_snapshot" IS NOT DISTINCT FROM OLD."model_name_snapshot"
          AND NEW."partiya_number" IS NOT DISTINCT FROM OLD."partiya_number"
          AND NEW."partiya_block_id" IS NOT DISTINCT FROM OLD."partiya_block_id"
          AND NEW."status" IS NOT DISTINCT FROM OLD."status"
          AND NEW."printed_at" IS NOT DISTINCT FROM OLD."printed_at"
          AND NEW."version" = OLD."version" + 1
          AND NEW."revision" = OLD."revision" + 1
          AND NEW."created_by" IS NOT DISTINCT FROM OLD."created_by"
          AND NEW."created_device_id" IS NOT DISTINCT FROM OLD."created_device_id"
          AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
          AND NEW."updated_at" >= OLD."updated_at"
          AND EXISTS (
            SELECT 1 FROM "patta_print_batch_corrections" correction
            WHERE correction."batch_id" = OLD."id"
              AND correction."from_version" = OLD."version"
              AND correction."to_version" = NEW."version"
              AND correction."from_revision" = OLD."revision"
              AND correction."to_revision" = NEW."revision"
          ) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Patta print batch corrections require a versioned correction ledger row'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batches_versioned_correction';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_print_batches_versioned_correction"
      BEFORE UPDATE OR DELETE ON "patta_print_batches"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_print_batch_mutation"()
    `);

    await queryRunner.query('DROP TRIGGER "trg_patta_print_batch_sizes_immutable" ON "patta_print_batch_sizes"');
    await queryRunner.query('DROP FUNCTION "guard_patta_print_batch_size_mutation"()');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_print_batch_size_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        target_batch uuid;
        current_revision integer;
      BEGIN
        target_batch := CASE WHEN TG_OP = 'INSERT' THEN NEW."print_batch_id" ELSE OLD."print_batch_id" END;
        SELECT "revision" INTO current_revision FROM "patta_print_batches" WHERE "id" = target_batch;
        IF TG_OP = 'INSERT' AND (
          current_revision IS NULL OR (current_revision = 1 AND NOT EXISTS (
            SELECT 1 FROM "patta_hisob" WHERE "print_batch_id" = target_batch
          ))
        ) THEN
          RETURN NEW;
        END IF;
        IF EXISTS (
          SELECT 1 FROM "patta_print_batch_corrections" correction
          WHERE correction."batch_id" = target_batch
            AND (
              (correction."from_revision" = current_revision AND correction."to_revision" = current_revision + 1)
              OR (correction."to_revision" = current_revision AND correction."from_revision" = current_revision - 1)
            )
        ) THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Patta print batch size rows require a versioned correction ledger row'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batch_sizes_immutable';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_print_batch_sizes_immutable"
      BEFORE INSERT OR UPDATE OR DELETE ON "patta_print_batch_sizes"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_print_batch_size_mutation"()
    `);

    await queryRunner.query('DROP TRIGGER "trg_patta_hisob_immutable" ON "patta_hisob"');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_hisob_correction"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Patta history cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_hisob_immutable';
        END IF;
        IF NEW."id" IS NOT DISTINCT FROM OLD."id"
          AND NEW."partiya_number" IS NOT DISTINCT FROM OLD."partiya_number"
          AND NEW."patta_number" IS NOT DISTINCT FROM OLD."patta_number"
          AND NEW."model_id" IS NOT DISTINCT FROM OLD."model_id"
          AND NEW."model_name_snapshot" IS NOT DISTINCT FROM OLD."model_name_snapshot"
          AND NEW."template_id" IS NOT DISTINCT FROM OLD."template_id"
          AND NEW."konveyer_snapshot" IS NOT DISTINCT FROM OLD."konveyer_snapshot"
          AND NEW."created_device_id" IS NOT DISTINCT FROM OLD."created_device_id"
          AND NEW."created_from_block_id" IS NOT DISTINCT FROM OLD."created_from_block_id"
          AND NEW."created_by" IS NOT DISTINCT FROM OLD."created_by"
          AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
          AND NEW."client_created_at" IS NOT DISTINCT FROM OLD."client_created_at"
          AND NEW."occurred_at" IS NOT DISTINCT FROM OLD."occurred_at"
          AND NEW."print_batch_id" IS NOT DISTINCT FROM OLD."print_batch_id"
          AND NEW."version" = OLD."version" + 1
          AND NEW."updated_at" >= OLD."updated_at"
          AND (
            (OLD."print_batch_id" IS NOT NULL AND EXISTS (
              SELECT 1 FROM "patta_print_batch_corrections" correction
              WHERE correction."batch_id" = OLD."print_batch_id"
                AND correction."from_revision" = (
                  SELECT batch."revision" - 1 FROM "patta_print_batches" batch WHERE batch."id" = OLD."print_batch_id"
                )
            )) OR
            (OLD."print_batch_id" IS NULL AND OLD."ish_soni" IS NULL
              AND NEW."ish_soni" IS NOT NULL
              AND NEW."legacy_operation_count" IS NOT DISTINCT FROM OLD."legacy_operation_count"
              AND EXISTS (
                SELECT 1 FROM "patta_legacy_quantity_corrections" correction
                WHERE correction."patta_hisob_id" = OLD."id"
                  AND correction."from_version" = OLD."version"
                  AND correction."to_version" = NEW."version"
                  AND correction."ish_soni" = NEW."ish_soni"
              ))
          ) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Patta rows may change only through a controlled correction ledger'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_hisob_immutable';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_hisob_immutable"
      BEFORE UPDATE OR DELETE ON "patta_hisob"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_hisob_correction"()
    `);

    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log" ADD CONSTRAINT "ck_audit_log_action" CHECK ("action" IN (
        'model.create', 'model.update', 'model.deactivate',
        'operation.create', 'operation.update', 'operation.deactivate', 'operation.price_change',
        'worker.create', 'worker.update', 'worker.deactivate',
        'badge.assign', 'badge.reassign', 'badge.close', 'badge.release',
        'patta_template.create', 'patta_template.update', 'patta_template.deactivate',
        'patta_number_block.allocate', 'patta_number_block.cancel', 'patta.create',
        'patta_partiya_number_block.allocate', 'patta_partiya_number_block.cancel',
        'patta_print_batch.create', 'patta_print_batch.correct', 'patta_print_batch.void',
        'patta_print_event.record', 'patta.quantity_correct'
      ))
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "patta_print_batch_corrections")
          OR EXISTS (SELECT 1 FROM "patta_legacy_quantity_corrections")
          OR EXISTS (SELECT 1 FROM "audit_log" WHERE "action" = 'patta.quantity_correct') THEN
          RAISE EXCEPTION 'cannot revert Patta correction policy while correction history exists'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_patta_correction_policy_empty_before_revert';
        END IF;
      END $$
    `);
    await queryRunner.query('DROP TRIGGER "trg_patta_hisob_immutable" ON "patta_hisob"');
    await queryRunner.query('DROP FUNCTION "guard_patta_hisob_correction"()');
    await queryRunner.query('CREATE TRIGGER "trg_patta_hisob_immutable" BEFORE UPDATE OR DELETE ON "patta_hisob" FOR EACH ROW EXECUTE FUNCTION "reject_patta_historical_mutation"()');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batch_sizes_immutable" ON "patta_print_batch_sizes"');
    await queryRunner.query('DROP FUNCTION "guard_patta_print_batch_size_mutation"()');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_print_batch_size_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Patta print batch size rows are immutable outside versioned correction'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batch_sizes_immutable';
      END $$
    `);
    await queryRunner.query('CREATE TRIGGER "trg_patta_print_batch_sizes_immutable" BEFORE UPDATE OR DELETE ON "patta_print_batch_sizes" FOR EACH ROW EXECUTE FUNCTION "guard_patta_print_batch_size_mutation"()');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batches_versioned_correction" ON "patta_print_batches"');
    await queryRunner.query('DROP FUNCTION "guard_patta_print_batch_mutation"()');
    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_print_batch_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD."printed_at" IS NULL AND NEW."printed_at" IS NOT NULL
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
          AND EXISTS (SELECT 1 FROM "patta_print_events" event WHERE event."batch_id" = OLD."id"
            AND event."revision" = OLD."revision" AND event."outcome" = 'SUCCEEDED') THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Patta print batch corrections require the versioned correction workflow'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_print_batches_versioned_correction';
      END $$
    `);
    await queryRunner.query('CREATE TRIGGER "trg_patta_print_batches_versioned_correction" BEFORE UPDATE OR DELETE ON "patta_print_batches" FOR EACH ROW EXECUTE FUNCTION "guard_patta_print_batch_mutation"()');
    await queryRunner.query('DROP TRIGGER "trg_patta_print_batch_corrections_immutable" ON "patta_print_batch_corrections"');
    await queryRunner.query('DROP TRIGGER "trg_patta_legacy_quantity_corrections_immutable" ON "patta_legacy_quantity_corrections"');
    await queryRunner.query('DROP TABLE "patta_legacy_quantity_corrections"');
    await queryRunner.query('DROP TABLE "patta_print_batch_corrections"');
    await queryRunner.query('DROP FUNCTION "reject_patta_correction_ledger_mutation"()');
    await queryRunner.query('DROP INDEX "ix_patta_print_batches_corrected_from"');
    await queryRunner.query('ALTER TABLE "patta_print_batches" DROP CONSTRAINT "fk_patta_print_batches_corrected_from"');
    await queryRunner.query('ALTER TABLE "patta_print_batches" DROP COLUMN "corrected_from_batch_id"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log" ADD CONSTRAINT "ck_audit_log_action" CHECK ("action" IN (
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
}
