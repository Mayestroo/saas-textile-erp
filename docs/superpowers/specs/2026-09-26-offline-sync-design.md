# Offline Synchronization Engine Design

## Goal and scope

Implement a production-grade two-way synchronization foundation for the
database-per-tenant ERP. Desktop SQLite is the durable offline store. The API
is authoritative for server-side mutations and exposes tenant-scoped push,
pull, and paged bootstrap APIs. Sync contracts are shared by API and desktop.

The first writable sync entity is offline-created Patta registration. Workers,
badge history, models, operations, operation price history, Patta templates,
existing Pattas and number blocks are server-authoritative reference/mirror
data. Their existing online mutation services emit pull changes, but the sync
push endpoint does not accept offline mutations for those entities.

Out of scope: Patta varag‘i UI, payroll, reports, license workflow, full desktop
login/admin UI, offline mutation of reference entities, and replacing existing
reference CRUD modules.

## Existing architecture and constraints

The API already has tenant JWT/hostname/company validation, a reusable cached
`TenantConnectionManager`, structured API errors, separate additive tenant
migrations, a Master `DeviceAccessService`, transaction-based domain services,
append-only audit, and Patta block/snapshot validators. Existing tenant data is
isolated by database. The sync implementation must use those boundaries.

The desktop currently has only a starter Electron main/preload/React structure;
it has no SQLite database, migration system, repository layer, network service,
or tests. `better-sqlite3` is already installed as a desktop main-process
dependency. Its Electron security baseline must be explicit: context isolation
enabled, Node integration disabled, and sandbox enabled. The Electron version
remains pinned at 44.4.5.

`packages/sync-protocol` exists but is empty and the package directories are not
currently npm workspaces. Make the sync protocol a real workspace package and
consume its contracts from both API and desktop. Do not duplicate wire payload
interfaces in either app.

## Shared protocol

Create the `@textile/sync-protocol` workspace package. Its TypeScript contracts
include `SyncEvent`, `SyncPushRequest`, `SyncPushResult`, `SyncPullRequest`,
`SyncPullResponse`, `SyncChange`, `SyncConflict`, `SyncErrorCode`, bootstrap
session/page contracts, and the versioned entity projection union.

Wire rules:

- `event_id` is a UUID created once with the local mutation and preserved across
  every retry.
- BIGINT cursors, versions, Patta numbers, and worker IDs cross API/SQLite
  boundaries as decimal strings.
- Decimal money is serialized as canonical decimal strings.
- Timestamps are ISO-8601 UTC strings; `client_created_at`, business
  `occurred_at`, and server receipt time are distinct.
- `SyncChange.operation` is `UPSERT` or `DELETE`; event mutation operation is
  `CREATE`, `UPDATE`, or `DELETE`.
- Change projections have an explicit schema/projection version and stable
  domain DTO fields. Do not expose raw PostgreSQL row serialization.
- A successful Patta push result includes the authoritative projection and its
  `server_change_log.sequence_id`, so response-loss retries can finalize the
  local row without waiting for its pull echo.
- Conflict/error codes include `VERSION_CONFLICT`, `PATTA_ALREADY_EXISTS`,
  `PATTA_NUMBER_OUTSIDE_BLOCK`, `PATTA_BLOCK_DEVICE_MISMATCH`,
  `PATTA_SNAPSHOT_MISMATCH`, `REFERENCE_DATA_STALE`, `DEVICE_NOT_ACTIVE`,
  `PAYLOAD_INVALID`, `SYNC_BOOTSTRAP_EXPIRED`, and
  `EVENT_ID_REUSE_MISMATCH`; the type remains extensible for later domains.

The API DTO classes implement/consume these shared contracts and use the
existing strict global validation. Unknown fields are rejected.

## Tenant PostgreSQL schema

Add a new additive tenant migration. Do not edit any committed migration.
Provisioned tenant runtime roles receive only the required table/sequence
privileges through the existing grant flow.

### Processed events

