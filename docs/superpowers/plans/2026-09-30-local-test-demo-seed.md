# Local Test Demo Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` for inline implementation or `subagent-driven-development` if the user chooses delegated task execution. Work through the tasks in order and preserve the existing worktree changes.

**Goal:** Add one repeatable, local-only CLI command that prepares a tenant admin, one active model with priced operations, and three badge-assigned workers for local testing.

**Architecture:** Keep tenant provisioning on the existing `CompaniesService` path. Add a small argument/target guard, a focused idempotent seed service that delegates writes to tenant domain services, and a CLI composition root that resolves an existing or newly provisioned tenant. Add root/workspace scripts and document the command.

**Tech Stack:** NestJS application context, TypeScript, TypeORM `DataSource`, existing tenant domain services, Vitest, npm workspaces.

## Global Constraints

- Only run when `NODE_ENV=development` and Master and tenant database hosts resolve to `localhost`, `127.0.0.1`, or `::1`.
- Reject a Master database name ending in `_test` before opening the app or writing data.
- Do not reset an existing admin password; print a randomly generated password only when creating a new local tenant/admin.
- Create `Trikotaj sinov modeli` with active operations `Bichish` (`300.00` so‘m), `Tikish` (`1500.00` so‘m), and `Qadoqlash` (`500.00` so‘m).
- Create three fictional active workers named `Lokal sinov ishchisi 1`, `Lokal sinov ishchisi 2`, and `Lokal sinov ishchisi 3`, assigned badges `9001`, `9002`, and `9003` respectively.
- Use existing model, operation, worker, and badge domain services for mutations so audit, historical prices, and sync projections are recorded.
- Never delete or rewrite existing tenant data. An occupied fixture badge belonging to a different worker is an error, not an implicit reassignment.

---

## File Structure

- Create `apps/api/src/master/provisioning/local-dev-demo-seed.config.ts` for CLI argument parsing and the local-environment guard.
- Create `apps/api/src/master/provisioning/local-dev-demo-seed.config.spec.ts` for argument and guard tests.
- Create `apps/api/src/master/provisioning/local-dev-demo-seeder.ts` for idempotent model/operation/worker/badge setup.
- Create `apps/api/src/master/provisioning/local-dev-demo-seeder.spec.ts` for repeat-run and badge-conflict tests.
- Create `apps/api/src/master/provisioning/local-dev-demo-seed.cli.ts` as the Nest CLI composition root.
- Modify `apps/api/package.json` and root `package.json` to expose the command.
- Modify `docs/tenant-provisioning.md` with local setup and credential behavior.

Before modifying existing package or documentation files, inspect their current worktree diff and preserve all unrelated changes already present on `feature/desktop-ui-ux`.

## Task 1: Local command options and fail-closed environment guard

**Files:**
- Create: `apps/api/src/master/provisioning/local-dev-demo-seed.config.ts`
- Test: `apps/api/src/master/provisioning/local-dev-demo-seed.config.spec.ts`

**Interfaces:**
- `LocalDemoSeedOptions`: `{ slug: string; companyName: string; adminEmail: string }`.
- `parseLocalDemoSeedOptions(args: readonly string[]): LocalDemoSeedOptions` accepts `--slug`, `--company-name`, and `--email`; defaults are `textile-dev`, `Textile Dev`, and `admin@<slug>.local`.
- `assertLocalDevelopmentTarget(env: NodeJS.ProcessEnv): void` validates development mode, loopback Master/tenant hosts, and a non-empty Master DB name that does not end with `_test`.
- `LocalDemoSeedOptions` and both functions are exported from `local-dev-demo-seed.config.ts`; all invalid input throws an `Error` with a non-secret explanation.

- [ ] **Step 1: Write failing option-parser and guard tests.** Cover defaults, custom values, missing flag values, unknown flags, invalid slug/email, non-development mode, remote Master host, remote tenant host, missing Master DB name, `_test` database name, and a valid loopback configuration.

