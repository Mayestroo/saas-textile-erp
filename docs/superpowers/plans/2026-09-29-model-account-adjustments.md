# Model Hisob Manual Adjustments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Model hisob `Soni` totals editable by adding separate manual contributions, while retaining Patta-derived `ish_soni` rows and price snapshots unchanged.

**Architecture:** Add a first-class `model_account_adjustment` aggregate keyed by model, model operation, and worker. Local create/edit/trash/restore mutations use SQLite transactions and stable sync events. Patta rows and manual adjustments are aggregated separately and then combined for `Soni` and gross `Jami so‘m`; worker detail keeps each source visible.

**Tech Stack:** NestJS, PostgreSQL, TypeORM migrations, `@textile/sync-protocol`, Electron main/preload, SQLite, `decimal.js`, Vitest.

## Global Constraints

- Work only on `feature/desktop-ui-ux`.
- Never update `patta_hisob.ish_soni` or `patta_sheet_rows.quantity_snapshot` from a Model hisob cell.
- Manual adjustments use positive integer quantities and an immutable effective `unit_price_snapshot` from their `entered_at`.
- Manual adjustment and Standalone Entry events/projections use SyncProtocolVersion 3; V1/V2 semantics remain intact.
- Editing a manual record preserves identity, `entered_at`, and price snapshot; stale edits conflict by version.
- Trash removes an adjustment from totals; restore returns it. No physical purge UI is added.
- Gross amount is `sum(quantity × that source row’s immutable price snapshot)` using decimal-safe calculations; no Nuqson, advance, penalty, or net-pay formula.
- Use the existing two-way sync/idempotency pipeline; no parallel queue or renderer network/database access.
- Use `patta.hisob.view` for read access and `patta.hisob.manual_manage` for adjustment mutations.

## Execution Status — 2026-09-30

- Core protocol, API, SQLite, sync, account aggregation, IPC, and renderer changes are implemented.
- PostgreSQL validation passed: Master DB 12 tests, tenant provisioning 7 tests, manual adjustment integration 1 targeted test, and sync integration 21 tests.
- The sync integration spawned the Electron two-PC acceptance and desktop tenant-auth suites; all 3 acceptance tests passed, including manual adjustment → PC-2 pull.
- API/Desktop typecheck and production builds passed; API lint passed. Desktop lint exited successfully with existing Prettier/line-ending warnings. Electron’s full interactive UI has not been manually launched.

## File map

- Shared types: `packages/sync-protocol/src/index.ts`.
- API schema/service/handler: new `database/tenant-migrations/20260929001300-AddModelAccountAdjustments.js`; new `apps/api/src/tenant/patta-sheets/model-account-adjustments.service.ts`, DTO/sync handler, and `apps/api/src/tenant/patta-sheets/model-account-v3.controller.ts`; modify `model-account-query.service.ts`, `patta-sheets.service.ts` V3 result types, `patta-sheets.module.ts`, API sync bootstrap/registry files, `apps/api/src/tenant/rbac/tenant-permission.seed.ts`, `apps/api/src/tenant/audit/audit.service.ts`, and audit action constraints.
- Desktop schema: new SQLite migration version 7 after v6 Standalone Entry migration.
- Desktop local logic: new `apps/desktop/src/main/local/model-account-adjustment.repository.ts` and service/specs; `model-account.repository.ts`, `create-sync-runtime.ts`, sync queue/reference mirror files.
- IPC: `apps/desktop/src/preload/erp-api.ts`, `src/main/ipc/register-ipc-handlers.ts` and specs.
- Renderer: `ModelAccountPage.tsx` and worker/source detail dialog tests are implemented in the renderer plan.

### Task 1: Projection/event types and DB constraints

**Interface produced:**

```ts
interface ModelAccountAdjustmentProjection {
  id: string
  model_id: string
  model_operation_id: string
  worker_id: string
  quantity: number
  unit_price_snapshot: string
  entered_at: string
  business_date: string
  version: string
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}
```

