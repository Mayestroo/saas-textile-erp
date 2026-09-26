# Models and Operation Price History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant-local models, operations, and non-overlapping effective-dated prices with optimistic locking, audit, permissions, and tenant isolation.

**Architecture:** An additive PostgreSQL tenant migration protects status, name, money, FK, audit append-only, and price interval invariants. Thin tenant-guarded Nest controllers pass the authenticated tenant DataSource to domain services; transaction-scoped services perform mutations, audit, version checks, and all price resolution against `model_operation_prices`.

**Tech Stack:** NestJS 12, TypeScript 7, TypeORM DataSource/EntityManager, PostgreSQL 16, Vitest, Supertest, class-validator, `decimal.js` (already installed).

## Global Constraints

- Work only on `feature/models-operations`; it is fast-forwarded to `main` at `27346b6029bf356d527866283da19d48f80b9435`.
- Keep `synchronize: false`; use only an additive tenant migration.
- Never edit committed migrations.
- Resolve tenant identity only through the existing tenant guards and authenticated request DataSource; reject platform tokens.
- `models.view` is required for reads; `models.manage` is required for mutations.
- No hard-delete route or mutation is allowed.
- API money is a decimal string backed by PostgreSQL `NUMERIC(14,2)` and `decimal.js`; never use JavaScript `number` for price arithmetic.
- API BIGINT versions are decimal integer strings; every update requires `expected_version` and a stale version returns `VERSION_CONFLICT`.
- `model_operation_prices` is the only price authority. Current price is resolved through `OperationPriceService` at the database transaction/current timestamp; never use `model_operations.price` as an effective price.
- `effective_from` is optional. Omitted means the transaction's `transaction_timestamp()`; a supplied value must be greater than or equal to that database timestamp.
- Only append a price after the currently open interval's `valid_from`. Never silently split or replace a future schedule; return a structured conflict.
- Reject price changes for inactive operations. Reject operation creation or reactivation beneath an inactive model. Model deactivation does not modify child operations.
- Audit records commit in the same transaction as their business mutation and are append-only.
- Do not add Workers, Badges, Patta, Sync, Payroll, or Desktop behavior.
- Final verification commands: `npm run lint --workspace=apps/api`, `npm run typecheck --workspace=apps/api`, `npm run test --workspace=apps/api`, `npm run test:e2e --workspace=apps/api`, and `npm run build --workspace=apps/api`, plus configured real-PostgreSQL feature integration tests.

---

## File Map

| File | Responsibility |
|---|---|
| `database/tenant-migrations/20260926000300-AddModelsOperationsAndPriceHistory.js` | Models, operations, audit, canonical-name support, price history, indexes, checks, FKs, append-only trigger, and exclusion constraint. |
| `apps/api/src/tenant/audit/audit.service.ts` | Reusable transaction-manager-backed append-only audit insert. |
| `apps/api/src/tenant/models/dto/*.ts` | Validated model create/update/list contracts. |
| `apps/api/src/tenant/models/models.service.ts` | Model reads, create/update/deactivate, name normalization, optimistic versioning, audit. |
| `apps/api/src/tenant/models/models.controller.ts` | Thin guarded model endpoints. |
| `apps/api/src/tenant/models/models.module.ts` | Model providers/controllers. |
| `apps/api/src/tenant/operations/dto/*.ts` | Operation create/update, price schedule, and history query contracts. |
| `apps/api/src/tenant/operations/operations.service.ts` | Operation list/create/update/deactivate, model-state rules, optimistic versioning, audit. |
| `apps/api/src/tenant/operations/operation-price.service.ts` | Initial price history, append-only scheduling, and effective-time/current price resolution. |
| `apps/api/src/tenant/operations/operations.controller.ts` | Thin guarded operation and price-history endpoints. |
| `apps/api/src/tenant/operations/operations.module.ts` | Operation providers/controllers. |
| `apps/api/src/tenant/tenant.module.ts` | Register feature modules. |
| `apps/api/src/database/tenant/tenant-database-manager.ts` | Grant tenant runtime DML access to new business/audit tables during provisioning. |
| `apps/api/src/tenant/models/models.service.spec.ts` | Unit tests for normalized model CRUD, conflicts, audit, and deactivation. |
| `apps/api/src/tenant/operations/operations.service.spec.ts` | Unit tests for model-state checks, operation CRUD, validation, and conflicts. |
| `apps/api/src/tenant/operations/operation-price.service.spec.ts` | Unit tests for scheduling, current/historical resolution, and backdating. |
| `apps/api/src/tenant/models/models-operations.e2e-spec.ts` | HTTP validation, tenant/platform auth, permission, and route behavior using Nest testing conventions. |
| `apps/api/src/tenant/models/models-operations.integration.spec.ts` | Real PostgreSQL migration, constraint, price timeline, transactional audit, and two-database isolation workflow. |
| `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts` | Update assertions that intentionally inspect the latest tenant migration/schema. |
| `apps/api/package.json` | Add an explicit feature PostgreSQL integration test script. |
| `docs/database.md`, `docs/testing.md`, `docs/IMPLEMENTATION.md` | Document migration, schema constraints, price semantics, and real DB test execution. |