The successful parser cases must assert these exact results:

```ts
expect(parseLocalDemoSeedOptions([])).toEqual({
  slug: 'textile-dev',
  companyName: 'Textile Dev',
  adminEmail: 'admin@textile-dev.local',
});
expect(parseLocalDemoSeedOptions([
  '--slug', 'factory-dev',
  '--company-name', 'Factory Dev',
  '--email', 'ADMIN@factory.local',
])).toEqual({
  slug: 'factory-dev',
  companyName: 'Factory Dev',
  adminEmail: 'admin@factory.local',
});
```
- [ ] **Step 2: Run the focused tests and confirm they fail because the config module is missing.**

Run from repository root:

```powershell
npm run test --workspace=apps/api -- src/master/provisioning/local-dev-demo-seed.config.spec.ts
```

Expected: Vitest reports the new module or exported functions are not available.

- [ ] **Step 3: Implement the config exports.** Parse only the three documented flags, reject unknown/duplicate flags and absent values, normalize the email to lowercase, and validate the slug using the existing DNS-label rule. The host allowlist is exactly `localhost`, `127.0.0.1`, and `::1`; lowercase and trim host values before comparison. Reject missing hosts instead of silently assuming loopback.

The parser loop maps only these flags and rejects all others:

```ts
const flagNames = new Map([
  ['--slug', 'slug'],
  ['--company-name', 'companyName'],
  ['--email', 'adminEmail'],
]);
```

After parsing, apply these validations and defaults before returning the options:

```ts
const slug = values.slug ?? 'textile-dev';
const companyName = values.companyName ?? 'Textile Dev';
const adminEmail = (values.adminEmail ?? `admin@${slug}.local`).trim().toLowerCase();
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) throw new Error('Invalid local tenant slug');
if (!companyName.trim()) throw new Error('Company name cannot be empty');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new Error('Invalid local admin email');
```

The guard must check the three environment values before Nest initialization:

```ts
if (env.NODE_ENV !== 'development') throw new Error('Local demo seed requires NODE_ENV=development');
for (const key of ['MASTER_DB_HOST', 'TENANT_DB_HOST'] as const) {
  const host = env[key]?.trim().toLowerCase();
  if (!host || !LOOPBACK_HOSTS.has(host)) throw new Error(`${key} must point to loopback`);
}
const database = env.MASTER_DB_NAME?.trim().toLowerCase();
if (!database || database.endsWith('_test')) throw new Error('Local demo seed refuses a missing or test Master database');
```
- [ ] **Step 4: Re-run the focused tests.**

Expected: all option-parser and local-target guard tests pass.

## Task 2: Idempotent domain-data seeder

**Files:**
- Create: `apps/api/src/master/provisioning/local-dev-demo-seeder.ts`
- Test: `apps/api/src/master/provisioning/local-dev-demo-seeder.spec.ts`

**Interfaces:**
- `LocalDemoSeedDependencies` is `{ models: Pick<ModelsService, 'list' | 'create'>; operations: Pick<OperationsService, 'listByModel' | 'create'>; workers: Pick<WorkersService, 'list' | 'create'>; badges: Pick<BadgeHistoryService, 'assign'> }`.
- `LocalDemoSeedResult` is `{ model: { id: string; name: string; created: boolean }; operations: Array<{ id: string; name: string; price: string; created: boolean }>; workers: Array<{ id: string; fullName: string; badgeNumber: string; created: boolean; badgeCreated: boolean }> }`.
- `seedLocalDemoData(dataSource: DataSource, actorUserId: string, dependencies: LocalDemoSeedDependencies): Promise<LocalDemoSeedResult>` returns the stable model/operation/worker identifiers and created/reused flags.
- The seeder looks up active fixture models/workers through service `list` methods and active model operations through `OperationsService.listByModel`; new rows use the corresponding `create` or `assign` service method.

