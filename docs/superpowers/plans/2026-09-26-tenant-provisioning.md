# Tenant Provisioning Foundation Implementation Plan

> **For agentic workers:** This plan is executed inline in the current session. Steps use checkbox syntax for progress tracking.

**Goal:** Provision a dedicated PostgreSQL database and least-privilege runtime login for each company, with retryable persisted state and isolated tenant foundation schema.

**Architecture:** Keep Master metadata in the existing named `master` DataSource. Use a separate elevated `TENANT_PROVISIONER_DB_*` connection for database/role lifecycle and migrations; persist only AES-256-GCM-encrypted tenant runtime credentials in Master. Run provisioning under a company-specific PostgreSQL advisory lock pinned to one Master QueryRunner, and cache runtime TypeORM DataSources by company ID.

**Tech Stack:** NestJS, TypeORM, PostgreSQL 16, node-postgres, `argon2` Argon2id, Node.js `crypto`, Vitest.

## Global Constraints

- Every TypeORM DataSource uses `synchronize: false` and `migrationsRun: false`.
- Master and tenant migrations remain in separate directories and use separate migration table names.
- Runtime tenant logins are unique per company and have `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`.
- Never interpolate company names/slugs into SQL identifiers; only generated names matching strict allowlists may be interpolated.
- Provisioning retries never drop databases, roles, migrations, seeds, or users.
- Integration tests require `TEST_MASTER_DB_NAME` ending in `_test`; test tenant DBs match only `tenant_test_<32 lowercase hex>` and cleanup tracks only DB names generated in that run.
- No public company creation endpoint or future business module is included.

---

### Task 1: Persist provisioning failure state

**Files:**
- Modify: `apps/api/src/master/companies/company.entity.ts`
- Create: `database/master-migrations/20260926000000-AddCompanyProvisioningFailure.js`
- Create: `database/master-migrations/20260926000100-AddDefaultAdminRequirement.js`
- Modify: `apps/api/src/database/master/master-database.integration.spec.ts`

**Interfaces:** Add nullable `failureStep` and `failureReason` entity fields mapped to `failure_step` and `failure_reason`. The additive migration adds/drops only those columns and does not edit the initial migration.

- [x] Add migration assertions for both columns and its rollback-safe schema behavior.
- [x] Add entity mappings and run the Master integration test against the dedicated `_test` database.

### Task 2: Tenant PostgreSQL configuration and encrypted credentials

**Files:**
- Create: `apps/api/src/database/tenant/tenant-database.config.ts`
- Create: `apps/api/src/database/tenant/tenant-database.config.spec.ts`
- Create: `apps/api/src/master/provisioning/aes-gcm-tenant-connection-secret-cipher.ts`
- Create: `apps/api/src/master/provisioning/aes-gcm-tenant-connection-secret-cipher.spec.ts`
- Modify: `apps/api/.env.example`

**Interfaces:** `createTenantMigrationDataSourceOptions(credentials)` and `createTenantRuntimeDataSourceOptions(credentials)` share strict PostgreSQL option construction and force `synchronize: false`. `AesGcmTenantConnectionSecretCipher` implements the existing `TenantConnectionSecretCipher` using a 32-byte external key and a fresh 12-byte nonce per envelope (`v1:<iv>:<tag>:<ciphertext>`).

- [x] Test invalid host/port/key inputs, fresh nonces, credential round-trip, version rejection, and authentication-tag tampering.
- [x] Add empty placeholders for `TENANT_PROVISIONER_DB_HOST`, `TENANT_PROVISIONER_DB_PORT`, `TENANT_PROVISIONER_DB_NAME`, `TENANT_PROVISIONER_DB_USER`, `TENANT_PROVISIONER_DB_PASSWORD`, and `TENANT_CONNECTION_ENCRYPTION_KEY`; do not put real secrets in source.

### Task 3: Tenant lifecycle manager and migration runner

**Files:**
- Create: `apps/api/src/database/tenant/tenant-migration-runner.ts`
- Create: `apps/api/src/database/tenant/tenant-database-manager.ts`
- Create: `apps/api/src/database/tenant/tenant-database.module.ts`
- Create: `apps/api/src/database/tenant/tenant-test-database-cleanup.ts`
- Create: `database/tenant-migrations/20260926000000-InitialTenantFoundation.js`
- Test: real PostgreSQL behavior in `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts`

