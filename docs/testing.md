# API testing

The API unit and endpoint tests run through Vitest:

```powershell
npm run lint --workspace=apps/api
npm run test --workspace=apps/api
npm run build --workspace=apps/api
```

## Master database integration tests

Master database constraint tests use a dedicated PostgreSQL database. They
read only `TEST_MASTER_DB_HOST`, `TEST_MASTER_DB_PORT`, `TEST_MASTER_DB_NAME`,
`TEST_MASTER_DB_USER`, and `TEST_MASTER_DB_PASSWORD`; the test DataSource never
reads `MASTER_DB_*`. `TEST_MASTER_DB_NAME` must end in `_test` before the test
DataSource can connect, migrate, or revert. Tests never synchronize or drop a
database. The migration-revert case drops only the Master tables in this
dedicated test database and then reapplies the migration.

When using the development PostgreSQL container, start it and create a separate
test database (do not use `textile_master` for tests):

```powershell
npm run infra:up
docker exec textile-postgres psql -U textile_admin -d textile_master -c "CREATE DATABASE textile_master_test;"
```

Set the five `TEST_MASTER_DB_*` values in the local shell or CI secret store to
connect to `textile_master_test`, then run:

```powershell
npm run test:master-db --workspace=apps/api
npm run test --workspace=apps/api
```

If none of the `TEST_MASTER_DB_*` values are set, Vitest marks the database
integration suite as blocked/skipped; that is not a database-test pass. A
partially configured test environment fails fast. A configured test database
name without the `_test` suffix is rejected before any connection is opened.

The database suite checks initial migration application and rollback/reapply,
slug and case-insensitive email uniqueness, duplicate RBAC assignment rejection,
device/company and license/company/device foreign keys, cross-company license
rejection, and idempotent platform permission seeding.