- [ ] **Step 1: Add a focused fake-backed test for the first seed run.** Assert that it creates the fixture model, three operations with the specified decimal-string prices and sort order `0`, `1`, `2`, three workers, and three badge assignments with actor ID and no explicit backdated `effective_at`.
- [ ] **Step 2: Add a repeat-run test using the same fake state.** Run `seedLocalDemoData` twice and assert the second run creates no additional entities, preserves IDs, and returns the same fixture model/workers/badges.

The repeat-run assertions must include:

```ts
const first = await seedLocalDemoData(dataSource, actorUserId, dependencies);
const second = await seedLocalDemoData(dataSource, actorUserId, dependencies);
expect(second).toEqual(expect.objectContaining({ model: expect.objectContaining({ id: first.model.id, created: false }) }));
expect(second.operations.every(({ created }) => !created)).toBe(true);
expect(second.workers.every(({ created, badgeCreated }) => !created && !badgeCreated)).toBe(true);
expect(createCounts).toEqual({ models: 1, operations: 3, workers: 3, badges: 3 });
```
- [ ] **Step 3: Add a badge-collision test.** Make the data source report badge `9002` as open for a worker other than the expected fixture worker; assert the seeder rejects without calling `BadgeHistoryService.assign` for that badge.
- [ ] **Step 4: Run the focused tests and confirm they fail before the seeder exists.**

Run:

```powershell
npm run test --workspace=apps/api -- src/master/provisioning/local-dev-demo-seeder.spec.ts
```

- [ ] **Step 5: Implement the seeder.** Use exact fixture constants from the Global Constraints. Resolve each fixture entity by its stable active name. For every badge, query the open `worker_badge_history` assignment by badge number; reuse it only when it belongs to the expected fixture worker, assign only when there is no open assignment, and throw a clear error for any other owner. Do not add direct SQL business writes.

For each operation, reuse a matching active operation; otherwise call the operation domain service with the chosen model ID and its `price` and `sort_order`. For each badge, the read query is parameterized and read-only:

```ts
const rows: Array<{ worker_id: string }> = await dataSource.query(
  'SELECT "worker_id"::text AS "worker_id" FROM "worker_badge_history" WHERE "badge_number" = $1 AND "valid_to" IS NULL',
  [badgeNumber],
);
```
- [ ] **Step 6: Run the focused tests and confirm they pass.**

Expected: repeated seeding is stable, and an unrelated badge owner is retained with a reported conflict.

## Task 3: Local setup CLI and workspace commands

**Files:**
- Create: `apps/api/src/master/provisioning/local-dev-demo-seed.cli.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`

**Interfaces:**
- The CLI uses `parseLocalDemoSeedOptions(process.argv.slice(2))` and calls `assertLocalDevelopmentTarget(process.env)` before creating the Nest application context.
- It queries Master `companies` by slug. If absent, it calls `CompaniesService.createAndProvision` with the requested company data and a `randomBytes(32).toString('base64url')` password. If present, it requires the company to be `ACTIVE` and never calls provisioning or admin-password mutation for it.
- It connects to the resolved company using `TenantConnectionManager.getDataSource(companyId)`, resolves the active system tenant-admin row matching the requested email, and uses that user ID as the audit actor for `seedLocalDemoData`.

- [ ] **Step 1: Add the CLI composition root.** Create a Nest application context with logging disabled; resolve the Master DataSource, `CompaniesService`, `TenantConnectionManager`, and four tenant seed collaborators using non-strict `app.get`; close the app in `finally`.
- [ ] **Step 2: Implement new-tenant and existing-tenant flows.** For a missing company, provision it with the generated password and default `Asia/Tashkent` timezone. Re-query the Master company row and require `ACTIVE` status and a connection ciphertext before accessing tenant data. For an existing company, require `ACTIVE`; do not generate or print a new password. Resolve an active user joined to system role `Korxona administratori` by normalized email; fail before seeding if absent.

