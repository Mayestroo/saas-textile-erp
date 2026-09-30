# Database boundaries

The API has a dedicated named TypeORM DataSource for the SaaS Master database.
Its single configuration factory lives in `apps/api/src/database/master/master-database.config.ts`
and is shared by the Nest runtime and the Master migration/seed command runner.
`synchronize` and `migrationsRun` are both disabled; schema changes are applied
only through the explicit Master migration commands.

The Master database stores platform-level data only:

- `companies`
- `platform_users`
- `platform_roles`
- `platform_permissions`
- `platform_role_permissions`
- `platform_user_roles`
- `devices`
- `licenses`

Tenant operational tables (workers, production, Patta, payroll, and reports)
belong in tenant databases and must not be added to the Master migration.

## Master schema and constraints

`database/master-migrations/` contains Master migrations, separate from the
future `database/tenant-migrations/` location. The initial migration creates
the `citext` extension and all eight platform tables. Status values are stored
as `VARCHAR` and guarded by named `CHECK` constraints. Unique keys and foreign
keys also have stable, explicit names.

`devices(id, company_id)` has a composite unique constraint. A license has a
company foreign key and a composite `(device_id, company_id)` foreign key to
that device key, so a license cannot reference a device owned by another
company. Company, device, and license history is protected with restrictive
delete rules; only RBAC assignment rows cascade when their role, permission,
or platform user is deleted.

The migration rollback drops only tables created by that migration, in
dependency order. It intentionally leaves `citext` installed: extensions may
be shared or may have existed before this migration, so rollback must not
remove a database-wide extension.

`companies.db_connection_ciphertext` stores per-tenant runtime credentials only
through the AES-256-GCM `TenantConnectionSecretCipher` implementation. The
versioned envelope contains a random IV and authentication tag; its 32-byte key
comes from `TENANT_CONNECTION_ENCRYPTION_KEY`, never source code. Provisioning
state and failure details are added by additive Master migrations for
`failure_step`, `failure_reason`, and the non-secret `default_admin_required`
retry marker.

Tenant databases have a separate DataSource factory and migration table in
`apps/api/src/database/tenant/` and `database/tenant-migrations/`. The elevated
`TENANT_PROVISIONER_DB_*` settings are separate from Master runtime credentials.
Provisioned runtime logins are company-specific and do not own the database or
have role/database creation privileges. See `docs/tenant-provisioning.md` for
the lifecycle, ACL policy, encryption-key operations, and retry behavior.

## Configuration and commands

The API reads `MASTER_DB_HOST`, `MASTER_DB_PORT`, `MASTER_DB_NAME`,
`MASTER_DB_USER`, and `MASTER_DB_PASSWORD`. Missing or invalid values cause a
startup error that names the missing setting without printing its value.
`apps/api/.env.example` lists the settings; keep real credentials in an
untracked `.env` file or secret manager.

Run commands from the repository root:

```powershell
npm run db:master:migrate --workspace=apps/api
npm run db:master:show --workspace=apps/api
npm run db:master:seed --workspace=apps/api
npm run db:master:revert --workspace=apps/api
```

The command runner builds the API and then opens the named Master DataSource.
The seed transaction idempotently upserts the eight platform permissions and
the `Superadmin` role, then attaches those platform permissions to that role.
It does not seed a platform user or add tenant permissions.

## Authentication tables

Additive Master migration
`20260926000200-AddPlatformAuthInfrastructure.js` creates
`platform_auth_sessions` and `platform_login_rate_limits`. The additive tenant
migration `20260926000200-AddTenantAuthInfrastructure.js` creates
`auth_sessions` and `login_rate_limits` in each tenant. Session user foreign
keys remain inside their own database; the unique refresh-token hash and expiry
constraints/indexes are domain-local. Existing committed migrations are not
modified.

