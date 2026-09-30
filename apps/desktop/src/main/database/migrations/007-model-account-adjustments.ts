import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function addModelAccountAdjustments(database: Database.Database): void {
  database.pragma('defer_foreign_keys = ON')
  database.exec(`
    CREATE TEMP TABLE _sync_queue_v6 AS SELECT * FROM sync_queue;
    CREATE TEMP TABLE _sync_conflicts_v6 AS SELECT * FROM sync_conflicts;
    CREATE TEMP TABLE _sync_event_dependencies_v6 AS SELECT * FROM sync_event_dependencies;
    CREATE TEMP TABLE _sync_tombstones_v6 AS SELECT * FROM sync_tombstones;
    CREATE TEMP TABLE _bootstrap_items_v6 AS SELECT * FROM bootstrap_items;

    DROP TABLE sync_conflicts;
    DROP TABLE sync_event_dependencies;
    DROP TABLE sync_queue;
    DROP TABLE sync_tombstones;
    DROP TABLE bootstrap_items;

    CREATE TABLE sync_queue (
      event_id TEXT NOT NULL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (
        entity_type IN ('patta', 'patta_print_batch', 'patta_print_event', 'model_operation',
          'patta_sheet', 'model_account_adjustment')
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
    INSERT INTO sync_queue SELECT * FROM _sync_queue_v6;
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
    INSERT INTO sync_conflicts SELECT * FROM _sync_conflicts_v6;
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
    INSERT INTO sync_event_dependencies SELECT * FROM _sync_event_dependencies_v6;
    CREATE INDEX ix_sync_event_dependencies_prerequisite
      ON sync_event_dependencies (prerequisite_event_id, event_id);

    CREATE TABLE sync_tombstones (
      entity_type TEXT NOT NULL CHECK (
        entity_type IN (
          'workers', 'worker_badge_history', 'models', 'model_operations',
          'model_operation_prices', 'patta_templates', 'patta_hisob',
          'patta_operation_snapshots', 'patta_number_blocks',
          'patta_partiya_number_blocks', 'patta_print_batches',
          'patta_print_batch_sizes', 'patta_print_events', 'patta_sheets',
          'patta_sheet_operation_snapshots', 'patta_sheet_rows', 'model_account_adjustments'
        )
      ),
      entity_id TEXT NOT NULL,
      server_sequence TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
    INSERT INTO sync_tombstones SELECT * FROM _sync_tombstones_v6;

    CREATE TABLE bootstrap_items (
      session_id TEXT NOT NULL,
      order_key TEXT NOT NULL CHECK (length(order_key) > 0 AND order_key NOT GLOB '*[^0-9]*'),
      entity_type TEXT NOT NULL CHECK (
        entity_type IN (
          'workers', 'worker_badge_history', 'models', 'model_operations',
          'model_operation_prices', 'patta_templates', 'patta_hisob',
          'patta_operation_snapshots', 'patta_number_blocks',
          'patta_partiya_number_blocks', 'patta_print_batches',
          'patta_print_batch_sizes', 'patta_print_events', 'patta_sheets',
          'patta_sheet_operation_snapshots', 'patta_sheet_rows', 'model_account_adjustments'
        )
      ),
      entity_id TEXT NOT NULL,
      projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
      PRIMARY KEY (session_id, order_key),
      UNIQUE (session_id, entity_type, entity_id)
    );
    INSERT INTO bootstrap_items SELECT * FROM _bootstrap_items_v6;
    CREATE INDEX ix_bootstrap_items_entity_order ON bootstrap_items (session_id, entity_type, entity_id);

    CREATE TABLE model_account_adjustments (
      id TEXT NOT NULL PRIMARY KEY,
      model_id TEXT NOT NULL,
      model_operation_id TEXT NOT NULL,
      worker_id TEXT NOT NULL CHECK (length(worker_id) > 0 AND worker_id NOT GLOB '*[^0-9]*'),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_snapshot TEXT NOT NULL CHECK (length(unit_price_snapshot) > 0),
      entered_at TEXT NOT NULL,
      business_date TEXT NOT NULL CHECK (length(business_date) = 10),
      version TEXT NOT NULL CHECK (length(version) > 0 AND version NOT GLOB '*[^0-9]*'),
      created_by TEXT NOT NULL,
      created_device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT,
      ownership_state TEXT NOT NULL DEFAULT 'LOCAL_PENDING'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      FOREIGN KEY (model_id) REFERENCES models (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (model_operation_id) REFERENCES model_operations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (worker_id) REFERENCES workers (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_model_account_adjustments_model_operation_worker
      ON model_account_adjustments (model_id, model_operation_id, worker_id, entered_at, id)
      WHERE deleted_at IS NULL;
    CREATE INDEX ix_model_account_adjustments_trash
      ON model_account_adjustments (model_id, deleted_at DESC, id) WHERE deleted_at IS NOT NULL;

    DROP TABLE _sync_queue_v6;
    DROP TABLE _sync_conflicts_v6;
    DROP TABLE _sync_event_dependencies_v6;
    DROP TABLE _sync_tombstones_v6;
    DROP TABLE _bootstrap_items_v6;

    CREATE TRIGGER trg_model_account_adjustments_model_operation
      BEFORE INSERT ON model_account_adjustments
      WHEN NOT EXISTS (
        SELECT 1 FROM model_operations operation
        WHERE operation.id = NEW.model_operation_id AND operation.model_id = NEW.model_id
          AND operation.status = 'ACTIVE'
      )
      BEGIN SELECT RAISE(ABORT, 'Manual adjustment operation does not belong to its model'); END;

    CREATE TRIGGER trg_model_account_adjustments_immutable_identity
      BEFORE UPDATE ON model_account_adjustments
      WHEN NEW.id IS NOT OLD.id OR NEW.model_id IS NOT OLD.model_id
        OR NEW.model_operation_id IS NOT OLD.model_operation_id OR NEW.worker_id IS NOT OLD.worker_id
        OR NEW.unit_price_snapshot IS NOT OLD.unit_price_snapshot
        OR NEW.entered_at IS NOT OLD.entered_at OR NEW.business_date IS NOT OLD.business_date
        OR ((NEW.created_by IS NOT OLD.created_by OR NEW.created_device_id IS NOT OLD.created_device_id
          OR NEW.created_at IS NOT OLD.created_at)
          AND NOT (OLD.ownership_state IN ('LOCAL_PENDING', 'SYNCING') AND NEW.ownership_state = 'SERVER_SYNCED'))
      BEGIN SELECT RAISE(ABORT, 'Manual adjustment identity, entered_at and price snapshot are immutable'); END;

    CREATE TRIGGER trg_model_account_adjustments_deleted_actor_lifecycle
      BEFORE UPDATE ON model_account_adjustments
      WHEN NEW.deleted_at IS OLD.deleted_at AND NEW.deleted_by IS NOT OLD.deleted_by
      BEGIN SELECT RAISE(ABORT, 'Manual adjustment trash actor changes only with trash or restore'); END;

    CREATE TRIGGER trg_model_account_adjustments_no_hard_delete
      BEFORE DELETE ON model_account_adjustments
      BEGIN SELECT RAISE(ABORT, 'Manual adjustments are retained as history'); END;
  `)

  const violations = database.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) throw new Error('Model Account adjustment SQLite migration left foreign-key violations')
}

export const modelAccountAdjustmentsMigration: SqliteMigration = {
  version: 7,
  name: 'model-account-adjustments',
  up: addModelAccountAdjustments
}
