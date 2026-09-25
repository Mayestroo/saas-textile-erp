# Textile ERP — Codex Repository Instructions

## 1. Mission

This repository implements a production-grade SaaS ERP for textile factories.

Core stack:

* NestJS + TypeScript backend
* PostgreSQL 16
* TypeORM
* Redis
* Electron + React + TypeScript desktop
* SQLite via `better-sqlite3`
* npm workspaces monorepo
* Docker Compose
* JWT authentication
* Ed25519 device licensing

The application is:

* database-per-tenant
* offline-first
* multi-device
* two-way synchronized
* strict about historical payroll correctness
* strict about tenant isolation

Do not simplify business rules unless the user explicitly changes the specification.

---

## 2. Repository Root

Primary repository:

```text
D:\textile-erp
```

Assume Windows PowerShell unless the current execution environment clearly indicates otherwise.

Use PowerShell-compatible commands in user-facing instructions.

---

## 3. Repository Layout

Expected high-level structure:

```text
apps/
  api/
  desktop/
  platform-admin/

packages/
  shared-types/
  validation/
  sync-protocol/
  ui/

database/
  master-migrations/
  tenant-migrations/
  seeds/

infrastructure/
  docker/
  nginx/
  docker-compose.dev.yml

docs/
scripts/
```

Do not create duplicate application roots when an existing module already exists.

Before creating files, inspect the repository and reuse the established structure.

---

## 4. Sources of Truth

Read relevant documentation before making architectural changes.

Primary documents should live under:

```text
docs/architecture.md
docs/database.md
docs/tenant-provisioning.md
docs/sync-protocol.md
docs/rbac.md
docs/license.md
docs/deployment.md
docs/backup-restore.md
docs/testing.md
```

If code and documentation disagree:

1. identify the conflict;
2. preserve existing working behavior unless the task explicitly changes it;
3. update documentation when implementing an approved architecture change.

Do not silently change business invariants.

---

## 5. Working Method

Before editing:

```text
1. Inspect existing files.
2. Inspect package.json files and workspace structure.
3. Inspect current Git branch and status.
4. Understand the current module boundary.
5. Make the smallest coherent change.
6. Run relevant validation.
7. Fix failures caused by the change.
8. Commit the completed unit of work.
9. Push the feature branch when allowed and possible.
```

Do not rewrite unrelated code.

Do not remove user changes merely because they are outside the current task.

Do not perform speculative refactors during an unrelated feature.

---

## 6. Delivery Order

The project is developed sequentially.

Preferred order:

```text
0. Foundation
1. Master database
2. Tenant provisioning
3. Authentication + RBAC
4. Models + operations + price history
5. Workers + badge history
6. Patta generation + Patta hisob
7. Offline synchronization engine
8. Patta varag'i
9. Licensing
10. Admin panels
11. Payroll + reports
```

Determine the current completed stage from the repository.

Do not jump ahead and implement later business modules while an earlier architectural stage is incomplete.

Each stage must be working before the next stage becomes the main focus.

---

## 7. Monorepo Rules

Use npm workspaces.

Root `package.json` owns workspace orchestration.

Prefer one root lockfile:

```text
package-lock.json
```

Do not intentionally create independent lockfiles inside:

```text
apps/api
apps/desktop
apps/platform-admin
packages/*
```

unless the repository has deliberately changed package management strategy.

Run installs from repository root unless a tool specifically requires otherwise.

---

## 8. Dependency Rules

Do not bulk-upgrade dependencies just because newer versions exist.

Never run an uncontrolled:

```text
ncu -u
```

and accept every major upgrade without compatibility verification.

Major dependency changes require:

```text
typecheck
lint
tests
build
runtime verification
```

Electron must use an exact version because `electron-builder` needs a resolvable Electron runtime version.

Current required Electron version:

```text
44.4.5
```

Correct:

```json
"electron": "44.4.5"
```

Incorrect:

```json
"electron": "^44.4.5"
```

When installing Electron use:

```powershell
npm install -D electron@44.4.5 --save-exact
```

Do not change this pin unless explicitly upgrading Electron and validating native dependencies.

---

## 9. General TypeScript Rules

Use strict TypeScript.

Avoid `any`.

If `any` is unavoidable, document why.

Prefer:

```text
explicit domain types
DTOs
discriminated unions
enums or validated literal unions
shared contracts
```

Do not duplicate API contracts independently between backend and desktop if they belong in `packages/shared-types` or `packages/sync-protocol`.

Business logic belongs in services/domain modules, not controllers or React components.

---

## 10. Backend Architecture