- [ ] Write failing API migration tests proving adjustment rows require existing model, operation and worker; operation model must match; `quantity > 0`; `unit_price_snapshot >= 0`; lifecycle deleter/time pair is consistent.
- [ ] Create PostgreSQL migration after the standalone Entry migration and SQLite migration 7. Preserve additive rollback protections and existing user rows.
- [ ] Add a unique stable adjustment UUID, tenant FKs, version, entry/business timestamps, price snapshot, soft-delete fields, created actor/device, and sync ownership metadata in SQLite.
- [ ] Add `patta.hisob.manual_manage` to `TENANT_PERMISSION_SEEDS` and the upgrade migration for already-provisioned tenant DBs. Do not grant it to arbitrary roles; existing admin seeding uses the canonical catalog.
- [ ] Add SyncProtocolVersion 3 as a superset of existing V2 entities and add `model_account_adjustments` V3 projection/event types. V1/V2 payload interfaces stay unchanged; soft-delete/restore is versioned UPDATE, not physical DELETE.
- [ ] Run focused schema/service tests and `npm run typecheck --workspace=apps/api`.

### Task 2: Local-first manual adjustment repository/service

**Interface produced:**

```ts
interface CreateManualAdjustmentInput {
  model_id: string
  model_operation_id: string
  worker_id: string
  quantity: number
}

create(input: CreateManualAdjustmentInput, actorUserId: string): ModelAccountAdjustmentProjection
update(adjustmentId: string, expectedVersion: string, quantity: number): ModelAccountAdjustmentProjection
trash(adjustmentId: string, expectedVersion: string, actorUserId: string): ModelAccountAdjustmentProjection
restore(adjustmentId: string, expectedVersion: string): ModelAccountAdjustmentProjection
```

- [ ] Add failing local tests that one positive addition snapshots local effective operation price/current tenant time, resolves `business_date` from tenant timezone, and writes the adjustment plus stable queue event in one SQLite transaction.
- [ ] Add tests that failed worker/operation/model/price lookup rolls back both the row and queue event; duplicate UI submits use separate intentional IDs only after the user presses the explicit add action.
- [ ] Implement `ModelAccountAdjustmentRepository` with `createLocal`, version-checked update, trash, restore, pull projection apply, ownership/conflict state and no-purge semantics.
- [ ] Implement `ModelAccountAdjustmentService`: validate active model/operation association and worker existence, snapshot the effective operation price at `entered_at`, use immutable timestamp/price on quantity update, and enqueue UPDATE/CREATE using existing sync infrastructure.
- [ ] Return Uzbek `VERSION_CONFLICT`, missing reference, missing price and offline metadata errors through typed IPC mapping; never expose raw SQLite/SQL errors.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/local/model-account-adjustment.service.spec.ts src/main/local/model-account-adjustment.repository.spec.ts`.

### Task 3: Server mutation handler, audit and sync

**Files:**
- Create: `apps/api/src/tenant/patta-sheets/model-account-adjustments.service.ts`, DTO/validator and sync entity handler/specs.
- Modify: `apps/api/src/tenant/sync/sync-event-processor.ts`, sync module/handler registry, bootstrap projections, `sync.service.ts`, sync projections and audit action allowlist.

- [ ] Add a failing sync test that an authorized manual CREATE inserts exactly one row and records audit/change-log in the same server transaction.
- [ ] Add tests rejecting an actor without `patta.hisob.manual_manage`, mismatched model/operation/worker, nonpositive quantity, stale version and an incorrect effective price snapshot.
- [ ] Validate `unit_price_snapshot` with `OperationPriceService.resolvePrice(model_operation_id, entered_at)`; do not use the latest `model_operations.price` for historical adjustments.
- [ ] Apply CREATE/UPDATE via the existing `SyncEventProcessor`; permission code is checked per event; duplicate event delivery returns the recorded result and never duplicates an adjustment.
- [ ] Add manual adjustment to V3 push/pull/bootstrap and soft-delete update allowlists. V2 clients receive `SYNC_PROTOCOL_UPGRADE_REQUIRED` when a cursor/bootstrap would include V3-only data, without cursor advancement; V2 linked-entry-only tenants continue working.
- [ ] Test PC-1 V3 offline manual create -> PC-2 V3 pull, duplicate retry, stale concurrent update, trash removal, restore return, and V2 upgrade-required/cursor preservation.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/sync/model-account-adjustment-sync-handler.spec.ts`, `npm run test:sync --workspace=apps/api`, and desktop focused sync tests. A skipped database suite is not a pass.

### Task 4: Combined quantity and snapshot-money aggregation

