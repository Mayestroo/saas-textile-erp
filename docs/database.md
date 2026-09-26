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

Additive tenant migration `20260926000500-AddPattaFoundation.js` creates
`patta_templates`, `patta_number_sequence`, `patta_number_blocks`,
`patta_hisob`, and `patta_operation_snapshots`. The migration does not seed a
sequence row from an environment variable. After migrations succeed,
`TenantMigrationRunner` invokes `PattaSequenceInitializer` with the validated
`PATTA_NUMBER_START`; it inserts singleton `id = 1` only if absent. Concurrent
initializers rely on the primary key and `ON CONFLICT DO NOTHING`. Existing
`next_number` is never reset when the environment changes.

Patta allocation settings are validated at startup:

- `PATTA_NUMBER_START=1` (positive BIGINT; used only when first initializing a tenant);
- `PATTA_NUMBER_BLOCK_SIZE=1000` (positive BIGINT block size);
- `PATTA_MAX_ACTIVE_BLOCKS_PER_DEVICE=2` (positive safe integer);
- `PATTA_MAX_BATCH_SIZE=100` (positive safe integer).

The online server allocator and device block allocator share the same
tenant-local sequence row. Both lock it `FOR UPDATE`, use exact `BigInt` range
arithmetic, and commit the range/sequence movement atomically with their tenant
transaction. API ranges and Patta numbers serialize as decimal strings. Online
generation always stores `created_from_block_id = NULL`; that means its numbers
came directly from the server allocator, not a device-reserved block. The
client cannot set this field. No allocator path uses `MAX(patta_number) + 1`.

`patta_number_blocks` stores inclusive BIGINT ranges. A GiST exclusion
constraint prohibits overlaps across `ACTIVE`, `EXHAUSTED`, and `CANCELLED`
rows. Cancellation and sequence rollback never release a range. Reports can
only advance monotonically while ACTIVE; reporting the full range transitions
to `EXHAUSTED`, and EXHAUSTED/CANCELLED are terminal for allocation and usage
updates. The historical membership validator may still prove that a number
belongs to an EXHAUSTED/CANCELLED block and its original device.

The Master `DeviceAccessService` is the reusable device authorization boundary
for block allocation, usage, cancellation, and online Patta generation. It
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
template row is the generation lock order.

Each `patta_hisob` row preserves `model_name_snapshot`, `konveyer_snapshot`,
size/color, and the required business key `UNIQUE(partiya_number,
patta_number)`. Partiya whitespace is normalized while casing is preserved and
compared case-sensitively. A standalone `patta_number` unique constraint is
intentionally absent. Operation snapshots store canonical operation name, effective
`NUMERIC(14,2)` price, and order. The deferred Patta FK permits inserting
snapshot rows first so `ish_soni` is derived from
`COUNT(patta_operation_snapshots)` before the Patta parent row is inserted.
`patta_hisob` and snapshot update/delete triggers protect historical values.

Online generation is all-or-nothing. One transaction timestamp is captured for
the whole batch; model and ACTIVE operation rows are shared-locked, and every
price is resolved with `OperationPriceService.resolvePrice(operation_id,
transaction_timestamp, manager)`. `model_operations.price` is not an effective
price source. Operation create/update/deactivate already takes model then
operation locks; price changes take the operation lock, making the snapshot
stable against concurrent mutations. A model with no ACTIVE operations returns
`PATTA_MODEL_HAS_NO_OPERATIONS`. Each created Patta receives its own append-only
`patta.create` audit record keyed by immutable Patta UUID.

Template read/write permissions reuse `models.view` and `models.manage`;
allocation, usage, cancellation, and generation use
`patta.chiqarish.create`; lookup and paginated list use `patta.hisob.view`.
Lookup/list read tenant PostgreSQL directly. Redis caching is deferred because
the current Redis module is a stub; PostgreSQL remains the source of truth.
Offline registration has only reusable number-membership and structural
snapshot validators in this stage, plus an existing `(partiya_number,
patta_number)` lookup check before a future registration attempt. PostgreSQL's
unique constraint remains the race-safe final authority. No sync endpoint, event
ID, queue, or offline Patta persistence is created.

Migration rollback refuses to remove any Patta/template/block business row or
Patta audit event. An untouched singleton sequence row alone does not prevent
an empty-schema test down/up cycle; a sequence whose version advanced also
prevents rollback.