NestJS controllers should remain thin.

Preferred flow:

```text
Controller
   ↓
Application/Domain Service
   ↓
Repository / DataSource
   ↓
PostgreSQL
```

Do not place complex business rules directly inside controllers.

Do not expose database credentials to clients.

Do not allow desktop applications to connect directly to PostgreSQL.

Desktop communicates with the cloud only through HTTPS REST API.

---

## 11. Master Database Boundary

The Master database contains platform-level data only.

Allowed examples:

```text
companies
platform_users
platform_roles
platform_permissions
platform_role_permissions
platform_user_roles
devices
licenses
provisioning state
migration state
```

The Master database must not contain tenant operational data such as:

```text
workers
worker payroll
patta
patta sheets
production rows
factory reports
```

Superadmin manages the SaaS platform but does not browse tenant operational production data.

---

## 12. Database-per-Tenant Rule

Each company has its own PostgreSQL database.

Tenant operational data from Company A must never be stored in or queried from Company B's database.

Tenant resolution must not trust a raw client-provided `tenant_id`.

Resolve and validate tenant identity using authenticated context such as:

```text
subdomain
JWT company_id
Master company record
company status
```

The resolved company and authenticated company must match.

Mismatch must fail authorization.

---

## 13. TypeORM Rules

Never enable:

```text
synchronize: true
```

Use:

```text
synchronize: false
```

All schema changes go through migrations.

Master migrations and tenant migrations remain separate.

Expected locations:

```text
database/master-migrations
database/tenant-migrations
```

Business-critical invariants should be protected by PostgreSQL constraints where practical, not only application code.

---

## 14. Provisioning

New tenant provisioning follows a state machine.

Conceptual flow:

```text
REQUESTED
   ↓
CREATING_DATABASE
   ↓
RUNNING_MIGRATIONS
   ↓
SEEDING_PERMISSIONS
   ↓
CREATING_DEFAULT_ADMIN
   ↓
ACTIVE
```

Failures must preserve useful state:

```text
FAILED
failure_step
failure_reason
```

Provisioning should be retryable and idempotent where possible.

Never construct raw SQL identifiers directly from untrusted company names.

---

## 15. Worker Identity Invariant

`workers.id` is the permanent historical worker identity.

It must:

```text
be automatically assigned
never be reused
remain stable for historical records
```

Payroll and production aggregation must use:

```sql
GROUP BY worker_id
```

Never use:

```sql
GROUP BY full_name
```

or:

```sql
GROUP BY badge_number
```

for worker identity.

Names are display data only.

---

## 16. Badge History Invariant

Physical badge numbers may be reused.

Worker identity and badge number are different concepts.

Use a history model equivalent to:

```text
badge_number
worker_id
valid_from
valid_to
```

When resolving a badge, use the operation timestamp.

Historical records must continue referencing the original `worker_id` even after the badge is assigned to another worker.

Prevent overlapping assignments for the same badge at the database level.

---

## 17. Historical Price Invariant

Current operation prices must not rewrite historical payroll.

When a Patta is created, preserve operation information required for historical calculation.

Historical production rows must use immutable price snapshots.

Changing:

```text
1 000 so'm → 1 200 so'm
```

today must not change payroll calculated for old production records.

Never recalculate historical payroll using only the current `model_operations.price`.

---

## 18. Patta Number Allocation

Never generate distributed Patta numbers using:

```sql
MAX(patta_number) + 1
```

Multiple PCs may generate Pattas while offline.

Server allocates non-overlapping number blocks atomically.

Example:

```text
PC-1 → 1000–1999
PC-2 → 2000–2999
PC-3 → 3000–3999
```

Desktop uses only its allocated blocks while offline.

At approximately 80% consumption, request a next block when online.

If current and reserved blocks are exhausted while offline, block only new Patta generation, not unrelated work.

---

## 19. Offline-First Rule

Each desktop workstation has its own SQLite database.

There is:

```text
NO LAN dependency
NO local factory server
```

Primary interaction:

```text
User
 ↓
SQLite local transaction
 ↓
sync_queue
 ↓
background synchronization
```

Operators must not wait for network latency during normal Patta data entry when the required data exists locally.

---

## 20. Sync Is Two-Way

Synchronization must support both:

```text
Desktop → Server
Server → Desktop
```

Push-only synchronization is incomplete.

PC-1-created data that reaches the server must eventually be pullable into PC-2's SQLite mirror.

---

## 21. Sync Idempotency

Every offline mutation must have a globally unique event identifier.

Concept:

```text
event_id UUID
```

