import type Database from 'better-sqlite3'
import type { SqliteMigration } from '../sqlite-migration-runner'

function updateImmutableIdentityTrigger(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS trg_patta_sheets_entered_immutable;
    CREATE TRIGGER trg_patta_sheets_entered_immutable
      BEFORE UPDATE ON patta_sheets
      WHEN NEW.id <> OLD.id OR NEW.patta_hisob_id <> OLD.patta_hisob_id
        OR NEW.entered_at <> OLD.entered_at OR NEW.business_date <> OLD.business_date
        OR ((NEW.created_by IS NOT OLD.created_by OR NEW.created_at <> OLD.created_at)
          AND NOT (OLD.ownership_state IN ('LOCAL_PENDING', 'SYNCING') AND NEW.ownership_state = 'SERVER_SYNCED'))
      BEGIN SELECT RAISE(ABORT, 'Patta Sheet identity and entered_at are immutable'); END;
  `)
}

export const pattaSheetSyncMetadataMigration: SqliteMigration = {
  version: 5,
  name: 'patta-sheet-sync-metadata',
  up(database) {
    updateImmutableIdentityTrigger(database)
  }
}
