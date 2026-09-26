# Patta Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant Patta templates, collision-free number allocation, online Patta generation/accounting, immutable operation snapshots, secure device validation, and bounded lookup/list APIs.

**Architecture:** A dedicated tenant Patta module owns templates, number blocks, generation, and lookup. A reusable Master `DeviceAccessService` validates request device IDs against authenticated company context. PostgreSQL tenant transactions lock a singleton sequence and coherent model/operation rows; operation prices are resolved only through `OperationPriceService`.

**Tech Stack:** NestJS 12, strict TypeScript 7, TypeORM 1.1, PostgreSQL 16 additive migrations, `decimal.js`, class-validator, Vitest, Supertest.

## Global Constraints

- Work only on `feature/patta`; do not discard unrelated changes.
- Keep tenant operational data in tenant databases; query Master only for device ownership/status.
- Keep `synchronize: false`; use only a new additive tenant migration.
- Never use `MAX(patta_number) + 1`; keep online and device allocations on one locked sequence.
- Do not convert `PATTA_NUMBER_START`, BIGINT ranges, or BIGINT API values through JavaScript `Number`; use `bigint` and decimal strings.
- Keep `UNIQUE(partiya_number, patta_number)` without standalone Patta-number uniqueness.
- Validate each request device through `DeviceAccessService`; use company identity only from `requireTenantContext()`.
- Preserve model → ACTIVE operation rows ordered by `sort_order, id` → price resolution lock order.
- Resolve every price with `OperationPriceService.resolvePrice(operationId, transactionTimestamp, manager)`; never use `model_operations.price` as effective price.
- Keep batch generation all-or-nothing, with sequence updates, records, snapshots, and audits in one transaction.
- Keep online `created_from_block_id = NULL`; do not expose it as client input.
- Do not implement sync events/queue, Desktop, Patta sheets, payroll, reports, licenses, or Redis caching.
- Use Uzbek Latin for production-facing messages and structured API error codes.
- Run real DB tests only against a dedicated `_test` Master database and generated tenant test databases.
- Keep the feature in one requested implementation commit: `feat: add patta generation and accounting foundation`.

---

## File map

### Create

- `database/tenant-migrations/20260926000500-AddPattaFoundation.js` — five Patta tables, constraints, exclusion range protection, audit catalog extension, delete/update guards, indexes, and safe rollback.
- `apps/api/src/tenant/patta/patta.config.ts` — validated config parser/provider for sequence start, block size, active-block limit, and batch maximum.
- `apps/api/src/tenant/patta/patta.config.spec.ts` — config defaults and invalid-value tests.
- `apps/api/src/database/tenant/patta-sequence.initializer.ts` — idempotent insert-only singleton initializer.
- `apps/api/src/database/tenant/patta-sequence.initializer.spec.ts` — idempotency and concurrent initialization tests.
- `apps/api/src/master/devices/device-access.service.ts` — reusable Master device/company/status authorization lookup.
- `apps/api/src/master/devices/device-access.service.spec.ts` — device lookup outcomes and exact error codes.
- `apps/api/src/tenant/patta/patta-errors.ts` — structured Patta validation/conflict/not-found errors.
- `apps/api/src/tenant/patta/patta-templates.service.ts` — normalized, optimistic template operations and audit.
- `apps/api/src/tenant/patta/patta-templates.service.spec.ts` — template normalization, status, uniqueness, and version tests.
- `apps/api/src/tenant/patta/patta-number-blocks.service.ts` — block allocation, monotonic usage, cancellation, range membership.
- `apps/api/src/tenant/patta/patta-number-blocks.service.spec.ts` — block policy and terminal transition tests.
- `apps/api/src/tenant/patta/patta.service.ts` — online generation, historical lookup, and paginated filtering.
- `apps/api/src/tenant/patta/patta.service.spec.ts` — generation, snapshot, price, lookup, and rollback unit tests.
- `apps/api/src/tenant/patta/patta-offline-registration.validator.ts` — non-persisting allocated-range and structural snapshot validation.
- `apps/api/src/tenant/patta/patta-offline-registration.validator.spec.ts` — block membership and payload structure tests.
- `apps/api/src/tenant/patta/patta.controller.ts` — generation, blocks, lookup, and list routes.
- `apps/api/src/tenant/patta/patta-templates.controller.ts` — template routes.
- `apps/api/src/tenant/patta/patta.module.ts` — Patta providers, controller guards, and required module imports.
- `apps/api/src/tenant/patta/dto/create-patta-template.dto.ts` — template creation contract.
- `apps/api/src/tenant/patta/dto/update-patta-template.dto.ts` — optimistic template patch contract.
- `apps/api/src/tenant/patta/dto/generate-patta.dto.ts` — strict bounded generation contract.
- `apps/api/src/tenant/patta/dto/allocate-patta-number-block.dto.ts` — device-only allocation contract.
- `apps/api/src/tenant/patta/dto/report-patta-block-usage.dto.ts` — device and decimal-string usage report.
- `apps/api/src/tenant/patta/dto/cancel-patta-number-block.dto.ts` — device-only cancellation contract.
- `apps/api/src/tenant/patta/dto/list-patta.dto.ts` — list filter and bounded pagination contract.
- `apps/api/src/tenant/patta/dto/lookup-patta.dto.ts` — business-key lookup contract.
- `apps/api/src/tenant/patta/patta.integration.spec.ts` — real PostgreSQL migration, allocator, generation, audit, history, concurrency, and isolation tests.
- `apps/api/src/tenant/patta/patta.e2e-spec.ts` — tenant/platform auth, permission, DTO, device-validation, and route tests.

