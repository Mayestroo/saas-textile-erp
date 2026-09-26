# Models, Operations, and Operation Price History Design

## Goal and scope

Implement tenant-local product models, model operations, and effective-dated
operation prices. Preserve the database-per-tenant boundary and ensure a price
change never rewrites the price resolved for an earlier effective time. This
stage does not implement workers, badges, Patta, offline sync, sheets, payroll,
reports, licensing workflows, or desktop UI.

The feature branch is based on the completed Auth + RBAC implementation by a
fast-forward from `main`; no merge commit or rebase is used.

## Tenant schema

An additive tenant migration creates:

- `models`: UUID identity, name, `ACTIVE`/`INACTIVE` status, optimistic-lock
  version, and creation/update timestamps.
- `model_operations`: model FK, name, latest-configured compatibility price,
  nonnegative sort order, `ACTIVE`/`INACTIVE` status, optimistic-lock version,
  and timestamps.
- `model_operation_prices`: operation FK, `NUMERIC(14,2)` price,
  `[valid_from, valid_to)` interval, optional actor, and creation timestamp.
- `audit_log`: append-only tenant audit events with actor, entity type/id,
  action, before/after JSON, and creation time.

Names are canonicalized by trimming ASCII space/tab/LF/VT/FF/CR and collapsing
consecutive such characters to one ASCII space, then compared using the
PostgreSQL lowercase form. The database owns the canonical form and partial unique
indexes enforce uniqueness among active models and among active operation names
within one model. Inactive historical records remain; reactivation can fail
with a structured duplicate-name conflict.

The migration adds check constraints for statuses, nonempty names, nonnegative
prices and sort orders, positive versions, and valid time ranges. It enables
`btree_gist` and adds a GiST exclusion constraint that prevents overlapping
price intervals for the same operation. Foreign keys use restrictive delete
behavior for historical entities. Query indexes cover status filters,
operations by model, and operation price lookup by effective time.

## API and authorization

Tenant endpoints use the established tenant auth and RBAC guards and the
authenticated request's tenant DataSource. They never accept a tenant/database
selector from the caller. Read routes require `models.view`; all create, update,
deactivate, and price-scheduling routes require `models.manage`. Platform
tokens are rejected by the tenant guard.

Routes follow the existing `/api/v1` convention:

```text
GET    /api/v1/models
POST   /api/v1/models
GET    /api/v1/models/:id
PATCH  /api/v1/models/:id
GET    /api/v1/models/:id/operations
POST   /api/v1/models/:id/operations
PATCH  /api/v1/operations/:id
POST   /api/v1/operations/:id/price
GET    /api/v1/operations/:id/prices
```

Controllers remain thin and delegate to model, operation, audit, and price
services. DTOs reject unknown fields and validate trimmed nonempty names,
statuses, decimal prices, nonnegative sort order, timestamps, and
`expected_version` on update requests (create requests start at version 1).
Since PostgreSQL `BIGINT` may exceed JavaScript's safe integer range, versions
cross the API boundary as decimal integer strings.
Prices cross the API boundary as decimal strings and use `decimal.js`; binary
floating-point arithmetic is not used.

Optimistic updates match the supplied expected version and increment the stored
version in the same write. A mismatch returns structured `VERSION_CONFLICT`.
Hard-delete routes do not exist; deactivation preserves historical rows.

## Price timeline semantics

`model_operation_prices` is the only authoritative source for prices. Every
effective-time lookup, including a current-price response, goes through
`OperationPriceService(operation_id, effective_at)` and queries the matching
`[valid_from, valid_to)` history interval. A missing interval is an explicit
not-found/conflict result; there is no fallback to `model_operations.price`.

`model_operations.price` may remain as a compatibility/denormalized value and
may be updated to the latest configured schedule price, but business
calculations and API current-price reads must not rely on it. A future schedule
therefore does not change the price returned for the current DB time. Newly
created initial history starts at the database transaction timestamp.

Price creation and scheduling run in a tenant transaction:

1. Lock the operation row and check its expected version/status after acquiring
   the lock. Reject a schedule for an `INACTIVE` operation.
2. Read the database transaction timestamp once. If optional `effective_from`
   is omitted, use this value; otherwise use the supplied timestamp. Use the
   same DB timestamp for validation and initial interval creation; equality is
   accepted.
3. Reject an `effective_from` earlier than that timestamp.
4. Require the new effective time to be after the current open interval's
   `valid_from`; this permits only appending after the last open interval and
   returns an explicit conflict for attempts to insert inside/reorder a future
   schedule.
5. Close the open interval at `effective_from` and insert the new open interval.
6. Update the operation's compatibility price/version and append the audit
   event.
7. Commit all writes atomically.

The database exclusion constraint remains the final defense against concurrent
or direct overlapping writes. A newly created operation receives its initial
open price interval in the same transaction as the operation row. A DB trigger
makes price history immutable except a one-time transition of an open interval's
`valid_to` from NULL to its closing boundary; history rows cannot be deleted.
Model and operation rows also cannot be hard-deleted. Operation creation and
operation reactivation require an active parent model. Deactivating a model
does not change child operation status.

For example, sequential scheduling yields:

```text
1,000: [2026-09-01, 2026-10-01)
1,200: [2026-10-01, 2026-11-01)
1,350: [2026-11-01, NULL)
```

The service rejects backdating. The operation row lock serializes competing
price changes, and the exclusion constraint rejects any interval overlap even
when application-level checks race.

## Audit

The feature adds a reusable tenant `AuditService` and append-only audit table
because no tenant audit implementation exists yet. Model create/update/
deactivate and operation create/update/deactivate/price-change actions record
actor, entity, action, before/after JSON, and database creation time in the same
transaction as the business mutation. Database triggers reject normal-flow
updates/deletes to audit records. No audit browsing endpoint is added in this
stage.

## Validation and testing

Unit/API tests cover model and operation CRUD/deactivation, normalized duplicate
rules, optimistic conflicts, decimal validation, permissions, platform-token
rejection, and structured errors. Price tests cover initial history, interval
closure and appending, current and historical resolution, future schedules,
backdate rejection, current-price stability before a future effective time,
schedule conflicts, and concurrent/overlap rejection.

Real PostgreSQL integration tests apply the additive migration, validate FK,
CHECK, unique, and exclusion constraints, revert and reapply it, create
model/operation/history records, schedule and resolve prices at different
effective times, and verify runtime permissions. Tenant isolation uses two
separately provisioned test tenant databases and confirms data with identical
names remains isolated. The integration suite uses only a dedicated `_test`
Master database and generated test tenants.

The feature verification includes API lint, typecheck, unit tests, e2e tests,
build, and the relevant real-PostgreSQL integration tests. Documentation is
updated to describe the new schema, price semantics, and test workflow.