## Shared Interfaces

Use request-scoped tenant context from `TenantAuthenticatedRequest`; services
receive its `DataSource` explicitly. Audit uses the transaction manager so no
service can accidentally commit an audit event outside the mutation:

```ts
interface AuditEventInput {
  actorUserId: string;
  entityType: 'model' | 'operation';
  entityId: string;
  action:
    | 'model.create' | 'model.update' | 'model.deactivate'
    | 'operation.create' | 'operation.update'
    | 'operation.deactivate' | 'operation.price_change';
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
}

class AuditService {
  append(manager: EntityManager, event: AuditEventInput): Promise<void>;
}

class OperationPriceService {
  createInitialPrice(
    manager: EntityManager,
    operationId: string,
    price: string,
    actorUserId: string,
    effectiveAt: Date,
  ): Promise<void>;
  changePrice(
    dataSource: DataSource,
    input: {
      operationId: string;
      price: string;
      effectiveFrom?: string;
      expectedVersion: string;
      actorUserId: string;
    },
  ): Promise<OperationPriceChangeResult>;
  resolvePrice(operationId: string, effectiveAt: Date, dataSource: DataSource): Promise<string>;
}
```

The migration's canonicalization function and generated normalized-name values
are authoritative for both model and operation uniqueness. Application input
normalization mirrors the database rule (trim; collapse ASCII whitespace
sequences; preserve display case). Tests compare the service canonical result
with the PostgreSQL function for spaces, tabs, CR/LF, and case variants.

---

## Task 1: Add Tenant Schema and Real PostgreSQL Migration Coverage

**Files:**
- Create: `database/tenant-migrations/20260926000300-AddModelsOperationsAndPriceHistory.js`
- Create: `apps/api/src/tenant/models/models-operations.integration.spec.ts`
- Modify: `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts`
- Modify: `apps/api/src/database/tenant/tenant-database-manager.ts`
- Modify: `apps/api/package.json`

**Interfaces:** Migration class name is `AddModelsOperationsAndPriceHistory20260926000300`; it follows the existing TypeORM JavaScript migration glob. The integration suite creates only generated `tenant_test_<uuid>` databases through the existing `TenantDatabaseManager` and `TenantTestDatabaseCleanup` helpers.

- [ ] Add migration verification cases first: `up`, schema inspection, DB check/unique/FK/exclusion violations, `down`, and `up` again.
- [ ] Run the focused test with all five `TEST_MASTER_DB_*` values targeting `textile_master_test`; verify the new test fails because the migration is absent.
- [ ] Add migration tables and constraints. Use `NUMERIC(14,2)`, `BIGINT` versions, canonical-name function plus generated name key, partial active-name unique indexes, restrictive historical FKs, and query indexes.
- [ ] Add `CREATE EXTENSION IF NOT EXISTS btree_gist`; define price exclusion as `operation_id WITH =` plus `tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&`.
- [ ] Add audit JSONB fields and a trigger rejecting UPDATE/DELETE. `down` removes feature triggers, function, tables, indexes and feature functions in dependency order; it does not drop shared `btree_gist`.
- [ ] Add DB tests for lower/trim/collapsed-whitespace canonical uniqueness, FK/check errors, adjacent non-overlap acceptance, real overlap rejection, and audit update/delete rejection.
- [ ] Add the four new business/audit tables to the explicit `GRANT SELECT, INSERT, UPDATE, DELETE` list in `TenantDatabaseManager.grantRuntimePrivileges`; assert a generated tenant runtime role can read and write them after provisioning.
- [ ] Update tenant provisioning's expected latest migration name and table listing. Change its rollback/reapply assertions to undo/reapply the feature migration and assert the feature tables disappear/reappear while committed auth tables remain.
- [ ] Add `"test:models-operations": "vitest run src/tenant/models/models-operations.integration.spec.ts"` to `apps/api/package.json`.
- [ ] Run `npm run test:models-operations --workspace=apps/api` and `npm run test:tenant-provisioning --workspace=apps/api` against the dedicated PostgreSQL test configuration; both must pass.