Session rows store a SHA-256 refresh-token hash, user/session identity, optional
device ID, expiry, revocation, creation, and last-use timestamps. Plain refresh
tokens are never persisted. Tenant runtime database roles receive DML access to
only their own auth session and login-limit tables; Master sessions stay in the
Master database.

## Models, operations, and operation price history

Additive tenant migration
`20260926000300-AddModelsOperationsAndPriceHistory.js` creates `models`,
`model_operations`, `model_operation_prices`, and append-only `audit_log`.
Models and operations use `ACTIVE`/`INACTIVE`, positive `BIGINT` optimistic
versions, restrictive historical foreign keys, and active-only canonical-name
uniqueness. `canonicalize_business_name(text)` trims ASCII whitespace
(`space`, tab, LF, VT, FF, CR), collapses every internal sequence to one ASCII
space, and compares using PostgreSQL `lower()`; the service uses the same
canonicalization before storing display names. Model names are unique per
tenant; operation names are unique per model, among active records. Inactive
records remain and can be reactivated only if they do not collide.

`model_operation_prices` is authoritative for both current and historical
prices. Each price is `NUMERIC(14,2)` and applies to `[valid_from, valid_to)`.
The migration enables shared `btree_gist` and adds an exclusion constraint on
`operation_id` plus overlapping `tstzrange(valid_from,
COALESCE(valid_to, 'infinity'), '[)')`, so adjacent intervals are allowed but
overlaps are rejected by PostgreSQL. `effective_from` may be omitted (the DB
transaction timestamp is used), equal to the transaction timestamp, or future;
backdating is rejected. Only appending after the current open interval is
allowed; attempts to insert/reorder an existing future schedule return a
structured conflict. Operation row locking and the expected version prevent
concurrent stale price changes.

`model_operations.price` is a compatibility/denormalized latest configured
price only. The API's current price and every effective-time lookup resolve
through `OperationPriceService` against `model_operation_prices`; application
business logic never reads the compatibility column as an effective price.
Operation creation inserts the initial price interval atomically. Price
interval changes, operation version changes, and the `operation.price_change`
audit row commit in one transaction. Model/operation creates, updates, and
deactivations likewise append audit in their mutation transaction. An
append-only trigger rejects audit updates and deletes. Provisioned tenant
runtime roles receive DML access to the tenant-local feature tables; the audit
trigger continues to forbid record edits/deletions.

The PostgreSQL login-limit tables store only HMAC-hashed account/IP bucket keys,
fixed-window start, attempt count, and expiry. Each login transaction deletes
up to 100 expired rows using the expiry index, then atomically upserts the
account and IP counters in deterministic key order. The stable
`AUTH_LOGIN_BUCKET_HASH_SECRET` must remain unchanged while bucket windows are
active; rotate it only after the maximum login window has elapsed, or all
existing hashed bucket identities will become unreachable.

## Workers and badge history

Additive tenant migration
`20260926000400-AddWorkersAndBadgeHistory.js` creates `workers` and
`worker_badge_history`. Worker IDs use PostgreSQL `BIGINT GENERATED ALWAYS AS
IDENTITY`, are permanent and never hard-deleted, and serialize to decimal
strings at the API boundary. Worker names are whitespace-trimmed/collapsed while
preserving user-entered letter casing; duplicate names are allowed. Worker
updates use a positive BIGINT `version` and expected-version optimistic locking.
Deactivation locks the worker and open badge rows, closes all effective open
assignments at the same database transaction timestamp, updates status/version,
and appends audit events in one transaction.

`worker_badge_history` stores a trimmed badge string and a worker FK over
`[valid_from, valid_to)` intervals. Badge numbers remain strings (including
leading zeroes) and may be reused only across non-overlapping intervals. The
migration reuses `btree_gist` and enforces badge equality plus `tstzrange`
overlap exclusion in PostgreSQL. FK/check constraints, no-delete triggers, and
a close-only history trigger protect historical identity. Indexes cover worker,
badge, effective-time, timeline, and tenant-local current/history lookups.