`processed_sync_events` has `event_id UUID PRIMARY KEY`, nullable device/user
IDs, entity type/ID, operation, `request_fingerprint CHAR(64)`, result status,
result JSONB, and `processed_at TIMESTAMPTZ`. A transaction may temporarily
insert an uncommitted `PROCESSING` reservation; only terminal
`SYNCED`/`CONFLICT`/`FAILED` results may commit. A guard permits the single
`PROCESSING -> terminal` transition, permits no identity/fingerprint mutation,
and rejects later update/delete. The
request fingerprint is SHA-256 of RFC 8785 JSON Canonicalization Scheme output
for the validated event plus its Master-validated device ID, excluding other
transport-only fields. BIGINT and decimal domain values are strings before
canonicalization. Binding the device prevents another device from replaying an
event identity. Same ID and same fingerprint returns the stored result;
same ID with another fingerprint returns `EVENT_ID_REUSE_MISMATCH` without
applying that payload.

### Change log and global ordering

`server_change_log` has `sequence_id BIGSERIAL PRIMARY KEY`, entity type/ID,
`UPSERT`/`DELETE`, nullable entity version, projection version, immutable JSONB
payload, and server `changed_at`. Index `(sequence_id)` is sufficient for
ordered cursor pages; entity indexes may be added where justified. Triggers
reject update/delete. Delete changes are tombstones with a versioned payload or
null projection and are supported by the protocol even though current business
rows mostly use inactive states and restrictive history.

Every sync-visible business mutation calls the single `SyncChangeRecorder`
inside its existing tenant transaction. The recorder MUST acquire the one
documented tenant advisory lock key before allocating/inserting its first
sequence. The transaction-scoped lock is retained through commit/rollback.
Consequently sequence allocation order follows commit order for logged
transactions; rolled-back transactions may leave BIGSERIAL gaps, which are
normal. No other sync-visible code writes `server_change_log` directly.

Record atomic changes for models, operations, both sides of operation price
history transitions, workers, both sides of badge interval reassignment/close,
Patta templates, number-block allocation/usage/cancel, online Patta generation,
offline Patta registration, and operation snapshots. Related changes within one
transaction are emitted in stable order. No audit/auth/session/password data is
included in projections.

### Bootstrap materialization

`bootstrap_sessions` stores UUID ID, validated device UUID, decimal BIGINT
watermark, `ACTIVE`/`COMPLETED`/`EXPIRED` status, creation time, and expiry.
Use a partial unique index to enforce at most one ACTIVE session per device.
`bootstrap_items` stores session ID, deterministic session-local BIGINT order
key, entity type, entity ID, projection version, and explicit payload JSONB;
unique keys prevent duplicate items within a session. A cascading FK from items
to the session is allowed because these are temporary staging rows, not business
history.

Bootstrap creation uses one tenant connection and a bounded materialization
transaction. No transaction, MVCC snapshot, or checked-out QueryRunner
connection survives the request; the shared tenant pool may retain an idle
connection for reuse. Exact lock/snapshot order:

1. On a dedicated `QueryRunner`, acquire a device-scoped session lock to
   serialize bootstrap creation for that device, then acquire the session-level
   advisory lock that conflicts with the recorder's transaction-level lock.
   Keep connection affinity and guarantee both unlocks in `finally`. The
   device-scoped lock may remain through materialization; it blocks only another
   bootstrap for that device, never tenant business writes.
2. Start `REPEATABLE READ` and explicitly establish the transaction snapshot.
3. Read `COALESCE(MAX(server_change_log.sequence_id), 0)` as watermark while the
   shared lock is held.
4. Release the change-log session-level advisory lock immediately after
   watermark read; do not hold it while materializing a large dataset. Keep only
   the per-device bootstrap-creation lock until this transaction commits.
5. In the same repeatable-read MVCC snapshot, create the ACTIVE session, insert
   all explicit reference projections into `bootstrap_items`, and commit.

Every concurrent sync-visible writer takes the transaction advisory lock before
its sequence allocation and keeps it to commit. A writer already holding it
must commit before bootstrap obtains its session lock. A writer that has changed
business rows but has not yet reached the recorder cannot commit without its
change log; bootstrap therefore sees the prior committed row and the writer's
later event receives a sequence above the watermark. After the watermark is
read and the lock is released, any later committed sync-visible mutation has a
sequence greater than the watermark. The same MVCC snapshot is used for all
materialization, so the frozen rows correspond to the watermark. Business writes
are blocked only through lock acquisition/snapshot/watermark, never through
materialization or HTTP paging.