### Modify

- `apps/api/src/database/tenant/tenant-migration-runner.ts` — initialize Patta sequence after successful tenant migrations.
- `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts` — update expected latest migration and assert Patta tables participate in provisioning/reapply.
- `apps/api/src/tenant/models/models-operations.integration.spec.ts` — preserve model migration rollback/reapply expectations with the new later additive migration.
- `apps/api/src/tenant/workers/workers-badges.integration.spec.ts` — preserve worker migration rollback/reapply/refusal coverage under the Patta migration.
- `apps/api/src/database/tenant/tenant-database.module.ts` — provide/export config and initializer to the migration runner.
- `apps/api/src/database/tenant/tenant-database-manager.ts` — add Patta tables to explicit tenant runtime DML grants.
- `apps/api/src/master/devices/devices.module.ts` — provide/export `DeviceAccessService`.
- `apps/api/src/tenant/audit/audit.service.ts` — add Patta audit entity/action literals while keeping universal `entity_key` behavior.
- `apps/api/src/tenant/tenant.module.ts` — register `PattaModule`.
- `apps/api/.env.example` — document four Patta configuration defaults.
- `apps/api/package.json` — add a focused `test:patta` PostgreSQL integration script.
- `docs/database.md` — document schema, sequence initialization, locks, templates, and history invariants.
- `docs/testing.md` — document test database setup and Patta unit/e2e/integration/regression commands.

The existing tenant permission seed already includes `patta.chiqarish.view`, `patta.chiqarish.create`, and `patta.hisob.view`; do not add duplicate permission codes. Existing model/operation mutation services already take model/operation locks in compatible order; only make a minimal lock fix if a new integration test demonstrates a violation.

---

### Task 1: Add the additive Patta schema and runtime grants

**Files:** create `database/tenant-migrations/20260926000500-AddPattaFoundation.js`; modify `apps/api/src/tenant/audit/audit.service.ts` and `apps/api/src/database/tenant/tenant-database-manager.ts`.

**Interfaces:** Migration creates the five approved tables. Audit accepts entity types `patta_template`, `patta_number_block`, and `patta`, and actions `patta_template.create/update/deactivate`, `patta_number_block.allocate/cancel`, and `patta.create`. Runtime role receives DML on the new tables; DB triggers remain the final hard-delete/immutability defense.