The migration also adds the universal `audit_log.entity_key VARCHAR NOT NULL`,
backfills existing UUID `entity_id` values as their UUID text, and indexes
`(entity_type, entity_key)`. The old UUID `entity_id` stays nullable for
compatibility: UUID events write both fields, while BIGINT worker IDs use values
such as `entity_key = '18'` and `entity_id = NULL`. Badge events use the
`worker_badge_history.id` UUID as their audit key, never the reusable badge
number. Audit JSON captures badge number, worker ID, and interval boundaries.

Migration down is intentionally guarded. It refuses if either feature table is
populated or if any audit row cannot be represented exactly by the legacy UUID
identity and model/operation checks. A compatible empty/UUID-only tenant can
revert and reapply without changing old UUID values; non-UUID worker identities
and worker/badge audit categories fail before DDL/data changes. Tenant runtime
roles receive DML on both feature tables and the identity sequence through the
existing `TenantDatabaseManager` grant flow.

## Patta templates, number allocation, and historical accounting

Tenant migrations `20260926000500-AddPattaFoundation.js`,
`20260928000700-CorrectPattaQuantitySemantics.js`, and
`20260928000800-AddPattaPrintBatches.js` create the Patta base schema, correct
quantity semantics, and add global Partiya numbering, print batches, normalized
size rows, print events and batch status. Migrations do not seed sequence rows
from environment variables. After migrations succeed, `TenantMigrationRunner`
invokes `PattaSequenceInitializer`; it idempotently inserts singleton rows for
the Patta and Partiya sequences only when absent. Concurrent initializers rely
on each primary key and `ON CONFLICT DO NOTHING`. Existing `next_number` values
are never reset when environment settings change.

Patta allocation settings are validated at startup:

- `PATTA_NUMBER_START=1` (positive BIGINT; used only when first initializing a tenant);
- `PARTIYA_NUMBER_START=1` (positive BIGINT; used only when first initializing a tenant Partiya sequence);
- `PATTA_NUMBER_BLOCK_SIZE=1000` (positive BIGINT block size);
- `PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE=2` (positive safe integer);
- `PATTA_MAX_BATCH_SIZE=100` (positive safe integer).

Partiya and Patta numbers each have an independent tenant-global BIGINT
sequence and offline device-block table. Online print batch creation locks the
Partiya sequence first, then the Patta sequence, allocates one Partiya and a
contiguous unique Patta range, and commits both movements with the batch.
Partiya and Patta block allocation use the matching locked sequence. All range
arithmetic uses `BigInt`; API numbers serialize as canonical decimal strings.
No allocator path uses `MAX(...)+1`.

`patta_number_blocks` stores inclusive BIGINT ranges. A GiST exclusion
constraint prohibits overlaps across `ACTIVE`, `EXHAUSTED`, and `CANCELLED`
rows. Cancellation and sequence rollback never release a range. Reports can
only advance monotonically while ACTIVE; reporting the full range transitions
to `EXHAUSTED`, and EXHAUSTED/CANCELLED are terminal for allocation and usage
updates. The historical membership validator may still prove that a number
belongs to an EXHAUSTED/CANCELLED block and its original device.
`patta_partiya_number_blocks` applies the same owner, overlap and monotonically
reported-usage invariants to Partiya ranges. Offline batch payloads reference
one reserved Partiya block and the applicable existing Patta block for every
Patta number.

The Master `DeviceAccessService` is the reusable device authorization boundary
for Patta and Partiya block allocation/usage and online Patta batch creation. It
looks up the supplied device ID in Master, compares its company to the
authenticated tenant context, and requires `ACTIVE`. It distinguishes
`DEVICE_NOT_FOUND`, `DEVICE_TENANT_MISMATCH`, and `DEVICE_NOT_ACTIVE`. A
cross-database FK is intentionally absent; only the validated device UUID is
written to tenant block/Patta rows and audit metadata. Client tenant/company IDs
are rejected as unknown DTO fields.

