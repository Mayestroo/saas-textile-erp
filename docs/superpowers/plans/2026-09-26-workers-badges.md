# Workers and Badge History Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in this session, with the listed test checkpoints and a diff review at each task boundary.

**Goal:** Add tenant-isolated permanent worker identities and effective-dated badge assignments with transaction-safe audit.

**Architecture:** One additive tenant migration creates workers and badge history and introduces universal `audit_log.entity_key`; the UUID `entity_id` remains a nullable compatibility column. Thin tenant-authenticated controllers delegate to worker/badge services. PostgreSQL exclusion constraints, advisory locks, and row locks enforce correctness under races; the existing `AuditService` appends in the same business transaction.

**Tech Stack:** NestJS 12, strict TypeScript, TypeORM `DataSource`/`EntityManager`, PostgreSQL 16, Vitest, Supertest.

## Global Constraints

- Work only on `feature/workers-badges`.
- `workers.id` is permanent historical identity; worker IDs and BIGINT versions serialize as decimal strings.
- Name cleanup trims/collapses ASCII whitespace and preserves the user's casing; names are non-unique.
- Badge values remain canonical trimmed strings, never integers; intervals are `[valid_from, valid_to)`.
- Ordinary badge mutations reject `effective_at < DB NOW()`; past historical fixtures must bypass mutation services explicitly.
- Worker and badge mutations/audit are atomic; no hard-delete endpoint exists.
- Tenant routes require tenant auth and tenant permissions; no request-supplied tenant selector is accepted.
- Migrations remain additive; `synchronize: false`; no dependency changes or edits to committed migrations.
- PostgreSQL integration uses only generated `tenant_test_<uuid>` databases paired with `TEST_MASTER_DB_*` configured to `_test`.

---

## File map

**Create:**

- `database/tenant-migrations/20260926000400-AddWorkersAndBadgeHistory.js`
- `apps/api/src/tenant/workers/{workers.module.ts,workers.controller.ts,workers.service.ts,worker-errors.ts,worker-name.ts,worker-id.pipe.ts}`
- `apps/api/src/tenant/workers/dto/{create-worker.dto.ts,update-worker.dto.ts,list-workers.dto.ts}`
- `apps/api/src/tenant/badges/{badges.controller.ts,badge-history.service.ts,badge-resolution.service.ts,badge-number.pipe.ts}`
- `apps/api/src/tenant/badges/dto/{assign-badge.dto.ts,reassign-badge.dto.ts,release-badge.dto.ts,resolve-badge.dto.ts}`
- `apps/api/src/tenant/workers/workers.service.spec.ts`
- `apps/api/src/tenant/audit/audit.service.spec.ts`
- `apps/api/src/tenant/badges/{badge-history.service.spec.ts,badge-resolution.service.spec.ts}`
- `apps/api/src/tenant/workers/workers-badges.e2e-spec.ts`
- `apps/api/src/tenant/workers/workers-badges.integration.spec.ts`

**Modify:**

- `apps/api/src/tenant/audit/audit.service.ts` — universal entity key, UUID compatibility, expanded audit types/actions.
- `apps/api/package.json` — add `test:workers-badges` integration script.
- `apps/api/src/database/tenant/tenant-database-manager.ts` — grant runtime DML on the two feature tables.
- `apps/api/src/tenant/tenant.module.ts` — register WorkersModule.
- `docs/database.md`, `docs/rbac.md`, `docs/testing.md` — feature schema/security/test workflow.

Existing `workers.view`, `workers.manage`, and `workers.badge.manage` seeds already exist; preserve/reuse them.

## Task 1: Audit key and database migration

**Files:** migration, AuditService, tenant runtime grants, integration test.

**Interface:** `AuditService.append(manager, {actorUserId, entityType, entityId, action, before, after})` always inserts `entity_key = String(entityId)`. It inserts matching `entity_id UUID` only when `entityId` is canonical UUID text, otherwise NULL. Entity types become `model | operation | worker | badge`; add worker create/update/deactivate and badge assign/reassign/close/release actions.