Materialization uses database-side explicit projections/`INSERT ... SELECT`,
not a raw row JSON contract and not a huge application-memory array. The exact
bootstrap set is `workers`, `worker_badge_history`, `models`,
`model_operations`, `model_operation_prices`, `patta_templates`, `patta_hisob`,
`patta_operation_snapshots`, and `patta_number_blocks`. Exclude users,
password hashes, auth sessions, platform data, and audit logs.

Pages use keyset pagination on session-local `order_key`, ascending, with a
bounded/configured page limit and deterministic projection ordering. Page reads
validate tenant auth, active Master device ownership/company, session/device
match, `ACTIVE` status, and expiry. Expired IDs return `SYNC_BOOTSTRAP_EXPIRED`
and require a new session. A device has a configured maximum active-session
count; starting a replacement session expires/cancels its older active session
and removes only that session's staging rows. Cleanup has configurable TTL,
batch size, and completed/expired retention; it deletes only staging/session
rows. It never touches business/source data.

`POST /api/v1/sync/bootstrap` creates a session. A page route reads a session
page. A completion route transitions ACTIVE to COMPLETED after local atomic
finalization; completion is only server staging lifecycle metadata, not proof
that SQLite committed. Missing/expired/completed server staging must never
invalidate the local cursor or business data. The client cursor is authoritative
local state.

## Tenant sync APIs and security

All routes use `TenantAuthGuard`, the authenticated tenant context, and seeded
tenant permissions `sync.pull` or `sync.push`; Patta push additionally requires
`patta.chiqarish.create`. Reject platform tokens. Every
request supplies a device ID, which is validated through Master
`DeviceAccessService` against the authenticated company and ACTIVE status. The
device ID is not a tenant selector or JWT company identity. Bootstrap pages
require the same session device that created the snapshot. Tenant A can never
read or mutate Tenant B data even if IDs/business keys overlap.

### Push

`POST /api/v1/sync/push` accepts a bounded batch (`SYNC_PUSH_MAX_EVENTS`,
default 100). Each event runs in its own tenant transaction so one bad event
does not roll back siblings. The handler registry currently supports only
`patta/CREATE`.

Per event: canonical fingerprint; attempt processed-event reservation under
the unique event ID; on duplicate wait for the competing transaction, compare
fingerprints, and return its stored terminal result; otherwise establish a
savepoint; validate/apply the registered domain handler; append change-log
projection; store terminal result and commit. Domain conflict/validation errors
roll business work back to the savepoint, persist a stable `CONFLICT` or
`FAILED` result against the reservation, and commit it. A retry returns that
same stored result without rerunning the handler. Unexpected database/infra
failure rolls back the full event transaction, including reservation, and is
retryable with the same ID.

The offline Patta handler reuses block ownership/number membership, duplicate
business key, and snapshot structure validators. It verifies the Patta UUID,
block UUID, authenticated device, model/template lineage, current operation
IDs/names/order/status and per-reference versions where the server can prove
them. Validate duplicate operation/snapshot IDs and all server constraints.
Current prices are never substituted for payload historical prices. The server
accepts a snapshot only when its reference context can be validated confidently;
stale or ambiguous state produces `REFERENCE_DATA_STALE` or
`PATTA_SNAPSHOT_MISMATCH`. This is an intentionally conservative first version:
legitimate Pattas created offline against references changed before sync may
need manual conflict resolution. Later immutable reference revision history can
allow more automatic resolution.

Offline Patta identity is client-generated and stable: local
`patta_hisob.id == SyncEvent.entity_id == server patta_hisob.id`. The API
preserves this UUID. Collision with another business row is a structured
conflict; never overwrite a different row because the client supplied an ID.
Each operation snapshot also has a client-generated UUID which the server
preserves; UUID collision with a different parent/entity is a structured
conflict. The local and server operation snapshot identities therefore match.

The additive tenant migration adds nullable `client_created_at` and `occurred_at`
to `patta_hisob` for offline registrations. Existing `created_at` remains the
server database creation/receipt time and is projected to the protocol as
`server_received_at`; online Patta generation retains its current behavior.

