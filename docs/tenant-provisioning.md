# Tenant provisioning

Each company receives its own PostgreSQL database and a distinct runtime login. Company `name` and `slug` are display/routing values only; SQL identifiers are generated from the Master UUID:

```text
tenant_<uuid-without-hyphens>
tenant_<uuid-without-hyphens>_app
```

Names are checked against strict production/test patterns before they are used as SQL identifiers.

## Provisioning lifecycle

`CompaniesService.createAndProvision()` creates the Master company row in `PROVISIONING` / `REQUESTED` state, then synchronously calls `ProvisioningService`. No public company-create route is registered while Platform Auth/RBAC is not implemented.

The service pins a single Master `QueryRunner` for a company-specific PostgreSQL advisory lock and releases the lock in `finally`:

```text
REQUESTED
  → CREATING_DATABASE
  → RUNNING_MIGRATIONS
  → SEEDING_PERMISSIONS
  → CREATING_DEFAULT_ADMIN
  → ACTIVE
```

Each step is persisted in `companies.provisioning_status`. Failure stores `status = FAILED`, `provisioning_status = FAILED`, the failed step in `failure_step`, and a bounded/redacted diagnostic in `failure_reason`. A non-secret `default_admin_required` marker ensures retries supply administrator details again when the original request required an administrator; the password itself is never persisted in Master. Retry never drops a database or role. It safely rechecks the generated role/database, TypeORM migration metadata, idempotent seed state, and existing administrator. TypeORM applies only pending migrations, so a retry after an already-completed migration does not run it again.

Provisioning is not one PostgreSQL transaction: `CREATE DATABASE` cannot run inside a transaction. Each Master state write is durable before the next external step. Permission and administrator writes use tenant transactions.

`schema_version` records the latest tenant migration name and `last_migration_at` records the completed migration check.

## PostgreSQL credentials and permissions

Provisioner credentials are independent from Master runtime credentials:

```text
TENANT_PROVISIONER_DB_HOST
TENANT_PROVISIONER_DB_PORT
TENANT_PROVISIONER_DB_NAME
TENANT_PROVISIONER_DB_USER
TENANT_PROVISIONER_DB_PASSWORD
```

The provisioner connects to its configured maintenance database, creates the tenant runtime role and database, runs tenant migrations, and applies database/schema/table/sequence grants. Configure a dedicated elevated account with `CREATEDB`, `CREATEROLE`, access to the maintenance database, and authority to manage database connection ACLs across this dedicated PostgreSQL application cluster. It should not be the ordinary Master application login. It need not be a superuser if it owns the databases whose ACLs it changes; bootstrap grants must cover the maintenance and template databases. The Master runtime account must be able to manage its own database connection ACL, because provisioning revokes PUBLIC CONNECT to the Master database and preserves CONNECT for the current Master account.

Tenant runtime credentials are generated independently for each company. Provisioning revokes PUBLIC CONNECT/TEMP on connectable databases in the dedicated cluster, then grants explicit CONNECT to the Master runtime account, provisioner maintenance account, and each tenant's runtime role for its own database. A tenant runtime role cannot connect to another tenant, Master, provisioner, or template database. The role is configured with:

```text
NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
```

The provisioner owns tenant databases; the runtime role does not. The runtime role receives DML privileges on the foundation tables and future provisioner-created tables/sequences, but no schema ownership, migration-table access, or migration DDL privileges. The Master database's PUBLIC CONNECT is revoked while its current Master role keeps explicit CONNECT.

Use a PostgreSQL cluster dedicated to the application and create tenant databases through this manager so new databases receive the same ACL policy. Other databases created outside this provisioning path need their own explicit connection ACL.

Runtime TypeORM pools use `TENANT_DB_HOST` / `TENANT_DB_PORT`; the per-company database name and login are resolved from authenticated company context and Master metadata. `TenantConnectionManager` caches one DataSource per company, shares concurrent initialization, pings reused pools, removes failed pools, and closes pools at shutdown. Its last-access timestamp supports later TTL/LRU eviction without creating a pool per request.

## Encrypted runtime credentials

`companies.db_connection_ciphertext` contains an AES-256-GCM envelope, not plaintext. Each encryption uses a fresh 12-byte random IV and stores the 16-byte authentication tag in a versioned envelope:

```text
v1:<base64url-iv>:<base64url-auth-tag>:<base64url-ciphertext>
```

The 32-byte key is read from `TENANT_CONNECTION_ENCRYPTION_KEY`; it is never compiled into source. Generate one outside the repository, for example:

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Store the value in the deployment secret store and keep it stable while ciphertext encrypted with it exists. Key rotation requires retaining the old decrypt key until all stored tenant credentials have been re-encrypted; a rotation workflow is not part of this stage.

Default administrator passwords are supplied only to the synchronous application-service call, hashed with Argon2id in the tenant database, and never returned or logged. Replaying administrator seeding does not duplicate a user or reset an existing password.

## Tenant schema and permissions

The tenant migration runner reads only `database/tenant-migrations/` and uses `tenant_typeorm_migrations`, separate from Master migration metadata. `synchronize` and automatic migration execution remain disabled.

The initial tenant foundation contains only:

- `users` (case-insensitive unique email and Argon2id password hash)
- `roles`
- `permissions`
- `role_permissions`
- TypeORM's tenant migration metadata table

The current foundation stores one `role_id` per user; a later Auth/RBAC migration can normalize that link if multi-role assignment is introduced. No worker, badge, model, Patta, sync, or payroll tables are present.

The idempotent tenant catalog includes the requested models, workers/badge, Patta, users, roles, report, payroll, license, and audit permission codes. It contains no platform permission codes. `Korxona administratori` is system-protected and receives only this tenant permission catalog.

## Tenant resolution boundary

`TenantResolverService.resolve({ hostname, authenticatedCompanyId })` requires a valid authenticated company ID, a hostname subdomain matching the Master company slug, and an `ACTIVE` Master company with encrypted connection metadata. It does not accept a body/query `tenant_id`. The future HTTP adapter must pass company identity from verified authentication and the hostname established by a trusted proxy; this stage does not add an authentication bypass or public endpoint.

## Commands

From the repository root, apply Master migrations before enabling provisioning:

```powershell
npm run db:master:migrate --workspace=apps/api
npm run db:master:show --workspace=apps/api
```

Set the provisioner and encryption-key settings in the deployment environment before starting the API. The sample names and blank placeholders are in `apps/api/.env.example`.
