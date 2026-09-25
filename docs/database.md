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