Templates require an ACTIVE model at creation, normalize business strings with
the existing `canonicalize_business_name()` function, and have tenant-wide
active-only normalized-name uniqueness. Template changes use positive BIGINT
optimistic versions; deactivation is a status transition. DB triggers prohibit
template hard-delete. Generation with a template reads conveyor/dimension
defaults only from a locked template row; explicit optional dimension `null`
clears that default. Model → ACTIVE operations ordered by `sort_order, id` →
template row remains the legacy template-management lock order. The new print
batch route does not require a conveyor or a Patta template.

Each `patta_hisob` row preserves `model_name_snapshot`, nullable
`konveyer_snapshot`,
size/color, and the required business key `UNIQUE(partiya_number,
patta_number)`. Partiya whitespace is normalized while casing is preserved and
compared case-sensitively. A standalone `patta_number` unique constraint is
intentionally absent. Operation snapshots store canonical operation name,
effective `NUMERIC(14,2)` price, and order. `ish_soni` is the positive product
quantity on the printed Patta; it is independent of operation snapshot count.
The old value was preserved as `legacy_operation_count` and historical actual
quantity remains NULL until an authorized correction supplies it. Operation
snapshot updates/deletes remain prohibited.

`POST /api/v2/patta-print-batches` validates positive product quantity, required
color and unique canonical size rows. One transaction captures one database
timestamp; it shared-locks the active model/operations, resolves each historical
price using `OperationPriceService.resolvePrice(operation_id, transaction_time,
manager)`, allocates both sequences, and writes batch, sizes, Pattas, immutable
operation snapshots, audit and batch change-log record atomically. Every Patta
gets the request's `ish_soni`; it never derives that value from its operation
count. `model_operations.price` is not an effective price source. The database
defers a batch-content constraint until commit to verify that normalized size
counts match the batch's ACTIVE Pattas and their shared snapshots. Batch/size
updates and deletes are blocked until a versioned correction workflow is enabled.
Physical print attempts are represented by append-only `patta_print_events`.

Template read/write permissions reuse `models.view` and `models.manage`;
allocation, usage and print-batch creation use `patta.chiqarish.create`.
`patta.chiqarish.correct` is seeded for the protected tenant administrator for
the correction workflow. Legacy v1 Patta generation, lookup and list routes
return `SYNC_PROTOCOL_UPGRADE_REQUIRED`. `GET /api/v2/patta/lookup` returns
nullable actual quantity, separate legacy operation count, Patta status/batch
identity, print timestamp, and stable operation snapshot IDs. Redis caching is
deferred because the current Redis module is a stub; PostgreSQL remains the
source of truth.
Offline registration validates stable client Patta/snapshot UUIDs, device block
membership, model/template/operation versions, reference cursor, effective-time
prices, and the `(partiya_number, patta_number)` business key before persisting
historical rows. PostgreSQL's unique constraint remains the race-safe final
authority. A protocol-v1 CREATE without actual `ish_soni` receives
`SYNC_PROTOCOL_UPGRADE_REQUIRED`; actual product quantity is never inferred
from operation snapshots.

Migration rollback refuses to remove historical Patta quantities, print batches,
Partiya blocks, print events or related audit history. Untouched singleton
sequence rows alone permit an empty-schema down/up cycle; any advanced sequence
prevents rollback.

## Patta Sheet V3 and Standalone Entries

Additive tenant migration
`20260929001200-AddStandalonePattaEntries.js` backfills every existing sheet as
`PATTA_LINKED` from its authoritative Patta before making the new model ID/name
and positive `ish_soni` snapshots required. `patta_hisob_id` becomes nullable;
the Patta uniqueness rule is retained as a partial unique index for non-null IDs.
An entry-kind check permits only `PATTA_LINKED` with a Patta FK or `STANDALONE`
without one. Standalone Partiya/Patta/Rang/Razmer snapshots are informational,
not number-allocation or duplicate keys.