**Interfaces:** `TenantDatabaseManager.ensureDatabase(companyId)` derives and validates `tenant_<normalized uuid>` and `tenant_<normalized uuid>_app`, idempotently configures the runtime role/database, and never drops either. `TenantMigrationRunner.run(companyId, credentials)` runs only tenant migrations via the provisioner connection.

- [x] Add the four foundation tables `users`, `roles`, `permissions`, `role_permissions`, with unique/case-insensitive email and explicit FK constraints.
- [x] Ensure PUBLIC cannot connect to a tenant database; grant CONNECT only to its generated runtime role. Apply schema/table/sequence DML grants to the runtime role, but do not grant schema ownership or migration privileges.
- [x] Test identifier validation, existing database/role retry, migration table separation, and `synchronize: false`.

### Task 4: Idempotent tenant seeds and default administrator

**Files:**
- Create: `apps/api/src/tenant/rbac/tenant-permission.seed.ts`
- Create: `apps/api/src/tenant/users/tenant-admin.seed.ts`
- Test: idempotency in `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts`

**Interfaces:** `seedTenantPermissions(dataSource)` upserts only tenant permission codes and the protected `Korxona administratori` role. `seedDefaultTenantAdmin(dataSource, {email, password, fullName})` hashes with Argon2id, assigns the default role transactionally, and does not duplicate or reset an existing user on retry.

- [x] Test repeated permission/role seeding and repeated admin seeding without duplicate rows or password leakage.
- [x] Keep platform permissions and every later business table/module out of tenant schema.

### Task 5: Provisioning orchestration and company application boundary

**Files:**
- Create: `apps/api/src/master/provisioning/provisioning.service.ts`
- Create: `apps/api/src/master/companies/companies.service.ts`
- Modify: `apps/api/src/master/provisioning/provisioning.module.ts`
- Modify: `apps/api/src/master/companies/companies.module.ts`
- Test: orchestration in `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts`

**Interfaces:** `CompaniesService.createAndProvision(input)` persists a PROVISIONING company and invokes the orchestration service. `ProvisioningService.provision(companyId, admin?)` pins one Master QueryRunner from `pg_advisory_lock` through `pg_advisory_unlock`/release in `finally`, persists each named step, reuses the stored encrypted tenant login on retry, migrates/seeds/admin-provisions idempotently, records schema version, and returns persisted state without database cleanup on failure.

- [x] Test successful state progression, migration failure persistence/retry, and concurrent calls for one company using real PostgreSQL.
- [x] Redact provisioner/runtime passwords from persisted failure reasons and all logs.

### Task 6: Tenant runtime connection cache and resolver contract

**Files:**
- Create: `apps/api/src/tenant/tenant-connection/tenant-connection.manager.ts`
- Modify: `apps/api/src/tenant/tenant-connection/tenant-connection.module.ts`
- Create: `apps/api/src/tenant/tenant-resolver/tenant-resolver.service.ts`
- Modify: `apps/api/src/tenant/tenant-resolver/tenant-resolver.module.ts`
- Create: `apps/api/src/tenant/tenant-resolver/tenant-resolver.service.spec.ts`
- Test connection cache behavior in `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts`

**Interfaces:** `TenantConnectionManager.getDataSource(companyId)` loads Master metadata, requires ACTIVE status, decrypts the per-company runtime secret, performs health checks, shares in-flight initialization, evicts failed pools, and closes all cached pools on shutdown. `TenantResolverService.resolve({hostname, authenticatedCompanyId})` requires a matching hostname slug, verified company ID, and ACTIVE Master row; it accepts no body/query tenant ID.

- [x] Test cache reuse, failed-connection cleanup, health query, graceful close, resolver mismatch, missing authenticated context, and non-ACTIVE status.
- [x] Verify tenant A credentials cannot connect to tenant B database after database ACLs are applied.

### Task 7: End-to-end PostgreSQL verification and documentation

**Files:**
- Create: `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts`
- Create: `docs/tenant-provisioning.md`
- Modify: `docs/database.md`
- Modify: `docs/testing.md`

- [x] Use only `TEST_MASTER_DB_*` for test provisioner credentials, require a `_test` Master DB, generate only `tenant_test_<uuid>` names, and drop only names recorded by the integration suite.
- [x] Verify two-company isolation, permission/admin idempotency, connection health/cache reuse, encrypted credential round-trip, retry after failure, and same-company advisory-lock serialization on local PostgreSQL.
- [x] Run API lint, all API tests, and API build; run the Master migration and the complete local provisioning workflow against Docker PostgreSQL.
- [x] Inspect `git status` and staged diff; stage only the tenant-provisioning feature files for the requested delivery commit.
