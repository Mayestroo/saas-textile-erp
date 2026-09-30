export class AddModelAccountAdjustments20260929001300 {
  name = 'AddModelAccountAdjustments20260929001300';

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "model_account_adjustments" (
        "id" uuid NOT NULL,
        "model_id" uuid NOT NULL,
        "model_operation_id" uuid NOT NULL,
        "worker_id" bigint NOT NULL,
        "quantity" integer NOT NULL,
        "unit_price_snapshot" numeric(14,2) NOT NULL,
        "entered_at" timestamptz NOT NULL,
        "business_date" date NOT NULL,
        "version" bigint NOT NULL DEFAULT 1,
        "created_by" uuid NOT NULL,
        "created_device_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "updated_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "deleted_at" timestamptz NULL,
        "deleted_by" uuid NULL,
        CONSTRAINT "pk_model_account_adjustments" PRIMARY KEY ("id"),
        CONSTRAINT "fk_model_account_adjustments_model" FOREIGN KEY ("model_id")
          REFERENCES "models" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_model_account_adjustments_operation" FOREIGN KEY ("model_operation_id")
          REFERENCES "model_operations" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_model_account_adjustments_worker" FOREIGN KEY ("worker_id")
          REFERENCES "workers" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_model_account_adjustments_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_model_account_adjustments_deleted_by" FOREIGN KEY ("deleted_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_model_account_adjustments_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "ck_model_account_adjustments_price" CHECK ("unit_price_snapshot" >= 0),
        CONSTRAINT "ck_model_account_adjustments_version" CHECK ("version" > 0),
        CONSTRAINT "ck_model_account_adjustments_deleted_pair" CHECK (
          ("deleted_at" IS NULL) = ("deleted_by" IS NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_model_account_adjustments_model_operation_worker"
      ON "model_account_adjustments" ("model_id", "model_operation_id", "worker_id", "entered_at", "id")
      WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_model_account_adjustments_trash"
      ON "model_account_adjustments" ("model_id", "deleted_at" DESC, "id")
      WHERE "deleted_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE FUNCTION "guard_model_account_adjustment_mutation"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        operation_model_id uuid;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Manual Model hisob contributions are retained as history'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_model_account_adjustments_no_hard_delete';
        END IF;
        IF TG_OP = 'INSERT' THEN
          SELECT "model_id" INTO operation_model_id FROM "model_operations"
            WHERE "id" = NEW."model_operation_id" AND "status" = 'ACTIVE';
          IF NOT FOUND OR operation_model_id IS DISTINCT FROM NEW."model_id" THEN
            RAISE EXCEPTION 'Manual adjustment operation must be active and belong to its model'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_model_account_adjustments_operation_model';
          END IF;
          IF NEW."deleted_at" IS NOT NULL OR NEW."deleted_by" IS NOT NULL THEN
            RAISE EXCEPTION 'Manual adjustment must be created outside Korzinka'
              USING ERRCODE = '23514', CONSTRAINT = 'ck_model_account_adjustments_create_active';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."model_id" IS DISTINCT FROM OLD."model_id"
          OR NEW."model_operation_id" IS DISTINCT FROM OLD."model_operation_id"
          OR NEW."worker_id" IS DISTINCT FROM OLD."worker_id"
          OR NEW."unit_price_snapshot" IS DISTINCT FROM OLD."unit_price_snapshot"
          OR NEW."entered_at" IS DISTINCT FROM OLD."entered_at"
          OR NEW."business_date" IS DISTINCT FROM OLD."business_date"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
          OR NEW."created_device_id" IS DISTINCT FROM OLD."created_device_id"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."version" <> OLD."version" + 1
          OR NEW."updated_at" < OLD."updated_at" THEN
          RAISE EXCEPTION 'Manual adjustment identity, entered_at, and price snapshot are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_model_account_adjustments_immutable_identity';
        END IF;
        IF OLD."deleted_at" IS NOT DISTINCT FROM NEW."deleted_at" THEN
          IF NEW."deleted_by" IS DISTINCT FROM OLD."deleted_by" THEN
            RAISE EXCEPTION 'Manual adjustment trash actor changes only with trash or restore'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_model_account_adjustments_deleted_actor_lifecycle';
          END IF;
        ELSIF NEW."deleted_at" IS NULL AND NEW."deleted_by" IS NOT NULL THEN
          RAISE EXCEPTION 'Restored manual adjustment must clear the deleting user'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_model_account_adjustments_deleted_pair';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_model_account_adjustments_guard_mutation"
      BEFORE INSERT OR UPDATE OR DELETE ON "model_account_adjustments"
      FOR EACH ROW EXECUTE FUNCTION "guard_model_account_adjustment_mutation"()
    `);
    await queryRunner.query(`
      INSERT INTO "permissions" ("code", "description")
      VALUES ('patta.hisob.manual_manage', 'Patta hisobiga qo‘lda yozuv qo‘shish va tahrirlash')
      ON CONFLICT ("code") DO UPDATE SET "description" = EXCLUDED."description"
    `);
    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT role."id", permission."id"
      FROM "roles" role CROSS JOIN "permissions" permission
      WHERE role."name" = 'Korxona administratori'
        AND permission."code" = 'patta.hisob.manual_manage'
      ON CONFLICT ("role_id", "permission_id") DO NOTHING
    `);

    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_entity_type"');
    await queryRunner.query('ALTER TABLE "audit_log" DROP CONSTRAINT "ck_audit_log_action"');
    await queryRunner.query(`
      ALTER TABLE "audit_log"
        ADD CONSTRAINT "ck_audit_log_entity_type" CHECK ("entity_type" IN (
          'model', 'operation', 'worker', 'badge', 'patta_template', 'patta_number_block',
          'patta', 'patta_partiya_number_block', 'patta_print_batch', 'patta_print_event', 'patta_sheet',
          'model_account_adjustment'
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
          'patta_sheet.row_restore', 'patta_sheet.custom_operation.create',
          'model_account_adjustment.create', 'model_account_adjustment.update',
          'model_account_adjustment.trash', 'model_account_adjustment.restore'
        ))
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "model_account_adjustments")
          OR EXISTS (SELECT 1 FROM "audit_log" WHERE "entity_type" = 'model_account_adjustment')
          OR EXISTS (SELECT 1 FROM "processed_sync_events" WHERE "entity_type" = 'model_account_adjustment')
          OR EXISTS (SELECT 1 FROM "bootstrap_items" WHERE "entity_type" = 'model_account_adjustments') THEN
          RAISE EXCEPTION 'cannot revert Model hisob adjustments while adjustment history exists'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_model_account_adjustments_empty_before_revert';
        END IF;
      END $$
    `);
    await queryRunner.query('DROP TRIGGER "trg_model_account_adjustments_guard_mutation" ON "model_account_adjustments"');
    await queryRunner.query('DROP FUNCTION "guard_model_account_adjustment_mutation"()');
    await queryRunner.query('DROP TABLE "model_account_adjustments"');
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
    await queryRunner.query(`
      DELETE FROM "role_permissions" assignment USING "permissions" permission
      WHERE assignment."permission_id" = permission."id"
        AND permission."code" = 'patta.hisob.manual_manage'
    `);
    await queryRunner.query(`DELETE FROM "permissions" WHERE "code" = 'patta.hisob.manual_manage'`);
  }
}
