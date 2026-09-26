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
