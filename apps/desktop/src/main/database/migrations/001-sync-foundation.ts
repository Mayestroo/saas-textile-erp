import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function createSyncFoundation(database: Database.Database): void {
  database.exec(`
    CREATE TABLE sync_state (
      key TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workers (
      id TEXT NOT NULL PRIMARY KEY,
      full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
      version TEXT NOT NULL CHECK (length(version) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_sequence TEXT
    );

    CREATE TABLE worker_badge_history (
      id TEXT NOT NULL PRIMARY KEY,
      badge_number TEXT NOT NULL CHECK (length(trim(badge_number)) > 0),
      worker_id TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      server_sequence TEXT,
      FOREIGN KEY (worker_id) REFERENCES workers (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_worker_badge_history_badge_timeline
      ON worker_badge_history (badge_number, valid_from, id);
    CREATE INDEX ix_worker_badge_history_worker_timeline
      ON worker_badge_history (worker_id, valid_from, id);

    CREATE TABLE models (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
      version TEXT NOT NULL CHECK (length(version) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_sequence TEXT
    );

    CREATE TABLE model_operations (
      id TEXT NOT NULL PRIMARY KEY,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
      version TEXT NOT NULL CHECK (length(version) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_sequence TEXT,
      FOREIGN KEY (model_id) REFERENCES models (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_model_operations_model_order
      ON model_operations (model_id, sort_order, id);

    CREATE TABLE model_operation_prices (
      id TEXT NOT NULL PRIMARY KEY,
      operation_id TEXT NOT NULL,
      price TEXT NOT NULL CHECK (length(price) > 0),
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      server_sequence TEXT,
      CHECK (valid_to IS NULL OR valid_to > valid_from),
      FOREIGN KEY (operation_id) REFERENCES model_operations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_model_operation_prices_timeline
      ON model_operation_prices (operation_id, valid_from, id);

    CREATE TABLE patta_templates (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      model_id TEXT NOT NULL,
      konveyer TEXT NOT NULL CHECK (length(trim(konveyer)) > 0),
      razmer TEXT,
      rang TEXT,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
      version TEXT NOT NULL CHECK (length(version) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      server_sequence TEXT,
      FOREIGN KEY (model_id) REFERENCES models (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_templates_model_status
      ON patta_templates (model_id, status, name);

    CREATE TABLE patta_number_blocks (
      id TEXT NOT NULL PRIMARY KEY,
      device_id TEXT NOT NULL,
      range_start TEXT NOT NULL CHECK (
        length(range_start) > 0 AND range_start NOT GLOB '*[^0-9]*'
      ),
      range_end TEXT NOT NULL CHECK (
        length(range_end) > 0 AND range_end NOT GLOB '*[^0-9]*'
      ),
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
    CREATE INDEX ix_patta_number_blocks_device_status
      ON patta_number_blocks (device_id, status, allocated_at);

    CREATE TABLE patta_hisob (
      id TEXT NOT NULL PRIMARY KEY,
      partiya_number TEXT NOT NULL CHECK (length(trim(partiya_number)) > 0),
      patta_number TEXT NOT NULL CHECK (
        length(patta_number) > 0 AND patta_number NOT GLOB '*[^0-9]*'
      ),
      model_id TEXT NOT NULL,
      model_name_snapshot TEXT NOT NULL CHECK (length(trim(model_name_snapshot)) > 0),
      template_id TEXT,
      konveyer_snapshot TEXT NOT NULL CHECK (length(trim(konveyer_snapshot)) > 0),
      razmer TEXT,
      rang TEXT,
      ish_soni INTEGER NOT NULL CHECK (ish_soni > 0),
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
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_hisob_model_created
      ON patta_hisob (model_id, created_at DESC, id DESC);

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

    CREATE TABLE sync_queue (
      event_id TEXT NOT NULL PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('patta')),
      entity_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('CREATE')),
      base_version TEXT NOT NULL,
      client_created_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      reference_cursor TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SYNCING', 'SYNCED', 'CONFLICT', 'FAILED')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX ix_sync_queue_pending
      ON sync_queue (status, next_attempt_at, created_at);
    CREATE INDEX ix_sync_queue_entity
      ON sync_queue (entity_type, entity_id, created_at);

    CREATE TABLE sync_conflicts (
      id TEXT NOT NULL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      local_payload_json TEXT NOT NULL CHECK (json_valid(local_payload_json)),
      server_payload_json TEXT CHECK (
        server_payload_json IS NULL OR json_valid(server_payload_json)
      ),
      resolution_state TEXT NOT NULL DEFAULT 'OPEN'
        CHECK (resolution_state IN ('OPEN', 'RESOLVED')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (event_id) REFERENCES sync_queue (event_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_sync_conflicts_open
      ON sync_conflicts (resolution_state, created_at);

    CREATE TABLE sync_tombstones (
      entity_type TEXT NOT NULL CHECK (
        entity_type IN (
          'workers', 'worker_badge_history', 'models', 'model_operations',
          'model_operation_prices', 'patta_templates', 'patta_hisob',
          'patta_operation_snapshots', 'patta_number_blocks'
        )
      ),
      entity_id TEXT NOT NULL,
      server_sequence TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );

    CREATE TABLE bootstrap_local_state (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      session_id TEXT NOT NULL,
      watermark TEXT NOT NULL,
      next_order_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'READY_TO_APPLY')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE bootstrap_items (
      session_id TEXT NOT NULL,
      order_key TEXT NOT NULL CHECK (
        length(order_key) > 0 AND order_key NOT GLOB '*[^0-9]*'
      ),
      entity_type TEXT NOT NULL CHECK (
        entity_type IN (
          'workers', 'worker_badge_history', 'models', 'model_operations',
          'model_operation_prices', 'patta_templates', 'patta_hisob',
          'patta_operation_snapshots', 'patta_number_blocks'
        )
      ),
      entity_id TEXT NOT NULL,
      projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
      PRIMARY KEY (session_id, order_key),
      UNIQUE (session_id, entity_type, entity_id)
    );
    CREATE INDEX ix_bootstrap_items_entity_order
      ON bootstrap_items (session_id, entity_type, entity_id);
  `)
}

export const syncFoundationMigration: SqliteMigration = {
  version: 1,
  name: 'sync-foundation',
  up: createSyncFoundation
}
