# Patta Generation and Accounting Foundation Design

## Goal and scope

Implement the tenant-side Patta foundation: templates, a PostgreSQL-backed
number allocator and device blocks, online batch generation, historical
operation snapshots, Patta lookup/list APIs, and the reusable validation seam
needed by later offline registration. Preserve database-per-tenant isolation,
historical price correctness, device ownership, and append-only audit history.

This stage does not implement Electron/SQLite, sync queues or events, offline
Patta persistence, Patta sheets, payroll, reports, licensing workflows, or a
Redis lookup cache.

## Module and security boundaries

Add a tenant `patta` module with thin controllers and domain services. Obtain
the tenant DataSource, actor, and company identity from
`requireTenantContext()`; never use a client-provided company or tenant ID.
Keep platform and tenant authentication separate. Tenant auth guards continue
to reject platform tokens.

Add a reusable Master `DeviceAccessService` to the existing
`master/devices` module. It queries the named Master DataSource and validates a
request `device_id` before number-block allocation, usage reporting, block
cancellation, or online Patta generation:

- unknown device -> `DEVICE_NOT_FOUND`;
- device owned by another authenticated company -> `DEVICE_TENANT_MISMATCH`;
- `BLOCKED` or `REPLACED` device -> `DEVICE_NOT_ACTIVE`.

The only company identity used is the authenticated tenant context. The
validated device ID is the only device ID written to tenant Patta/block rows or
their audit metadata. Strict DTO validation rejects unknown authority-bearing
fields such as `company_id`, `tenant_id`, client block size, `ish_soni`, and
client-authored online operation snapshots.

Device validation occurs before the separate tenant transaction. The Master
lookup is reusable rather than duplicated as ad-hoc queries in Patta handlers.

## Tenant schema

Create a new additive tenant migration; do not edit committed migrations. The
migration creates `patta_templates`, `patta_number_sequence`,
`patta_number_blocks`, `patta_hisob`, and `patta_operation_snapshots`, plus
constraints, indexes, audit catalog extensions, immutability triggers, and
runtime grants.

### Templates

`patta_templates` stores UUID ID, name, model FK, conveyor, optional size/color,
`ACTIVE`/`INACTIVE` status, positive BIGINT version, actor, and timestamps.
Canonicalize name, conveyor, size, and color using the existing business-name
normalization contract (trim ASCII whitespace and collapse internal whitespace
to one space); preserve letter case. Reject empty required values. Normalize
whitespace-only optional size/color to `NULL`. Enforce active-only normalized
name uniqueness across the tenant. Creating a template requires an ACTIVE
model. Updates use optimistic `expected_version`; deactivation is a status
transition. Templates are never hard-deleted.

### Sequence initialization and number blocks

`patta_number_sequence` has one row (`id = 1`) with BIGINT `next_number`,
positive version, and update timestamp. The table migration does not read
environment variables and does not seed a hard-coded start. After tenant
migrations, `TenantMigrationRunner` invokes an idempotent
`PattaSequenceInitializer` with validated `PATTA_NUMBER_START`. It inserts
`(id=1, next_number=start, version=1)` only when the row is absent. Concurrent
initializers rely on the primary key and `INSERT ... ON CONFLICT DO NOTHING`;
an existing sequence is never reset by a later environment change. This applies
to new tenants and to tenant databases when their migration runner applies an
upgrade.

Configuration defaults and validation:

- `PATTA_NUMBER_START=1`, positive BIGINT;
- `PATTA_NUMBER_BLOCK_SIZE=1000`, positive integer;
- `PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE=2`, positive integer;
- `PATTA_MAX_BATCH_SIZE=100`, positive integer.

Number-block rows store UUID ID, Master `device_id` (no cross-database FK),
inclusive BIGINT start/end, allocation/exhaustion timestamps, monotonic
`reported_used_count`, `ACTIVE`/`EXHAUSTED`/`CANCELLED` status, and actor. DB
checks enforce positive starts, ordered ranges, and a nonnegative report no
larger than range capacity. A PostgreSQL GiST exclusion constraint protects
range non-overlap across every status. No cancellation or sequence rollback
releases a range.

