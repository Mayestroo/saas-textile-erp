export class AddOfflineSyncInfrastructure20260926000600 {
  name = 'AddOfflineSyncInfrastructure20260926000600';

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE "processed_sync_events" (
        "event_id" uuid NOT NULL,
        "device_id" uuid NULL,
        "user_id" uuid NULL,
        "entity_type" varchar NOT NULL,
        "entity_id" varchar NULL,
        "operation" varchar NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "result_status" varchar NOT NULL,
        "result_json" jsonb NULL,
        "processed_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_processed_sync_events" PRIMARY KEY ("event_id"),
        CONSTRAINT "ck_processed_sync_events_entity_type" CHECK (
          "entity_type" <> ''
        ),
        CONSTRAINT "ck_processed_sync_events_entity_id" CHECK (
          "entity_id" IS NULL OR "entity_id" <> ''
        ),
        CONSTRAINT "ck_processed_sync_events_operation" CHECK (
          "operation" IN ('CREATE', 'UPDATE', 'DELETE')
        ),
        CONSTRAINT "ck_processed_sync_events_fingerprint" CHECK (
          "request_fingerprint" ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT "ck_processed_sync_events_status" CHECK (
          "result_status" IN ('PROCESSING', 'SYNCED', 'CONFLICT', 'FAILED')
        ),
        CONSTRAINT "ck_processed_sync_events_result" CHECK (
          ("result_status" = 'PROCESSING' AND "result_json" IS NULL) OR
          ("result_status" <> 'PROCESSING' AND "result_json" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_processed_sync_events_device_processed" ON "processed_sync_events" ("device_id", "processed_at" DESC)',
    );
    await queryRunner.query(`
      CREATE FUNCTION "guard_processed_sync_event_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'processed sync events cannot be deleted'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_processed_sync_events_immutable';
        END IF;

        IF OLD."result_status" <> 'PROCESSING'
          OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
          OR NEW."device_id" IS DISTINCT FROM OLD."device_id"
          OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
          OR NEW."entity_type" IS DISTINCT FROM OLD."entity_type"
          OR NEW."entity_id" IS DISTINCT FROM OLD."entity_id"
          OR NEW."operation" IS DISTINCT FROM OLD."operation"
          OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
          OR NEW."processed_at" IS DISTINCT FROM OLD."processed_at"
          OR NEW."result_status" = 'PROCESSING' THEN
          RAISE EXCEPTION 'processed sync event identity and result are immutable'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_processed_sync_events_immutable';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_processed_sync_events_immutable"
      BEFORE UPDATE OR DELETE ON "processed_sync_events"
      FOR EACH ROW EXECUTE FUNCTION "guard_processed_sync_event_mutation"()
    `);
    await queryRunner.query(`
      CREATE FUNCTION "require_terminal_processed_sync_event"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        final_status varchar;
      BEGIN
        SELECT "result_status" INTO final_status
        FROM "processed_sync_events" WHERE "event_id" = NEW."event_id";
        IF final_status IS NULL OR final_status = 'PROCESSING' THEN
          RAISE EXCEPTION 'processed sync event must reach a terminal result before commit'
            USING ERRCODE = '23514', CONSTRAINT = 'ck_processed_sync_events_terminal';
        END IF;
        RETURN NULL;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER "trg_processed_sync_events_terminal"
      AFTER INSERT OR UPDATE ON "processed_sync_events"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION "require_terminal_processed_sync_event"()
    `);

    await queryRunner.query(`
      CREATE TABLE "server_change_log" (
        "sequence_id" bigserial NOT NULL,
        "entity_type" varchar NOT NULL,
        "entity_id" varchar NOT NULL,
        "operation" varchar NOT NULL,
        "entity_version" varchar NULL,
        "projection_version" integer NOT NULL,
        "payload_json" jsonb NULL,
        "changed_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        CONSTRAINT "pk_server_change_log" PRIMARY KEY ("sequence_id"),
        CONSTRAINT "ck_server_change_log_entity_type" CHECK ("entity_type" <> ''),
        CONSTRAINT "ck_server_change_log_entity_id" CHECK ("entity_id" <> ''),
        CONSTRAINT "ck_server_change_log_operation" CHECK ("operation" IN ('UPSERT', 'DELETE')),
        CONSTRAINT "ck_server_change_log_projection_version" CHECK ("projection_version" > 0),
        CONSTRAINT "ck_server_change_log_upsert_payload" CHECK (
          "operation" = 'DELETE' OR "payload_json" IS NOT NULL
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_server_change_log_entity" ON "server_change_log" ("entity_type", "entity_id", "sequence_id")',
    );
    await queryRunner.query(`
      CREATE FUNCTION "reject_sync_change_log_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'server sync change log is append-only'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_server_change_log_append_only';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_server_change_log_append_only"
      BEFORE UPDATE OR DELETE ON "server_change_log"
      FOR EACH ROW EXECUTE FUNCTION "reject_sync_change_log_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "bootstrap_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "device_id" uuid NOT NULL,
        "watermark" bigint NOT NULL,
        "status" varchar NOT NULL DEFAULT 'ACTIVE',
        "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz NULL,
        CONSTRAINT "pk_bootstrap_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_bootstrap_sessions_watermark" CHECK ("watermark" >= 0),
        CONSTRAINT "ck_bootstrap_sessions_status" CHECK (
          "status" IN ('ACTIVE', 'COMPLETED', 'EXPIRED')
        ),
        CONSTRAINT "ck_bootstrap_sessions_expiry" CHECK ("expires_at" > "created_at"),
        CONSTRAINT "ck_bootstrap_sessions_completed_at" CHECK (
          ("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_bootstrap_sessions_active_device"
      ON "bootstrap_sessions" ("device_id") WHERE "status" = 'ACTIVE'
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_bootstrap_sessions_expiry" ON "bootstrap_sessions" ("status", "expires_at")',
    );
    await queryRunner.query(`
      CREATE FUNCTION "guard_bootstrap_session_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD."status" = 'ACTIVE' THEN
            RAISE EXCEPTION 'active bootstrap sessions cannot be deleted'
              USING ERRCODE = '55000', CONSTRAINT = 'trg_bootstrap_sessions_state';
          END IF;
          RETURN OLD;
        END IF;

        IF NEW."id" IS DISTINCT FROM OLD."id"
          OR NEW."device_id" IS DISTINCT FROM OLD."device_id"
          OR NEW."watermark" IS DISTINCT FROM OLD."watermark"
          OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
          OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
          OR OLD."status" <> 'ACTIVE'
          OR NEW."status" NOT IN ('COMPLETED', 'EXPIRED')
          OR ((NEW."status" = 'COMPLETED') <> (NEW."completed_at" IS NOT NULL)) THEN
          RAISE EXCEPTION 'bootstrap session identity is immutable and status is terminal'
            USING ERRCODE = '55000', CONSTRAINT = 'trg_bootstrap_sessions_state';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_bootstrap_sessions_state"
      BEFORE UPDATE OR DELETE ON "bootstrap_sessions"
      FOR EACH ROW EXECUTE FUNCTION "guard_bootstrap_session_mutation"()
    `);

    await queryRunner.query(`
      CREATE TABLE "bootstrap_items" (
        "session_id" uuid NOT NULL,
        "order_key" bigint NOT NULL,
        "entity_type" varchar NOT NULL,
        "entity_id" varchar NOT NULL,
        "projection_version" integer NOT NULL,
        "payload_json" jsonb NOT NULL,
        CONSTRAINT "pk_bootstrap_items" PRIMARY KEY ("session_id", "order_key"),
        CONSTRAINT "uq_bootstrap_items_entity" UNIQUE ("session_id", "entity_type", "entity_id"),
        CONSTRAINT "fk_bootstrap_items_session_id" FOREIGN KEY ("session_id")
          REFERENCES "bootstrap_sessions" ("id") ON DELETE CASCADE,
        CONSTRAINT "ck_bootstrap_items_order_key" CHECK ("order_key" > 0),
        CONSTRAINT "ck_bootstrap_items_entity_type" CHECK ("entity_type" <> ''),
        CONSTRAINT "ck_bootstrap_items_entity_id" CHECK ("entity_id" <> ''),
        CONSTRAINT "ck_bootstrap_items_projection_version" CHECK ("projection_version" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION "guard_bootstrap_item_mutation"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'materialized bootstrap items are immutable'
          USING ERRCODE = '55000', CONSTRAINT = 'trg_bootstrap_items_immutable';
      END
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "trg_bootstrap_items_immutable"
      BEFORE UPDATE ON "bootstrap_items"
      FOR EACH ROW EXECUTE FUNCTION "guard_bootstrap_item_mutation"()
    `);

    await queryRunner.query(`
      ALTER TABLE "patta_hisob"
      ADD COLUMN "client_created_at" timestamptz NULL,
      ADD COLUMN "occurred_at" timestamptz NULL,
      ADD CONSTRAINT "ck_patta_hisob_offline_timestamps" CHECK (
        "created_from_block_id" IS NULL OR
        ("client_created_at" IS NOT NULL AND "occurred_at" IS NOT NULL)
      )
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "processed_sync_events")
          OR EXISTS (SELECT 1 FROM "server_change_log")
          OR EXISTS (
            SELECT 1 FROM "patta_hisob"
            WHERE "client_created_at" IS NOT NULL OR "occurred_at" IS NOT NULL
          ) THEN
          RAISE EXCEPTION 'cannot revert sync schema while processed events, change history, or offline Patta rows exist'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_sync_schema_empty_before_revert';
        END IF;
      END
      $$
    `);

    await queryRunner.query('DROP TABLE IF EXISTS "bootstrap_items"');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "guard_bootstrap_item_mutation"()',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS "trg_bootstrap_sessions_state" ON "bootstrap_sessions"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "bootstrap_sessions"');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "guard_bootstrap_session_mutation"()',
    );
    await queryRunner.query(
      'ALTER TABLE "patta_hisob" DROP CONSTRAINT IF EXISTS "ck_patta_hisob_offline_timestamps"',
    );
    await queryRunner.query(
      'ALTER TABLE "patta_hisob" DROP COLUMN IF EXISTS "occurred_at"',
    );
    await queryRunner.query(
      'ALTER TABLE "patta_hisob" DROP COLUMN IF EXISTS "client_created_at"',
    );

    await queryRunner.query(
      'DROP TRIGGER IF EXISTS "trg_server_change_log_append_only" ON "server_change_log"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "server_change_log"');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "reject_sync_change_log_mutation"()',
    );

    await queryRunner.query(
      'DROP TRIGGER IF EXISTS "trg_processed_sync_events_terminal" ON "processed_sync_events"',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "require_terminal_processed_sync_event"()',
    );
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS "trg_processed_sync_events_immutable" ON "processed_sync_events"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "processed_sync_events"');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS "guard_processed_sync_event_mutation"()',
    );
  }
}