**Files:**
- Modify: `apps/desktop/src/main/local/model-account.repository.ts` and `model-account.repository.spec.ts`.
- Modify: `apps/api/src/tenant/patta-sheets/model-account-query.service.ts`, `patta-sheets.controller.ts` only to preserve the existing V2 route, `model-account-v3.controller.ts`, module, and query specs.

**Interface produced:**

```ts
interface ModelAccountOperationTotal {
  model_operation_id: string
  operation_name: string
  sort_order: number
  current_price: string | null
  version: string
  status: 'ACTIVE' | 'INACTIVE'
  quantity: string
  patta_quantity: string
  standalone_quantity: string
  manual_quantity: string
  gross_amount: string
  patta_amount: string
  standalone_amount: string
  manual_amount: string
}

interface ModelAccountContributionRow {
  worker_id: string
  worker_name: string
  model_operation_id: string
  patta_quantity: string
  standalone_quantity: string
  manual_quantity: string
  total_quantity: string
  patta_amount: string
  standalone_amount: string
  manual_amount: string
  gross_amount: string
}

interface ModelAccountWorkerDetail {
  model_id: string
  model_name: string
  model_operation_id: string
  operation_name: string
  source: 'PATTA' | 'STANDALONE' | 'MANUAL'
  quantity: string
  unit_price_snapshot: string
  gross_amount: string
  entered_at: string
  manual_adjustment_id: string | null
  version: string | null
  deleted_at: string | null
  deleted_by: string | null
}

interface ConveyorAccountRow {
  conveyor_label: string
  model_id: string
  model_name: string
  patta_count: string
  standalone_entry_count: string
  manual_adjustment_count: string
  ish_soni: string
}
```

- [ ] Add local repository tests with two Patta rows at different `unit_price_snapshot`s plus a manual adjustment at a third price; assert quantity and gross amount use each source snapshot, not current price.

```ts
expect(sheet.rows.find((row) => row.worker_id === workerId && row.model_operation_id === operationId))
  .toMatchObject({
    patta_quantity: '125',
    standalone_quantity: '0',
    manual_quantity: '20',
    total_quantity: '145',
    gross_amount: '1550.00'
  })
```

- [ ] Add V3 API query tests with linked/Standalone rows and manual adjustments from different price intervals; assert `Jami so‘m` uses PostgreSQL NUMERIC source snapshots and current operation price is returned separately. Preserve the V2 shape and return `SYNC_PROTOCOL_UPGRADE_REQUIRED` from V2 when manual adjustments exist for that model.
- [ ] Add tests that deleting a Patta row/Sheet or trashing a manual adjustment removes its contribution, restore returns only the corresponding source, and Nuqson does not apply an unapproved deduction.
- [ ] Query Patta contributions from active non-trashed sheets and rows grouped by `model_id + model_operation_id + worker_id`, retaining each row’s `quantity_snapshot` and operation snapshot price for decimal aggregation.
- [ ] Query active manual adjustments by the same worker/model/operation key. Sum quantities as integers and gross amounts with `Decimal`; return money as canonical decimal strings to preload/renderer.
- [ ] Preserve `GET /api/v2/models/:modelId/account-sheet` response shape. Add `getModelAccountSheetV3` and `GET /api/v3/models/:modelId/account-sheet` with mixed-source quantities, price snapshots and gross amounts; compute money using PostgreSQL NUMERIC/Decimal, not JavaScript floats.
- [ ] Add `getWorkerDetails(workerId): readonly ModelAccountWorkerDetail[]` to return all models/operations grouped by source (`PATTA` vs `MANUAL`) with quantity, price snapshot, gross amount, timestamp and nullable manual adjustment ID.
- [ ] Add `getConveyorAccount(): readonly ConveyorAccountRow[]`; standalone Patta entries and manual additions with no conveyor snapshot group under `Noma’lum`. Count each source record once and never multiply by operation rows.
- [ ] Expose typed main/preload methods `modelAccount.addManual(input)`, `updateManual(id, expectedVersion, quantity)`, `trashManual(id, expectedVersion)`, `restoreManual(id, expectedVersion)`, `workerDetails(workerId)`, and `conveyorAccount.get()`; validate every IPC payload in main.
- [ ] Run focused Model account repository tests and all desktop Model account/manual-adjustment tests.
- [ ] Commit as `feat: add offline Model hisob manual adjustments` after the API and desktop tests pass.