- [ ] **Step 1: Define the table/constraint migration before service code.** Create `patta_templates` with generated canonical name, active-only unique name index, ACTIVE/INACTIVE and version checks, model/actor FKs, timestamps, and a no-delete trigger.
- [ ] **Step 2: Add sequence and block DDL.** Create the singleton sequence table without a seeded row. Create blocks with inclusive BIGINT ranges and checks; protect all statuses with `EXCLUDE USING gist (int8range("range_start", "range_end", '[]') WITH &&)`. Add no-delete and terminal state/usage-transition trigger rules.
- [ ] **Step 3: Add Patta and snapshot DDL.** Create `patta_hisob` with only `UNIQUE(partiya_number, patta_number)`, restrictive model/template/block references, creation snapshots, positive version/ish_soni checks, and no-delete trigger. Create operation snapshots with unique `(patta_hisob_id, operation_id)`, `NUMERIC(14,2) >= 0`, `sort_order >= 0`, restrictive operation FK, and update/delete rejection trigger. Make the snapshot-to-Patta FK deferred so `ish_soni` can be inserted from a DB count of persisted snapshots in the same transaction.
- [ ] **Step 4: Extend audit constraints and indexes.** Rebuild the audit type/action checks additively for Patta event values, create lookup/list/filter indexes, and restore the append-only audit trigger without opening a mutation window outside the migration transaction.
- [ ] **Step 5: Implement fail-safe `down`.** Before dropping DDL, reject if any Patta/template/block business rows or Patta audit events exist. Permit dropping a sequence table containing only its untouched initializer row. Drop only objects introduced by this migration, in dependency order.
- [ ] **Step 6: Extend runtime DML grants.** Add all five tables to the explicit table grant list in `TenantDatabaseManager.grantRuntimePrivileges()`; do not grant Master tables to tenant roles.
- [ ] **Step 7: Verify migration syntax and formatting.** Run `npm run build --workspace=apps/api`; then use the dedicated Patta PostgreSQL suite added in Task 7 to prove up/down/up, constraints, triggers, and grants.

### Task 2: Validate Patta configuration and initialize sequence idempotently

**Files:** create `apps/api/src/tenant/patta/patta.config.ts`, `apps/api/src/database/tenant/patta-sequence.initializer.ts`, and their unit specs; modify `tenant-migration-runner.ts`, `tenant-database.module.ts`, and `apps/api/.env.example`.

**Interfaces:**

```ts
export interface PattaConfiguration {
  numberStart: bigint;
  blockSize: bigint;
  maxActiveBlocksPerDevice: number;
  maxBatchSize: number;
}

export class PattaSequenceInitializer {
  initialize(dataSource: DataSource, start: bigint): Promise<void>;
}
```

- [ ] **Step 1: Test configuration parsing.** Cover defaults, zero/negative/invalid decimal input, values above signed BIGINT maximum, safe-integer validation for count settings, and valid custom start/block-size values.
- [ ] **Step 2: Implement decimal parsing without Number coercion.** Parse `PATTA_NUMBER_START` and `PATTA_NUMBER_BLOCK_SIZE` with an anchored positive-decimal regex and `BigInt`; reject values outside PostgreSQL BIGINT bounds for start. Parse only active-block and batch counts as positive safe integers.
- [ ] **Step 3: Test initializer idempotency.** Verify first initialization inserts `(id=1,next_number=start,version=1)`, second initialization with another start leaves the first value untouched, and simultaneous calls produce exactly one row.
- [ ] **Step 4: Implement the insert-only initializer.** Execute parameterized `INSERT INTO patta_number_sequence(id,next_number,version) VALUES (1,$1::bigint,1) ON CONFLICT (id) DO NOTHING` with `start.toString()`; never update a conflict row.
- [ ] **Step 5: Wire post-migration initialization.** After `runMigrations()` succeeds, have `TenantMigrationRunner` invoke the initializer using validated configuration on the same migration DataSource. Ensure a failed migration never initializes a partial schema.
- [ ] **Step 6: Document environment values.** Add the four defaults to `.env.example`; test that the parser applies a custom start only to a missing row, not to an existing sequence.

### Task 3: Add reusable Master device authorization