The Patta event includes `reference_cursor`, `client_created_at`,
`occurred_at`, model/name snapshot, template context, exact operation snapshots
(including historical decimal price), block and Patta business key. It also
contains model/template/operation version context. `occurred_at` is the
business-effective client timestamp, `client_created_at` is the local entry
time, and `server_received_at` maps to the tenant DB's `created_at` clock.
Client time is never trusted as auth/license/security time. Require valid
ISO-8601 timestamps and reject future skew greater than five minutes; accept
past timestamps because a device may remain offline, with stale references
handled by the explicit conflict policy.

### Pull

`GET /api/v1/sync/pull?device_id=...&cursor=<decimal>&limit=...` validates tenant
and device, then returns `sequence_id > cursor ORDER BY sequence_id ASC LIMIT
bounded_limit`. Default/max are configured (`SYNC_PULL_MAX_CHANGES`, default
500). `next_cursor` is the last returned sequence or input cursor when no
changes exist; it is always a decimal string. `has_more` indicates another
page. Aborted sequence gaps do not imply missing changes. Do not prune the
change log in this stage; document that old cursors remain serviceable until a
future explicit retention policy introduces `SYNC_CURSOR_EXPIRED` and
re-bootstrap.

## Desktop persistence and local workflows

### SQLite lifecycle and schema

Open SQLite in Electron main at the app's user-data path. Use versioned
additive migrations with migration metadata, transactional DDL/data updates,
foreign keys, WAL, and a busy timeout. Never delete/recreate an existing DB to
recover migration failure. Migrations create:

- `sync_queue` with UUID PK/event ID unique, entity/op/base version/payload,
  creation/attempt/error/status fields and `PENDING`, `SYNCING`, `SYNCED`,
  `CONFLICT`, `FAILED` statuses;
- `sync_state` key/value/update time, with `last_server_cursor` decimal text;
- `sync_conflicts` with event/entity/code/local/server JSON and resolution
  lifecycle;
- reference mirror tables for the nine bootstrap entities above;
- server Patta and operation-snapshot mirror/local tables;
- bootstrap local session metadata and staging items/pages;
- `local_next_number` and local allocator status separate from server
  `reported_used_count`;
- server sequence/revision and sync ownership metadata (`LOCAL_PENDING`,
  `SERVER_SYNCED`, `CONFLICT`, `FAILED`) for Pattas and snapshots.

Use SQLite INTEGER only for bounded counters/indexes. PostgreSQL BIGINT,
Patta/worker IDs, cursor/sequence/version, and NUMERIC prices are stored as TEXT
decimal/canonical strings. Timestamps are canonical ISO-8601 UTC. Define
explicit SQLite serializers; do not copy PostgreSQL storage types blindly.

### Transaction boundary and repositories

Use a reusable main-process `LocalUnitOfWork` around synchronous SQLite
transactions. Business local writes and queue insertions share the same
transaction. A committed Patta can never be missing its event, and an event can
never exist without its Patta.

Provide responsibility-focused repositories/services for sync queue/state,
bootstrap staging, workers/badges, models/operations/prices/templates, Pattas,
and number blocks. Renderer code never executes SQL or receives a database
handle.

### Paged bootstrap staging/finalization

Fetch every server bootstrap page into SQLite staging; do not publish partial
staging as the live mirror and do not accumulate the entire dataset in RAM. The
local active bootstrap ID/page key allows safe restart or replacement.

After the last page arrives, one SQLite transaction reconciles staged snapshot
rows into all live server-authoritative mirrors, reconciles stale server-owned
reference rows absent from the complete snapshot, preserves every local
`LOCAL_PENDING`/`CONFLICT`/`FAILED` Patta and its snapshots, applies the
bootstrap watermark to `last_server_cursor`, and marks the local snapshot
finalized. Only this transaction makes the baseline operational. Failure before
commit leaves live mirrors/cursor unchanged; retry or re-bootstrap is safe.
After local commit, call the server completion endpoint; its failure does not
roll back local completion. A new full bootstrap is reconciled with the same
rules and does not remove locally owned unsynced business data.