The migration replaces `guard_patta_sheet_mutation`,
`guard_patta_sheet_operation_snapshot_mutation`, and
`guard_patta_sheet_row_mutation`, and adds INSERT to the parent guard trigger.
The parent guard validates linked snapshots against the Patta, keeps standalone
quantity/model identity immutable, and permits linked quantity changes only
when an existing authorized Patta correction ledger matches. The snapshot guard
enforces model membership and allows `MODEL` sources only for standalone sheets;
`PATTA` and `CUSTOM` keep their respective source rules. The row guard requires
every row quantity to match the immutable sheet header, plus the current Patta
quantity for linked sheets. `deleted_by_name_snapshot` is set from the server
user at trash time, cleared on restore, and retained in the typed V3 projection.
Existing deleted rows keep a null actor-name snapshot rather than inventing
history.

The linked-only `/api/v2/patta-sheets` shape remains unchanged. Standalone-capable
REST and sync use V3 projections. V2 clients can continue linked-only pulls, but
encountering a V3-only projection/tombstone or bootstrapping a tenant with a
Standalone sheet returns `SYNC_PROTOCOL_UPGRADE_REQUIRED` without cursor
advancement. Reverting migration 012 is blocked while Standalone rows, V3 change
log entries, or protocol-3 bootstrap sessions remain.

## Manual Model hisob adjustments

Additive tenant migration `20260929001300-AddModelAccountAdjustments.js` adds a
first-class adjustment table separate from Patta Sheets. Each UUID row references
one model, model operation and permanent worker; quantity is positive, effective
price is immutable `NUMERIC(14,2)`, and `entered_at`/tenant-local `business_date`
are preserved across quantity edits. Versions protect stale updates. Trash and
restore are soft lifecycle updates; physical deletion is guarded. The migration
adds the `patta.hisob.manual_manage` permission for the system administrator,
extends audit action/entity checks, and creates indexes for model/operation/
worker aggregation. SQLite migration 7 preserves existing queue/conflict/
dependency/tombstone/bootstrap state while extending sync entity allowlists and
adding the local adjustment mirror.

## Offline synchronization database boundaries

The additive tenant migration
`20260926000600-AddOfflineSyncInfrastructure.js` adds four tenant-local tables:

- `processed_sync_events` stores the UUID idempotency key, Master-validated
  device/user identity, SHA-256 canonical request fingerprint, terminal result,
  and processing time. A transaction may reserve `PROCESSING`, but a deferred
  constraint trigger rejects a commit before the status is `SYNCED`, `CONFLICT`,
  or `FAILED`. Identity/fingerprint/result rows are immutable after the one
  terminal transition.
- `server_change_log` is append-only. Its `BIGSERIAL sequence_id` is the tenant
  pull cursor; changes store entity identity, `UPSERT`/`DELETE`, entity/projection
  versions, explicit JSONB projection, and server time.
- `bootstrap_sessions` stores a device-bound watermark, ACTIVE/COMPLETED/EXPIRED
  lifecycle and expiry. A partial unique index permits one ACTIVE baseline per
  device. `bootstrap_items` contains only temporary, versioned reference
  projections and cascades with its session.
- `patta_hisob.client_created_at` and `occurred_at` are nullable additive columns
  for offline registrations; `created_at` remains server receipt time.

Tenant runtime roles receive only the required DML grants through
`TenantDatabaseManager.grantRuntimePrivileges()`. Master rows remain isolated:
the API resolves company context from tenant hostname plus JWT and verifies each
device through Master `DeviceAccessService` before accessing its tenant
database. Desktop stores no database credentials or authentication tokens.