**Files:** create `apps/api/src/master/devices/device-access.service.ts` and `.spec.ts`; modify `apps/api/src/master/devices/devices.module.ts`.

**Interface:**

```ts
assertActiveDevice(companyId: string, deviceId: string): Promise<{ id: string }>;
```

- [ ] **Step 1: Write service tests for all ownership states.** Test valid ACTIVE device; unknown ID -> `DEVICE_NOT_FOUND`; existing foreign-company device -> `DEVICE_TENANT_MISMATCH`; BLOCKED/REPLACED -> `DEVICE_NOT_ACTIVE`; and Master query failure does not turn into successful authorization.
- [ ] **Step 2: Implement one reusable named-Master lookup.** Inject `@InjectDataSource(MASTER_DATA_SOURCE_NAME)`. Query by `device.id` only, then compare `company_id` to authenticated context, then status; return the validated ID only after all checks pass.
- [ ] **Step 3: Export through existing `DevicesModule`.** Provide/export the service and import the existing module from Patta module; do not add device identity to tenant JWT/session claims.
- [ ] **Step 4: Run focused checks.** Run `npm run test --workspace=apps/api -- src/master/devices/device-access.service.spec.ts` and `npm run typecheck --workspace=apps/api`.

### Task 4: Implement template service and API

**Files:** create template service/controller/DTO/error tests under `apps/api/src/tenant/patta/`; modify `patta.module.ts` and `tenant.module.ts`.

**Interface:** `list(dataSource, status)`, `getById(dataSource,id)`, `create(dataSource,actor,input)`, and `update(dataSource,actor,id,inputWithExpectedVersion)` return serialized records with BIGINT versions as strings.

- [ ] **Step 1: Add DTO/service tests first.** Cover canonical whitespace, optional blank-to-null, active model enforcement, duplicate normalized ACTIVE names, inactive listing, expected-version conflict, and reactivation collision.
- [ ] **Step 2: Implement template transactions.** Lock the model before insert or model reassignment; require ACTIVE when creating or changing the model reference. Lock the template row for update; apply expected version; increment version; append create/update/deactivate audit in the same transaction. Never issue DELETE.
- [ ] **Step 3: Add endpoints and permissions.** Register GET/list/get with `models.view`; POST/PATCH with `models.manage`; use strict DTOs and existing tenant guards/context helpers.
- [ ] **Step 4: Add optimistic response serialization.** Return status/version/timestamps; preserve all display text casing after whitespace normalization.
- [ ] **Step 5: Run template checks.** Run `npm run test --workspace=apps/api -- src/tenant/patta/patta-templates.service.spec.ts` and `npm run test:e2e --workspace=apps/api -- src/tenant/patta/patta.e2e-spec.ts`.

### Task 5: Implement block allocation, usage, and cancellation

**Files:** create `patta-number-blocks.service.ts`, allocation/report/cancel DTOs and service specs; extend Patta controller/e2e tests.

**Interface:**

```ts
allocate(dataSource: DataSource, actorId: string, validatedDeviceId: string): Promise<PattaNumberBlockRecord>;
reportUsage(dataSource: DataSource, actorId: string, validatedDeviceId: string, blockId: string, usedCount: bigint): Promise<PattaNumberBlockRecord>;
cancel(dataSource: DataSource, actorId: string, validatedDeviceId: string, blockId: string): Promise<PattaNumberBlockRecord>;
```