The server must remember processed events.

Sending the same event repeatedly must not duplicate business writes.

Do not implement sync without idempotency.

---

## 22. Sync Conflict Rules

Do not use universal blind last-write-wins.

Use explicit conflict handling.

Examples:

```text
VERSION_CONFLICT
CONFLICT_BADGE_ASSIGNMENT
SHEET_FINALIZED
PAYROLL_PERIOD_CLOSED
PATTA_NUMBER_CONFLICT
```

Reference data should use optimistic concurrency where appropriate.

Conflicts must be visible and resolvable, not silently discarded.

---

## 23. Redis Rule

Redis is a cache and coordination tool.

Redis is never the authoritative business database.

Correct fallback:

```text
Redis miss
   ↓
PostgreSQL
   ↓
optional cache fill
```

The system must continue returning correct data if Redis is unavailable.

Tenant cache keys must be namespaced.

---

## 24. Electron Security

Keep Electron security settings strict.

Required baseline:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Renderer code must not receive unrestricted Node.js or `ipcRenderer` access.

Expose narrow typed APIs through preload.

`better-sqlite3` belongs in Electron main process or an appropriate worker, not directly in React renderer.

Sensitive tokens should use OS-backed secure storage where possible.

---

## 25. Licensing

Device licenses use Ed25519 signatures.

Private signing keys must never be committed to Git or bundled inside Electron.

Desktop contains only the public verification key.

Local license verification must work offline.

Online revalidation occurs periodically according to product policy.

License state must account for:

```text
device identity
valid_until
offline grace
revocation
trusted server time
clock rollback
```

Do not rely solely on the local Windows clock for license security.

---

## 26. UI Language

All normal end-user UI text is Uzbek Latin.

Do not mix Russian, Cyrillic and Uzbek in production screens.

Developer logs and technical identifiers may remain English.

Name formatting should be sentence case, for example:

```text
Abdullayeva Nodira
```

not:

```text
ABDULLAYEVA NODIRA
```

---

## 27. Spreadsheet UX

Patta-related screens are keyboard-first spreadsheet interfaces.

Important screens:

```text
Patta chiqarish
Patta hisob
Patta varag'i
reports
```

Support efficient Tab/Enter navigation.

Automatically populated fields should be read-only and visibly marked as automatic.

A column must have one meaning.

Never combine:

```text
Nuqson
O'chirish
```

into one action or column.

`Jami` should remain visible in calculation/report grids.

---

## 28. Validation

Never trust frontend validation alone.

Backend validates all input.

Database constraints protect critical invariants.

Examples:

```text
price >= 0
soni > 0
valid_to > valid_from
unique Patta key
unique sync event
FK integrity
non-overlapping badge assignment
non-overlapping price history
```

Return structured API errors instead of raw SQL errors.

---

## 29. Money

Do not use unsafe JavaScript floating-point arithmetic for payroll.

Prefer PostgreSQL `NUMERIC` and decimal-safe application calculations.

Historical monetary results must be reproducible.

---

## 30. Audit

Sensitive business changes require append-only audit records.

Examples:

```text
badge reassignment
operation price change
role/permission change
Patta reopen
payroll adjustment
payroll close
license action
```

Audit entries should capture appropriate:

```text
actor
device
entity
before
after
timestamp
request id
```

Do not silently hard-delete audit history.

---

## 31. Hard Delete Policy

Avoid hard deletion for historical business entities.

Prefer:

```text
INACTIVE
CANCELLED
REPLACED
deleted_at tombstone
```

depending on domain semantics.

Especially preserve historical references for:

```text
workers
badge history
Pattas
finalized sheets
payroll
licenses
audit logs
```

---

## 32. Secrets

Never commit:

```text
.env
database passwords
JWT secrets
Ed25519 private keys
device secrets
production credentials
```

Keep `.env.example` with placeholders.

Never print credentials into logs.

If a secret is accidentally committed, removing it in a later commit is insufficient; report that credential rotation is required.

---

## 33. Testing Expectations

For every meaningful module, add the appropriate combination of:

```text
unit tests
integration tests
database tests
E2E tests
```

Critical scenarios include:

```text
tenant isolation
duplicate sync event
two-PC offline Patta allocation
badge reassignment history
historical price preservation
license tampering
migration rollback
database constraints
```

Do not claim a task is complete without running relevant tests when execution is available.

---

## 34. Required Verification

Before declaring a substantial task complete, run the relevant available scripts.

Prefer:

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

If a script does not exist, inspect package scripts before inventing commands.