Block allocation locks the singleton sequence row `FOR UPDATE`, reads the
start, computes the configured end without unsafe JavaScript Number conversion,
inserts the block, advances the sequence and version, and appends allocation
audit in one tenant transaction. The active/unexhausted-per-device limit is
checked in this serialized transaction. Client block size is not accepted.
Online generation reserves its own number range by advancing this same
sequence, but does not consume a desktop device's block.

Usage reports are accepted only from the Master-validated owner device and only
for that device's ACTIVE block. Count cannot decrease or exceed capacity. A
count equal to capacity transitions the block to `EXHAUSTED`; exhausted and
cancelled blocks cannot receive further usage mutations. Cancellation permits
only `ACTIVE -> CANCELLED`. Neither `EXHAUSTED` nor `CANCELLED` can return to
`ACTIVE`.

For historical offline membership checks, block state does not erase ownership:
an `EXHAUSTED` or `CANCELLED` block can still prove that a number was allocated
to its device. Such checks never allocate or release numbers.

### Patta records and snapshots

`patta_hisob` stores UUID ID, string `partiya_number`, BIGINT `patta_number`,
model FK and `model_name_snapshot`, optional template FK, `konveyer_snapshot`,
optional size/color, server-derived `ish_soni`, validated `created_device_id`,
optional source block ID, actor, timestamps, and positive version. Normalize
partiya by trimming/collapsing whitespace, reject empty values, and preserve
case. The required business constraint is only
`UNIQUE(partiya_number, patta_number)`; do not add a standalone Patta-number
unique constraint. BIGINT values serialize as decimal strings.

`patta_operation_snapshots` stores UUID ID, restrictive FK to Patta and
operation, immutable operation name, `NUMERIC(14,2)` price, order, and creation
timestamp. Enforce unique `(patta_hisob_id, operation_id)`, nonnegative price,
and nonnegative order. Trigger protection rejects snapshot update/delete,
Patta deletion, block deletion, and template deletion. FK delete rules preserve
referenced history.

The Patta row preserves model name, conveyor, size, and color as creation-time
values. The optional template FK is lineage only; template deactivation or later
updates do not alter those values. Operation snapshots do not rely on the
mutable operation name, status, or compatibility price column.

Indexes cover Patta business key, model, creation time, list ordering, snapshot
Patta/operation lookup, template model/status, and device/block status lookups.

## Template selection and online generation

Template API:

- `GET /api/v1/patta-templates` and `GET /api/v1/patta-templates/:id` require
  `models.view`;
- `POST /api/v1/patta-templates` and `PATCH /api/v1/patta-templates/:id`
  require `models.manage`;
- no DELETE endpoint; PATCH includes `expected_version` and may transition
  status to `INACTIVE`.

Online generation is `POST /api/v1/patta/generate`, protected by
`patta.chiqarish.create`. Request fields include `partiya_number`, optional
`model_id` when a template provides it, optional `template_id`, optional
`konveyer`/`razmer`/`rang`, bounded `count`, and `device_id`. Without a template,
`model_id` and nonempty conveyor are required. With a template, the template
must be ACTIVE and its `model_id` is authoritative; if request `model_id` is
also present it must match. Explicit conveyor/size/color values override
template defaults. Omitted fields inherit template values. Explicit `null`
clears optional size/color; an empty or whitespace-only string is rejected,
not silently treated as an omitted default. A missing template or model is a
structured error.

The batch is all-or-nothing in one tenant transaction and cannot exceed
`PATTA_MAX_BATCH_SIZE`. It locks in deterministic order:

1. target model `FOR SHARE` and verify ACTIVE;
2. ACTIVE model operations `FOR SHARE`, ordered by `sort_order, id`;
3. selected template row when used;
4. one database `transaction_timestamp()` for the whole transaction;
5. resolve each operation's effective price through
   `OperationPriceService.resolvePrice()` with the operation ID, shared
   timestamp, and transaction manager.

Every Patta in a batch shares the same locked model/operation set and timestamp.
Operation create/update/deactivate already locks the model before the operation;
price change locks the operation. Those conflicts ensure a concurrent mutation
cannot produce a half-old/half-new operation set or price snapshot. Preserve
that mutation lock ordering and add DB concurrency tests. Never use
`model_operations.price` for effective or snapshot prices.

