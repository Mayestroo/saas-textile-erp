import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function rebuildPattaSheetsForStandalone(database: Database.Database): void {
  database.pragma('defer_foreign_keys = ON')
  database.exec(`
    CREATE TEMP TABLE _patta_sheets_v5 AS
      SELECT sheet.id, 'PATTA_LINKED' AS entry_kind, sheet.patta_hisob_id,
        patta.model_id, patta.model_name_snapshot, patta.ish_soni,
        patta.partiya_number AS partiya_number_snapshot,
        patta.patta_number AS patta_number_snapshot,
        patta.rang AS rang_snapshot, patta.razmer AS razmer_snapshot,
        sheet.entered_at, sheet.business_date, sheet.conveyor_snapshot, sheet.version,
        sheet.created_by, sheet.created_at, sheet.updated_at, sheet.deleted_at, sheet.deleted_by,
        NULL AS deleted_by_name_snapshot, sheet.ownership_state, sheet.server_sequence
      FROM patta_sheets sheet
      LEFT JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id;
    CREATE TEMP TABLE _patta_sheet_operations_v5 AS SELECT * FROM patta_sheet_operation_snapshots;
    CREATE TEMP TABLE _patta_sheet_rows_v5 AS SELECT * FROM patta_sheet_rows;

    DROP TRIGGER IF EXISTS trg_patta_sheets_entered_immutable;
    DROP TRIGGER IF EXISTS trg_patta_sheets_trash_before_delete;
    DROP TRIGGER IF EXISTS trg_patta_sheet_snapshots_immutable_update;
    DROP TRIGGER IF EXISTS trg_patta_sheet_snapshots_purge_only;
    DROP TRIGGER IF EXISTS trg_patta_sheet_rows_same_parent_snapshot;
    DROP TRIGGER IF EXISTS trg_patta_sheet_rows_identity_immutable;
    DROP TRIGGER IF EXISTS trg_patta_sheet_rows_quantity_matches_patta_insert;
    DROP TRIGGER IF EXISTS trg_patta_sheet_rows_quantity_matches_patta_update;
    DROP TRIGGER IF EXISTS trg_patta_sheet_rows_purge_only;

    DROP TABLE patta_sheet_rows;
    DROP TABLE patta_sheet_operation_snapshots;
    DROP TABLE patta_sheets;

    CREATE TABLE patta_sheets (
      id TEXT NOT NULL PRIMARY KEY,
      entry_kind TEXT NOT NULL CHECK (entry_kind IN ('PATTA_LINKED', 'STANDALONE')),
      patta_hisob_id TEXT,
      model_id TEXT NOT NULL,
      model_name_snapshot TEXT NOT NULL CHECK (length(trim(model_name_snapshot)) > 0),
      ish_soni INTEGER NOT NULL CHECK (ish_soni > 0),
      partiya_number_snapshot TEXT,
      patta_number_snapshot TEXT CHECK (
        patta_number_snapshot IS NULL OR
        (length(patta_number_snapshot) > 0 AND patta_number_snapshot NOT GLOB '*[^0-9]*')
      ),
      rang_snapshot TEXT,
      razmer_snapshot TEXT,
      entered_at TEXT NOT NULL,
      business_date TEXT NOT NULL CHECK (length(business_date) = 10),
      conveyor_snapshot TEXT,
      version TEXT NOT NULL CHECK (length(version) > 0 AND version NOT GLOB '*[^0-9]*'),
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT,
      deleted_by_name_snapshot TEXT,
      ownership_state TEXT NOT NULL DEFAULT 'LOCAL_PENDING'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      CHECK ((entry_kind = 'PATTA_LINKED' AND patta_hisob_id IS NOT NULL) OR
        (entry_kind = 'STANDALONE' AND patta_hisob_id IS NULL)),
      CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      CHECK (deleted_by_name_snapshot IS NULL OR deleted_at IS NOT NULL),
      CHECK (conveyor_snapshot IS NULL OR length(trim(conveyor_snapshot)) > 0),
      CHECK (partiya_number_snapshot IS NULL OR length(trim(partiya_number_snapshot)) > 0),
      CHECK (rang_snapshot IS NULL OR length(trim(rang_snapshot)) > 0),
      CHECK (razmer_snapshot IS NULL OR length(trim(razmer_snapshot)) > 0),
      FOREIGN KEY (patta_hisob_id) REFERENCES patta_hisob (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY (model_id) REFERENCES models (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE UNIQUE INDEX uq_patta_sheets_patta
      ON patta_sheets (patta_hisob_id) WHERE patta_hisob_id IS NOT NULL;
    CREATE INDEX ix_patta_sheets_live_entered
      ON patta_sheets (entered_at, id) WHERE deleted_at IS NULL;
    CREATE INDEX ix_patta_sheets_trash
      ON patta_sheets (deleted_at DESC, id) WHERE deleted_at IS NOT NULL;

    CREATE TABLE patta_sheet_operation_snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      patta_sheet_id TEXT NOT NULL,
      model_operation_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('PATTA', 'MODEL', 'CUSTOM')),
      source_patta_operation_snapshot_id TEXT,
      operation_name_snapshot TEXT NOT NULL CHECK (length(trim(operation_name_snapshot)) > 0),
      unit_price_snapshot TEXT NOT NULL CHECK (length(unit_price_snapshot) > 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      created_at TEXT NOT NULL,
      ownership_state TEXT NOT NULL DEFAULT 'LOCAL_PENDING'
        CHECK (ownership_state IN ('LOCAL_PENDING', 'SYNCING', 'SERVER_SYNCED', 'CONFLICT', 'FAILED')),
      server_sequence TEXT,
      UNIQUE (patta_sheet_id, model_operation_id),
      CHECK ((source_type = 'PATTA' AND source_patta_operation_snapshot_id IS NOT NULL) OR
        (source_type IN ('MODEL', 'CUSTOM') AND source_patta_operation_snapshot_id IS NULL)),
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
    CREATE INDEX ix_patta_sheet_rows_worker ON patta_sheet_rows (worker_id, patta_sheet_id);
    CREATE INDEX ix_patta_sheet_rows_trash
      ON patta_sheet_rows (patta_sheet_id, deleted_at) WHERE deleted_at IS NOT NULL;

    INSERT INTO patta_sheets (
      id, entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
      partiya_number_snapshot, patta_number_snapshot, rang_snapshot, razmer_snapshot,
      entered_at, business_date, conveyor_snapshot, version, created_by, created_at,
      updated_at, deleted_at, deleted_by, deleted_by_name_snapshot, ownership_state, server_sequence
    )
    SELECT id, entry_kind, patta_hisob_id, model_id, model_name_snapshot, ish_soni,
      partiya_number_snapshot, patta_number_snapshot, rang_snapshot, razmer_snapshot,
      entered_at, business_date, conveyor_snapshot, version, created_by, created_at,
      updated_at, deleted_at, deleted_by, deleted_by_name_snapshot, ownership_state, server_sequence
    FROM _patta_sheets_v5;

    INSERT INTO patta_sheet_operation_snapshots (
      id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
      operation_name_snapshot, unit_price_snapshot, sort_order, created_at, ownership_state, server_sequence
    )
    SELECT id, patta_sheet_id, model_operation_id, source_type, source_patta_operation_snapshot_id,
      operation_name_snapshot, unit_price_snapshot, sort_order, created_at, ownership_state, server_sequence
    FROM _patta_sheet_operations_v5;

    INSERT INTO patta_sheet_rows (
      id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
      nuqson, entered_badge_number, deleted_at, deleted_by, created_at, updated_at,
      ownership_state, server_sequence
    )
    SELECT id, patta_sheet_id, patta_sheet_operation_snapshot_id, worker_id, quantity_snapshot,
      nuqson, entered_badge_number, deleted_at, deleted_by, created_at, updated_at,
      ownership_state, server_sequence
    FROM _patta_sheet_rows_v5;

    DROP TABLE _patta_sheet_rows_v5;
    DROP TABLE _patta_sheet_operations_v5;
    DROP TABLE _patta_sheets_v5;

    CREATE TRIGGER trg_patta_sheets_validate_insert
      BEFORE INSERT ON patta_sheets
      WHEN (NEW.entry_kind = 'PATTA_LINKED' AND NOT EXISTS (
        SELECT 1 FROM patta_hisob patta
        WHERE patta.id = NEW.patta_hisob_id
          AND patta.status = 'ACTIVE'
          AND patta.ish_soni = NEW.ish_soni AND patta.model_id = NEW.model_id
          AND patta.model_name_snapshot = NEW.model_name_snapshot
          AND patta.partiya_number = NEW.partiya_number_snapshot
          AND patta.patta_number = NEW.patta_number_snapshot
          AND patta.rang IS NEW.rang_snapshot AND patta.razmer IS NEW.razmer_snapshot
      )) OR (NEW.entry_kind = 'STANDALONE' AND NOT EXISTS (
        SELECT 1 FROM models model WHERE model.id = NEW.model_id
      ))
      BEGIN SELECT RAISE(ABORT, 'Patta Entry model or linked Patta snapshot is invalid'); END;

    CREATE TRIGGER trg_patta_sheets_entered_immutable
      BEFORE UPDATE ON patta_sheets
      WHEN NEW.id IS NOT OLD.id OR NEW.entry_kind IS NOT OLD.entry_kind
        OR NEW.patta_hisob_id IS NOT OLD.patta_hisob_id OR NEW.model_id IS NOT OLD.model_id
        OR NEW.model_name_snapshot IS NOT OLD.model_name_snapshot
        OR NEW.partiya_number_snapshot IS NOT OLD.partiya_number_snapshot
        OR NEW.patta_number_snapshot IS NOT OLD.patta_number_snapshot
        OR NEW.rang_snapshot IS NOT OLD.rang_snapshot OR NEW.razmer_snapshot IS NOT OLD.razmer_snapshot
        OR NEW.entered_at IS NOT OLD.entered_at OR NEW.business_date IS NOT OLD.business_date
        OR (NEW.ish_soni IS NOT OLD.ish_soni AND NOT (
          OLD.entry_kind = 'PATTA_LINKED' AND NEW.ownership_state = 'SERVER_SYNCED'
          AND EXISTS (SELECT 1 FROM patta_hisob patta
            WHERE patta.id = OLD.patta_hisob_id AND patta.ish_soni = NEW.ish_soni)
        ))
        OR ((NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at)
          AND NOT (OLD.ownership_state IN ('LOCAL_PENDING', 'SYNCING') AND NEW.ownership_state = 'SERVER_SYNCED'))
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet identity and Entry snapshots are immutable'); END;

    CREATE TRIGGER trg_patta_sheets_trash_before_delete
      BEFORE DELETE ON patta_sheets WHEN OLD.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM sync_tombstones tombstone
        WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = OLD.id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet must be trashed before purge'); END;

    CREATE TRIGGER trg_patta_sheets_deleted_actor_lifecycle
      BEFORE UPDATE ON patta_sheets
      WHEN (NEW.deleted_at IS OLD.deleted_at AND (
          NEW.deleted_by IS NOT OLD.deleted_by OR
          (NEW.deleted_by_name_snapshot IS NOT OLD.deleted_by_name_snapshot
            AND NEW.ownership_state <> 'SERVER_SYNCED')
        )) OR
        (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND
          (NEW.deleted_by IS NOT NULL OR NEW.deleted_by_name_snapshot IS NOT NULL))
      BEGIN SELECT RAISE(ABORT, 'Patta Entry trash actor changes only with trash or restore'); END;

    CREATE TRIGGER trg_patta_sheet_snapshots_immutable_update
      BEFORE UPDATE ON patta_sheet_operation_snapshots
      WHEN NEW.id IS NOT OLD.id OR NEW.patta_sheet_id IS NOT OLD.patta_sheet_id
        OR NEW.model_operation_id IS NOT OLD.model_operation_id OR NEW.source_type IS NOT OLD.source_type
        OR NEW.source_patta_operation_snapshot_id IS NOT OLD.source_patta_operation_snapshot_id
        OR NEW.operation_name_snapshot IS NOT OLD.operation_name_snapshot
        OR NEW.unit_price_snapshot IS NOT OLD.unit_price_snapshot OR NEW.sort_order IS NOT OLD.sort_order
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet operation snapshots are immutable'); END;

    CREATE TRIGGER trg_patta_sheet_snapshots_validate_insert
      BEFORE INSERT ON patta_sheet_operation_snapshots
      WHEN NOT EXISTS (
        SELECT 1 FROM patta_sheets sheet
        JOIN model_operations operation ON operation.id = NEW.model_operation_id
        WHERE sheet.id = NEW.patta_sheet_id AND sheet.deleted_at IS NULL
          AND operation.model_id = sheet.model_id
          AND ((NEW.source_type = 'PATTA' AND sheet.entry_kind = 'PATTA_LINKED'
            AND EXISTS (
              SELECT 1 FROM patta_operation_snapshots source
              WHERE source.id = NEW.source_patta_operation_snapshot_id
                AND source.patta_hisob_id = sheet.patta_hisob_id
                AND source.operation_id = NEW.model_operation_id
                AND source.operation_name_snapshot = NEW.operation_name_snapshot
                AND source.unit_price_snapshot = NEW.unit_price_snapshot
                AND source.sort_order = NEW.sort_order
            )) OR (NEW.source_type = 'MODEL' AND sheet.entry_kind = 'STANDALONE'
              AND NEW.source_patta_operation_snapshot_id IS NULL) OR
            (NEW.source_type = 'CUSTOM' AND NEW.source_patta_operation_snapshot_id IS NULL))
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet operation source or model is invalid'); END;

    CREATE TRIGGER trg_patta_sheet_snapshots_purge_only
      BEFORE DELETE ON patta_sheet_operation_snapshots
      WHEN (SELECT deleted_at FROM patta_sheets WHERE id = OLD.patta_sheet_id) IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = OLD.patta_sheet_id
        )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet operation snapshots can be deleted only during purge'); END;

    CREATE TRIGGER trg_patta_sheet_rows_same_parent_snapshot_insert
      BEFORE INSERT ON patta_sheet_rows
      WHEN NOT EXISTS (
        SELECT 1 FROM patta_sheet_operation_snapshots snapshot
        WHERE snapshot.id = NEW.patta_sheet_operation_snapshot_id
          AND snapshot.patta_sheet_id = NEW.patta_sheet_id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row operation snapshot belongs to another Entry'); END;
    CREATE TRIGGER trg_patta_sheet_rows_same_parent_snapshot_update
      BEFORE UPDATE ON patta_sheet_rows
      WHEN NOT EXISTS (
        SELECT 1 FROM patta_sheet_operation_snapshots snapshot
        WHERE snapshot.id = NEW.patta_sheet_operation_snapshot_id
          AND snapshot.patta_sheet_id = NEW.patta_sheet_id
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row operation snapshot belongs to another Entry'); END;
    CREATE TRIGGER trg_patta_sheet_rows_identity_immutable
      BEFORE UPDATE ON patta_sheet_rows
      WHEN NEW.id IS NOT OLD.id OR NEW.patta_sheet_id IS NOT OLD.patta_sheet_id
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row identity is immutable'); END;
    CREATE TRIGGER trg_patta_sheet_rows_quantity_matches_entry_insert
      BEFORE INSERT ON patta_sheet_rows
      WHEN NOT EXISTS (
        SELECT 1 FROM patta_sheets sheet
        LEFT JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
        WHERE sheet.id = NEW.patta_sheet_id AND sheet.ish_soni = NEW.quantity_snapshot
          AND (sheet.entry_kind = 'STANDALONE' OR
            (sheet.entry_kind = 'PATTA_LINKED' AND patta.ish_soni = sheet.ish_soni))
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row quantity must match its Entry quantity'); END;
    CREATE TRIGGER trg_patta_sheet_rows_quantity_matches_entry_update
      BEFORE UPDATE OF quantity_snapshot ON patta_sheet_rows
      WHEN NOT EXISTS (
        SELECT 1 FROM patta_sheets sheet
        LEFT JOIN patta_hisob patta ON patta.id = sheet.patta_hisob_id
        WHERE sheet.id = NEW.patta_sheet_id AND sheet.ish_soni = NEW.quantity_snapshot
          AND (sheet.entry_kind = 'STANDALONE' OR
            (sheet.entry_kind = 'PATTA_LINKED' AND patta.ish_soni = sheet.ish_soni))
      )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet row quantity must match its Entry quantity'); END;
    CREATE TRIGGER trg_patta_sheet_rows_purge_only
      BEFORE DELETE ON patta_sheet_rows
      WHEN (SELECT deleted_at FROM patta_sheets WHERE id = OLD.patta_sheet_id) IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sync_tombstones tombstone
          WHERE tombstone.entity_type = 'patta_sheets' AND tombstone.entity_id = OLD.patta_sheet_id
        )
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet rows can be deleted only during purge'); END;
  `)

  const sheetCount = database.prepare('SELECT count(*) AS count FROM patta_sheets').get() as { count: number }
  const missingBackfill = database.prepare(`
    SELECT count(*) AS count FROM patta_sheets
    WHERE model_id IS NULL OR model_name_snapshot IS NULL OR ish_soni IS NULL
  `).get() as { count: number }
  if (sheetCount.count !== 0 && missingBackfill.count !== 0) {
    throw new Error('Standalone Patta Entry migration could not backfill linked sheet snapshots')
  }

  const violations = database.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) throw new Error('Standalone Patta Entry SQLite migration left foreign-key violations')
}

export const standalonePattaEntriesMigration: SqliteMigration = {
  version: 6,
  name: 'standalone-patta-entries',
  up: rebuildPattaSheetsForStandalone
}