Rows absent from a complete server snapshot are reconciled as server tombstones
(`is_deleted`/equivalent) rather than blindly hard-deleted. This preserves local
historical foreign-key references. Never reconcile a local Patta/snapshot whose
ownership state is `LOCAL_PENDING`, `CONFLICT`, or `FAILED` as a server row.

### Local Patta creation and blocks

The local Patta service, not a UI, can create an offline Patta in one local
transaction:

1. Reserve a number from an ACTIVE server-assigned local block using an atomic
   SQLite write transaction; no `MAX()+1` logic is allowed.
2. Promote the next eligible reserved block when current is exhausted. Keep
   `local_next_number` distinct from server `reported_used_count`.
3. Resolve local model/template/ACTIVE operation set and operation price using
   `model_operation_prices` effective intervals at `occurred_at`, never
   `model_operations.price`.
4. Build immutable Patta/operation snapshots with client-generated UUIDs and
   reference cursor/version context.
5. Insert the `LOCAL_PENDING` Patta/snapshots and one stable-ID sync event in
   the same transaction.

Return a prefetch signal once block consumption is at least 80%; an online
allocator may request another server block through the existing allocation API.
Initialize a new local block's next number from its server-reported usage and
never reduce an already advanced local next number during pull/re-bootstrap.
Report local usage monotonically through the existing usage API when online;
that report is separate from local consumption state. Exhaustion while offline
blocks only new Patta creation. Unresolved block membership/invalid reference
fails the local write. Badge local lookup resolves by badge string and effective
timestamp to permanent `worker_id`; names are display-only.

### Queue, pull, echo, and retry

Startup recovers stale `SYNCING` queue events to `PENDING`. A network error
never changes an event ID or marks a business conflict. SyncEngine performs one
single-flight cycle: recover → push pending batch → persist per-event outcomes
and local conflicts → pull → atomically apply a page and advance cursor →
continue while more pages exist.

`AuthenticatedSyncTransport` is the sole auth/network boundary. SyncEngine does
not store access tokens, refresh tokens, or construct authorization headers.
The transport supplies authenticated REST calls and validated device context;
later auth refresh can be implemented behind it. Credentials are not stored in
SQLite. No full login UI is added.

Network status is based on actual authenticated API reachability/sync outcomes,
not solely `navigator.onLine`; network failure is never reported as a domain
conflict. The in-process single-flight guard prevents manual and background
cycles from overlapping.

Retryable network/timeout/502/503/504 failures use bounded exponential delays
of 5/15/30/60 seconds with jitter and no tight loop. 400/401/403/409 are not
blindly retried; 401 is delegated to the auth transport, 409 persists conflict.
Per-event permanent failures become FAILED; transient transport failure
returns the same queue rows to PENDING. SYNCED queue events may be removed only
after configurable retention; PENDING/SYNCING/CONFLICT/FAILED are not silently
cleaned. Unresolved local conflicts remain stored.

Pull apply is one SQLite transaction: apply ordered UPSERT/tombstone changes,
then update `last_server_cursor`, then commit. Any apply failure rolls back
both data and cursor; replay is idempotent. Apply reference rows only when the
incoming server sequence is newer. Server echo of a locally pushed Patta uses
the preserved UUID and is an UPSERT of the same row. A server echo cannot
duplicate a row or overwrite an immutable local Patta snapshot; it can promote
the row/queue state to `SERVER_SYNCED` based on the persisted push result and
server sequence.

## Electron IPC and security

Electron main owns SQLite, repositories, transport, and SyncEngine. Expose only
narrow typed preload APIs (e.g. sync status/manual sync and local lookup/create
operations needed by later UI). Do not expose `ipcRenderer`, unrestricted
filesystem/Node APIs, tokens, or SQLite. Preserve Electron 44.4.5 and native
dependency rebuild configuration. The renderer has no sync implementation.

## Configuration and resource limits

Add validated defaults and bounds:

- `SYNC_PUSH_MAX_EVENTS=100`;
- `SYNC_PULL_MAX_CHANGES=500`;
- `SYNC_BOOTSTRAP_PAGE_SIZE=250` with a bounded maximum;
- `SYNC_BOOTSTRAP_SESSION_TTL_MINUTES=30`;
- `SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE=1`;
- `SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE=100`;
- completed/expired staging retention of 24 hours;
- synced desktop queue retention of 30 days;
- maximum accepted client future skew of 300 seconds.

Validate configuration at application startup. Bootstrap cleanup processes
bounded batches and only temporary staging. Starting a replacement session
expires an older ACTIVE session for that same validated device. An expired
session returns `SYNC_BOOTSTRAP_EXPIRED`; client starts a new baseline.

## Testing and acceptance

### API unit/e2e

Test protocol DTO validation, tenant/platform token separation, permission
enforcement, Master device missing/cross-tenant/inactive rejection, batch size,
conflict mapping, page limits and structured errors. Test handler registry and
offline Patta validation including duplicate IDs, immutable UUID preservation,
reference version/name/operation set checks, timestamp handling and no
repricing.

### Real PostgreSQL

Using only generated test tenant databases under the dedicated `_test` Master
DB, test additive migration up/down/reapply and grants; immutability; duplicate
event delivered ten times and concurrently produces one Patta and one processed
identity; same event ID/different fingerprint is rejected; conflict event
retried ten times returns the same result and never reapplies; valid/conflict/
valid events get partial results; a handler conflict rolls back only to its
savepoint; an injected infra failure leaves no reservation; pull pages have
stable sequence order/no loss; reference mutation and recorder rollback are
atomic; two tenants can use same IDs/business keys without leakage.

Bootstrap tests cover large keyset-paged snapshot, deterministic order, expiry,
wrong device/tenant, active-session replacement, bounded cleanup, snapshot
watermark consistency, mutation before/after watermark, no write starvation
during projection materialization, and no data loss when pull follows the last
bootstrap page. A mutation included in the snapshot is not lost; one excluded
is always returned after the watermark. Verify no users/password/session/audit
projection is staged.

### SQLite/Electron runtime

Test transactional migration and rollback, local business+queue atomicity,
stable event retry ID, stale SYNCING recovery, conflict retention, bootstrap
page staging, crash at page 3 of 10 (no partial live mirror/cursor), atomic
finalize/reconciliation, re-bootstrap, preservation of LOCAL_PENDING Patta,
pull apply failure/cursor rollback/replay, local UUID push/pull echo identity,
price effective-time mirror, old/new badge worker resolution, concurrent local
block allocation, exhaustion/promotion, and 80% prefetch signal. Run native
SQLite tests under a runtime compatible with the Electron-rebuilt native
module.

Two-PC acceptance: PC-1 creates an offline Patta with its allocated block and
local UUID, synchronizes successfully; PC-2 pulls that UUID, disconnects from
server, and finds the same Patta in local SQLite. Confirm same row after echo,
same event ID after lost response/retry, and two-tenant/device isolation with
separate local SQLite databases.

### Required verification

Run API lint, typecheck, unit tests, e2e, build, real PostgreSQL sync suites,
and regressions for tenant provisioning, auth/RBAC, models/operations,
workers/badges, and Patta. Add desktop test script because none exists; run
desktop lint, both typecheck targets, tests under compatible SQLite runtime,
and build without changing Electron/native ABI pinning.

Update `docs/sync-protocol.md`, `docs/database.md`, and `docs/testing.md` with
contracts, schema, ordering/bootstrap guarantees, TTL/cleanup, conservative
Patta conflict limitation, cursor retention, commands, and test coverage.

## Delivery sequence

1. Shared protocol package and documented contracts.
2. Tenant migration, recorder lock contract, and reference write integrations.
3. Push handler/idempotency, pull and materialized paged bootstrap APIs.
4. Desktop SQLite migrations, repositories, staging/reconciliation, and offline
   Patta/block domain foundation.
5. Authenticated transport boundary, single-flight SyncEngine, IPC, and retry.
6. PostgreSQL/SQLite/two-PC/two-tenant acceptance tests, docs, required
   regression/verification, then one feature implementation commit and push.

Work only on `feature/offline-sync`. Do not start Patta varag‘i or Payroll until
this stage's acceptance and verification are complete.