Every sync-visible API mutation calls `SyncChangeRecorder` in the same tenant
transaction as its business write. The recorder and bootstrap use the same
advisory lock key. Writers acquire the transaction lock before inserting a
sequence and hold it through commit. Bootstrap acquires a device-scoped lock,
acquires the global change lock, starts `REPEATABLE READ`, establishes the
snapshot, reads `COALESCE(MAX(sequence_id), 0)` as watermark, and releases the
global lock before projection materialization. It uses that same MVCC snapshot
for all nine reference projections. The per-device lock can remain through
materialization; tenant business writes are not blocked during materialization
or HTTP page reads. QueryRunners/transactions never survive an HTTP request.

Projection order is stable and pages are keyset-paginated by the session-local
decimal `order_key`. Bootstrap cleanup expires bounded batches of sessions and
retains terminal staging for the configured TTL; it never removes source
business rows. The API currently retains its change log so every committed
cursor remains pullable.

## Desktop SQLite persistence

Each Electron workstation keeps each company's local mirror in
`<userData>/tenants/tenant-<authenticated-company-uuid>.sqlite`. The UUID comes
only from the server login response or the validated encrypted secure-session
envelope during offline startup; a host, email, IPC payload, or device config
never determines the DB filename. Additive SQLite migration version 2 stores a
singleton `tenant_database_identity` row with `application_id`, `company_id`,
and `schema_version`. On open, the path company UUID and in-file identity must
match. An unowned populated database or mismatch is rejected without data
overwrite/reassignment. Only one tenant DB handle/runtime is active at a time.

The old shared `textile-erp.sqlite` is left untouched: it is not opened,
migrated, or auto-bound to the first tenant. Existing tenant files are retained
on logout so offline work remains durable.

`better-sqlite3` stays in Electron main and remains externalized/rebuilt for
pinned Electron `44.4.5`. SQLite uses `schema_migrations`, exclusive
per-migration transactions, foreign keys, WAL and a bounded busy timeout. A
failed migration rolls back its DDL and leaves the existing database intact;
it is never deleted/recreated as recovery.

SQLite migration 6 rebuilds the Patta Sheet parent/children in one migration
transaction to make the Patta FK nullable and add the V3 Entry discriminator and
snapshots. It preserves existing linked data, local ownership/server sequences,
queued event JSON, worker/badge evidence, and tombstones, recreates all sheet
triggers/indexes, and requires an empty `PRAGMA foreign_key_check` before commit.

The versioned mirror includes workers/badges, models/operations/effective price
history, templates, Patta/block/snapshot data, queue/state/conflicts, bootstrap
staging and tombstones. PostgreSQL BIGINT IDs/cursors/versions and NUMERIC money
are canonical decimal TEXT; timestamps are UTC ISO strings; only bounded counts
use SQLite INTEGER. Server-owned rows missing from a complete snapshot are
tombstoned rather than hard-deleted, preserving historical foreign keys.

An offline Patta, its immutable operation-price snapshots, and one stable UUID
sync event commit together in a `BEGIN IMMEDIATE` local transaction. Number
blocks are server-assigned inclusive ranges; offline allocation advances only
`local_next_number`/local consumption and never uses `MAX(patta_number) + 1`.
At `consumed * 100 >= capacity * 80`, online sync can request a reserved block.
Server usage reports are monotonic and never move a locally advanced next number
backward. Pull projection changes and `last_server_cursor` commit in one local
transaction; failures leave both unchanged.

Desktop auth credentials are separate from the operational SQLite mirrors.
Electron `safeStorage` encrypts a versioned session payload, including the
refresh token, before an atomic temp-file sync/close/replace in `userData`.
Windows uses DPAPI. If encryption is unavailable, login persistence fails
closed; no refresh token is written as plaintext or into SQLite. The access
token remains in main-process memory only. `userData/device-config.json` is a
separate non-secret provisioning file containing only `{ "version": 1,
"device_id": "<registered Master UUID>" }`; it contains no company or session
identity.