For a workspace-specific task, use the smallest applicable workspace command when practical.

Do not hide failing tests.

Distinguish:

```text
existing failure
new failure caused by this change
environment/tooling failure
```

---

## 35. Definition of Done

A module is complete only when applicable items are satisfied:

```text
database migration exists
domain/entity model exists
service logic exists
REST/API boundary exists
authorization exists
validation exists
audit exists where required
tests exist
UI works where required
offline behavior works where required
sync behavior works where required
errors are handled
TypeScript passes
lint passes
tests pass
build passes
documentation is updated
no intentional TODO placeholder remains for core behavior
```

Do not move to the next major module with the current module half-implemented.

---

## 36. Git Safety

Before Git operations inspect:

```powershell
git status
git branch --show-current
git remote -v
```

Never discard unrelated user changes.

Do not run destructive operations without explicit user approval.

Forbidden unless specifically approved:

```text
git reset --hard
git clean -fd
git push --force
git push --force-with-lease
```

Never force-push `main`.

---

## 37. Branch Workflow

Do not develop features directly on `main` unless explicitly instructed.

Feature branch examples:

```text
feature/master-db
feature/tenant-provisioning
feature/auth-rbac
feature/workers-badges
feature/patta
feature/offline-sync
feature/patta-sheet
feature/license
feature/payroll
```

When beginning a new feature:

```powershell
git checkout main
git pull origin main
git checkout -b feature/<name>
```

Only run `git pull` when an `origin` remote exists and credentials/network are available.

If the correct feature branch already exists, reuse it rather than creating duplicates.

---

## 38. Commit Rules

Create coherent commits, not giant unrelated commits.

Before committing:

```powershell
git status
git diff
```

Stage only intended work.

Commit message style:

```text
feat: add master database schema
feat: add tenant provisioning service
feat: add badge history constraints
feat: add offline sync pull protocol

fix: prevent duplicate sync events
fix: pin electron version for native rebuild

test: add tenant isolation integration tests
docs: update sync architecture
chore: update workspace tooling
```

Avoid vague messages such as:

```text
update
changes
stuff
fix
work
```

---

## 39. Push Rules

After a coherent feature checkpoint passes relevant validation:

```powershell
git add <intended-files>
git commit -m "<clear message>"
```

If a configured remote exists, the current branch is not `main`, authentication is available, and the user has not asked to avoid pushing:

First push:

```powershell
git push -u origin <current-feature-branch>
```

Later pushes:

```powershell
git push
```

Never push directly to `main` as part of normal feature development.

If push cannot be performed because authentication, permissions or network are unavailable, do not fake success. Report the exact command the user should run.

---

## 40. Pull Requests

Preferred integration path:

```text
feature branch
      ↓
push
      ↓
Pull Request
      ↓
CI
      ↓
review
      ↓
main
```

If GitHub CLI is installed and authenticated, PR operations may use `gh`.

Do not merge a PR merely because code was generated.

Validation must pass first.

---

## 41. Reporting After Work

After a substantial task, report concisely:

```text
Changed:
- major implementation changes

Validation:
- commands run
- pass/fail status

Git:
- current branch
- commit created, if any
- push result, if any

Remaining:
- actual unresolved issues only

Next:
- one logical next development step
```

Do not claim commands passed unless they were actually run.

---

## 42. Autonomy

For normal coding work:

* inspect the repository yourself;
* resolve straightforward implementation details yourself;
* do not repeatedly ask the user questions whose answers are already available in code or documentation;
* continue through obvious build/test fixes caused by your changes.

Ask the user before:

```text
destructive Git actions
irreversible data deletion
changing a core business invariant
changing database tenancy strategy
changing the package manager
changing major architecture without specification support
```

---

## 43. Current Architectural Priorities

When multiple improvements are possible, prioritize correctness in this order:

```text
tenant isolation
historical accounting correctness
sync idempotency
offline durability
database integrity
authorization
auditability
data-entry speed
UI polish
```

Do not trade historical correctness for implementation convenience.

---

## 44. Final Principle

This ERP must remain correct under this real factory scenario:

```text
multiple independent PCs
no LAN
no local server
unstable internet
offline production entry
later synchronization
badge reassignment over time
operation price changes over time
multiple companies on the same SaaS platform
```

Implementation is acceptable only if:

```text
tenant data stays isolated
offline entries survive
duplicate sync does not duplicate business data
Patta numbers do not collide
historical worker attribution does not change
historical prices do not change
payroll remains reproducible
Superadmin cannot casually browse tenant production data
```

Preserve these invariants throughout the repository.
