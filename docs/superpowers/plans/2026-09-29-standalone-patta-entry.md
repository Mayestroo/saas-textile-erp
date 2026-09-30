# Standalone Patta Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved OFF/Standalone Patta Entry mode while keeping linked Patta assignment quantity and identity invariants unchanged.

**Architecture:** Extend the existing Patta Sheet aggregate with an explicit `PATTA_LINKED | STANDALONE` kind. The linked path still resolves a real Partiya/Patta pair. The standalone path snapshots a selected model, positive operator-entered `ish_soni`, optional display metadata, model operation prices, and assignments without creating a fake Patta. Both modes use the same row, history, trash/restore/purge, audit, and two-way sync lifecycle.

**Tech Stack:** NestJS, additive PostgreSQL migrations, `@textile/sync-protocol`, Electron main/preload, SQLite numbered migrations, React, Vitest.

## Global Constraints

- Work only on `feature/desktop-ui-ux`.
- Do not create fake Pattas or consume either number allocator for Standalone Entry.
- For linked rows, `quantity_snapshot === patta_hisob.ish_soni`; do not make Patta `ish_soni` editable.
- Every Entry keeps immutable `entered_at` and tenant-timezone `business_date`.
- Worker identity stays `worker_id`; badge resolution is local and timestamp-based.
- Operation `unit_price_snapshot` is immutable and effective at Entry `entered_at`.
- Preserve linked one-Patta-one-Entry uniqueness; Standalone metadata values are informational, not Patta keys.
- All offline writes commit local state and stable sync event IDs atomically; API validates again.

## Execution Status — 2026-09-30

- Core protocol, API, SQLite, sync, renderer, and documentation changes are implemented.
- PostgreSQL validation passed: Master DB 12 tests, tenant provisioning 7 tests, Standalone/Patta Sheet migration 3 targeted tests, and sync integration 21 tests.
- The sync integration spawned the Electron two-PC acceptance and desktop tenant-auth suites; all 3 acceptance tests passed, including PC-1 Standalone Entry → PC-2 pull and manual adjustment → PC-2 pull.
- API/Desktop typecheck and production builds passed; API lint passed. Desktop lint exited successfully with existing Prettier/line-ending warnings. Electron’s full interactive UI has not been manually launched.

## File map

- Shared contract: `packages/sync-protocol/src/index.ts` (protocol V3, preserving V1/V2 types).
- Tenant persistence/service: new additive `database/tenant-migrations/20260929001200-AddStandalonePattaEntries.js` (auto-discovered by `apps/api/src/database/tenant/tenant-database.config.ts`), linked-only V2 adapters, new V3 Patta Sheet controller/DTO, `patta-sheets.service.ts`, new service/handler tests.
- Desktop local persistence/service: new `apps/desktop/src/main/database/migrations/006-standalone-patta-entries.ts`, `src/main/database/sqlite-database.ts`, `src/main/local/patta-sheet.repository.ts`, `patta-sheet.service.ts`, `model-local.repository.ts`.
- Sync and IPC: `apps/api/src/tenant/sync/*`, `apps/desktop/src/main/sync/*`, `src/main/ipc/register-ipc-handlers.ts`, `src/preload/erp-api.ts`.
- Renderer: `apps/desktop/src/renderer/src/pages/PattaEntryPage.tsx` and focused page tests (implemented in renderer plan after this contract).

### Task 1: Shared types and linked/standalone validation tests

**Interface produced:**

In `packages/sync-protocol/src/index.ts`, rename the current sheet projection to `PattaSheetProjectionV2` with all existing fields unchanged. Keep the existing V2 operation-snapshot source union unchanged. The new interface below is V3; the Desktop current UI/main-process consumers use V3 types.

