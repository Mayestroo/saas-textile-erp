import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function migratePattaQuantityAndPrintBatches(database: Database.Database): void {
  database.pragma('defer_foreign_keys = ON')

  database.exec(`
    DROP INDEX IF EXISTS ix_patta_hisob_model_created;
    DROP INDEX IF EXISTS ix_patta_operation_snapshots_patta_order;
    DROP INDEX IF EXISTS ix_sync_queue_pending;
    DROP INDEX IF EXISTS ix_sync_queue_entity;
    DROP INDEX IF EXISTS ix_sync_conflicts_open;
    DROP INDEX IF EXISTS ix_bootstrap_items_entity_order;

    ALTER TABLE patta_operation_snapshots RENAME TO patta_operation_snapshots_v2_legacy;
    ALTER TABLE patta_hisob RENAME TO patta_hisob_v2_legacy;

    CREATE TABLE patta_partiya_number_blocks (
      id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      range_start TEXT NOT NULL CHECK (length(range_start) > 0 AND range_start NOT GLOB '*[^0-9]*'),
      range_end TEXT NOT NULL CHECK (length(range_end) > 0 AND range_end NOT GLOB '*[^0-9]*'),
      reported_used_count TEXT NOT NULL CHECK (
        length(reported_used_count) > 0 AND reported_used_count NOT GLOB '*[^0-9]*'
      ),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'EXHAUSTED', 'CANCELLED')),
      allocated_at TEXT NOT NULL,
      exhausted_at TEXT,
      local_next_number TEXT,
      local_consumed_count TEXT NOT NULL DEFAULT '0' CHECK (
        length(local_consumed_count) > 0 AND local_consumed_count NOT GLOB '*[^0-9]*'
      ),
      local_role TEXT NOT NULL DEFAULT 'AVAILABLE'
        CHECK (local_role IN ('CURRENT', 'RESERVED', 'AVAILABLE')),
      server_sequence TEXT
    );
    CREATE INDEX ix_patta_partiya_number_blocks_device_status
      ON patta_partiya_number_blocks (device_id, status, allocated_at);

    CREATE TABLE patta_print_batches (
      id TEXT NOT NULL PRIMARY KEY,
      model_id TEXT NOT NULL,
      model_name_snapshot TEXT NOT NULL CHECK (length(trim(model_name_snapshot)) > 0),
      partiya_number TEXT NOT NULL CHECK (
        length(partiya_number) > 0 AND partiya_number NOT GLOB '*[^0-9]*'
      ),
      partiya_block_id TEXT,
      ish_soni INTEGER NOT NULL CHECK (ish_soni > 0),
      rang TEXT NOT NULL CHECK (length(trim(rang)) > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'VOID', 'SUPERSEDED')),
      version TEXT NOT NULL CHECK (length(version) > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      corrected_from_batch_id TEXT,
      created_by TEXT,
      created_device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      printed_at TEXT,
      ownership_state TEXT NOT NULL DEFAULT 'SERVER_SYNCED'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      FOREIGN KEY (model_id) REFERENCES models (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (partiya_block_id) REFERENCES patta_partiya_number_blocks (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (corrected_from_batch_id) REFERENCES patta_print_batches (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_patta_print_batches_partiya ON patta_print_batches (partiya_number);
    CREATE INDEX ix_patta_print_batches_model_created
      ON patta_print_batches (model_id, created_at DESC, id DESC);

    CREATE TABLE patta_print_batch_sizes (
      id TEXT NOT NULL PRIMARY KEY,
      print_batch_id TEXT NOT NULL,
      razmer TEXT NOT NULL CHECK (length(trim(razmer)) > 0),
      patta_count INTEGER NOT NULL CHECK (patta_count > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      ownership_state TEXT NOT NULL DEFAULT 'SERVER_SYNCED'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      UNIQUE (print_batch_id, razmer),
      FOREIGN KEY (print_batch_id) REFERENCES patta_print_batches (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_print_batch_sizes_order
      ON patta_print_batch_sizes (print_batch_id, sort_order, id);

    CREATE TABLE patta_print_events (
      id TEXT NOT NULL PRIMARY KEY,
      batch_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      kind TEXT NOT NULL CHECK (kind IN ('INITIAL', 'REPRINT', 'CORRECTED_REPRINT')),
      outcome TEXT NOT NULL CHECK (outcome IN ('REQUESTED', 'SUCCEEDED', 'FAILED')),
      actor_user_id TEXT,
      device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      printed_at TEXT,
      server_sequence TEXT,
      FOREIGN KEY (batch_id) REFERENCES patta_print_batches (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_print_events_batch
      ON patta_print_events (batch_id, created_at, id);
    CREATE TRIGGER trg_patta_print_events_immutable_update
      BEFORE UPDATE ON patta_print_events
      BEGIN SELECT RAISE(ABORT, 'Patta print events are append-only'); END;
    CREATE TRIGGER trg_patta_print_events_immutable_delete
      BEFORE DELETE ON patta_print_events
      BEGIN SELECT RAISE(ABORT, 'Patta print events are append-only'); END;

    CREATE TABLE patta_hisob (
      id TEXT NOT NULL PRIMARY KEY,
      partiya_number TEXT NOT NULL CHECK (length(trim(partiya_number)) > 0),
      patta_number TEXT NOT NULL CHECK (length(patta_number) > 0 AND patta_number NOT GLOB '*[^0-9]*'),
      model_id TEXT NOT NULL,
      model_name_snapshot TEXT NOT NULL CHECK (length(trim(model_name_snapshot)) > 0),
      template_id TEXT,
      konveyer_snapshot TEXT,
      razmer TEXT,
      rang TEXT,
      ish_soni INTEGER CHECK (ish_soni IS NULL OR ish_soni > 0),
      legacy_operation_count INTEGER CHECK (legacy_operation_count IS NULL OR legacy_operation_count > 0),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOID')),
      print_batch_id TEXT,
      created_device_id TEXT NOT NULL,
      created_from_block_id TEXT,
      created_at TEXT NOT NULL,
      client_created_at TEXT,
      occurred_at TEXT,
      version TEXT NOT NULL DEFAULT '0' CHECK (length(version) > 0),
      ownership_state TEXT NOT NULL CHECK (
        ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')
      ),
      server_sequence TEXT,
      UNIQUE (partiya_number, patta_number),
      FOREIGN KEY (model_id) REFERENCES models (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (template_id) REFERENCES patta_templates (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (created_from_block_id) REFERENCES patta_number_blocks (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (print_batch_id) REFERENCES patta_print_batches (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_hisob_model_created ON patta_hisob (model_id, created_at DESC, id DESC);
    CREATE INDEX ix_patta_hisob_print_batch ON patta_hisob (print_batch_id, patta_number);

    CREATE TABLE patta_operation_snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      patta_hisob_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      operation_name_snapshot TEXT NOT NULL CHECK (length(trim(operation_name_snapshot)) > 0),
      unit_price_snapshot TEXT NOT NULL CHECK (length(unit_price_snapshot) > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      created_at TEXT NOT NULL,
      ownership_state TEXT NOT NULL CHECK (
        ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')
      ),
      server_sequence TEXT,
      UNIQUE (patta_hisob_id, operation_id),
      FOREIGN KEY (patta_hisob_id) REFERENCES patta_hisob (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (operation_id) REFERENCES model_operations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_operation_snapshots_patta_order
      ON patta_operation_snapshots (patta_hisob_id, sort_order, id);

    INSERT INTO patta_hisob (
      id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
      konveyer_snapshot, razmer, rang, ish_soni, legacy_operation_count, status, print_batch_id,
      created_device_id, created_from_block_id, created_at, client_created_at, occurred_at,
      version, ownership_state, server_sequence
    )
    SELECT id, partiya_number, patta_number, model_id, model_name_snapshot, template_id,
      konveyer_snapshot, razmer, rang, NULL, ish_soni, 'ACTIVE', NULL,
      created_device_id, created_from_block_id, created_at, client_created_at, occurred_at,
      version, ownership_state, server_sequence
    FROM patta_hisob_v2_legacy;

    INSERT INTO patta_operation_snapshots (
      id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
      sort_order, created_at, ownership_state, server_sequence
    )
    SELECT id, patta_hisob_id, operation_id, operation_name_snapshot, unit_price_snapshot,
      sort_order, created_at, ownership_state, server_sequence
    FROM patta_operation_snapshots_v2_legacy;

    DROP TABLE patta_operation_snapshots_v2_legacy;
    DROP TABLE patta_hisob_v2_legacy;
  `)

  database.exec(`
    ALTER TABLE sync_conflicts RENAME TO sync_conflicts_v2_legacy;
    ALTER TABLE sync_queue RENAME TO sync_queue_v2_legacy;

    CREATE TABLE sync_queue (
      event_id TEXT NOT NULL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (
        entity_type IN ('patta', 'patta_print_batch', 'patta_print_event', 'model_operation', 'patta_sheet')
      ),
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
      base_version TEXT NOT NULL,
      client_created_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reference_cursor TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SYNCING', 'SYNCED', 'CONFLICT', 'FAILED')),
      ever_sent INTEGER NOT NULL DEFAULT 0 CHECK (ever_sent IN (0, 1)),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sync_queue (
      event_id, entity_type, entity_id, operation, base_version, client_created_at,
      occurred_at, reference_cursor, payload_json, status, ever_sent, attempt_count,
      next_attempt_at, last_error_code, last_error_message, result_json, created_at, updated_at
    )
    SELECT event_id, entity_type, entity_id, operation, base_version, client_created_at,
      occurred_at, reference_cursor, payload_json, status,
      CASE WHEN status = 'PENDING' AND attempt_count = 0 THEN 0 ELSE 1 END,
      attempt_count, next_attempt_at, last_error_code, last_error_message, result_json,
      created_at, updated_at
    FROM sync_queue_v2_legacy;
    CREATE INDEX ix_sync_queue_pending ON sync_queue (status, next_attempt_at, created_at);
    CREATE INDEX ix_sync_queue_entity ON sync_queue (entity_type, entity_id, created_at);

    CREATE TABLE sync_conflicts (
      id TEXT NOT NULL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      local_payload_json TEXT NOT NULL CHECK (json_valid(local_payload_json)),
      server_payload_json TEXT CHECK (server_payload_json IS NULL OR json_valid(server_payload_json)),
      resolution_state TEXT NOT NULL DEFAULT 'OPEN' CHECK (resolution_state IN ('OPEN', 'RESOLVED')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (event_id) REFERENCES sync_queue (event_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    INSERT INTO sync_conflicts SELECT * FROM sync_conflicts_v2_legacy;
    CREATE INDEX ix_sync_conflicts_open ON sync_conflicts (resolution_state, created_at);

    CREATE TABLE sync_event_dependencies (
      event_id TEXT NOT NULL,
      prerequisite_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, prerequisite_event_id),
      CHECK (event_id <> prerequisite_event_id),
      FOREIGN KEY (event_id) REFERENCES sync_queue (event_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (prerequisite_event_id) REFERENCES sync_queue (event_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_sync_event_dependencies_prerequisite
      ON sync_event_dependencies (prerequisite_event_id, event_id);

    INSERT INTO sync_conflicts (
      id, event_id, code, message, local_payload_json, server_payload_json,
      resolution_state, created_at
    )
    SELECT event.event_id, event.event_id, 'PATTA_QUANTITY_UNKNOWN',
      'Eski Patta hodisasida haqiqiy ish soni yo‘q; miqdorni tuzating va v2 hodisa yarating',
      event.payload_json, NULL, 'OPEN', event.updated_at
    FROM sync_queue event
    WHERE event.entity_type = 'patta'
      AND event.status IN ('PENDING', 'SYNCING')
      AND (json_type(event.payload_json, '$.ish_soni') IS NULL
        OR json_type(event.payload_json, '$.ish_soni') <> 'integer'
        OR json_extract(event.payload_json, '$.ish_soni') <= 0)
      AND NOT EXISTS (SELECT 1 FROM sync_conflicts existing WHERE existing.event_id = event.event_id);

    UPDATE sync_queue SET status = 'CONFLICT', result_json = json_object(
      'event_id', event_id, 'status', 'CONFLICT',
      'conflict', json_object(
        'code', 'PATTA_QUANTITY_UNKNOWN',
        'message', 'Eski Patta hodisasida haqiqiy ish soni yo‘q; miqdorni tuzating va v2 hodisa yarating',
        'details', json('{}'), 'local_payload', json(payload_json), 'server_payload', NULL
      )
    ), last_error_code = 'PATTA_QUANTITY_UNKNOWN',
       last_error_message = 'Eski Patta hodisasida haqiqiy ish soni yo‘q; miqdorni tuzating va v2 hodisa yarating'
    WHERE entity_type = 'patta'
      AND status IN ('PENDING', 'SYNCING')
      AND (json_type(payload_json, '$.ish_soni') IS NULL
        OR json_type(payload_json, '$.ish_soni') <> 'integer'
        OR json_extract(payload_json, '$.ish_soni') <= 0);

    UPDATE patta_hisob SET ownership_state = 'CONFLICT'
    WHERE id IN (
      SELECT entity_id FROM sync_queue WHERE entity_type = 'patta'
        AND status = 'CONFLICT' AND last_error_code = 'PATTA_QUANTITY_UNKNOWN'
    ) AND ownership_state IN ('LOCAL_PENDING', 'SYNCING');
    UPDATE patta_operation_snapshots SET ownership_state = 'CONFLICT'
    WHERE patta_hisob_id IN (
      SELECT entity_id FROM sync_queue WHERE entity_type = 'patta'
        AND status = 'CONFLICT' AND last_error_code = 'PATTA_QUANTITY_UNKNOWN'
    ) AND ownership_state IN ('LOCAL_PENDING', 'SYNCING');

    DROP TABLE sync_conflicts_v2_legacy;
    DROP TABLE sync_queue_v2_legacy;
  `)

  database.exec(`
    ALTER TABLE sync_tombstones RENAME TO sync_tombstones_v2_legacy;
    CREATE TABLE sync_tombstones (
      entity_type TEXT NOT NULL CHECK (
        entity_type IN (
          'workers', 'worker_badge_history', 'models', 'model_operations',
          'model_operation_prices', 'patta_templates', 'patta_hisob',
          'patta_operation_snapshots', 'patta_number_blocks',
          'patta_partiya_number_blocks', 'patta_print_batches',
          'patta_print_batch_sizes', 'patta_print_events',
          'patta_sheets', 'patta_sheet_operation_snapshots', 'patta_sheet_rows'
        )
      ),
      entity_id TEXT NOT NULL,
      server_sequence TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
    INSERT INTO sync_tombstones SELECT * FROM sync_tombstones_v2_legacy;
    DROP TABLE sync_tombstones_v2_legacy;

    ALTER TABLE bootstrap_items RENAME TO bootstrap_items_v2_legacy;
    CREATE TABLE bootstrap_items (
      session_id TEXT NOT NULL,
      order_key TEXT NOT NULL CHECK (length(order_key) > 0 AND order_key NOT GLOB '*[^0-9]*'),
      entity_type TEXT NOT NULL CHECK (
        entity_type IN (
          'workers', 'worker_badge_history', 'models', 'model_operations',
          'model_operation_prices', 'patta_templates', 'patta_hisob',
          'patta_operation_snapshots', 'patta_number_blocks',
          'patta_partiya_number_blocks', 'patta_print_batches',
          'patta_print_batch_sizes', 'patta_print_events',
          'patta_sheets', 'patta_sheet_operation_snapshots', 'patta_sheet_rows'
        )
      ),
      entity_id TEXT NOT NULL,
      projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
      PRIMARY KEY (session_id, order_key),
      UNIQUE (session_id, entity_type, entity_id)
    );
    INSERT INTO bootstrap_items SELECT * FROM bootstrap_items_v2_legacy;
    CREATE INDEX ix_bootstrap_items_entity_order ON bootstrap_items (session_id, entity_type, entity_id);
    DROP TABLE bootstrap_items_v2_legacy;

  `)

  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeyViolations.length > 0) {
    throw new Error('SQLite Patta quantity/batch migration left foreign-key violations')
  }
}

export const pattaQuantityPrintBatchesMigration: SqliteMigration = {
  version: 3,
  name: 'patta-quantity-print-batches',
  up: migratePattaQuantityAndPrintBatches,
}