- [ ] Add PostgreSQL tests first: legacy UUID audit backfill; new tables/index/runtime grants; clean down/reapply; non-UUID key down rejection; worker/badge CHECK-value down rejection; populated feature tables down rejection. Assert failed down leaves all rows/schema intact. To prove backfill, revert migration 004 while clean, insert one legacy UUID audit row, reapply migration 004, and assert its exact UUID text appears in `entity_key`.
- [ ] Add `"test:workers-badges": "vitest run src/tenant/workers/workers-badges.integration.spec.ts"` to `apps/api/package.json` and run it; expected initial failure before migration/service implementation.
- [ ] Migration up: ensure `btree_gist`; add nullable `entity_key`; temporarily drop the append-only audit trigger while backfilling `entity_id::text`; set `entity_key NOT NULL`; restore trigger; make legacy `entity_id` nullable; replace audit checks; add `(entity_type, entity_key)` index; create `workers`, `worker_badge_history`, indexes, FK/CHECK constraints, no-delete/close-only triggers, and GiST exclusion over badge equality plus `tstzrange(valid_from, COALESCE(valid_to, 'infinity'), '[)')`.
- [ ] Migration down begins with a preflight before any DDL: refuse populated worker/history tables; refuse any audit key not canonical UUID text, any missing/different legacy UUID, or any entity/action outside the old checks. Raise an explicit migration exception. If compatible, restore the old checks and `entity_id NOT NULL`, remove feature tables and new index/key, and leave legacy UUID values untouched. Do not delete or update audit rows.
- [ ] Extend `AuditService` SQL to insert both `entity_id` and `entity_key`. Preserve `entity_id` for canonical UUID model/operation/badge IDs; use NULL for BIGINT/string IDs.
- [ ] Add literal `workers` and `worker_badge_history` table names to `TenantDatabaseManager.grantRuntimePrivileges()`; retain the existing all-sequence grant for the identity sequence.
- [ ] Re-run the PostgreSQL migration/audit tests; expected: compatible clean down passes, each lossy down refuses atomically, and reapply succeeds.

## Task 2: Worker identity and optimistic updates

**Files:** worker service, name helper, ID pipe, DTOs, errors, unit tests.

**Interface:**

```ts
type WorkerStatus = 'ACTIVE' | 'INACTIVE';
interface WorkerRecord { id: string; full_name: string; status: WorkerStatus; version: string; created_at: string; updated_at: string; }
list(source: DataSource, status?: WorkerStatus): Promise<WorkerRecord[]>;
getById(source: DataSource, id: string): Promise<WorkerRecord>;
create(source: DataSource, actor: string, input: CreateWorkerDto): Promise<WorkerRecord>;
update(source: DataSource, actor: string, id: string, input: UpdateWorkerDto): Promise<WorkerRecord>;
```

