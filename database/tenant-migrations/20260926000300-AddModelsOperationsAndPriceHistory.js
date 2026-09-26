export class AddModelsOperationsAndPriceHistory20260926000300 {
  name = 'AddModelsOperationsAndPriceHistory20260926000300';

  async up(queryRunner) {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "btree_gist"');

    await queryRunner.query(`
      CREATE FUNCTION "canonicalize_business_name"(input_name text)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      STRICT
      PARALLEL SAFE
      AS $$
        SELECT regexp_replace(
          regexp_replace(input_name, E'^[ \\011\\012\\013\\014\\015]+|[ \\011\\012\\013\\014\\015]+$', '', 'g'),
          E'[ \\011\\012\\013\\014\\015]+',
          ' ',
          'g'
        )
      $$
    `);

    await queryRunner.query(`
      CREATE TABLE "models" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "name_normalized" text GENERATED ALWAYS AS (
          lower("canonicalize_business_name"("name"))
        ) STORED,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "version" bigint NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_models" PRIMARY KEY ("id"),
        CONSTRAINT "ck_models_name_not_empty"
          CHECK ("canonicalize_business_name"("name") <> ''),
        CONSTRAINT "ck_models_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT "ck_models_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_models_active_name" ON "models" ("name_normalized") WHERE "status" = 'ACTIVE'`,
    );
    await queryRunner.query('CREATE INDEX "ix_models_status" ON "models" ("status")');
    await queryRunner.query(`
      CREATE FUNCTION "reject_historical_entity_delete"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'historical model and operation rows cannot be deleted'
          USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_models_no_delete"
      BEFORE DELETE ON "models"
      FOR EACH ROW EXECUTE FUNCTION "reject_historical_entity_delete"()
    `);

    await queryRunner.query(`
      CREATE TABLE "model_operations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "model_id" uuid NOT NULL,
        "name" varchar NOT NULL,
        "name_normalized" text GENERATED ALWAYS AS (
          lower("canonicalize_business_name"("name"))
        ) STORED,
        "price" numeric(14,2) NOT NULL,
        "sort_order" integer NOT NULL,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "version" bigint NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_model_operations" PRIMARY KEY ("id"),
        CONSTRAINT "fk_model_operations_model_id" FOREIGN KEY ("model_id")
          REFERENCES "models" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_model_operations_name_not_empty"
          CHECK ("canonicalize_business_name"("name") <> ''),
        CONSTRAINT "ck_model_operations_price_nonnegative" CHECK ("price" >= 0),
        CONSTRAINT "ck_model_operations_sort_order_nonnegative" CHECK ("sort_order" >= 0),
        CONSTRAINT "ck_model_operations_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT "ck_model_operations_version_positive" CHECK ("version" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_model_operations_active_name"
       ON "model_operations" ("model_id", "name_normalized") WHERE "status" = 'ACTIVE'`,
    );
    await queryRunner.query(
      'CREATE INDEX "ix_model_operations_model_id" ON "model_operations" ("model_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_model_operations_status" ON "model_operations" ("status")',
    );
    await queryRunner.query(`
      CREATE TRIGGER "trg_model_operations_no_delete"
      BEFORE DELETE ON "model_operations"
      FOR EACH ROW EXECUTE FUNCTION "reject_historical_entity_delete"()
    `);

    await queryRunner.query(`
      CREATE TABLE "model_operation_prices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "operation_id" uuid NOT NULL,
        "price" numeric(14,2) NOT NULL,
        "valid_from" timestamptz NOT NULL,
        "valid_to" timestamptz NULL,
        "created_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_model_operation_prices" PRIMARY KEY ("id"),
        CONSTRAINT "fk_model_operation_prices_operation_id" FOREIGN KEY ("operation_id")
          REFERENCES "model_operations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "fk_model_operation_prices_created_by" FOREIGN KEY ("created_by")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_model_operation_prices_price_nonnegative" CHECK ("price" >= 0),
        CONSTRAINT "ck_model_operation_prices_interval"
          CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
        CONSTRAINT "ex_model_operation_prices_no_overlap"
          EXCLUDE USING gist (
            "operation_id" WITH =,
            tstzrange(
              "valid_from",
              COALESCE("valid_to", 'infinity'::timestamptz),
              '[)'
            ) WITH &&
          )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_model_operation_prices_operation_valid_from" ON "model_operation_prices" ("operation_id", "valid_from" DESC)',
    );
    await queryRunner.query(`
      CREATE FUNCTION "guard_model_operation_price_history"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'operation price history cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;

        IF OLD."valid_to" IS NOT NULL
          OR NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
          OR NEW."price" IS DISTINCT FROM OLD."price"
          OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
          OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."valid_to" IS NULL
          OR NEW."valid_to" <= OLD."valid_from" THEN
          RAISE EXCEPTION 'operation price history is immutable except closing an open interval'
            USING ERRCODE = '55000', CONSTRAINT = TG_NAME;
        END IF;

        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_model_operation_prices_immutable"
      BEFORE UPDATE OR DELETE ON "model_operation_prices"
      FOR EACH ROW EXECUTE FUNCTION "guard_model_operation_price_history"()
    `);

    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_user_id" uuid NOT NULL,
        "entity_type" varchar NOT NULL,
        "entity_id" uuid NOT NULL,
        "action" varchar NOT NULL,
        "before_json" jsonb NULL,
        "after_json" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_audit_log" PRIMARY KEY ("id"),
        CONSTRAINT "fk_audit_log_actor_user_id" FOREIGN KEY ("actor_user_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "ck_audit_log_entity_type"
          CHECK ("entity_type" IN ('model', 'operation')),
        CONSTRAINT "ck_audit_log_action" CHECK (
          "action" IN (
            'model.create', 'model.update', 'model.deactivate',
            'operation.create', 'operation.update', 'operation.deactivate',
            'operation.price_change'
          )
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_audit_log_entity" ON "audit_log" ("entity_type", "entity_id", "created_at" DESC)',
    );
    await queryRunner.query('CREATE INDEX "ix_audit_log_created_at" ON "audit_log" ("created_at" DESC)');
    await queryRunner.query(`
      CREATE FUNCTION "reject_audit_log_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'audit log rows are append-only'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_audit_log_append_only';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_log_append_only"
      BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION "reject_audit_log_mutation"()
    `);
  }

  async down(queryRunner) {
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_audit_log_append_only" ON "audit_log"');
    await queryRunner.query('DROP TABLE IF EXISTS "audit_log"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "reject_audit_log_mutation"()');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_model_operation_prices_immutable" ON "model_operation_prices"');
    await queryRunner.query('DROP TABLE IF EXISTS "model_operation_prices"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "guard_model_operation_price_history"()');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_model_operations_no_delete" ON "model_operations"');
    await queryRunner.query('DROP TABLE IF EXISTS "model_operations"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "trg_models_no_delete" ON "models"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "reject_historical_entity_delete"()');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_models_active_name"');
    await queryRunner.query('DROP INDEX IF EXISTS "ix_models_status"');
    await queryRunner.query('DROP TABLE IF EXISTS "models"');
    await queryRunner.query('DROP FUNCTION IF EXISTS "canonicalize_business_name"(text)');
  }
}
