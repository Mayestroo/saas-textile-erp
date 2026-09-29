export class AddPattaSheets20260928001100 {
  name = 'AddPattaSheets20260928001100';

  async up(queryRunner) {
    await queryRunner.query('ALTER TABLE "audit_log" ADD COLUMN "device_id" uuid NULL');
    await queryRunner.query(`
      CREATE TABLE "patta_sheets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "patta_hisob_id" uuid NOT NULL,
        "entered_at" timestamptz NOT NULL,
        "business_date" date NOT NULL,
        "conveyor_snapshot" varchar NULL,
        "version" bigint NOT NULL DEFAULT 1,
        "created_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "deleted_at" timestamptz NULL,
        "deleted_by" uuid NULL,
        CONSTRAINT "pk_patta_sheets" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_sheets_patta" UNIQUE ("patta_hisob_id"),
        CONSTRAINT "fk_patta_sheets_patta" FOREIGN KEY ("patta_hisob_id")
          REFERENCES "patta_hisob" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheets_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheets_deleted_by" FOREIGN KEY ("deleted_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_sheets_version_positive" CHECK ("version" > 0),
        CONSTRAINT "ck_patta_sheets_conveyor_canonical" CHECK (
          "conveyor_snapshot" IS NULL OR (
            "conveyor_snapshot" <> '' AND
            "conveyor_snapshot" = "canonicalize_business_name"("conveyor_snapshot")
          )
        ),
        CONSTRAINT "ck_patta_sheets_deleted_pair" CHECK (
          ("deleted_at" IS NULL) = ("deleted_by" IS NULL)
        )
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_sheets_patta" ON "patta_sheets" ("patta_hisob_id")');
    await queryRunner.query('CREATE INDEX "ix_patta_sheets_live_entered" ON "patta_sheets" ("entered_at", "id") WHERE "deleted_at" IS NULL');
    await queryRunner.query('CREATE INDEX "ix_patta_sheets_trash" ON "patta_sheets" ("deleted_at" DESC, "id") WHERE "deleted_at" IS NOT NULL');

    await queryRunner.query(`
      CREATE TABLE "patta_sheet_operation_snapshots" (
        "id" uuid NOT NULL,
        "patta_sheet_id" uuid NOT NULL,
        "model_operation_id" uuid NOT NULL,
        "source_type" varchar NOT NULL,
        "source_patta_operation_snapshot_id" uuid NULL,
        "operation_name_snapshot" varchar NOT NULL,
        "unit_price_snapshot" numeric(14,2) NOT NULL,
        "sort_order" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_sheet_operation_snapshots" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patta_sheet_operation_snapshots_operation" UNIQUE ("patta_sheet_id", "model_operation_id"),
        CONSTRAINT "fk_patta_sheet_operation_snapshots_sheet" FOREIGN KEY ("patta_sheet_id")
          REFERENCES "patta_sheets" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheet_operation_snapshots_operation" FOREIGN KEY ("model_operation_id")
          REFERENCES "model_operations" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheet_operation_snapshots_source" FOREIGN KEY ("source_patta_operation_snapshot_id")
          REFERENCES "patta_operation_snapshots" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_sheet_operation_snapshots_source" CHECK (
          ("source_type" = 'PATTA' AND "source_patta_operation_snapshot_id" IS NOT NULL) OR
          ("source_type" = 'CUSTOM' AND "source_patta_operation_snapshot_id" IS NULL)
        ),
        CONSTRAINT "ck_patta_sheet_operation_snapshots_name" CHECK (
          "operation_name_snapshot" <> '' AND
          "operation_name_snapshot" = "canonicalize_business_name"("operation_name_snapshot")
        ),
        CONSTRAINT "ck_patta_sheet_operation_snapshots_price" CHECK ("unit_price_snapshot" >= 0),
        CONSTRAINT "ck_patta_sheet_operation_snapshots_order" CHECK ("sort_order" >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_sheet_operation_snapshots_sheet_order" ON "patta_sheet_operation_snapshots" ("patta_sheet_id", "sort_order", "model_operation_id")');

    await queryRunner.query(`
      CREATE TABLE "patta_sheet_rows" (
        "id" uuid NOT NULL,
        "patta_sheet_id" uuid NOT NULL,
        "patta_sheet_operation_snapshot_id" uuid NOT NULL,
        "worker_id" bigint NOT NULL,
        "quantity_snapshot" integer NOT NULL,
        "nuqson" boolean NOT NULL DEFAULT false,
        "deleted_at" timestamptz NULL,
        "deleted_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_patta_sheet_rows" PRIMARY KEY ("id"),
        CONSTRAINT "fk_patta_sheet_rows_sheet" FOREIGN KEY ("patta_sheet_id")
          REFERENCES "patta_sheets" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheet_rows_operation_snapshot" FOREIGN KEY ("patta_sheet_operation_snapshot_id")
          REFERENCES "patta_sheet_operation_snapshots" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheet_rows_worker" FOREIGN KEY ("worker_id")
          REFERENCES "workers" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_patta_sheet_rows_deleted_by" FOREIGN KEY ("deleted_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_patta_sheet_rows_quantity" CHECK ("quantity_snapshot" > 0),
        CONSTRAINT "ck_patta_sheet_rows_deleted_pair" CHECK (
          ("deleted_at" IS NULL) = ("deleted_by" IS NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_patta_sheet_rows_active_operation"
      ON "patta_sheet_rows" ("patta_sheet_id", "patta_sheet_operation_snapshot_id")
      WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query('CREATE INDEX "ix_patta_sheet_rows_worker" ON "patta_sheet_rows" ("worker_id", "patta_sheet_id")');
    await queryRunner.query('CREATE INDEX "ix_patta_sheet_rows_trash" ON "patta_sheet_rows" ("patta_sheet_id", "deleted_at") WHERE "deleted_at" IS NOT NULL');

    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_sheet_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD."deleted_at" IS NULL THEN
            RAISE EXCEPTION 'Patta Entry must be moved to Korzinka before purge'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_trash_before_purge';
          END IF;
          RETURN OLD;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."patta_hisob_id" IS DISTINCT FROM OLD."patta_hisob_id"
          OR NEW."entered_at" IS DISTINCT FROM OLD."entered_at"
          OR NEW."business_date" IS DISTINCT FROM OLD."business_date"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."version" <> OLD."version" + 1
          OR NEW."updated_at" < OLD."updated_at" THEN
          RAISE EXCEPTION 'Patta Entry identity, entered_at, and business date are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_immutable_identity';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_sheets_guard_mutation"
      BEFORE UPDATE OR DELETE ON "patta_sheets"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_sheet_mutation"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_sheet_operation_snapshot_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        parent_deleted_at timestamptz;
        patta_model_id uuid;
        operation_model_id uuid;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'Patta Entry operation snapshots are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_operation_snapshots_immutable';
        END IF;
        SELECT sheet."deleted_at", patta."model_id"
          INTO parent_deleted_at, patta_model_id
          FROM "patta_sheets" sheet
          JOIN "patta_hisob" patta ON patta."id" = sheet."patta_hisob_id"
          WHERE sheet."id" = CASE WHEN TG_OP = 'INSERT' THEN NEW."patta_sheet_id" ELSE OLD."patta_sheet_id" END;
        IF TG_OP = 'DELETE' THEN
          IF parent_deleted_at IS NULL THEN
            RAISE EXCEPTION 'Patta Entry operation snapshot can be purged only from Korzinka'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_children_purge_only';
          END IF;
          RETURN OLD;
        END IF;
        IF parent_deleted_at IS NOT NULL THEN
          RAISE EXCEPTION 'Cannot add an operation to a trashed Patta Entry'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_snapshot_parent_active';
        END IF;
        SELECT "model_id" INTO operation_model_id FROM "model_operations"
          WHERE "id" = NEW."model_operation_id";
        IF operation_model_id IS DISTINCT FROM patta_model_id THEN
          RAISE EXCEPTION 'Patta Entry operation must belong to its Patta model'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_operation_model';
        END IF;
        IF NEW."source_type" = 'PATTA' AND NOT EXISTS (
          SELECT 1 FROM "patta_operation_snapshots" source
          WHERE source."id" = NEW."source_patta_operation_snapshot_id"
            AND source."patta_hisob_id" = (
              SELECT "patta_hisob_id" FROM "patta_sheets" WHERE "id" = NEW."patta_sheet_id"
            )
            AND source."operation_id" = NEW."model_operation_id"
            AND source."operation_name_snapshot" = NEW."operation_name_snapshot"
            AND source."unit_price_snapshot" = NEW."unit_price_snapshot"
        ) THEN
          RAISE EXCEPTION 'Patta Entry snapshot must preserve its original Patta operation history'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_source_snapshot_matches';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_sheet_operation_snapshots_guard"
      BEFORE INSERT OR UPDATE OR DELETE ON "patta_sheet_operation_snapshots"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_sheet_operation_snapshot_mutation"()
    `);

    await queryRunner.query(`
      CREATE FUNCTION "guard_patta_sheet_row_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          parent_deleted_at timestamptz;
          parent_patta_id uuid;
          patta_quantity integer;
          correction_authorized boolean := false;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          SELECT "deleted_at" INTO parent_deleted_at FROM "patta_sheets"
            WHERE "id" = OLD."patta_sheet_id";
          IF parent_deleted_at IS NULL THEN
            RAISE EXCEPTION 'Patta Entry rows can be physically deleted only during Korzinka purge'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_children_purge_only';
          END IF;
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND (
          NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."patta_sheet_id" IS DISTINCT FROM OLD."patta_sheet_id"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        ) THEN
          RAISE EXCEPTION 'Patta Entry row identity is immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_rows_immutable_identity';
        END IF;
        SELECT sheet."deleted_at", sheet."patta_hisob_id", patta."ish_soni"
          INTO parent_deleted_at, parent_patta_id, patta_quantity
          FROM "patta_sheets" sheet
          JOIN "patta_hisob" patta ON patta."id" = sheet."patta_hisob_id"
          WHERE sheet."id" = NEW."patta_sheet_id";
        IF parent_deleted_at IS NOT NULL THEN
          IF TG_OP = 'UPDATE'
            AND OLD."deleted_at" IS NULL AND NEW."deleted_at" IS NULL
            AND NEW."id" IS NOT DISTINCT FROM OLD."id"
            AND NEW."patta_sheet_id" IS NOT DISTINCT FROM OLD."patta_sheet_id"
            AND NEW."patta_sheet_operation_snapshot_id" IS NOT DISTINCT FROM OLD."patta_sheet_operation_snapshot_id"
            AND NEW."worker_id" IS NOT DISTINCT FROM OLD."worker_id"
            AND NEW."nuqson" IS NOT DISTINCT FROM OLD."nuqson"
            AND NEW."deleted_by" IS NOT DISTINCT FROM OLD."deleted_by"
            AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
            AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
            AND NEW."quantity_snapshot" = patta_quantity THEN
            SELECT EXISTS (
              SELECT 1 FROM "patta_legacy_quantity_corrections" correction
              WHERE correction."patta_hisob_id" = parent_patta_id
                AND correction."ish_soni" = patta_quantity
            ) OR EXISTS (
              SELECT 1 FROM "patta_print_batch_corrections" correction
              JOIN "patta_hisob" patta ON patta."print_batch_id" = correction."batch_id"
              JOIN "patta_print_batches" batch ON batch."id" = correction."batch_id"
              WHERE patta."id" = parent_patta_id
                AND correction."to_revision" = batch."revision"
                AND correction."after_json" ->> 'ish_soni' = patta_quantity::text
            ) INTO correction_authorized;
            IF correction_authorized THEN RETURN NEW; END IF;
          END IF;
          RAISE EXCEPTION 'Cannot write rows to a trashed Patta Entry'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_rows_parent_active';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM "patta_sheet_operation_snapshots" snapshot
          WHERE snapshot."id" = NEW."patta_sheet_operation_snapshot_id"
            AND snapshot."patta_sheet_id" = NEW."patta_sheet_id"
        ) THEN
          RAISE EXCEPTION 'Patta Entry row must reference an operation snapshot from the same Entry'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_row_snapshot_parent';
        END IF;
        IF patta_quantity IS NULL OR NEW."quantity_snapshot" <> patta_quantity THEN
          RAISE EXCEPTION 'Patta Entry row quantity must match its Patta product quantity'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_row_quantity_matches_patta';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_sheet_rows_guard_mutation"
      BEFORE INSERT OR UPDATE OR DELETE ON "patta_sheet_rows"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_sheet_row_mutation"()
    `);

    await queryRunner.query(`
      INSERT INTO "permissions" ("code", "description") VALUES
        ('patta_varaq.delete', 'Patta varag‘ini Korzinkaga yuborish'),
        ('patta_varaq.restore', 'Patta varag‘ini qayta tiklash'),
        ('patta_varaq.purge', 'Patta varag‘ini butunlay o‘chirish'),
        ('patta_varaq.custom_operation', 'Patta varag‘i uchun model operatsiyasi yaratish')
      ON CONFLICT ("code") DO UPDATE SET "description" = EXCLUDED."description"
    `);
    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT role."id", permission."id"
      FROM "roles" role CROSS JOIN "permissions" permission
      WHERE role."name" = 'Korxona administratori'
        AND permission."code" IN (
          'patta_varaq.delete', 'patta_varaq.restore', 'patta_varaq.purge', 'patta_varaq.custom_operation'
        )
      ON CONFLICT ("role_id", "permission_id") DO NOTHING
    `);

    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
        ADD CONSTRAINT "ck_audit_log_entity_type" CHECK ("entity_type" IN (
          'model', 'operation', 'worker', 'badge', 'patta_template', 'patta_number_block',
          'patta', 'patta_partiya_number_block', 'patta_print_batch', 'patta_print_event', 'patta_sheet'
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
          'patta_print_event.record', 'patta.quantity_correct',
          'patta_sheet.create', 'patta_sheet.update', 'patta_sheet.trash',
          'patta_sheet.restore', 'patta_sheet.purge', 'patta_sheet.row_delete',
          'patta_sheet.row_restore', 'patta_sheet.custom_operation.create'
        ))
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "patta_sheets")
          OR EXISTS (SELECT 1 FROM "patta_sheet_operation_snapshots")
          OR EXISTS (SELECT 1 FROM "patta_sheet_rows")
          OR EXISTS (SELECT 1 FROM "audit_log" WHERE "entity_type" = 'patta_sheet')
          OR EXISTS (SELECT 1 FROM "audit_log" WHERE "device_id" IS NOT NULL) THEN
          RAISE EXCEPTION 'cannot revert Patta Sheet schema while Entry or audit history exists'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_patta_sheets_empty_before_revert';
        END IF;
      END $$
    `);
    await queryRunner.query('DROP TRIGGER "trg_patta_sheet_rows_guard_mutation" ON "patta_sheet_rows"');
    await queryRunner.query('DROP FUNCTION "guard_patta_sheet_row_mutation"()');
    await queryRunner.query('DROP TRIGGER "trg_patta_sheet_operation_snapshots_guard" ON "patta_sheet_operation_snapshots"');
    await queryRunner.query('DROP FUNCTION "guard_patta_sheet_operation_snapshot_mutation"()');
    await queryRunner.query('DROP TRIGGER "trg_patta_sheets_guard_mutation" ON "patta_sheets"');
    await queryRunner.query('DROP FUNCTION "guard_patta_sheet_mutation"()');
    await queryRunner.query('DROP TABLE "patta_sheet_rows"');
    await queryRunner.query('DROP TABLE "patta_sheet_operation_snapshots"');
    await queryRunner.query('DROP TABLE "patta_sheets"');
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
          'patta_print_event.record', 'patta.quantity_correct'
      ))
    `);
    await queryRunner.query(`
      DELETE FROM "role_permissions" assignment USING "permissions" permission
      WHERE assignment."permission_id" = permission."id"
        AND permission."code" IN (
          'patta_varaq.delete', 'patta_varaq.restore', 'patta_varaq.purge', 'patta_varaq.custom_operation'
        )
    `);
    await queryRunner.query(`
      DELETE FROM "permissions" WHERE "code" IN (
        'patta_varaq.delete', 'patta_varaq.restore', 'patta_varaq.purge', 'patta_varaq.custom_operation'
      )
    `);
    await queryRunner.query('ALTER TABLE "audit_log" DROP COLUMN "device_id"');
  }
}