- [ ] Test whitespace cleanup (`'  Abdullayeva\t Nodira  '` → `'Abdullayeva Nodira'`), case preservation, blank rejection, duplicate names allowed, generated string ID/version, list/get, missing record, expected-version increment/conflict, and no delete query.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/workers/workers.service.spec.ts`; expected: fail before implementation.
- [ ] Implement cleanup with `value.replace(/[ \t\n\v\f\r]+/g, ' ').trim()` only. DTOs accept only ACTIVE/INACTIVE, positive decimal-string IDs/versions, and reject unknown fields through existing global ValidationPipe.
- [ ] Implement SQL serialization with `id::text`, `version::text`, and UTC timestamps. Create/update run inside `DataSource.transaction`; update locks the worker `FOR UPDATE`, compares `expected_version`, increments version, and writes worker audit before commit.
- [ ] Route an ACTIVE→INACTIVE update through the transaction's badge-close operation: lock badge rows, close all currently open assignments at one DB transaction timestamp, update status/version, append badge-close and worker-deactivate audit, then commit. Any close/audit failure rolls back the status change.
- [ ] Return structured Uzbek errors for worker not-found, invalid name, and `VERSION_CONFLICT`; never expose driver SQL text. Re-run worker unit tests; expected: all assertions pass.

## Task 3: Badge history, assignment, reassignment, release, and resolution

**Files:** badge history/resolution services, badge DTOs/controller, worker service integration, unit tests.

**Interfaces:**

```ts
interface BadgeResolution { worker_id: string; full_name: string; assignment: { id: string; badge_number: string; valid_from: string; valid_to: string | null; }; }
resolve(source: DataSource, badge: string, performedAt: string): Promise<BadgeResolution>;
resolveCurrent(source: DataSource, badge: string): Promise<BadgeResolution>;
closeOpenAssignmentsForWorker(manager: EntityManager, actor: string, workerId: string, at: string): Promise<BadgeAssignmentRecord[]>;
```

- [ ] Test resolution at `valid_from`, inside an old range, exactly at `valid_to`, current open range, and no match; assert join/group identity is `worker_id` only.
- [ ] Test assign/reassign/release, preserving `00125`, rejecting empty badge/inactive or missing worker, no current assignment, active assignment conflict, old owner history, strict non-backdate, service audit rollback, and structured exclusion-constraint conflict.
- [ ] Implement trim-only badge canonicalization and reject empty strings. Serialize each badge mutation with tenant-local `pg_advisory_xact_lock(hashtextextended('worker-badge:' || $1, 0))`; bind the badge value as a parameter.
- [ ] Assignment: read `transaction_timestamp()`, lock target worker `FOR UPDATE`, require ACTIVE, reject an open owner, insert history, append `badge.assign` audit keyed by history UUID.
- [ ] Reassignment: advisory-lock badge, lock current open history row, lock/validate target worker ACTIVE, require effective time `>= transaction_timestamp()` and `> old.valid_from`, close old row, insert new open row, append `badge.reassign` audit.
- [ ] Release: lock badge/current row, apply the same DB-time validation, close once, append `badge.release`. Worker deactivation uses `badge.close` for every row closed by that transaction.
- [ ] For all badge audits, use history row UUID as `entity_key`; JSON includes `badge_number`, string `worker_id`, `valid_from`, `valid_to`, and history `id`. Never key audit by reusable badge number.
- [ ] Implement chronological worker history (`valid_from, id`), current owner, and the exact half-open resolver predicate. Re-run resolver and badge unit tests; expected: pass.

## Task 4: Tenant API, auth, RBAC, and validation

**Files:** both controllers, feature module, tenant.module, e2e spec.

- [ ] E2E first: verify unauthenticated and platform tokens get 401; `workers.view` reads but cannot mutate; `workers.manage` manages workers only; `workers.badge.manage` manages badges; absent permission gets 403.
- [ ] E2E invalid bodies/paths: empty name/badge, nonpositive worker ID/version, invalid status/time, unknown field; expect 400 and no service call. Confirm no DELETE route exists.
- [ ] Implement routes: `GET/POST /api/v1/workers`, `GET/PATCH /api/v1/workers/:id`, `GET/POST /api/v1/workers/:id/badges`, `POST /api/v1/badges/:badgeNumber/reassign`, `POST /api/v1/badges/:badgeNumber/release`, and protected `GET /api/v1/badges/:badgeNumber/resolve?at=...`.
- [ ] Worker list/get/history/resolve require `workers.view`; worker create/update/deactivate require `workers.manage`; badge assign/reassign/release require `workers.badge.manage`.
- [ ] Register tenant auth/permission guards, tenant connection/resolver and audit modules in `WorkersModule`, then import it into `TenantModule`. Controllers use `requireTenantContext()` and contain no business SQL/rules.
- [ ] Run `npm run test:e2e --workspace=apps/api -- src/tenant/workers/workers-badges.e2e-spec.ts`; expected: endpoint/auth/permission/DTO checks pass.

## Task 5: Real PostgreSQL constraints, concurrency, audit, and tenant isolation

**Files:** `workers-badges.integration.spec.ts`, migration/services if fixes are required.

- [ ] Follow `models-operations.integration.spec.ts`: configure all five `TEST_MASTER_DB_*` values, require `_test`, provision only generated tenant DBs, grant runtime roles, and clean only through `TenantTestDatabaseCleanup`.
- [ ] Verify DB CHECK/FK/no-delete protections, identity/string serialization, duplicate names, leading-zero badges, interval validity, runtime grants, half-open adjacency, and direct SQL overlap rejection by the named exclusion constraint.
- [ ] Race two independent service transactions assigning one unused badge to different active workers; assert exactly one succeeds and only one open interval remains.
- [ ] Verify worker create/update/deactivate and badge assign/reassign/release audit data; inject audit failure and assert worker/history mutation rollback.
- [ ] Create the historical Jan–May worker 18 / May-on worker 47 fixture with test-only SQL inserts (not the ordinary backdate-rejecting mutation service); resolve January as 18 and May/June as 47. Separately assert service rejects `effective_at < transaction_timestamp()` without writes.
- [ ] Create two generated tenant databases with worker `id = 1` and badge `125` independently; resolve through each tenant DataSource and prove no cross-database access.
- [ ] Run `npm run test:workers-badges --workspace=apps/api`; expected: integration suite executes (does not skip) and passes on PostgreSQL 16.

## Task 6: Docs, full validation, commit, and push

**Files:** `docs/database.md`, `docs/rbac.md`, `docs/testing.md` plus feature sources/tests.

- [ ] Document schema/index/interval rules, permanent IDs, casing-preserving normalization, deactivation closure, entity-key compatibility/rollback refusal, route permissions, and test DB safety.
- [ ] Run exactly:

```powershell
npm run lint --workspace=apps/api
npm run typecheck --workspace=apps/api
npm run test --workspace=apps/api
npm run test:e2e --workspace=apps/api
npm run build --workspace=apps/api
npm run test:workers-badges --workspace=apps/api
```

- [ ] Inspect `git status`, `git diff --check`, and `git diff`; stage only intended Workers + Badge History files and commit as `feat: add workers and badge history`.
- [ ] Push only the feature branch with `git push -u origin feature/workers-badges`; report actual push result.