- [ ] **Step 1: Test boundary/error behavior.** Cover first/sequential blocks, two active block cap, device mismatch, reported count decrease/over-capacity/terminal block, valid exhaustion, active cancellation, and rejection of exhausted/cancelled transitions.
- [ ] **Step 2: Implement atomic allocation.** After `DeviceAccessService` succeeds, open a tenant transaction, lock sequence row `FOR UPDATE`, count ACTIVE blocks for that device, calculate `end = start + blockSize - 1n`, ensure both end and next number fit PostgreSQL BIGINT, insert block, update next number/version, and append `patta_number_block.allocate` audit.
- [ ] **Step 3: Implement usage and cancellation locks.** Lock target block row `FOR UPDATE`; require matching validated device; accept usage changes only from ACTIVE and enforce monotonic decimal-string/BigInt count; transition full count to EXHAUSTED. Allow cancellation only from ACTIVE; append cancellation audit. Never change sequence on report or cancellation.
- [ ] **Step 4: Add strict routes.** Implement allocate/usage/cancel routes under `/api/v1/patta-number-blocks`, require `patta.chiqarish.create`, validate every DTO device through the same service, reject body/query tenant/company IDs and block size.
- [ ] **Step 5: Test BIGINT wire format.** Assert all starts/ends/counts return decimal strings even above `Number.MAX_SAFE_INTEGER`, with no numeric conversion in DTO/service serialization.
- [ ] **Step 6: Run focused tests.** Run allocator unit specs and the Patta e2e spec.

### Task 6: Implement online Patta generation, lookup, and offline validators

**Files:** create `patta.service.ts`, `patta-offline-registration.validator.ts`, generation/list DTOs and specs; complete Patta controller/module.

**Interfaces:**

```ts
generate(dataSource: DataSource, actorId: string, validatedDeviceId: string, input: GeneratePattaDto): Promise<PattaRecord[]>;
lookup(dataSource: DataSource, partiya: string, pattaNumber: bigint): Promise<PattaDetailRecord>;
list(dataSource: DataSource, filters: PattaListDto): Promise<PaginatedPattaRecord>;
assertAllocatedNumber(dataSource: DataSource, validatedDeviceId: string, blockId: string, pattaNumber: bigint): Promise<void>;
validateOfflineSnapshotPayload(payload: OfflineSnapshotPayload): ValidatedOfflineSnapshotPayload;
```

- [ ] **Step 1: Write generation/service tests first.** Cover normalization, template defaults/explicit overrides/null clearing, template/model mismatch, inactive model/template, zero ACTIVE operations, all snapshot values, snapshot-derived `ish_soni`, future-effective price, and transaction/audit rollback.
- [ ] **Step 2: Lock one coherent generation state.** Validate the device before tenant transaction. In one tenant transaction lock model `FOR SHARE`, ACTIVE operations `FOR SHARE ORDER BY sort_order,id`, then selected template row; capture transaction timestamp once and resolve every price using the existing `OperationPriceService` with the transaction manager.
- [ ] **Step 3: Allocate online numbers transactionally.** Lock/update the same singleton sequence after model/operation locks and price resolution, calculate the contiguous range with `bigint`, then insert snapshot rows, derive each `ish_soni` with `COUNT(*)::integer`, insert Patta parents, and append audits. On any error (including an audit failure after the sequence update), transaction rollback must restore `next_number`; do not use `created_from_block_id` from client input. Store `created_from_block_id = NULL` for online generation to mean server sequence allocation, not device-block allocation.
- [ ] **Step 4: Insert historical records.** Persist model name, conveyor, dimensions, validated device, effective operation name/price/order, and template lineage from locked database rows. Derive `ish_soni` from snapshot count. Reuse the same resolved snapshot set for all Pattas in a batch.
- [ ] **Step 5: Add duplicate-safe error mapping.** Convert the required `(partiya_number, patta_number)` constraint and template/version constraints into structured API errors; do not add a unique constraint on `patta_number` alone.
- [ ] **Step 6: Implement bounded reads.** Lookup through query DTO to support slash-containing partiya strings. List filters with `page=1`, `limit=50`, maximum 100, stable `created_at DESC,id DESC`, and a response carrying total/page/limit/items; serialize BIGINT as strings and prices as decimal strings.
- [ ] **Step 7: Add offline-only validators without persistence.** Check block existence/device/range membership regardless of ACTIVE/EXHAUSTED/CANCELLED status; check the canonical `(partiya_number,patta_number)` for an existing record while leaving the DB unique constraint authoritative. Structurally validate unique operation IDs, nonempty names, decimal nonnegative prices, nonnegative integer sort order, and count; do not mark client data authoritative and do not add sync/event/queue behavior.
- [ ] **Step 8: Run focused tests.** Run Patta service/validator tests, lint, and typecheck.

