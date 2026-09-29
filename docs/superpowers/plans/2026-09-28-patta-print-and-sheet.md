# Patta Print and Sheet Implementation Plan

> **Status:** User-approved; implementation is in progress on `feature/patta-sheet`.

**Goal:** Correct Patta product quantity semantics and deliver offline-first Patta batch printing, correction/reprint, and Patta Sheet entry with immutable worker/operation history.
<!--

Superseded duplicate architecture note; use the canonical architecture below.

**Architecture:** Patta print batches persist normalized size distribution and individual Pattas atomically; existing Patta operation snapshots stay immutable. A Sheet copies Patta snapshots into one model-scoped sheet-operation snapshot model, stores only `worker_id` as worker identity, and snapshots the Patta product quantity per operation. There is no Sheet finalize/status stage: non-deleted assigned rows immediately feed a derived Model hesab aggregate; entry delete uses Korzinka TRASH/RESTORE/PURGE. Desktop persists print batches and Sheets in the tenant SQLite DB and uses the existing `sync_queue`, SyncEngine, authenticated transport, API event processor, change log, and bootstrap/pull projection path.

-->

**Architecture:** Patta batch corrections/reprints preserve Patta-number history. Patta Entry immediately persists worker-operation assignments with Patta-derived quantity, and the live Model hisob aggregates active rows by stable model operation and worker IDs. Soft delete, restore and permanent purge use the Korzinka lifecycle. Desktop reuses tenant SQLite, the sync queue, SyncEngine, authenticated transport, API event processor, change log and bootstrap/pull path.

**Tech Stack:** NestJS, TypeScript strict mode, PostgreSQL tenant migrations, TypeORM transactions, existing AuditService/RBAC/sync infrastructure, `@textile/sync-protocol`, Electron 44.4.5, React, preload IPC, `better-sqlite3`, Vitest.

## Global Constraints

- Work only on branch `feature/patta-sheet`; never switch to or push `main`.
- Implement only the user-approved design and this plan; record unresolved blockers rather than changing business invariants.
- Do not edit committed migrations; PostgreSQL and SQLite changes are additive migrations.
- Do not delete/recreate tenant SQLite databases or drop existing Patta/worker history.
- `ish_soni` is the Patta product quantity, not an operation count; every new Patta create requires positive `ish_soni`. Protocol-v1 create requests that cannot supply the actual quantity receive an explicit v2-upgrade error and do not create a Patta.
- Preserve old `ish_soni` values as `legacy_operation_count`; do not infer historical product quantity from operation rows.
- `patta_operation_count` is derived from original Patta operation snapshots and never controls product quantity.
- A Patta Sheet has one immutable `entered_at`; `Sana`, badge resolution, and `business_date` use that timestamp. There is no separate production timestamp field.
- `printed_at` records print history and is not a Sheet timestamp.
- Tenant timezone comes from Master `companies.timezone`; default is exactly `Asia/Tashkent`. Do not hard-code a global timezone in business logic.
- `workers.id`/`worker_id` is permanent identity. `badge_number` is only input/verification evidence; `full_name` is display-only.
- Historical badge resolution is `[valid_from, valid_to)` at `entered_at`; push re-resolves badge and compares the submitted `worker_id`.
- Sheet rows store `quantity_snapshot = patta_hisob.ish_soni`; the operator never edits row quantity.
- Operation identity is `(model_id, model_operation_id)`, never operation name. Sheet rows reference only `patta_sheet_operation_snapshots.id`.
- `Nuqson` and `O‘chirish` remain separate actions. Model hisob is a derived aggregate query from non-deleted rows; payroll calculation is out of scope. The second-screen renderer UI remains a review scope decision.
- Business write + audit + change log + processed event result are transactional. Local write + queue event are one SQLite transaction.
- Event UUIDs remain stable over retry. Never mutate a `SYNCING` event; never use last-write-wins for stale versions.
- Electron stays exactly pinned to `44.4.5`; context isolation, disabled node integration, and sandbox remain enabled.
- Renderer receives only narrow typed IPC APIs; SQLite, HTTP tokens, and unrestricted IPC stay in Electron main.
- Normal UI text is Uzbek Latin.

---

## Existing File Map

### Backend

- `database/tenant-migrations/20260926000500-AddPattaFoundation.js`: Patta schema, original immutable operation snapshots, current incorrect `ish_soni` column, required conveyor, and `patta_hisob` immutability trigger.
- `database/tenant-migrations/20260926000600-AddOfflineSyncInfrastructure.js`: processed event idempotency, server change log, bootstrap tables, and offline Patta timestamps.
- `apps/api/src/tenant/patta/patta.service.ts`: online Patta generation, lookup, offline registration, audit, and Patta/snapshot change recording.
- The legacy offline validator derives no quantity for v1 payloads; a required actual `ish_soni` is accepted only by the explicit v2 offline batch contract.
- `apps/api/src/tenant/patta/dto/generate-patta.dto.ts`: current one-size `count` request; no product count or size distribution.
- `apps/api/src/tenant/sync/{sync-event-processor,sync-handler.registry,sync-projections,sync-bootstrap-projections,sync-bootstrap.service,sync.service}.ts`: one supported `patta/CREATE`, strict projection v1, pull, and bootstrap.
- `apps/api/src/tenant/audit/audit.service.ts`, `apps/api/src/tenant/rbac/tenant-permission.seed.ts`, and `apps/api/src/database/tenant/tenant-database-manager.ts`: audit catalog, permissions, and runtime grants to extend.
- `apps/api/src/master/companies/{company.entity.ts,companies.service.ts}`: existing validated Master company IANA timezone; `companies.timezone` defaults to `Asia/Tashkent`.
- `apps/api/src/tenant/tenant-resolver/{master-tenant-lookup.service.ts,tenant-resolver.service.ts}` and `apps/api/src/tenant/auth/{tenant-auth.service.ts,require-tenant-context.ts}`: current trusted tenant context does not carry timezone.

### Desktop/shared