Use this parameterized Master lookup and require exactly one active result before resolving tenant data:

```ts
const rows: Array<{ id: string; name: string; slug: string; status: string; db_connection_ciphertext: string | null }> =
  await master.query(
    'SELECT "id"::text AS "id", "name", "slug", "status", "db_connection_ciphertext" FROM "companies" WHERE "slug" = $1',
    [options.slug],
  );
```

Resolve the actor with this parameterized tenant query; a missing result is a hard error before any fixture mutation:

```ts
const admins: Array<{ id: string }> = await dataSource.query(
  `SELECT app_user."id"::text AS "id"
   FROM "users" AS app_user
   INNER JOIN "roles" AS role ON role."id" = app_user."role_id"
   WHERE lower(app_user."email") = $1
     AND app_user."status" = 'ACTIVE'
     AND role."name" = 'Korxona administratori'
     AND role."is_system" = true`,
  [options.adminEmail],
);
```
- [ ] **Step 3: Print a concise result.** Show tenant slug/URL, admin email, model ID, workers and badge numbers, plus created/reused status. Include the generated password only for a newly provisioned tenant. Do not log the password elsewhere or place it in an error message.
- [ ] **Step 4: Add `dev:setup-local-demo` scripts.** The API workspace command must run Master migrations and then the built CLI with `node --env-file=.env`; the root command forwards to `apps/api` using npm workspaces. Preserve all existing scripts and user changes in both package manifests.
- [ ] **Step 5: Build and run focused tests.**

```powershell
npm run typecheck --workspace=apps/api
npm run test --workspace=apps/api -- src/master/provisioning/local-dev-demo-seed.config.spec.ts src/master/provisioning/local-dev-demo-seeder.spec.ts
npm run build --workspace=apps/api
```

Expected: typecheck, focused tests, and API build pass; the compiled CLI exists at `apps/api/dist/master/provisioning/local-dev-demo-seed.cli.js`.

## Task 4: Document, validate, and local smoke test

**Files:**
- Modify: `docs/tenant-provisioning.md`
- Validate: all files listed in Tasks 1–3.

- [ ] **Step 1: Document setup and reuse.** Explain that the command provisions the default local tenant only when missing; on a fresh tenant it prints a generated one-time password, while on an existing tenant it preserves the current password and requires the specified active admin email. Document the exact fixture model, operation prices, workers, badges, and the loopback/`_test` safety checks.
- [ ] **Step 2: Run API lint and full unit suite.**

```powershell
npm run lint --workspace=apps/api
npm run test --workspace=apps/api
```

Expected: both commands pass; if any database integration tests are gated because dedicated `TEST_MASTER_DB_*` values are absent, record them as skipped rather than passed.

- [ ] **Step 3: Run the command twice against the configured local development stack.** First execution should provision or reuse the tenant and print credentials only if it creates the tenant; second execution should reuse every fixture and preserve the admin password. Verify model/operation/worker counts and badge ownership through the command’s summary or existing local API.

Run from repository root:

```powershell
npm run dev:setup-local-demo
npm run dev:setup-local-demo
```

Expected: both executions complete, second execution reports reused fixtures, and no duplicate active records or badge assignments are created. Do not substitute `TEST_MASTER_DB_*` or production database settings for local development settings.

- [ ] **Step 4: Inspect `git status` and `git diff`, stage only the implementation/spec/plan/documentation files for this feature, and commit with `feat: add local test demo seed`.** Do not include the unrelated pre-existing worktree changes.

## Plan Self-Review

- The target guard, tenant/admin lifecycle, exact demo fixture, idempotency, badge collision handling, audit/sync-aware mutations, docs, and validation in the approved spec are each covered above.
- Tests explicitly exercise invalid targets, parser errors, first run, repeat run, and unrelated badge ownership.
- The CLI only prints a generated password after new tenant provisioning; existing tenant credentials are not reset or guessed.