### Task 7: Prove PostgreSQL behavior, update docs, and run regressions

**Files:** create `patta.integration.spec.ts`, complete `patta.e2e-spec.ts`; modify `apps/api/package.json`, `docs/database.md`, and `docs/testing.md`.

- [ ] **Step 1: Build safe real-DB fixtures.** Use only `TEST_MASTER_DB_*` pointing to `textile_master_test` (or another `_test` DB), generated `tenant_test_<uuid>` databases/roles, and Master company/device rows with valid FKs. Never use `textile_master` or a production database for destructive migration tests.
- [ ] **Step 2: Test migration/init/grants.** Apply migration, initialize default and custom start, initialize concurrently, change config and prove existing sequence is unchanged, verify runtime grants/constraints/triggers, down empty schema including an untouched initializer row, and reapply/init.
- [ ] **Step 3: Test allocator concurrency.** Run two-device and many concurrent allocations; assert no overlapping inclusive ranges, configured per-device active limits, sequence monotonicity, BIGINT string serialization, cancellation non-reuse, and exclusion constraint across all statuses.
- [ ] **Step 4: Test Master device security.** Against Master PostgreSQL verify ACTIVE same-company success; unknown, BLOCKED, REPLACED, and foreign-company devices map to exact error codes; Tenant A cannot allocate/use/cancel with Tenant B device; forged company/tenant IDs are rejected by strict DTO validation.
- [ ] **Step 5: Test Patta/accounting concurrency.** Race identical business-key inserts and prove one DB write succeeds. Race generation with rename/deactivate/new-operation/price-change; prove each committed batch uses one coherent operation set/price timestamp. Check audit-trigger failure rolls back sequence, Patta, snapshots, and audit together.
- [ ] **Step 6: Test history and tenant isolation.** Verify future price schedules, old snapshots after later rename/deactivation/price changes, same `(partiya,patta)` independently in two tenants, and no cross-tenant lookup access.
- [ ] **Step 7: Test API auth and validation.** Verify tenant permission allow/deny, platform token rejection, exact DeviceAccessService errors, unknown authority fields, batch upper bound, path/query filters, pagination, and BIGINT string payloads.
- [ ] **Step 8: Document behavior.** Add schema/initialization/runtime grants/rollback/config to `docs/database.md`; add test credentials and Patta unit/e2e/integration instructions to `docs/testing.md`.
- [ ] **Step 9: Run required validation.** Run the requested API lint/typecheck/unit/e2e/build commands plus `test:master-db`, `test:tenant-provisioning`, `test:models-operations`, `test:workers-badges`, and `test:patta`. Real PostgreSQL results count only when all suites ran with dedicated `_test` credentials; report missing credentials or any skipped database suite as blocked, never PASS.
- [ ] **Step 10: Review and deliver.** Check `git status`, `git diff --check`, full `git diff`, and branch name. Stage only Patta feature/doc files, create the requested feature commit, then push `origin feature/patta` if authentication/network permit.

## Plan self-review

- Schema, constraints, triggers, range exclusion, audit catalog, runtime grants, and safe down/up are covered in Tasks 1 and 7.
- Config validation, no-Number BIGINT math, idempotent/concurrent initialization, and no reset on existing tenants are covered in Tasks 2 and 7.
- Reusable Master device authorization and all required device ownership/status errors are covered in Tasks 3 and 7.
- Template normalization, optimistic versioning, model status, permissions, and audit are covered in Task 4.
- Block allocation, usage/cancel transitions, concurrency, reserved-range non-reuse, and decimal-string wire values are covered in Tasks 5 and 7.
- Online generation locks, atomic rollback/no committed gap on failed batches, snapshots, future prices, historical immutability, audit, lookup/list, and offline validation seam are covered in Tasks 6 and 7.
- Tenant isolation, platform-token rejection, regressions, docs, build/lint/typecheck/unit/e2e, commit, and push are covered in Task 7.
- No new permission catalog entries, Redis dependency, sync queue, Desktop, Patta sheet, payroll, report, or license workflow is planned.
