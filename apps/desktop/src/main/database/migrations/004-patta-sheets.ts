import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function addPattaSheets(database: Database.Database): void {
  database.exec(`
    CREATE TABLE patta_sheets (
      id TEXT NOT NULL PRIMARY KEY,
      patta_hisob_id TEXT NOT NULL UNIQUE,
      entered_at TEXT NOT NULL,
      business_date TEXT NOT NULL CHECK (length(business_date) = 10),
      conveyor_snapshot TEXT,
      version TEXT NOT NULL CHECK (length(version) > 0 AND version NOT GLOB '*[^0-9]*'),
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT,
      ownership_state TEXT NOT NULL DEFAULT 'LOCAL_PENDING'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      CHECK (conveyor_snapshot IS NULL OR length(trim(conveyor_snapshot)) > 0),
      FOREIGN KEY (patta_hisob_id) REFERENCES patta_hisob (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_sheets_live_entered
      ON patta_sheets (entered_at, id) WHERE deleted_at IS NULL;
    CREATE INDEX ix_patta_sheets_trash
      ON patta_sheets (deleted_at DESC, id) WHERE deleted_at IS NOT NULL;

    CREATE TABLE patta_sheet_operation_snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      patta_sheet_id TEXT NOT NULL,
      model_operation_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('PATTA', 'CUSTOM')),
      source_patta_operation_snapshot_id TEXT,
      operation_name_snapshot TEXT NOT NULL CHECK (length(trim(operation_name_snapshot)) > 0),
      unit_price_snapshot TEXT NOT NULL CHECK (length(unit_price_snapshot) > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      created_at TEXT NOT NULL,
      ownership_state TEXT NOT NULL DEFAULT 'LOCAL_PENDING'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      UNIQUE (patta_sheet_id, model_operation_id),
      CHECK (
        (source_type = 'PATTA' AND source_patta_operation_snapshot_id IS NOT NULL) OR
        (source_type = 'CUSTOM' AND source_patta_operation_snapshot_id IS NULL)
      ),
      FOREIGN KEY (patta_sheet_id) REFERENCES patta_sheets (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (model_operation_id) REFERENCES model_operations (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (source_patta_operation_snapshot_id) REFERENCES patta_operation_snapshots (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX ix_patta_sheet_operation_snapshots_order
      ON patta_sheet_operation_snapshots (patta_sheet_id, sort_order, model_operation_id);

    CREATE TABLE patta_sheet_rows (
      id TEXT NOT NULL PRIMARY KEY,
      patta_sheet_id TEXT NOT NULL,
      patta_sheet_operation_snapshot_id TEXT NOT NULL,
      worker_id TEXT NOT NULL CHECK (length(worker_id) > 0 AND worker_id NOT GLOB '*[^0-9]*'),
      quantity_snapshot INTEGER NOT NULL CHECK (quantity_snapshot > 0),
      nuqson INTEGER NOT NULL DEFAULT 0 CHECK (nuqson IN (0, 1)),
      entered_badge_number TEXT,
      deleted_at TEXT,
      deleted_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ownership_state TEXT NOT NULL DEFAULT 'LOCAL_PENDING'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      FOREIGN KEY (patta_sheet_id) REFERENCES patta_sheets (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (patta_sheet_operation_snapshot_id) REFERENCES patta_sheet_operation_snapshots (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (worker_id) REFERENCES workers (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_patta_sheet_rows_active_operation
      ON patta_sheet_rows (patta_sheet_id, patta_sheet_operation_snapshot_id)
      WHERE deleted_at IS NULL;
    CREATE INDEX ix_patta_sheet_rows_worker
      ON patta_sheet_rows (worker_id, patta_sheet_id);
    CREATE INDEX ix_patta_sheet_rows_trash
      ON patta_sheet_rows (patta_sheet_id, deleted_at) WHERE deleted_at IS NOT NULL;

    CREATE TABLE entry_buffer (
      patta_hisob_id TEXT NOT NULL PRIMARY KEY,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      entered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (patta_hisob_id) REFERENCES patta_hisob (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TRIGGER trg_patta_sheets_entered_immutable
      BEFORE UPDATE ON patta_sheets
      WHEN NEW.id <> OLD.id OR NEW.patta_hisob_id <> OLD.patta_hisob_id
        OR NEW.entered_at <> OLD.entered_at OR NEW.business_date <> OLD.business_date
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet identity and entered_at are immutable'); END;
    CREATE TRIGGER trg_patta_sheets_trash_before_delete
      BEFORE DELETE ON patta_sheets WHEN OLD.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM sync_tombstones tombstone
        WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = OLD.id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet must be trashed before purge'); END;
    CREATE TRIGGER trg_patta_sheet_snapshots_immutable_update
      BEFORE UPDATE ON patta_sheet_operation_snapshots
      WHEN NEW.id <> OLD.id OR NEW.patta_sheet_id <> OLD.patta_sheet_id
        OR NEW.model_operation_id <> OLD.model_operation_id OR NEW.source_type <> OLD.source_type
        OR NEW.source_patta_operation_snapshot_id IS NOT OLD.source_patta_operation_snapshot_id
        OR NEW.operation_name_snapshot <> OLD.operation_name_snapshot
        OR NEW.unit_price_snapshot <> OLD.unit_price_snapshot OR NEW.sort_order <> OLD.sort_order
        OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet operation snapshots are immutable'); END;
    CREATE TRIGGER trg_patta_sheet_snapshots_purge_only
      BEFORE DELETE ON patta_sheet_operation_snapshots
      WHEN (SELECT deleted_at FROM patta_sheets WHERE id = OLD.patta_sheet_id) IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = OLD.patta_sheet_id
        )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet operation snapshots can be deleted only during purge'); END;
    CREATE TRIGGER trg_patta_sheet_rows_same_parent_snapshot
      BEFORE INSERT ON patta_sheet_rows
      WHEN NOT EXISTS (
        SELECT 1 FROM patta_sheet_operation_snapshots snapshot
        WHERE snapshot.id = NEW.patta_sheet_operation_snapshot_id
          AND snapshot.patta_sheet_id = NEW.patta_sheet_id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row operation snapshot belongs to another Entry'); END;
    CREATE TRIGGER trg_patta_sheet_rows_identity_immutable
      BEFORE UPDATE ON patta_sheet_rows
      WHEN NEW.id <> OLD.id OR NEW.patta_sheet_id <> OLD.patta_sheet_id
        OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row identity is immutable'); END;
    CREATE TRIGGER trg_patta_sheet_rows_quantity_matches_patta_insert
      BEFORE INSERT ON patta_sheet_rows
      WHEN (
        SELECT patta.ish_soni FROM patta_sheets sheet
        JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
        WHERE sheet.id = NEW.patta_sheet_id
      ) IS NULL OR NEW.quantity_snapshot <> (
        SELECT patta.ish_soni FROM patta_sheets sheet
        JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
        WHERE sheet.id = NEW.patta_sheet_id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet quantity must match Patta product quantity'); END;
    CREATE TRIGGER trg_patta_sheet_rows_quantity_matches_patta_update
      BEFORE UPDATE OF quantity_snapshot ON patta_sheet_rows
      WHEN (
        SELECT patta.ish_soni FROM patta_sheets sheet
        JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
        WHERE sheet.id = NEW.patta_sheet_id
      ) IS NULL OR NEW.quantity_snapshot <> (
        SELECT patta.ish_soni FROM patta_sheets sheet
        JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
        WHERE sheet.id = NEW.patta_sheet_id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet quantity must match Patta product quantity'); END;
    CREATE TRIGGER trg_patta_sheet_rows_purge_only
      BEFORE DELETE ON patta_sheet_rows
      WHEN (SELECT deleted_at FROM patta_sheets WHERE id = OLD.patta_sheet_id) IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = OLD.patta_sheet_id
        )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet rows can be deleted only during purge'); END;
  `)

  const violations = database.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) throw new Error('Patta Sheet SQLite migration left foreign-key violations')
}

export const pattaSheetsMigration: SqliteMigration = {
  version: 4,
  name: 'patta-sheets',
  up: addPattaSheets
}