## Task 2: Implement Transaction-Scoped Tenant Audit and Models

**Files:**
- Create: `apps/api/src/tenant/audit/audit.service.ts`
- Create: `apps/api/src/tenant/models/dto/create-model.dto.ts`
- Create: `apps/api/src/tenant/models/dto/update-model.dto.ts`
- Create: `apps/api/src/tenant/models/dto/list-models.dto.ts`
- Create: `apps/api/src/tenant/models/models.service.ts`
- Create: `apps/api/src/tenant/models/models.service.spec.ts`

**Interfaces:** `ModelsService` receives `DataSource`, actor UUID, and validated DTOs; update DTO carries `expected_version: string`. All writes use `dataSource.transaction`. `AuditService.append(manager, event)` inserts via the same EntityManager.

- [ ] Write unit tests for trimmed/collapsed names, duplicate conflict, create audit, list/get, update with matching version, stale `VERSION_CONFLICT`, deactivate audit, no hard delete, and audit transaction-manager identity.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/models/models.service.spec.ts`; confirm tests fail before implementation.
- [ ] Implement shared structured domain errors for not found, duplicate, and `VERSION_CONFLICT`; map PostgreSQL unique codes by known constraint names without exposing SQL details.
- [ ] Implement database-aligned canonical name normalization and model create/list/get/update/deactivate. Model updates lock the row, check expected version after lock, then increment `version` and append audit inside the transaction.
- [ ] Use database time for `created_at`/`updated_at`; return versions as strings. Deactivate by status update only.
- [ ] Run the focused service suite; all cases must pass.

## Task 3: Implement Operations and Effective-Dated Price Services

**Files:**
- Create: `apps/api/src/tenant/operations/dto/create-operation.dto.ts`
- Create: `apps/api/src/tenant/operations/dto/update-operation.dto.ts`
- Create: `apps/api/src/tenant/operations/dto/change-operation-price.dto.ts`
- Create: `apps/api/src/tenant/operations/dto/list-operation-prices.dto.ts`
- Create: `apps/api/src/tenant/operations/operations.service.ts`
- Create: `apps/api/src/tenant/operations/operation-price.service.ts`
- Create: `apps/api/src/tenant/operations/operations.service.spec.ts`
- Create: `apps/api/src/tenant/operations/operation-price.service.spec.ts`

**Interfaces:** `OperationsService.create(dataSource, modelId, actorUserId, input)` creates the operation and initial history in one transaction. `OperationPriceService.changePrice(...)` locks the operation row, checks active status and `expected_version` after acquiring the lock, reads one `transaction_timestamp()`, chooses it when `effective_from` is omitted, rejects supplied timestamps earlier than it, requires append-after-open-start, closes the open interval, creates the new open interval, increments the operation version, updates only compatibility `price`, and appends audit before commit. `resolvePrice(operationId, effectiveAt, dataSource)` reads only `model_operation_prices` and returns a decimal string.

- [ ] Write operation tests for create+initial history atomicity, active-model requirement, normalized duplicate operation names per model, list by model, update/deactivate version behavior, inactive-model reactivation rejection, inactive-operation price rejection, decimal and sort-order validation.
- [ ] Write price service tests for current and historical interval lookup, omitted date uses transaction time, equal transaction time acceptance, past rejection, future append acceptance, current lookup remains old before future start, lookup at/after future start returns new price, second later schedule forms a chain, insertion into/reordering an existing schedule conflicts, stale concurrent expected version, overlap driver violation maps to a safe conflict, and audit rollback when any later write fails.
- [ ] Run both focused suites and confirm new cases fail before implementation.
- [ ] Implement decimal validation with `Decimal`, reject negatives, values exceeding `NUMERIC(14,2)`, and more than two fractional digits; keep all response prices as strings.
- [ ] Lock the parent model row before operation create/reactivation and require it to be ACTIVE. Never cascade model deactivation to child operations.
- [ ] Create initial price with the same transaction timestamp as operation creation. `model_operations.price` may track latest configured price but is never selected for current/historical API/business reads.
- [ ] Implement price resolution as interval predicate `valid_from <= effective_at AND (valid_to IS NULL OR effective_at < valid_to)` against history only.
- [ ] Map exclusion SQLSTATE `23P01` to a structured operation price conflict. Commit old interval close, new interval insert, operation version/compatibility update, and audit atomically.
- [ ] Run both focused suites; all cases must pass.

## Task 4: Expose Guarded Tenant API and Verify HTTP Security

**Files:**
- Create: `apps/api/src/tenant/models/models.controller.ts`
- Create: `apps/api/src/tenant/models/models.module.ts`
- Create: `apps/api/src/tenant/operations/operations.controller.ts`
- Create: `apps/api/src/tenant/operations/operations.module.ts`
- Create: `apps/api/src/tenant/models/models-operations.e2e-spec.ts`
- Modify: `apps/api/src/tenant/tenant.module.ts`

**Interfaces:** All handlers use `@UseGuards(TenantAuthGuard, TenantPermissionGuard)`, `@TenantPermissions(...)`, and `@Req()` typed `TenantAuthenticatedRequest`. Missing authenticated principal/DataSource fails closed. Models and operations modules share transaction-safe services and `AuditService`.

- [ ] Write endpoint tests for unauthenticated access, platform token rejection, tenant token success, view-vs-manage allow/deny, DTO unknown-field/invalid-price/timestamp errors, and exact route/service delegation.
- [ ] Run `npm run test:e2e --workspace=apps/api -- src/tenant/models/models-operations.e2e-spec.ts`; confirm expected failures before wiring controllers.
- [ ] Implement routes from the approved design. Reads require `models.view`; model/operation create, update, deactivate, and price scheduling require `models.manage`.
- [ ] Make current-price fields resolve with `OperationPriceService` at a database timestamp; no controller, serializer, or service reads `model_operations.price` as effective price.
- [ ] Register feature modules in `TenantModule` without adding platform routes or unrelated modules.
- [ ] Run feature e2e tests and existing `npm run test:e2e --workspace=apps/api`.

## Task 5: Verify Full PostgreSQL Workflow, Document, and Deliver

**Files:**
- Modify: `docs/database.md`
- Modify: `docs/testing.md`
- Modify: `docs/IMPLEMENTATION.md`
- Verify: all feature files and `git status`/`git diff`

- [ ] Extend the real PostgreSQL suite to create same-named models in two generated tenant databases; prove each tenant sees only its own model and same-name data does not collide.
- [ ] Exercise the requested DB workflow end-to-end: migration up; model create; operation create and initial history; future price schedule; current and historical lookup; overlapping direct SQL insert rejected; migration down and reapply.
- [ ] Document schema, generated canonical-name rule, intervals/exclusion constraint, schedule append rule, API permissions, DB-time semantics, and exact feature integration-test setup.
- [ ] With `TEST_MASTER_DB_*` set only for `textile_master_test`, run: `npm run test:models-operations --workspace=apps/api`, `npm run test:tenant-provisioning --workspace=apps/api`, then the requested lint, typecheck, full unit test, e2e, and build commands.
- [ ] Fix only regressions caused by this feature and repeat failed relevant checks.
- [ ] Inspect `git status`, `git diff`, and recent log on `feature/models-operations`; stage only feature implementation, test, and documentation files.
- [ ] Create implementation commit `feat: add models and operation price history`.
- [ ] Push with `git push -u origin feature/models-operations`; report a precise auth/network failure rather than claiming success.