- `apps/desktop/src/main/database/migrations/001-sync-foundation.ts` and `002-tenant-ownership.ts`: SQLite mirror and tenant ownership.
- `apps/desktop/src/main/database/{sqlite-database.ts,tenant-database-manager.ts}`: migration registration and business-table ownership checks.
- `apps/desktop/src/main/local/{offline-patta.service.ts,patta-local.repository.ts,local-patta.types.ts,sync-queue.repository.ts,reference-mirror.repository.ts,bootstrap-staging.repository.ts}`: local Patta creation/mirror/queue/pull.
- `apps/desktop/src/main/sync/{sync-protocol.validation.ts,sync-engine.ts,rest-sync-transport.ts,create-sync-runtime.ts}`: strict response validation, push/pull, bootstrap, and runtime composition.
- `apps/desktop/src/main/auth/{tenant-auth-api-client.ts,desktop-auth.service.ts,secure-session-store.ts,desktop-tenant-runtime.ts}`: session restoration and timezone cache boundary to extend.
- `apps/desktop/src/main/ipc/register-ipc-handlers.ts`, `apps/desktop/src/preload/erp-api.ts`, and `apps/desktop/src/renderer/src/App.tsx`: local-only lookup bridge and authenticated shell; there are no current print or Sheet pages.
- `packages/sync-protocol/src/index.ts`: shared event/projection contracts; do not duplicate contracts in API/desktop.

### Existing verification infrastructure

- PostgreSQL Patta integration: `npm run test:patta --workspace=apps/api`, gated by dedicated `TEST_MASTER_DB_*` settings and generated tenant test databases.
- PostgreSQL sync integration/two-PC harness: `npm run test:sync --workspace=apps/api`.
- Desktop SQLite/Vitest runs under the pinned Electron binary via `npm run test --workspace=apps/desktop`.
- API e2e: `npm run test:e2e --workspace=apps/api`.

## Shared Contract Blueprint

The following shapes are planned shared `@textile/sync-protocol` contracts. Protocol v1 remains for non-Patta reference sync only; all new Patta print/entry flows use protocol v2. Never preserve the old quantity alias as compatibility behavior.

```ts
export interface PattaSizeDistributionItem {
  razmer: string
  patta_count: number
  sort_order: number
}

export interface PattaPrintBatchOperationInput {
  id: string
  model_operation_id: string
  operation_name_snapshot: string
  unit_price_snapshot: string
  sort_order: number
}

export interface OfflinePattaBatchItem {
  id: string
  patta_number: string
  block_id: string
  razmer: string
  operation_snapshots: readonly PattaPrintBatchOperationInput[]
}

export interface PattaPrintBatchCreatePayload {
  model_id: string
  partiya_number: string
  partiya_block_id: string | null
  ish_soni: number
  rang: string
  size_distribution: readonly PattaSizeDistributionItem[]
  pattas: readonly OfflinePattaBatchItem[]
  depends_on_event_ids: readonly string[]
}

export interface CustomModelOperationCreateInput {
  id: string
  model_id: string
  name: string
  initial_price: string
  sort_order: number
  effective_from: string
}

export interface OfflineModelOperationCreateEvent {
  event_id: string
  entity_type: 'model_operation'
  entity_id: string
  operation: 'CREATE'
  base_version: '0'
  client_created_at: string
  occurred_at: string
  reference_cursor: string
  payload: CustomModelOperationCreateInput
}

export interface PattaSheetOperationSnapshotInput {
  id: string
  model_operation_id: string
  source_type: 'PATTA' | 'CUSTOM'
  source_patta_operation_snapshot_id: string | null
  operation_name_snapshot: string
  unit_price_snapshot: string
  sort_order: number
}

export interface PattaSheetRowInput {
  id: string
  patta_sheet_operation_snapshot_id: string
  worker_id: string
  quantity_snapshot: number
  nuqson: boolean
  entered_badge_number: string
  deleted_at: string | null
  deleted_by: string | null
}

export interface PattaSheetAggregatePayload {
  id: string
  patta_hisob_id: string
  entered_at: string
  business_date: string
  conveyor_snapshot: string | null
  version: string
  deleted_at: string | null
  deleted_by: string | null
  operation_snapshots: readonly PattaSheetOperationSnapshotInput[]
  rows: readonly PattaSheetRowInput[]
  depends_on_event_ids: readonly string[]
}
```

`entered_badge_number` is transient validation evidence and never appears in authoritative row storage or a worker identity projection. New Sheet rows use only `worker_id`; quantity comes from the persisted Patta. Event envelope `occurred_at` is set to the immutable `entered_at`. A Sheet/print event depending on a locally-created model operation must list its create-event ID in `depends_on_event_ids`; the existing queue persists this edge and SyncEngine pushes prerequisites first. `printed_at` is recorded by print batch/event contracts only. A successful PUSH DELETE result allows a null projection and returns the last child/parent tombstone sequence.

## Implementation Tasks

### Task 1: Add the legacy-safe Patta quantity migration

**Files:**
- Create: `database/tenant-migrations/20260928000700-CorrectPattaQuantitySemantics.js`
- Test: `apps/api/src/tenant/patta/patta.integration.spec.ts` and `apps/api/src/tenant/patta/patta.service.spec.ts`.
- Modify: `docs/database.md` after the schema passes its PostgreSQL test.

**Interfaces:**
- Existing Patta creation inputs gain a required positive integer `ish_soni`.
- Existing historical rows expose `legacy_operation_count` and nullable actual `ish_soni`.

- [ ] Write the PostgreSQL migration test first: create a Patta with 13 operation snapshots under the old migration, apply the new migration, assert old `ish_soni=13` moved unchanged to `legacy_operation_count` and new `ish_soni IS NULL`.
- [ ] Run the focused integration test with the dedicated `_test` DB; confirm the new migration assertion fails against the old schema.
- [ ] Add the migration: rename old `ish_soni` to `legacy_operation_count`, rename its check constraint, add nullable positive-only `ish_soni`, and widen `konveyer_snapshot` to nullable with a matching nullable canonical check.
- [ ] Make `down()` refuse to drop any actual `ish_soni` value or data protected by the subsequent print/Sheet migrations; verify empty-schema down/up/reapply succeeds.
- [ ] Add PostgreSQL assertions for a new Patta with product quantity 125, a 13-operation snapshot set, and `legacy_operation_count` tracked separately.
- [ ] Run `npm run test:patta --workspace=apps/api`.

### Task 2: Persist print batches and create online size-distribution batches