If the ACTIVE operation set is empty, reject with
`PATTA_MODEL_HAS_NO_OPERATIONS`. Insert Patta rows and their snapshots; compute
`ish_soni` from the number of inserted snapshots rather than request input. The
online batch allocates its sequence range in this transaction and records no
desktop block ID. Append one `patta.create` audit event per Patta in the same
transaction, keyed by immutable `patta_hisob.id`. Audit metadata includes
partiya/Patta number, model ID/name snapshot, validated device, block/source,
and generation context without copying every operation snapshot into JSON.

## Blocks, lookup, and list APIs

Block routes:

- `POST /api/v1/patta-number-blocks/allocate`;
- `POST /api/v1/patta-number-blocks/:id/usage`;
- `POST /api/v1/patta-number-blocks/:id/cancel`.

Each requires `patta.chiqarish.create`, validates `device_id` with the shared
Master service, and verifies block ownership before any report/cancellation.
Allocation, cancellation, and Patta creation are audited in their tenant
transactions. Audit entity types/actions extend the existing universal
`audit_log.entity_key` catalog; audit remains append-only.

Lookup uses query parameters so partiya values containing `/` remain supported:

`GET /api/v1/patta/lookup?partiya_number=...&patta_number=...`

It requires `patta.hisob.view` and returns the historical model name and
operation snapshot summary with creation metadata. List
`GET /api/v1/patta` has the same permission, bounded `limit` (maximum 100),
default `page=1`, `limit=50`, available business/model/creation-time filters,
and stable `created_at DESC, id DESC` ordering. Pagination is structured so a
future keyset cursor can replace offset pagination without changing filters or
sort semantics. No unbounded list is returned.

Redis is not part of this feature: the current Redis module is a stub. Lookup
reads tenant PostgreSQL directly, which remains the source of truth. A future
tenant-namespaced Redis cache may be considered as an optimization, never as a
correctness dependency.

## Offline registration seam

Provide reusable domain validation, not a sync endpoint or persistence flow.
The block-membership validator accepts an already Master-validated device ID,
block ID, and BIGINT number; it verifies that the tenant-local block exists,
belongs to that device, and contains the number. It permits historical
membership in `EXHAUSTED` and `CANCELLED` ranges, without making those blocks
available for new allocation or usage mutations. The Patta pair unique
constraint protects later registration races.

A structural snapshot-payload validator checks unique operation IDs, nonempty
operation names, valid nonnegative decimal prices, nonnegative sort order, and
internally consistent snapshot count. It does not call the payload
authoritative, persist offline rows, resolve stale references, or decide
historical offline price authority. Those are explicit Offline Sync design
decisions. Do not add `event_id`, sync queue, push/pull, server change log, or
processed event storage in this stage.

## Migration rollback safety

The additive migration's `down` checks for Patta/template/block business rows
and Patta audit events before removing any schema. If identity or audit history
would be lost, rollback raises a named error and leaves migration state/schema
untouched. The initializer's untouched singleton sequence row alone does not
block a test/empty-schema down; the migration may safely drop it. Reapply then
creates the tables and the runner initializes the sequence from current
validated configuration.

## Validation

Unit and API e2e coverage includes template CRUD/deactivation, normalization,
inactive-model rejection, active-name conflict, expected-version conflict,
permissions, platform-token rejection, unknown DTO fields, and structured
device error mapping.

PostgreSQL integration coverage applies, reverts, and reapplies the migration;
tests default/custom sequence initialization, no reset after config changes,
concurrent initializer idempotency, runtime grants, number serialization,
range exclusion, parallel many-device allocation, active-block policy, usage
monotonicity and terminal states, device/company ownership, rollback on audit
failure, duplicate `(partiya_number, patta_number)` race, batch rollback, zero
operation rejection, historical snapshots and later rename/price changes,
future price effective dates, and Patta creation racing operation
create/deactivate/rename/price changes. Two real tenant databases may contain
the same business key without crossing tenant boundaries.

Use only a dedicated PostgreSQL `_test` Master database and generated tenant
test databases. Never use development/production business data in rollback or
cleanup tests. If credentials are absent, the suite is blocked/skipped, not
reported as passing. Run API lint, typecheck, unit tests, e2e tests, build, and
the relevant tenant-provisioning/auth/models/operations/workers/badges
regression suites. Document migration, endpoint, config, and test behavior in
`docs/database.md` and `docs/testing.md`.