```ts
type PattaSheetEntryKind = 'PATTA_LINKED' | 'STANDALONE'

interface PattaSheetProjectionV3 {
  id: string
  entry_kind: PattaSheetEntryKind
  patta_hisob_id: string | null
  model_id: string
  model_name_snapshot: string
  ish_soni: number
  partiya_number_snapshot: string | null
  patta_number_snapshot: string | null
  rang_snapshot: string | null
  razmer_snapshot: string | null
  entered_at: string
  business_date: string
  conveyor_snapshot: string | null
  version: string
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
  deleted_by_name_snapshot: string | null
  operation_snapshots: readonly PattaSheetOperationSnapshotProjectionV3[]
  rows: readonly PattaSheetRowProjection[]
}

interface PattaSheetOperationSnapshotProjectionV3 {
  id: string
  patta_sheet_id: string
  model_operation_id: string
  source_type: 'PATTA' | 'MODEL' | 'CUSTOM'
  source_patta_operation_snapshot_id: string | null
  operation_name_snapshot: string
  unit_price_snapshot: string
  sort_order: number
  created_at: string
}

interface PattaSheetRowProjection {
  id: string
  patta_sheet_id: string
  patta_sheet_operation_snapshot_id: string
  worker_id: string
  quantity_snapshot: number
  nuqson: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

interface DesktopModelOperationOption {
  model_operation_id: string
  operation_name_snapshot: string
  unit_price_snapshot: string
  sort_order: number
  version: string
}
```

Define `SyncProjectionV3` as the V1/V2 projection unions plus the V3 `patta_sheets` and manual-adjustment projections. `SyncChange.projection_version` accepts `1 | 2 | 3`; V1/V2 event and projection interfaces stay unchanged.

- [ ] Add protocol V3 tests/types for linked and standalone projection and mutation payloads while leaving V1/V2 types unchanged. `PATTA` snapshots require Patta source IDs; standalone `MODEL` snapshots have no Patta source ID; `CUSTOM` remains existing model-operation creation.
- [ ] Add service test cases: linked create rejects mismatched model/Patta metadata and keeps Patta quantity; standalone create requires active model, positive `ish_soni`, operation belonging to that model, and allows null Partiya/Patta/Rang/Razmer.
- [ ] Add a test that OFF never invokes `pattaSheet.lookup`, even if both informational numbers are entered:

```ts
expect(api.pattaSheet.lookup).not.toHaveBeenCalled()
expect(api.pattaSheet.create).toHaveBeenCalledWith(expect.objectContaining({
  entry_kind: 'STANDALONE',
  patta_hisob_id: null,
  partiya_number_snapshot: '9',
  patta_number_snapshot: '100',
  ish_soni: 125
}))
```
- [ ] Extend protocol validators to reject invalid discriminator/source/nullable-FK combinations.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/patta-sheets/patta-sheets.service.spec.ts` and `npm run test --workspace=apps/desktop -- src/main/local/patta-sheet.service.spec.ts`.

### Task 2: Additive PostgreSQL migration

**Files:**
- Create: `database/tenant-migrations/20260929001200-AddStandalonePattaEntries.js`; in the same transaction replace the bootstrap-session protocol check with `protocol_version IN (1,2,3)`.
- Migration discovery: `apps/api/src/database/tenant/tenant-database.config.ts` already globs `database/tenant-migrations/*.js`; no registry edit is needed.
- Extend: `apps/api/src/tenant/patta/patta.integration.spec.ts` reusing its isolated tenant database fixture for schema/backfill/trigger assertions.
- Modify: `apps/api/package.json` to add a focused `test:patta-sheets` script.

- [ ] Write a migration test that first creates linked rows with current migration `20260928001100`, applies the new migration, and verifies every old sheet remains `PATTA_LINKED` and retains its Patta FK, rows, and snapshots.

```ts
const rows = await dataSource.query(
  `SELECT "entry_kind", "patta_hisob_id"::text AS "patta_hisob_id", "ish_soni"
   FROM "patta_sheets" WHERE "id" = $1`,
  [sheetId],
)
expect(rows[0]).toEqual({ entry_kind: 'PATTA_LINKED', patta_hisob_id: pattaId, ish_soni: 125 })
```

- [ ] Make `patta_sheets.patta_hisob_id` nullable, replace the unconditional unique constraint with a partial unique constraint for non-null Patta IDs, and add an entry-kind consistency check.
- [ ] Add model ID/name and positive `ish_soni` snapshots plus nullable Partiya/Patta/Rang/Razmer snapshots; backfill existing linked rows from `patta_hisob` before enforcing non-null model/quantity fields.
- [ ] Extend source-type constraints to `PATTA`, `MODEL`, and `CUSTOM`; `MODEL` and `CUSTOM` have no Patta snapshot source. Replace all three sheet trigger-function bodies: parent identity/model/quantity/lifecycle guard, operation source/model guard, and row quantity guard. Recreate the parent trigger with `INSERT` included; the previous operation/row functions inner-join `patta_hisob` and therefore reject valid nullable-FK Standalone entries.
- [ ] Keep linked quantity corrections authorized only by the existing correction ledgers; row quantity validation uses the Patta snapshot for linked sheets and the immutable sheet `ish_soni` for Standalone sheets.
- [ ] Add `deleted_by_name_snapshot`; set it only on trash and preserve it in sync projection. Existing rows without historical name data remain null.
- [ ] Test linked unique-Pata behavior, multiple Standalone entries with null Patta FK, FK and trigger failures, model/operation validation, backfill preservation, and migration rollback guards.
- [ ] Run `npm run test:patta-sheets --workspace=apps/api`; if test database settings are absent, report the integration suite as skipped/blocked, not passed.

### Task 3: Additive SQLite migration and repositories

**Files:**
- Create: `apps/desktop/src/main/database/migrations/006-standalone-patta-entries.ts`
- Modify: `apps/desktop/src/main/database/sqlite-database.ts`, `src/main/local/patta-sheet.repository.ts`, `src/main/local/model-account.repository.ts`, and migration/repository specs.

- [ ] Add a migration test with an existing v5 database containing linked Pattas, Sheets, queue entries, badge evidence, and tombstones; run v6 and assert all records and `user_version` are preserved.
- [ ] Rebuild `patta_sheets` transactionally to allow a null Patta FK, add the entry discriminator/snapshots and linked-only uniqueness, recreate indexes/triggers, and run `PRAGMA foreign_key_check`.
- [ ] Preserve `entry_buffer` linked FK semantics; do not bind an unlinked draft to a fake Patta. Keep Standalone form state in renderer until the final local create transaction.
- [ ] Update `PattaSheetRepository` insert/update/read/server-projection paths for the new projection and return local ownership state exactly as before.
- [ ] Extend `ModelAccountRepository` to derive model identity from the Sheet snapshot for Standalone rows and from the Patta for linked rows; keep grouping key `(model_id, model_operation_id, worker_id)`.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/database/sqlite-database.spec.ts src/main/local/patta-sheet.repository.spec.ts src/main/local/model-account.repository.spec.ts`.

### Task 4: Local-first Standalone Entry service

**Files:**
- Modify: `apps/desktop/src/main/local/patta-sheet.service.ts`, `model-local.repository.ts`, and their `*.spec.ts` files.

- [ ] Add a failing unit test that Standalone create snapshots active model operation prices at `entered_at`, persists each row with quantity equal to the input header `ish_soni`, and enqueues one stable sync event in the same SQLite transaction.
- [ ] Add tests that missing/inactive model, missing price, wrong-model operation, invalid/unknown badge, and non-positive quantity roll back the entire local write and queue event.
- [ ] Implement separate linked and standalone branches in the service: linked still obtains metadata from Patta; standalone consumes an explicit active model, positive quantity, optional metadata, and informational Partiya/Patta strings without calling Patta lookup.
- [ ] Expose `window.erp.pattaSheet.modelOperations(modelId, enteredAt): Promise<readonly DesktopModelOperationOption[]>` backed by `ModelLocalRepository.snapshotAt({ model_id: modelId, occurred_at: enteredAt })`; validate and return only operation identity/name/effective-price/order/version.
- [ ] Expose `window.erp.pattaSheet.get(sheetId): Promise<DesktopPattaSheetHistoryItem | null>` through a narrow typed IPC so History/Edit can reopen standalone entries without a Partiya/Patta key.
- [ ] Resolve every badge at immutable `entered_at` and persist permanent `worker_id`; do not save a successful Entry with unresolved badges.
- [ ] For custom operations, continue using `PattaSheetCustomOperationRepository` and existing `model_operation` dependency events; standalone source rows use `MODEL` or `CUSTOM`, not a fabricated `PATTA` source.
- [ ] Add tests for Standalone edit preserving `entry_kind`, `entered_at`, worker IDs, and unit-price snapshots; trash/restore/purge uses existing version and queue semantics.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/local/patta-sheet.service.spec.ts src/main/local/patta-sheet-custom-operation.repository.spec.ts`.

### Task 5: API validation, sync bootstrap/push/pull

**Files:**
- Create: `apps/api/src/tenant/patta-sheets/patta-sheets-v3.controller.ts` and V3 input/lifecycle DTOs under `apps/api/src/tenant/patta-sheets/dto/`.
- Modify: existing V2 controller/DTO adapters, `patta-sheets.module.ts`, `patta-sheets.service.ts`, `patta-sheet-sync-handler.ts`, sync service/processor/bootstrap/registry/module/controller files, four sync DTOs, and focused specs.
- Modify: `apps/desktop/src/main/local/sync-queue.repository.ts`, `reference-mirror.repository.ts`, `src/main/sync/rest-sync-transport.ts`, `sync-protocol.validation.ts`, and their specs.

- [ ] Add server tests that linked and Standalone DTOs validate different required metadata while both reject operation/model mismatch, missing workers, invalid price snapshots, and row quantity mismatch.
- [ ] Validate Standalone model and active operation against authoritative tenant rows; validate submitted price snapshot against `OperationPriceService.resolvePrice(model_operation_id, entered_at)`.
- [ ] Derive `business_date` from the company timezone and verify the submitted date; keep `entered_at` immutable.
- [ ] Include `deleted_by_name_snapshot` when soft trash occurs and return it in the typed projection; do not change old sheet snapshots on restore.
- [ ] Add SyncProtocolVersion 3 and a V3 projection union that includes existing V1/V2 entity projections plus the Standalone Patta Sheet shape. Update the four sync DTO enums and bootstrap-session protocol constraint; keep V1/V2 request behavior unchanged.
- [ ] Add the V3 projection/event type to bootstrap ordering, push registry, pull mirror, and local queued-event parser. Update Desktop transport to send protocol version 3. Reuse current event processor, processed-event idempotency, cursor, and tombstones; do not create a parallel sync path.
- [ ] Preserve V2 linked-Entry compatibility: map a V2 linked event to the V3 internal record using the authoritative Patta row, and adapt a V3 linked pull projection back to the exact old V2 response shape. Reject a Standalone mutation from a V2 client.
- [ ] If a V2 pull/bootstrap would encounter a Standalone projection, return `SYNC_PROTOCOL_UPGRADE_REQUIRED` without advancing the V2 cursor; V3 clients exchange linked and Standalone records.
- [ ] Keep `/api/v2/patta-sheets` linked-only with its current request/response shape. Add Standalone-capable create/get/update/trash/restore/purge REST methods under `/api/v3/patta-sheets`; use existing `patta_varaq.*` permission checks.
- [ ] Add acceptance tests for V2 linked Entry compatibility, V2 upgrade-required on Standalone data/cursor preservation, duplicate V3 event retry, PC-1 Standalone create/PC-2 V3 pull, price history change after create, badge reassignment history, stale edit conflict, and trash/restore propagation.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/patta-sheets/patta-sheets.service.spec.ts src/tenant/sync/patta-sheet-sync-handler.spec.ts`, `npm run test:sync --workspace=apps/api`, and desktop focused sync tests.
- [ ] Commit as `feat: add standalone Patta Entry mode` after applicable tests pass.