**Files:**
- Create: `database/tenant-migrations/20260928000800-AddPattaPrintBatches.js`
- Create: `apps/api/src/tenant/patta/{patta-print-batches.service.ts,dto/create-patta-print-batch.dto.ts}`
- Create: `apps/api/src/tenant/patta/patta-print-batches.controller.ts`
- Create: `apps/api/src/tenant/patta/{patta-partiya-number-blocks.service.ts,dto/allocate-patta-partiya-block.dto.ts,dto/report-patta-partiya-block-usage.dto.ts}`
- Modify: `apps/api/src/tenant/patta/patta.config.ts` for validated `PARTIYA_NUMBER_START=1`.
- Modify: `apps/api/src/database/tenant/{tenant-migration-runner.ts,patta-sequence.initializer.ts}` for idempotent Partiya singleton initialization.
- Modify: `apps/api/src/tenant/patta/{patta.module.ts,patta.controller.ts,patta.service.ts}`
- Modify: `apps/api/src/tenant/{audit/audit.service.ts,rbac/tenant-permission.seed.ts}` and `apps/api/src/database/tenant/tenant-database-manager.ts`.
- Tests: `apps/api/src/tenant/patta/{patta.service.spec.ts,patta.e2e-spec.ts,patta.integration.spec.ts,patta-print-batches.service.spec.ts,patta-print-batches.integration.spec.ts}`.

**Interfaces:**
- New route: `POST /api/v2/patta-print-batches` with `{ model_id, ish_soni, rang, size_distribution, device_id, partiya_block_id? }`; Partiya is allocated and never accepted as arbitrary user input. Each size row is `{ razmer, patta_count, sort_order }`; conveyor is not required.
- Existing `/api/v1/patta/generate` and `/api/v1/patta/lookup` return `SYNC_PROTOCOL_UPGRADE_REQUIRED` for Patta mutations/reads; v1 never returns operation count as `ish_soni` or exposes an ambiguous Patta quantity. New Patta generation/lookup uses v2.
- Batch result includes stable batch ID, batch version, size rows and persisted Patta records with each Patta’s own number/razmer and the same item `ish_soni`.

