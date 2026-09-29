export class AddSyncProtocolV2Sessions20260928000900 {
  name = 'AddSyncProtocolV2Sessions20260928000900';

  async up(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE "bootstrap_sessions"
        ADD COLUMN "protocol_version" smallint NOT NULL DEFAULT 1,
        ADD CONSTRAINT "ck_bootstrap_sessions_protocol_version"
          CHECK ("protocol_version" IN (1, 2))
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_bootstrap_sessions_protocol_version" ON "bootstrap_sessions" ("protocol_version", "status", "expires_at")',
    );
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "bootstrap_sessions" WHERE "protocol_version" = 2)
          OR EXISTS (SELECT 1 FROM "server_change_log" WHERE "projection_version" = 2)
          OR EXISTS (SELECT 1 FROM "processed_sync_events"
            WHERE "entity_type" IN (
              'patta_print_batch', 'patta_print_batches', 'patta_print_batch_sizes',
              'patta_print_events', 'patta_partiya_number_blocks', 'model_operation'
            )) THEN
          RAISE EXCEPTION 'cannot revert sync protocol v2 while v2 sessions, events, or projections remain'
            USING ERRCODE = '55000', CONSTRAINT = 'ck_sync_protocol_v2_sessions_empty_before_revert';
        END IF;
      END $$
    `);
    await queryRunner.query('DROP INDEX "ix_bootstrap_sessions_protocol_version"');
    await queryRunner.query('ALTER TABLE "bootstrap_sessions" DROP CONSTRAINT "ck_bootstrap_sessions_protocol_version"');
    await queryRunner.query('ALTER TABLE "bootstrap_sessions" DROP COLUMN "protocol_version"');
  }
}
