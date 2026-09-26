# Workers and Badge History Design

## Goal and scope

Implement tenant-local workers and effective-dated physical badge assignments.
`workers.id` is the permanent worker identity; a badge number is a reusable
physical token whose owner is resolved using the operation timestamp. Historical
attribution must remain stable across deactivation, release, and reassignment.
This stage does not implement Patta, offline sync, Patta sheets, payroll,
reports, licensing workflows, or desktop UI.

The implementation reuses the current tenant database-per-company architecture,
tenant authentication/RBAC, `TenantConnectionManager`, migration runner,
append-only `audit_log`, and `AuditService`.

## Tenant schema

An additive tenant migration creates:

- `workers`: generated non-reused `BIGINT` identity, sentence-case display
  `full_name`, `ACTIVE`/`INACTIVE` status, positive `BIGINT` version, and
  database-managed timestamps. Names are trimmed and consecutive ASCII
  whitespace is collapsed; names are not unique and are never identity keys.
- `worker_badge_history`: UUID row identity, canonical trimmed badge string,
  restrictive worker FK, `[valid_from, valid_to)` interval, optional actor, and
  creation timestamp. Badge values remain strings, including leading zeroes.
- A GiST exclusion constraint on badge equality and interval overlap, using
  `btree_gist`, prevents simultaneous ownership even for concurrent/direct DB
  writes. Indexes support worker, badge, and effective-time history lookups.

CHECK constraints protect status, positive versions, nonempty canonical names
and badges, and valid intervals. Worker and badge-history rows cannot be hard
deleted; worker foreign keys use restrictive deletion. Badge history may only
be closed once, preserving the assignment record and interval.

## Universal audit entity identity

Existing audit records use UUID `audit_log.entity_id`, but worker identity is a
BIGINT and future tenant entity IDs may be UUID, BIGINT, or strings. The same
additive tenant migration therefore:

1. Adds `audit_log.entity_key VARCHAR NOT NULL`.
2. Backfills every existing row with `entity_id::text`, preserving UUID text.
3. Adds an index on `(entity_type, entity_key)` and extends allowed entity types
   and actions for worker and badge events.
4. Makes the UUID `entity_id` nullable and leaves it in place as legacy
   compatibility; UUID-producing events continue filling it, while
   `entity_key` is the canonical lookup/source field for all new audit records.

`AuditService` writes `entity_key = String(entityId)` for every new event. Worker
IDs therefore appear as strings such as `"18"`; badge events consistently use
the created/closed badge-history UUID as their audit entity key. Down migration
drops the new index and `entity_key` without altering or removing any legacy
UUID values. It keeps the broadened audit type/action checks and nullable legacy
column when newer audit rows exist, so rollback does not delete audit records or
rewrite UUID values.

## API and authorization

Tenant routes follow the existing `/api/v1` controller conventions, derive the
DataSource and actor only from authenticated tenant request context, and use
`TenantAuthGuard` plus `TenantPermissionGuard`. Platform-scoped tokens are
rejected by the tenant guard. No tenant selector is accepted from request data.

Conceptual routes:

```text
GET    /api/v1/workers
POST   /api/v1/workers
GET    /api/v1/workers/:id
PATCH  /api/v1/workers/:id
GET    /api/v1/workers/:id/badges
POST   /api/v1/workers/:id/badges
POST   /api/v1/badges/:badgeNumber/reassign
POST   /api/v1/badges/:badgeNumber/release
GET    /api/v1/badges/:badgeNumber/resolve?at=...
```

Worker list/get and badge-history/resolution reads require `workers.view`.
Worker create/update/deactivate requires `workers.manage`; badge assignment,
reassignment, and release requires `workers.badge.manage`. No DELETE routes are
provided. DTOs trim and validate nonempty names/badges, status, positive worker
IDs and expected versions, effective timestamps, and reject unknown fields.
Worker IDs and BIGINT versions serialize as decimal strings at the API boundary.

## Worker and badge behavior

Worker update uses row locking and `expected_version`; stale updates return
structured `VERSION_CONFLICT`. Deactivation is a status transition, preserves
history, and closes all current open badge assignments at one database
transaction timestamp in the same transaction. Inactive workers cannot receive
new badges.

Assignment, reassignment, and release use tenant transactions and a per-badge
transaction advisory lock so a badge with no existing row is serialized too.
Assignment verifies the worker exists and is active, rejects an already-current
badge, then inserts an open history row and audit event. Reassignment locks the
current open row, validates the target worker and `effective_at`, closes the old
interval, inserts the new open interval, and appends audit. Omitted effective
time uses the database transaction timestamp. Ordinary assignment/reassignment
does not permit backdating; a supplied reassignment time must be at or after DB
transaction time and strictly after the current interval's `valid_from`.
Release closes the current open interval without assigning a replacement.
Audit and business writes commit or roll back together. Database exclusion and
CHECK constraints remain the final defense against overlap/invalid intervals.

`BadgeResolutionService` is the reusable historical resolver. It accepts a
badge string and operation timestamp, resolves only the assignment satisfying
`valid_from <= performed_at AND (valid_to IS NULL OR performed_at < valid_to)`,
and returns string `worker_id`, display name, and assignment interval. Current
owner lookup uses the same history model. Resolution is tenant-authenticated and
permission-protected; there is no public badge endpoint.

## Testing and validation

Unit and HTTP e2e tests cover worker create/list/get/update/deactivation,
duplicate display names, optimistic conflicts, validation, tenant/platform
authentication separation, permission allow/deny, badge assignment/resolution,
historical resolution, release/reassignment, inactive-worker rejection,
backdate rejection, and audit transaction behavior.

Real PostgreSQL integration tests use only the dedicated `TEST_MASTER_DB_*`
configuration and generated `_test` tenant databases. They apply, roll back,
and reapply the additive migrations; verify runtime table grants, foreign keys,
checks, hard-delete protections, half-open adjacent intervals, exclusion
rejection, concurrent assignment serialization, audit rollback, and isolation
between two tenant databases with the same worker IDs and badge strings. The
historical scenario assigns badge `125` to worker `18` through May and to worker
`47` from May onward; a January resolution returns `18`, and a June resolution
returns `47`.

Completion verification runs API lint, typecheck, unit tests, e2e tests, build,
and the relevant real-PostgreSQL integration tests. Database and RBAC
documentation is updated to describe the worker/badge schema, universal audit
entity key, and PostgreSQL test workflow.