- [ ] Write migration tests for Partiya sequence singleton and block range overlap/owner/monotonic usage, positive item count, canonical/non-empty size, positive `patta_count`, unique `(print_batch_id, razmer)`, Patta-batch FK, runtime grants and up/down/reapply.
- [ ] Create `patta_partiya_number_sequence`, `patta_partiya_number_blocks` with the existing Patta block overlap/ownership/status pattern; add `patta_print_batches`, `patta_print_batch_sizes`, `patta_print_events`, nullable batch FK and `ACTIVE|VOID` Patta status.
- [ ] Add idempotent `PartiyaSequenceInitializer` after tenant migrations using `PARTIYA_NUMBER_START=1`; reuse existing Patta block size and per-device active block limits.
- [ ] Add Master DeviceAccess-validated Partiya block allocate/monotonic-usage API endpoints; do not use `MAX(partiya_number)+1`.
- [ ] Add audit catalog values for batch create, correction, void and print events; add tenant permission seed `patta.chiqarish.correct`.
- [ ] Add `create-patta-print-batch.dto.ts`; validate `ish_soni > 0`, at least one positive size count, canonical unique razmer rows, and total Patta count at or below `PATTA_MAX_BATCH_SIZE`.
- [ ] Add `POST /api/v2/patta-print-batches` with `patta.chiqarish.create`; make v1 Patta generation/lookup return structured upgrade errors while keeping unrelated v1/reference routes operational.
- [ ] Replace one-size online generation with one transaction: lock Partiya sequence then Patta sequence, lock model/active operations, resolve historical prices, allocate one Partiya plus a distinct Patta range, insert batch/sizes/Pattas/snapshots, and record audits/change log. Rollback reverts both sequence increments; committed/printed numbers are never released.
- [ ] Offline batches require one reserved Partiya block plus per-Patta existing Patta-block IDs; cross-block batch consumption remains atomic in local SQLite and the server validates ownership/ranges.
- [ ] Keep operation snapshot count derived only from `patta_operation_snapshots`; do not update `ish_soni` when the model operation set changes.
- [ ] Test Model A batch XS=1/S=1 gets Partiya 1 and Patta numbers 1–2; Model B next batch gets Partiya 2 and Patta numbers 3–4; model changes do not reset either sequence.
- [ ] Test concurrent online batches serialize both sequences; transaction/audit failure rolls batch + both sequences back; two offline devices’ Partiya/Patta blocks never overlap; exhausted Partiya allocation blocks printing only.
- [ ] Test model with 13 operations plus `ish_soni=125` creates each Patta at 125, zero/duplicate sizes reject, old v1 generation without actual quantity is rejected.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/patta/patta.service.spec.ts src/tenant/patta/patta.e2e-spec.ts` and `npm run test:patta --workspace=apps/api`.

### Task 3: Add print correction, VOID lifecycle, and physical print-event recording

**Files:**
- Create: `database/tenant-migrations/20260928001000-AddPattaPrintBatchCorrections.js`
- Create: `apps/api/src/tenant/patta/dto/{correct-patta-print-batch.dto.ts,correct-legacy-patta-quantity.dto.ts,record-patta-print-event.dto.ts}` and a focused batch-correction service under `apps/api/src/tenant/patta/`.
- Modify: `apps/api/src/tenant/patta/{patta.module.ts,patta.controller.ts,patta.service.ts}` and `apps/api/src/tenant/audit/audit.service.ts`.
- Tests: `apps/api/src/tenant/patta/patta-print-corrections.spec.ts`, `patta-print-corrections.e2e-spec.ts`, and PostgreSQL migration/integration coverage.

**Interfaces:**
- `correctBatch(batchId, expectedVersion, correctionReason, { ish_soni, rang, size_distribution }, actor, device)` returns corrected batch revision and active Pattas.
- `recordPrintEvent(batchId, revision, kind, outcome, actor, device)` is append-only; plain reprint never allocates a Patta number.
- HTTP correction boundary: `PATCH /api/v2/patta-print-batches/:id` and one-time legacy quantity correction route under `/api/v2/patta/:id/quantity-correction`; both use tenant `expected_version` and current correction permissions.

- [ ] Write failing tests for stale `expected_version`, active/trashed/purged Sheet use, controlled entry correction, blocked distribution replacement for an in-use Patta, correction audit reason/before/after, and printer retry without new numbers.
- [ ] Add batch revision/reason fields and append-only correction/print-event constraints. Narrow the old Patta immutability trigger only through the versioned correction path; keep operation snapshots immutable.
- [ ] Lock batch, normalized sizes and active Patta rows in deterministic number order inside one transaction; reject duplicate business keys and any number reuse.
- [ ] Reconcile existing Pattas deterministically: keep same-size Pattas by ascending number, remap unmatched active Pattas by size `sort_order`, VOID surplus Pattas, allocate new numbers for deficits.
- [ ] If model or Partiya identity changes, VOID/SUPERSEDE the old batch and Pattas and create a linked replacement batch using fresh numbers; do not rewrite the original Patta identity/snapshot lineage.
- [ ] Add one-time correction for legacy Pattas with `ish_soni IS NULL`: require `patta.chiqarish.correct`, actor and reason; preserve `legacy_operation_count`; record before/after, version and change log; reject a second correction. Keep bulk backfill as a separate privileged maintenance path.
- [ ] Expose legacy quantity correction as a permission-gated online API/IPC action; standard Patta Sheet entry keeps the Patta quantity read-only.
- [ ] If any non-purged Sheet exists, require both `patta.chiqarish.correct` and `patta_varaq.edit`; atomically update parent metadata and all non-deleted row `quantity_snapshot`s, sheet version, audit and change log. Block a correction that would VOID/remap an entry’s Patta with `PATTA_ALREADY_IN_USE`.
- [ ] Record initial print, reprint and corrected reprint attempts with revision and outcome; `printed_at` remains first successful physical print.
- [ ] Test size reduction VOID lifecycle, size increase allocation, model/Partiya replacement, transaction rollback, idempotent print event, audit and no-number-reuse; run Patta PostgreSQL integration.

### Task 4: Propagate the existing company timezone to trusted desktop context

**Files:**
- Modify: `apps/api/src/tenant/tenant-resolver/{master-tenant-lookup.service.ts,tenant-resolver.service.ts}`
- Modify: `apps/api/src/common/auth/auth-types.ts`, `apps/api/src/tenant/auth/{tenant-auth.service.ts,require-tenant-context.ts}`
- Modify: `apps/desktop/src/main/auth/{tenant-auth-api-client.ts,secure-session-store.ts,electron-secure-session-store.ts,desktop-auth.service.ts,desktop-tenant-runtime.ts}`
- Tests: corresponding API resolver/auth and desktop secure-session/auth specs.

**Interfaces:**
- Trusted `TenantCompanyContext` and `TenantRequestContext` gain validated IANA `timezone` from Master `companies.timezone`.
- Tenant login response and encrypted desktop session carry the timezone; local renderer never chooses tenant timezone.

- [ ] Write tests proving Master lookup selects timezone and malformed/non-IANA values are rejected without falling back to a global business constant.
- [ ] Add timezone to `MasterTenantMetadata`, resolver context, authenticated request context, and login result; retain the current `Asia/Tashkent` company default.
- [ ] Add timezone to secure session parsing/versioned envelope and pass it to `DesktopTenantRuntime` when online or restoring offline.
- [ ] Persist the trusted timezone in tenant `sync_state` for local date formatting and business-date calculation after app restart.
- [ ] When an existing encrypted session has no timezone, do not invent a hard-coded company timezone; retain local lookup/view, but block new Sheet create with `TENANT_TIMEZONE_UNAVAILABLE` until authenticated refresh supplies it.
- [ ] Test online login, refresh, encrypted offline session restoration, company switch, old session without timezone, timezone-unavailable Sheet creation, and invalid IANA timezone.
- [ ] Run focused API auth/resolver and desktop auth tests.

### Task 5: Add Patta batch sync v2 and backward-compatible projections

**Files:**
- Modify: `packages/sync-protocol/src/index.ts`
- Create: `database/tenant-migrations/20260928000900-AddSyncProtocolV2Sessions.js`
- Modify: `apps/api/src/tenant/sync/{dto/sync-push-envelope.dto.ts,sync.controller.ts,sync-event-processor.ts,sync-entity-handler.ts,sync-handler.registry.ts,sync.service.ts,sync-projections.ts,sync-bootstrap.service.ts,sync-bootstrap-projections.ts}` and Patta Partiya block usage service.
- Create: `apps/api/src/tenant/sync/{patta-print-batch-sync-handler.ts,model-operation-sync-handler.ts}`
- Modify: `apps/desktop/src/main/sync/{sync-protocol.validation.ts,rest-sync-transport.ts,sync-engine.ts,bootstrap-staging.repository.ts,reference-mirror.repository.ts}`.
- Tests: protocol validation, event processor/handler, bootstrap, sync integration and two-client acceptance.

**Interfaces:**
- Sync requests accept optional `protocol_version` (default v1); new desktop sends v2 for pull/bootstrap/push.
- `patta_print_batch CREATE/UPDATE` is one aggregate event with stable UUIDs, size rows, Patta rows, operation snapshots and `ish_soni` values.
- Projection v1 is served for non-Patta reference entities only; any v1 result that includes a Patta returns a structured upgrade error. V1 never aliases operation count to `ish_soni`. Projection v2 explicitly separates actual `ish_soni: number|null` and `legacy_operation_count` and includes batch/status identity.

- [ ] Write strict shared protocol tests for v1 non-Patta reference responses, v1 upgrade errors for Patta projection/mutation, v2 batch create/correction, nullable v2 legacy quantity, VOID Patta, print events, unknown fields, and canonical decimal/timestamp validation.
- [ ] Add protocol-version negotiation to push, pull and bootstrap; v1 sessions receive non-Patta references only and get `SYNC_PROTOCOL_UPGRADE_REQUIRED` if result includes a Patta; v2 receives batch/Sheet entities and nullable actual quantity. Never serialize legacy operation count under `ish_soni`.
- [ ] Extend SyncChange/projection serializers and strict desktop Zod schemas for v2 without weakening v1 schemas.
- [ ] Register the batch handler with the existing `SyncEventProcessor`; apply batch size rows, all Patta/snapshot rows, audits and server change records in one tenant transaction and return an idempotent aggregate result.
- [ ] Reject every protocol-v1 Patta CREATE with `SYNC_PROTOCOL_UPGRADE_REQUIRED`; never create a new Patta whose quantity is inferred from snapshots. During Desktop upgrade, preserve each existing queued event, Patta row, UUID and payload; mark `PATTA_QUANTITY_UNKNOWN` conflict and require authorized quantity correction plus a new v2 event UUID before push.
- [ ] Enforce event-specific permissions: batch create `patta.chiqarish.create`, correction `patta.chiqarish.correct`, Sheet create/edit/delete/restore/purge `patta_varaq.*`, nested model operation creation `patta_varaq.custom_operation`.
- [ ] Extend projection/bootstrap materialization and pull apply for print batches/sizes/events and Sheet entities; preserve client UUIDs and local pending ownership.
- [ ] Add replay, event-ID fingerprint, mixed v1/v2 clients, partial failures, size batch atomicity, projection echo, pull/bootstrap, and two-device conflict tests; run `npm run test:sync --workspace=apps/api`.

### Task 6: Add durable SQLite print batches and safe queue migration

**Files:**
- Create: `apps/desktop/src/main/database/migrations/003-patta-quantity-print-batches.ts`
- Modify: `apps/desktop/src/main/database/sqlite-database.ts`, `apps/desktop/src/main/database/tenant-database-manager.ts`
- Create: `apps/desktop/src/main/local/{patta-print-batch.repository.ts,patta-print.service.ts,patta-partiya-number-block.repository.ts}`
- Modify: `apps/desktop/src/main/local/{offline-patta.service.ts,patta-local.repository.ts,sync-queue.repository.ts,reference-mirror.repository.ts,bootstrap-staging.repository.ts}`
- Modify: `apps/desktop/src/main/sync/{sync-protocol.validation.ts,rest-sync-transport.ts,sync-engine.ts,create-sync-runtime.ts}` for Partiya number block projection/usage reporting.
- Tests: `apps/desktop/src/main/database/sqlite-database.spec.ts`, local repository tests, offline Patta tests, sync engine tests.

**Interfaces:**
- `PattaPrintService.createBatch(input)` returns persisted batch + Patta identities and size summary; its `LocalUnitOfWork` transaction writes batch, sizes, Pattas/snapshots and stable event.
- Existing single-Patta queue records and sync conflicts remain available after migration; new aggregate events use the same `sync_queue` table/repository.

- [ ] Add SQLite migration test fixture with existing Patta rows, pending/synced queue rows and unresolved conflicts; assert exact preservation after migration.
- [ ] In the migration, rename local `ish_soni` to `legacy_operation_count`, add nullable actual `ish_soni`, add batch/size/event tables and durable `sync_event_dependencies` without recreating the DB.
- [ ] Rebuild the constrained `sync_queue` and dependent `sync_conflicts` tables in one exclusive SQLite migration: copy all rows, create v1/v2 entity/operation checks, recreate indexes/FKs, validate with `foreign_key_check`, then drop only the temporary legacy tables.
- [ ] Register migration version 3 and add new operational tables to `BUSINESS_TABLES` ownership checks.
- [ ] Implement `PattaPrintBatchRepository` transactional create/correct/reprint records with stable UUIDs and decimal-safe size/count validation.
- [ ] Migrate any old queued v1 Patta event lacking actual product quantity into a visible `PATTA_QUANTITY_UNKNOWN` conflict without changing/deleting its local Patta or payload; allow authorized quantity correction to enqueue a new v2 event UUID, since event fingerprint reuse is forbidden.
- [ ] Store model operation prerequisite edges in `sync_event_dependencies`; topologically push ready prerequisite events before dependent Sheet/print aggregates; preserve blocked local work if prerequisite conflicts.
- [ ] Extend SyncEngine with a dependency barrier: after prerequisite model operation CREATE succeeds, pull/apply its `model_operations` and initial-price change rows, then update `reference_cursor` only on dependent, never-sent PENDING Patta events before their first push. Do not change event UUID or any business snapshot.
- [ ] Retain a SYNCED prerequisite event row while pending dependents reference it; remove dependency edges atomically when a dependent event is marked SYNCED, then allow normal queue retention cleanup.
- [ ] Implement local deterministic correction: retain same-size numbers, remap remaining ACTIVE numbers, mark excess VOID, consume new block numbers for shortages, and never release a number.
- [ ] Extend echo/pull/bootstrap merge so actual quantity, legacy count, status and batch identity never overwrite unsynced local corrections.
- [ ] Add offline batch transaction rollback, migration preservation, correction/reprint, no-number-reuse, queue stable-ID and bootstrap tests; run `npm run test --workspace=apps/desktop`.

### Task 7: Build Patta Print UI and A4 output

**Files:**
- Create: `apps/desktop/src/renderer/src/pages/PattaPrintPage.tsx`
- Create: `apps/desktop/src/renderer/src/components/{PattaPrintForm.tsx,PattaSizeDistributionEditor.tsx,PattaPrintDocument.tsx}`
- Modify: `apps/desktop/src/renderer/src/{App.tsx,assets/main.css}`
- Modify: `apps/desktop/src/preload/{erp-api.ts,index.d.ts}` and `apps/desktop/src/main/ipc/register-ipc-handlers.ts` for narrow typed print-batch APIs.
- Modify: `apps/desktop/{package.json,vitest.config.mts}` and root `package-lock.json`.
- Tests: renderer component tests and Electron runtime smoke.

**Interfaces:**
- Renderer calls only `window.erp.pattaPrint.createBatch`, `correctBatch`, `correctLegacyQuantity`, `printBatch`, and `reprintBatch`; Electron main owns persistence and system print invocation.
- Input validates model, Partiya, `ish_soni > 0`, Rang and per-size Patta counts. It contains no conveyor requirement.

- [ ] Add failing tests for `ish_soni` and size-count UI validation, per-size totals, correction/reprint actions, keyboard navigation and no number changes on plain reprint.
- [ ] Install compatible renderer test dependencies from repository root with `npm install -D --workspace=apps/desktop @testing-library/react jsdom`; include renderer `.spec.tsx` in Vitest and use jsdom for renderer specs while retaining Electron-compatible main-process SQLite execution.
- [ ] Add a separate print route/view from Patta Entry; create a batch locally before invoking printer output.
- [ ] Render exactly two persisted Patta slips per A4 page with Model, Partiya, Patta, `ish_soni`, Rang, Razmer, print Sana and original operation snapshots/prices.
- [ ] Render batch total pack count and grouped razmer summary from normalized size rows.
- [ ] Add corrected revision marking; superseded/VOID copies are clearly marked and cannot be mistaken for current active Pattas.
- [ ] Add permission-gated legacy quantity repair for local/server Pattas with unknown actual quantity; require actor/reason online for already-synced rows, preserve `legacy_operation_count`, and create a fresh v2 event UUID for unsynced old create events.
- [ ] Ensure physical print request creates a stable print event; printer failure leaves persisted Pattas/numbers intact and reprint uses the same batch/Patta IDs.
- [ ] Test 13 Pattas produce 7 A4 pages; run desktop component/unit tests and perform `npm run dev --workspace=apps/desktop` Electron print-preview/runtime smoke without printing test data to a physical printer.

### Task 8: Implement immediate Patta Entry schema and accounting service

**Files:**
- Create: `database/tenant-migrations/20260928001100-AddPattaSheets.js`
- Create: `apps/api/src/tenant/patta-sheets/patta-sheets.module.ts`
- Create: `apps/api/src/tenant/patta-sheets/patta-sheets.controller.ts`
- Create: `apps/api/src/tenant/patta-sheets/patta-sheets.service.ts`
- Create: `apps/api/src/tenant/patta-sheets/model-account-query.service.ts`
- Create: `apps/api/src/tenant/patta-sheets/dto/{create-patta-sheet.dto.ts,update-patta-sheet.dto.ts,trash-patta-sheet.dto.ts,restore-patta-sheet.dto.ts,purge-patta-sheet.dto.ts}`
- Modify: `apps/api/src/tenant/{tenant.module.ts,workers/workers.module.ts,audit/audit.service.ts,rbac/tenant-permission.seed.ts}`
- Modify: `apps/api/src/database/tenant/tenant-database-manager.ts` grants and audit catalog constraints in the new migration.
- Tests: `apps/api/src/tenant/patta-sheets/patta-sheets.service.spec.ts`, `patta-sheets.e2e-spec.ts`, `patta-sheets.integration.spec.ts`, `model-account-query.service.spec.ts`.

**Interfaces:**
- `POST /api/v2/patta-sheets` / `openOrCreate(ctx, pattaId, enteredAt, conveyor?)` immediately creates or returns the non-trashed entry and copies operation snapshots.
- `updateEntry(ctx, sheetId, expectedVersion, aggregate)` edits row assignments/custom operations and immediately changes the live Model hisob source.
- `trash`, `restore`, and `purge` implement Korzinka via `deleted_at/deleted_by`; there is no Sheet workflow status.
- Sheet `Sana` and badge resolution use immutable `entered_at`; `business_date` is derived with trusted `companies.timezone`.
- `GET /api/v2/models/:modelId/account-sheet` (permission `patta_varaq.view`) computes live worker/operation totals from non-deleted rows; no stored/manual total is authoritative.

- [ ] Write PostgreSQL tests for one non-trashed entry per Patta, immutable entered_at, snapshot source identity, worker FK, quantity check, row/parent deletion metadata, version constraints, purge FKs and rollback.
- [ ] Add tables `patta_sheets`, `patta_sheet_operation_snapshots`, `patta_sheet_rows`; original sheet snapshots point to `source_patta_operation_snapshot_id`, custom snapshots have NULL source, and every snapshot has model-scoped `model_operation_id`.
- [ ] Add tenant permission seeds/migration upsert for `patta_varaq.delete`, `patta_varaq.restore`, `patta_varaq.purge`, and `patta_varaq.custom_operation`; attach them to the protected system admin role for already-provisioned tenants and keep platform permissions separate.
- [ ] Implement `openOrCreate` immediately after Patta lookup; reject VOID Patta, preserve one non-trashed entry per Patta, capture entered_at once, derive business_date with tenant timezone, and permit empty assignment rows.
- [ ] Implement row CREATE/UPDATE with `expected_version`: resolve badge at entered_at, store worker_id and parent Patta quantity, write row audit/change-log, and make the live derived account query reflect the mutation in the same transaction.
- [ ] Implement custom normal model operation create/reuse with stable same-model operation ID, ACTIVE state and future-print inclusion; authorize with `patta_varaq.custom_operation` and call OperationsService’s shared transaction logic.
- [ ] Implement Edit for worker/custom operation/conveyor/Nuqson, preserving entered_at; calculate all account changes from non-deleted rows grouped by model_id, model_operation_id and worker_id.
- [ ] Implement row O‘chirish as row soft-delete and separate Nuqson toggle; row soft-delete removes its quantity contribution immediately but retains operation snapshot and audit history.
- [ ] Implement whole-entry TRASH, RESTORE and PURGE. TRASH/RESTORE set/clear parent deletion metadata; purge accepts only trashed entries, deletes Sheet/row/snapshot business data physically but never patta_hisob/original Patta snapshots, and leaves append-only audit/tombstones.
- [ ] Implement one-time legacy quantity correction with `patta.chiqarish.correct`, actor/reason/before/after/version/change-log; never use `legacy_operation_count` as quantity.
- [ ] Implement `GET /api/v2/models/:modelId/account-sheet` under `patta_varaq.view`: `GROUP BY model_id, model_operation_id, worker_id`, `SUM(quantity_snapshot)`, require Patta ACTIVE and parent/row non-deleted, and join worker name for display only.
- [ ] Test same-name workers remain separate IDs, two Pattas add quantities, custom model operation joins by stable ID, TRASH/PURGE subtract contribution, and RESTORE adds it back.
- [ ] Test Model hisob matrix: worker rows group by worker_id, columns use model_operation_id, quantities sum across entries, identical names stay separate, and deleted rows/entries contribute zero.
- [ ] Test duplicate entry, operation snapshot identity, 13 operations vs ish_soni 125, active model count changes without old Patta mutation, same-name workers, badge resolution at entered_at, worker Edit account reassignment, Trash/Restore/Purge account contributions, Korzinka purge and re-entry with new UUID/entered_at, rollback, audit and tenant isolation.

### Task 9: Integrate Sheet/custom-operation aggregate sync and timezone contract

**Files:**
- Modify: `packages/sync-protocol/src/index.ts`
- Modify: `apps/api/src/tenant/sync/{sync.controller.ts,sync-event-processor.ts,sync-handler.registry.ts,sync-entity-handler.ts,sync.service.ts,sync-projections.ts,sync-bootstrap-projections.ts,sync-bootstrap.service.ts}`
- Create: `apps/api/src/tenant/sync/patta-sheet-sync-handler.ts`.
- Modify: timezone context files listed in Task 4 and desktop REST/auth session contracts.
- Tests: `apps/api/src/tenant/sync/patta-sheet-sync-handler.spec.ts`, `patta-print-batch-sync-handler.spec.ts`, shared event processor/registry/bootstrap specs, and `sync.integration.spec.ts`.

**Interfaces:**
- `model_operation/CREATE` is a normal model catalog mutation with ACTIVE status, stable model-scoped UUID and first price interval effective at the originating Sheet `entered_at` only for the new operation.
- `patta_sheet CREATE/UPDATE` references stable model operation IDs, immutable `entered_at`, derived `business_date`, operation snapshot aggregate, rows, badge evidence and optimistic base version.
- Dependent Sheet and print-batch events list prerequisite operation-create event IDs; persistent queue dependencies/topological push prevent dangling model operation references.
- Parent/row soft deletion is an `UPDATE` with `deleted_at/deleted_by`; restore is an `UPDATE` clearing them. Permanent purge is a `DELETE` of a TRASHED aggregate and emits child tombstones.
- Each push row submits `entered_badge_number` and `worker_id`; server calls `BadgeResolutionService.resolve(..., sheet.entered_at)` and returns `CONFLICT_BADGE_ASSIGNMENT` on mismatch.
- Print batch aggregate carries normalized distribution and child Patta/snapshot data; batch correction uses `expected_version`/`base_version`.

- [ ] Add shared protocol v2 projections/events for Partiya number blocks, print batches, size rows, print events, corrected Patta quantity/status and all Sheet entities; keep protocol v1 for non-Patta reference sync only.
- [ ] Add protocol version negotiation to push, pull and bootstrap. V1 continues non-Patta reference sync only; any v1 pull/bootstrap requiring a Patta projection returns `SYNC_PROTOCOL_UPGRADE_REQUIRED`. V2 exposes nullable actual `ish_soni` and separate `legacy_operation_count`; never put operation count in `ish_soni`.
- [ ] Use CRUD event operations: `UPDATE` carries TRASH/RESTORE deletion metadata, `DELETE` is only permanent purge of an already-TRASHED sheet. Validate the prior state/version and emit child/parent DELETE tombstones in order.
- [ ] Extend successful DELETE push results to allow `projection=null` plus the final child/parent `change_sequence`; on push echo and pull, Desktop physically deletes Sheet children/parent in FK order, retains tombstones, applies the cursor atomically, and rejects stale post-purge updates as `ENTRY_PURGED`.
- [ ] Add API batch handler using existing idempotent `SyncEventProcessor`; in one transaction validate device block membership for each Patta, process each child through the existing Patta registration domain seam, and apply batch/correction rows.
- [ ] Add bootstrap/pull projections and device-validated Partiya block allocation/usage sync; persist the block owner and monotonically report Partiya usage with the existing retry cycle.
- [ ] Add `model_operation/CREATE` handler: verify `patta_varaq.custom_operation`, canonical same-model uniqueness, model lock, and create a normal ACTIVE model operation through a transaction-scoped OperationsService seam; set its first price interval to the client `effective_from=entered_at` only because the stable new operation has no prior price history.
- [ ] Add API Sheet handler; require referenced model_operation IDs to exist (prerequisite event is SYNCED), resolve each badge at `entered_at`, validate snapshot ownership and parent quantity, apply TRASH/RESTORE/PURGE lifecycle transitions, and record audit/change log in the event transaction.
- [ ] Change sync push controller’s static permissions to `sync.push` only; within the tenant transaction authorize `patta/CREATE` and batch CREATE, batch correction, Sheet CREATE/UPDATE/TRASH/RESTORE/PURGE, and `model_operation/CREATE` against their respective tenant permission codes.
- [ ] Add tenant timezone to Master lookup/resolved/auth context. Extend secure Desktop login/session payload and local runtime cache; use IANA `companies.timezone` for `business_date` and keep the UTC `entered_at` unchanged through push/echo.
- [ ] Extend bootstrap projection order/materialization and pull upserts for batch, size, print event, Sheet, Sheet operation snapshot and row; echo preserves client UUIDs and local pending ownership.
- [ ] Test retry idempotency, response loss, permission-denied custom operation conflict preserving local entry, a print event blocked on an unsynced operation, quantity conflict, badge mismatch, stale version, PURGE null projection and tombstone replay, v1 upgrade errors, no silent overwrite, and two-PC batch/Sheet pull.

### Task 10: Add local Sheet persistence, IPC and renderer entry UI

**Files:**
- Create: `apps/desktop/src/main/database/migrations/004-patta-sheets.ts`
- Modify: `apps/desktop/src/main/database/{sqlite-database.ts,tenant-database-manager.ts}`
- Create: `apps/desktop/src/main/local/{patta-sheet.repository.ts,patta-sheet.service.ts}`
- Create: `apps/desktop/src/main/local/model-account.repository.ts`
- Modify: `apps/desktop/src/main/local/{badge-local.repository.ts,reference-mirror.repository.ts,sync-queue.repository.ts,sync-conflict.repository.ts}`
- Modify: `apps/desktop/src/main/sync/{create-sync-runtime.ts,sync-engine.ts,sync-protocol.validation.ts}`
- Modify: `apps/desktop/src/main/{auth/desktop-tenant-runtime.ts,ipc/register-ipc-handlers.ts}`
- Modify: `apps/desktop/src/preload/{erp-api.ts,index.d.ts}`
- Create: `apps/desktop/src/renderer/src/pages/PattaEntryPage.tsx`
- Create: `apps/desktop/src/renderer/src/pages/PattaHistoryPage.tsx`
- Create: `apps/desktop/src/renderer/src/pages/PattaTrashPage.tsx`
- Create: `apps/desktop/src/renderer/src/pages/ModelAccountPage.tsx`
- Create: `apps/desktop/src/renderer/src/components/{PattaEntryHeader.tsx,PattaOperationGrid.tsx,AddSheetOperationDialog.tsx}`
- Modify: `apps/desktop/src/renderer/src/{App.tsx,assets/main.css}`.
- Tests: `apps/desktop/src/main/local/{patta-sheet.repository.spec.ts,patta-sheet.service.spec.ts,model-account.repository.spec.ts}`, `apps/desktop/src/main/ipc/main-ipc.spec.ts`, and renderer `PattaEntryPage.spec.tsx`, `PattaHistoryPage.spec.tsx`, `PattaTrashPage.spec.tsx`, `ModelAccountPage.spec.tsx`.

**Interfaces:**
- `window.erp.pattaSheet.lookup(partiyaNumber, pattaNumber)`, `open(...)`, `updateRow(...)`, `deleteRow(...)`, `editEntry(...)`, `trash(...)`, `restore(...)`, `purge(...)`, and `history(...)` are narrow typed methods.
- Main-process lookup order is SQLite, authenticated API on miss, save mirror, return safe typed view with Patta/snapshot IDs.
- `PattaSheetService` captures `entered_at` once, computes `business_date` from cached trusted tenant IANA timezone, resolves badges locally at that timestamp, derives quantity, persists aggregate + queue atomically.

- [ ] Add failing SQLite migration tests proving original Patta/worker/badge/queue/conflict rows survive v4 and legacy quantity columns remain preserved.
- [ ] Add local Sheet/operation snapshot/row schemas and worker/model-operation foreign keys; persist transient badge input only for local/sync evidence.
- [ ] Implement local-first Patta lookup and authenticated fallback in Electron main; return Patta UUID and Patta-operation-snapshot UUIDs through a narrowly scoped view model.
- [ ] Implement local `entered_at` creation and tenant-timezone `business_date`; use the immutable entry timestamp for every badge lookup and re-resolution.
- [ ] Implement transactional local row updates: no quantity input, `quantity_snapshot` from Patta `ish_soni`, badge string remains string, unresolved badge has no worker ID, and row write plus queue coalescing is atomic.
- [ ] Implement custom normal model operation on local mirror with stable same-model UUID; queue it inside the Sheet aggregate, preserve the active local entry if server `patta_varaq.custom_operation` permission later conflicts.
- [ ] Implement the offline account aggregate in `model-account.repository.ts` with the same ACTIVE Patta, non-deleted Sheet/row, model_id/model_operation_id/worker_id filters and grouping as the API query.
- [ ] Implement whole-entry TRASH, RESTORE and PURGE local transactions; purge only a trashed aggregate and child rows, retain Patta rows, audit/purge payload and cursor tombstones.
- [ ] Build Uzbek Entry, Kiritilgan Pattalar, Korzinka and Model hisob pages: automatic Patta fields, optional/manual conveyor, operation/price, Jeton, worker display, no Soni input, separate Nuqson/assignment clear, Edit, whole-entry Delete-to-trash with `Korzinkaga yuborilsinmi?` confirmation, Restore and strong Purge confirmation, model grid worker rows/operation columns, and keyboard-first entry.
- [ ] Test restart durability, invalid badge row rejection, `ish_soni=125` row quantity, worker Edit aggregation move, `Nuqson != row delete`, Enter focus, whole-entry TRASH/RESTORE/PURGE, Korzinka and offline local lookup/edit/delete.

### Task 11: Acceptance, documentation, regressions and delivery

**Files:**
- Update: `docs/architecture.md`, `docs/database.md`, `docs/sync-protocol.md`, `docs/rbac.md`, `docs/testing.md`, `docs/IMPLEMENTATION.md`.
- Add/extend: `apps/api/src/tenant/sync/sync.integration.spec.ts`, a Patta workflow PostgreSQL integration spec, and `apps/desktop/src/main/sync/two-client-sync.integration.spec.ts`.

- [ ] Add end-to-end acceptance: print XS=1/S=1, `ish_soni=125`, save all Patta/batch IDs, then return paper and enter each badge offline.
- [ ] Verify a Sheet entered at 10:30 on an offline desktop remains `entered_at=10:30` after sync receipt at 17:00; resolve badge at 10:30 and derive business date with Master company timezone.
- [ ] Verify entry-aware batch quantity correction updates non-deleted row snapshots atomically; in-use distribution/identity replacement conflicts; number blocks never release VOID Patta numbers.
- [ ] Verify two-PC flow: PC-1 creates/prints batch and enters rows; PC-2 pulls batch/Sheet and can view/edit offline; stale updates, trash/restore/purge, and permanent-delete echo converge without resurrection.
- [ ] Update docs to distinguish actual product quantity from operation cardinality and document legacy unknown values, batch correction, timezone/entered_at, model-scoped custom operations and protocol negotiation.
- [ ] Run `npm run lint --workspace=apps/api`, `npm run typecheck --workspace=apps/api`, `npm run test --workspace=apps/api`, `npm run test:e2e --workspace=apps/api`, `npm run build --workspace=apps/api`.
- [ ] Run `npm run lint --workspace=apps/desktop`, `npm run typecheck --workspace=apps/desktop`, `npm run test --workspace=apps/desktop`, `npm run build --workspace=apps/desktop`, then Electron runtime smoke.
- [ ] Run PostgreSQL `npm run test:tenant-provisioning --workspace=apps/api`, `npm run test:models-operations --workspace=apps/api`, `npm run test:workers-badges --workspace=apps/api`, `npm run test:patta --workspace=apps/api`, and `npm run test:sync --workspace=apps/api` only with dedicated `_test` credentials; run API auth/RBAC e2e and desktop `src/main/auth/desktop-auth-sync.integration.spec.ts` acceptance where gated credentials exist.
- [ ] Inspect `git status`, `git diff`, `git diff --check`; verify every staged path belongs to the completed task checkpoint, then push only `feature/patta-sheet` when remote auth permits.

## Commit Checkpoints

After the corresponding tasks pass their focused tests, keep reviewable commits:

1. After Task 1: `fix: separate Patta product quantity from operation count`
2. After Tasks 2–3: `feat: add versioned Patta print batches and corrections`
3. After Tasks 4–7: `feat: add offline Patta batch printing and sync`
4. After Tasks 8–10: `feat: add offline-first Patta sheet`
5. After Task 11 regressions/docs: `test: cover Patta print and sheet acceptance`

Every commit stays on `feature/patta-sheet` and stages only the files listed in
that checkpoint. Commits are created only when explicitly authorized.

## Execution State

The user approved the design and implementation plan. Work is active on
`feature/patta-sheet`; task checkboxes remain unchecked until their required
implementation and verification are complete. The scope includes both the API
aggregation query and the offline read-only Model hisob grid. Commits and pushes
follow repository/user authorization rules and are not implied by this plan.
