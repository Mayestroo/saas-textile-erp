export class AddStandalonePattaEntries20260929001200 {
  name = 'AddStandalonePattaEntries20260929001200';

  async up(queryRunner) {
    // This migration backfills immutable snapshots as a schema transformation,
    // not a business mutation. Remove the legacy row guard within the same
    // transaction and install its V3 replacement below.
    await queryRunner.query('DROP TRIGGER "trg_patta_sheets_guard_mutation" ON "patta_sheets"');
    await queryRunner.query(`
      ALTER TABLE "patta_sheets"
        ADD COLUMN "entry_kind" varchar NOT NULL DEFAULT 'PATTA_LINKED',
        ADD COLUMN "model_id" uuid NULL,
        ADD COLUMN "model_name_snapshot" varchar NULL,
        ADD COLUMN "ish_soni" integer NULL,
        ADD COLUMN "partiya_number_snapshot" varchar(256) NULL,
        ADD COLUMN "patta_number_snapshot" varchar(19) NULL,
        ADD COLUMN "rang_snapshot" varchar(120) NULL,
        ADD COLUMN "razmer_snapshot" varchar(48) NULL,
        ADD COLUMN "deleted_by_name_snapshot" varchar(512) NULL
    `);
    await queryRunner.query(`
      UPDATE "patta_sheets" sheet
      SET "model_id" = patta."model_id",
          "model_name_snapshot" = patta."model_name_snapshot",
          "ish_soni" = patta."ish_soni",
          "partiya_number_snapshot" = patta."partiya_number",
          "patta_number_snapshot" = patta."patta_number"::text,
          "rang_snapshot" = patta."rang",
          "razmer_snapshot" = patta."razmer"
      FROM "patta_hisob" patta
      WHERE patta."id" = sheet."patta_hisob_id"
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "patta_sheets"
          WHERE "model_id" IS NULL OR "model_name_snapshot" IS NULL OR "ish_soni" IS NULL) THEN
          RAISE EXCEPTION 'cannot add standalone Patta Entries: existing linked Entry snapshots are incomplete'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_v3_backfill_complete';
        END IF;
      END $$
    `);
    await queryRunner.query('ALTER TABLE "patta_sheets" ALTER COLUMN "patta_hisob_id" DROP NOT NULL');
    await queryRunner.query('ALTER TABLE "patta_sheets" ALTER COLUMN "model_id" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "patta_sheets" ALTER COLUMN "model_name_snapshot" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "patta_sheets" ALTER COLUMN "ish_soni" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "uq_patta_sheets_patta"');
    await queryRunner.query('ALTER TABLE "patta_sheets" ADD CONSTRAINT "fk_patta_sheets_model" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE RESTRICT');
    await queryRunner.query(`
      ALTER TABLE "patta_sheets"
        ADD CONSTRAINT "ck_patta_sheets_entry_kind" CHECK (
          ("entry_kind" = 'PATTA_LINKED' AND "patta_hisob_id" IS NOT NULL) OR
          ("entry_kind" = 'STANDALONE' AND "patta_hisob_id" IS NULL)
        ),
        ADD CONSTRAINT "ck_patta_sheets_model_name" CHECK (
          "model_name_snapshot" <> '' AND
          "model_name_snapshot" = "canonicalize_business_name"("model_name_snapshot")
        ),
        ADD CONSTRAINT "ck_patta_sheets_quantity_positive" CHECK ("ish_soni" > 0),
        ADD CONSTRAINT "ck_patta_sheets_partiya_snapshot" CHECK (
          "partiya_number_snapshot" IS NULL OR (
            "partiya_number_snapshot" <> '' AND
            "partiya_number_snapshot" = "canonicalize_business_name"("partiya_number_snapshot")
          )
        ),
        ADD CONSTRAINT "ck_patta_sheets_patta_number_snapshot" CHECK (
          "patta_number_snapshot" IS NULL OR "patta_number_snapshot" ~ '^[1-9][0-9]*$'
        ),
        ADD CONSTRAINT "ck_patta_sheets_rang_snapshot" CHECK (
          "rang_snapshot" IS NULL OR (
            "rang_snapshot" <> '' AND "rang_snapshot" = "canonicalize_business_name"("rang_snapshot")
          )
        ),
        ADD CONSTRAINT "ck_patta_sheets_razmer_snapshot" CHECK (
          "razmer_snapshot" IS NULL OR (
            "razmer_snapshot" <> '' AND "razmer_snapshot" = "canonicalize_business_name"("razmer_snapshot")
          )
        ),
        ADD CONSTRAINT "ck_patta_sheets_deleted_name_lifecycle" CHECK (
          "deleted_by_name_snapshot" IS NULL OR "deleted_at" IS NOT NULL
        )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_patta_sheets_patta"
      ON "patta_sheets" ("patta_hisob_id") WHERE "patta_hisob_id" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "patta_sheet_operation_snapshots"
        DROP CONSTRAINT "ck_patta_sheet_operation_snapshots_source",
        ADD CONSTRAINT "ck_patta_sheet_operation_snapshots_source" CHECK (
          ("source_type" = 'PATTA' AND "source_patta_operation_snapshot_id" IS NOT NULL) OR
          ("source_type" IN ('MODEL', 'CUSTOM') AND "source_patta_operation_snapshot_id" IS NULL)
        )
    `);

    // Existing triggers remain attached to these function names. Replacing the
    // function bodies updates the write boundary for both old linked rows and
    // new standalone rows in place.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "guard_patta_sheet_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        patta_model_id uuid;
        patta_model_name varchar;
        patta_quantity integer;
        patta_partiya varchar;
        patta_number text;
        patta_rang varchar;
        patta_razmer varchar;
        patta_status varchar;
        expected_delete_name varchar;
        correction_authorized boolean := false;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD."deleted_at" IS NULL THEN
            RAISE EXCEPTION 'Patta Entry must be moved to Korzinka before purge'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_trash_before_purge';
          END IF;
          RETURN OLD;
        END IF;

        IF TG_OP = 'INSERT' THEN
          IF NEW."deleted_at" IS NOT NULL OR NEW."deleted_by" IS NOT NULL
            OR NEW."deleted_by_name_snapshot" IS NOT NULL THEN
            RAISE EXCEPTION 'A Patta Entry must be created outside Korzinka'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_create_active';
          END IF;
          IF NEW."entry_kind" = 'PATTA_LINKED' THEN
            SELECT patta."model_id", patta."model_name_snapshot", patta."ish_soni", patta."partiya_number",
              patta."patta_number"::text, patta."rang", patta."razmer", patta."status"
              INTO patta_model_id, patta_model_name, patta_quantity, patta_partiya,
                patta_number, patta_rang, patta_razmer, patta_status
              FROM "patta_hisob" patta WHERE patta."id" = NEW."patta_hisob_id";
            IF NOT FOUND OR patta_status <> 'ACTIVE' OR patta_quantity IS NULL THEN
              RAISE EXCEPTION 'Linked Patta Entry requires an active Patta with a known quantity'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_linked_patta_available';
            END IF;
            IF NEW."model_id" IS DISTINCT FROM patta_model_id
              OR NEW."model_name_snapshot" IS DISTINCT FROM patta_model_name
              OR NEW."ish_soni" IS DISTINCT FROM patta_quantity
              OR NEW."partiya_number_snapshot" IS DISTINCT FROM patta_partiya
              OR NEW."patta_number_snapshot" IS DISTINCT FROM patta_number
              OR NEW."rang_snapshot" IS DISTINCT FROM patta_rang
              OR NEW."razmer_snapshot" IS DISTINCT FROM patta_razmer THEN
              RAISE EXCEPTION 'Linked Patta Entry must preserve the authoritative Patta identity and quantity'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_linked_snapshot_matches_patta';
            END IF;
          ELSIF NEW."entry_kind" = 'STANDALONE' THEN
            IF NEW."patta_hisob_id" IS NOT NULL THEN
              RAISE EXCEPTION 'Standalone Patta Entry cannot reference a Patta'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_entry_kind';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM "models" WHERE "id" = NEW."model_id") THEN
              RAISE EXCEPTION 'Standalone Patta Entry model does not exist'
                USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_standalone_model';
            END IF;
          ELSE
            RAISE EXCEPTION 'Patta Entry kind is invalid'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_entry_kind';
          END IF;
          RETURN NEW;
        END IF;

        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."patta_hisob_id" IS DISTINCT FROM OLD."patta_hisob_id"
          OR NEW."entry_kind" IS DISTINCT FROM OLD."entry_kind"
          OR NEW."model_id" IS DISTINCT FROM OLD."model_id"
          OR NEW."model_name_snapshot" IS DISTINCT FROM OLD."model_name_snapshot"
          OR NEW."partiya_number_snapshot" IS DISTINCT FROM OLD."partiya_number_snapshot"
          OR NEW."patta_number_snapshot" IS DISTINCT FROM OLD."patta_number_snapshot"
          OR NEW."rang_snapshot" IS DISTINCT FROM OLD."rang_snapshot"
          OR NEW."razmer_snapshot" IS DISTINCT FROM OLD."razmer_snapshot"
          OR NEW."entered_at" IS DISTINCT FROM OLD."entered_at"
          OR NEW."business_date" IS DISTINCT FROM OLD."business_date"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."version" <> OLD."version" + 1
          OR NEW."updated_at" < OLD."updated_at" THEN
          RAISE EXCEPTION 'Patta Entry identity, model, entered_at, and business date are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_immutable_identity';
        END IF;

        IF NEW."ish_soni" IS DISTINCT FROM OLD."ish_soni" THEN
          IF OLD."entry_kind" <> 'PATTA_LINKED' OR OLD."patta_hisob_id" IS NULL THEN
            RAISE EXCEPTION 'Standalone Entry quantity is immutable'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_quantity_immutable';
          END IF;
          SELECT EXISTS (
            SELECT 1 FROM "patta_legacy_quantity_corrections" correction
            WHERE correction."patta_hisob_id" = OLD."patta_hisob_id"
              AND correction."ish_soni" = NEW."ish_soni"
          ) OR EXISTS (
            SELECT 1 FROM "patta_print_batch_corrections" correction
            JOIN "patta_hisob" patta ON patta."print_batch_id" = correction."batch_id"
            JOIN "patta_print_batches" batch ON batch."id" = correction."batch_id"
            WHERE patta."id" = OLD."patta_hisob_id"
              AND correction."to_revision" = batch."revision"
              AND correction."after_json" ->> 'ish_soni' = NEW."ish_soni"::text
          ) INTO correction_authorized;
          IF NOT correction_authorized OR NOT EXISTS (
            SELECT 1 FROM "patta_hisob" patta
            WHERE patta."id" = OLD."patta_hisob_id" AND patta."ish_soni" = NEW."ish_soni"
          ) THEN
            RAISE EXCEPTION 'Linked Patta Entry quantity can change only with its authorized Patta correction'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_quantity_correction_only';
          END IF;
        END IF;

        IF OLD."deleted_at" IS NOT DISTINCT FROM NEW."deleted_at" THEN
          IF NEW."deleted_by" IS DISTINCT FROM OLD."deleted_by"
            OR NEW."deleted_by_name_snapshot" IS DISTINCT FROM OLD."deleted_by_name_snapshot" THEN
            RAISE EXCEPTION 'Patta Entry trash actor can change only during trash or restore'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheets_deleted_actor_lifecycle';
          END IF;
        ELSIF NEW."deleted_at" IS NULL THEN
          IF NEW."deleted_by" IS NOT NULL OR NEW."deleted_by_name_snapshot" IS NOT NULL THEN
            RAISE EXCEPTION 'Restored Patta Entry must clear trash actor snapshots'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_deleted_name_lifecycle';
          END IF;
        ELSE
          SELECT "full_name" INTO expected_delete_name FROM "users" WHERE "id" = NEW."deleted_by";
          IF expected_delete_name IS NULL OR NEW."deleted_by_name_snapshot" IS DISTINCT FROM expected_delete_name THEN
            RAISE EXCEPTION 'Patta Entry trash actor name must match the authorized user'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheets_deleted_actor_snapshot';
          END IF;
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_sheets_guard_mutation"
      BEFORE INSERT OR UPDATE OR DELETE ON "patta_sheets"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_sheet_mutation"()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "guard_patta_sheet_operation_snapshot_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        parent_deleted_at timestamptz;
        entry_kind varchar;
        parent_model_id uuid;
        parent_patta_id uuid;
        operation_model_id uuid;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'Patta Entry operation snapshots are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_patta_sheet_operation_snapshots_immutable';
        END IF;
        SELECT sheet."deleted_at", sheet."entry_kind", sheet."model_id", sheet."patta_hisob_id"
          INTO parent_deleted_at, entry_kind, parent_model_id, parent_patta_id
          FROM "patta_sheets" sheet
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
        IF operation_model_id IS DISTINCT FROM parent_model_id THEN
          RAISE EXCEPTION 'Patta Entry operation must belong to its model'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_operation_model';
        END IF;
        IF NEW."source_type" = 'PATTA' THEN
          IF entry_kind <> 'PATTA_LINKED' OR parent_patta_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM "patta_operation_snapshots" source
            WHERE source."id" = NEW."source_patta_operation_snapshot_id"
              AND source."patta_hisob_id" = parent_patta_id
              AND source."operation_id" = NEW."model_operation_id"
              AND source."operation_name_snapshot" = NEW."operation_name_snapshot"
              AND source."unit_price_snapshot" = NEW."unit_price_snapshot"
              AND source."sort_order" = NEW."sort_order"
          ) THEN
            RAISE EXCEPTION 'Patta Entry PATTA snapshot must preserve its linked Patta operation history'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_source_snapshot_matches';
          END IF;
        ELSIF NEW."source_type" = 'MODEL' THEN
          IF entry_kind <> 'STANDALONE' OR NEW."source_patta_operation_snapshot_id" IS NOT NULL THEN
            RAISE EXCEPTION 'MODEL operation snapshots are valid only for standalone entries'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_operation_source_kind';
          END IF;
        ELSIF NEW."source_type" = 'CUSTOM' THEN
          IF NEW."source_patta_operation_snapshot_id" IS NOT NULL THEN
            RAISE EXCEPTION 'CUSTOM operation snapshots cannot reference a Patta operation'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_operation_source_kind';
          END IF;
        ELSE
          RAISE EXCEPTION 'Patta Entry operation source is invalid'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_operation_source_kind';
        END IF;
        RETURN NEW;
      END
      $$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "guard_patta_sheet_row_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        parent_deleted_at timestamptz;
        parent_patta_id uuid;
        entry_kind varchar;
        entry_quantity integer;
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
        SELECT sheet."deleted_at", sheet."patta_hisob_id", sheet."entry_kind", sheet."ish_soni", patta."ish_soni"
          INTO parent_deleted_at, parent_patta_id, entry_kind, entry_quantity, patta_quantity
          FROM "patta_sheets" sheet
          LEFT JOIN "patta_hisob" patta ON patta."id" = sheet."patta_hisob_id"
          WHERE sheet."id" = NEW."patta_sheet_id";
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Patta Entry row parent was not found'
            USING ERRCODE = '23503', CONSTRAINT = 'fk_patta_sheet_rows_sheet';
        END IF;
        IF parent_deleted_at IS NOT NULL THEN
          IF TG_OP = 'UPDATE' AND entry_kind = 'PATTA_LINKED' AND parent_patta_id IS NOT NULL
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
        IF entry_quantity IS NULL OR NEW."quantity_snapshot" <> entry_quantity THEN
          RAISE EXCEPTION 'Patta Entry row quantity must match its Entry quantity'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_row_quantity_matches_entry';
        END IF;
        IF entry_kind = 'PATTA_LINKED' AND (patta_quantity IS NULL OR entry_quantity <> patta_quantity) THEN
          RAISE EXCEPTION 'Linked Patta Entry quantity must match its Patta product quantity'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_patta_sheet_quantity_matches_patta';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "bootstrap_sessions"
        DROP CONSTRAINT "ck_bootstrap_sessions_protocol_version",
        ADD CONSTRAINT "ck_bootstrap_sessions_protocol_version" CHECK ("protocol_version" IN (1, 2, 3))
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "patta_sheets" WHERE "entry_kind" = 'STANDALONE')
          OR EXISTS (SELECT 1 FROM "patta_sheets" WHERE "deleted_by_name_snapshot" IS NOT NULL)
          OR EXISTS (SELECT 1 FROM "bootstrap_sessions" WHERE "protocol_version" = 3)
          OR EXISTS (SELECT 1 FROM "server_change_log" WHERE "projection_version" = 3) THEN
          RAISE EXCEPTION 'cannot revert Standalone Patta Entry schema while V3 data or sessions exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_standalone_patta_entries_empty_before_revert';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "guard_patta_sheet_mutation"()
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
    await queryRunner.query('DROP TRIGGER "trg_patta_sheets_guard_mutation" ON "patta_sheets"');
    await queryRunner.query(`
      CREATE TRIGGER "trg_patta_sheets_guard_mutation"
      BEFORE UPDATE OR DELETE ON "patta_sheets"
      FOR EACH ROW EXECUTE FUNCTION "guard_patta_sheet_mutation"()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "guard_patta_sheet_operation_snapshot_mutation"()
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
      CREATE OR REPLACE FUNCTION "guard_patta_sheet_row_mutation"()
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
      ALTER TABLE "bootstrap_sessions"
        DROP CONSTRAINT "ck_bootstrap_sessions_protocol_version",
        ADD CONSTRAINT "ck_bootstrap_sessions_protocol_version" CHECK ("protocol_version" IN (1, 2))
    `);
    await queryRunner.query(`
      ALTER TABLE "patta_sheet_operation_snapshots"
        DROP CONSTRAINT "ck_patta_sheet_operation_snapshots_source",
        ADD CONSTRAINT "ck_patta_sheet_operation_snapshots_source" CHECK (
          ("source_type" = 'PATTA' AND "source_patta_operation_snapshot_id" IS NOT NULL) OR
          ("source_type" = 'CUSTOM' AND "source_patta_operation_snapshot_id" IS NULL)
        )
    `);
    await queryRunner.query('DROP INDEX "uq_patta_sheets_patta"');
    await queryRunner.query('ALTER TABLE "patta_sheets" ADD CONSTRAINT "uq_patta_sheets_patta" UNIQUE ("patta_hisob_id")');
    await queryRunner.query('ALTER TABLE "patta_sheets" ALTER COLUMN "patta_hisob_id" SET NOT NULL');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_deleted_name_lifecycle"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_razmer_snapshot"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_rang_snapshot"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_patta_number_snapshot"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_partiya_snapshot"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_quantity_positive"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_model_name"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "ck_patta_sheets_entry_kind"');
    await queryRunner.query('ALTER TABLE "patta_sheets" DROP CONSTRAINT "fk_patta_sheets_model"');
    await queryRunner.query(`
      ALTER TABLE "patta_sheets"
        DROP COLUMN "deleted_by_name_snapshot",
        DROP COLUMN "razmer_snapshot",
        DROP COLUMN "rang_snapshot",
        DROP COLUMN "patta_number_snapshot",
        DROP COLUMN "partiya_number_snapshot",
        DROP COLUMN "ish_soni",
        DROP COLUMN "model_name_snapshot",
        DROP COLUMN "model_id",
        DROP COLUMN "entry_kind"
    `);
  }
}
