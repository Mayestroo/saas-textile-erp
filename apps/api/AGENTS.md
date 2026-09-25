# API — Codex Instructions

These instructions apply to `apps/api/**`.

Also follow all repository-level rules from the root `AGENTS.md`.

## Scope

This application is the NestJS backend for the Textile ERP SaaS.

Primary responsibilities:

* Master database access
* tenant resolution
* database-per-tenant connection management
* tenant business APIs
* authentication
* RBAC
* synchronization APIs
* licensing
* audit
* reporting APIs

The backend is the authoritative cloud application layer.

---

## Architecture

Prefer this flow:

```text
Controller
    ↓
Application / Domain Service
    ↓
Repository / DataSource
    ↓
PostgreSQL / Redis
```

Controllers must remain thin.

Do not put substantial business logic inside:

```text
controllers
guards
DTOs
interceptors
```

Business rules belong in dedicated services.

---

## Module Boundaries

Keep platform-level and tenant-level code separate.

Preferred structure:

```text
src/
├── master/
│   ├── companies/
│   ├── platform-auth/
│   ├── platform-users/
│   ├── platform-rbac/
│   ├── devices/
│   ├── licenses/
│   └── provisioning/
│
├── tenant/
│   ├── tenant-resolver/
│   ├── tenant-connection/
│   ├── auth/
│   ├── rbac/
│   ├── users/
│   ├── workers/
│   ├── badges/
│   ├── models/
│   ├── operations/
│   ├── patta/
│   ├── patta-sheets/
│   ├── sync/
│   ├── payroll/
│   ├── reports/
│   └── audit/
│
├── common/
└── infrastructure/
```

Do not move tenant business entities into `master/`.

Do not place platform Superadmin authorization into tenant RBAC tables.

---

## Master Database

Master database contains only platform-level data.

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
migration status
provisioning status
```

Never add these tenant business concepts to Master DB:

```text
workers
badges
patta
patta_sheet_rows
payroll
factory reports
```

---

## Tenant Database

Each company owns a separate PostgreSQL database.

Never query tenant data before tenant identity has been resolved and authorized.

Do not trust a client-provided tenant ID.

Tenant resolution should validate at least:

```text
request hostname/subdomain
authenticated company_id
Master company record
company status
```

Mismatch must fail.

---

## TenantConnectionManager

Do not open a new PostgreSQL connection for every HTTP request.

Use reusable TypeORM `DataSource` instances/pools.

Concept:

```text
company_id
    ↓
TenantConnectionManager
    ↓
cached DataSource
```

Connection lifecycle must support:

* creation
* reuse
* failure handling
* idle cleanup
* graceful shutdown

Never expose tenant DB connection credentials to clients.

---

## TypeORM

Required:

```ts
synchronize: false
```

Never enable automatic schema synchronization.

All database changes must use migrations.

Keep Master and Tenant migrations separate.

Do not create ad-hoc schema changes at runtime except controlled tenant database provisioning.

---

## Transactions

Use transactions for multi-write business operations.

Mandatory examples:

* tenant provisioning
* Patta number block allocation
* Patta batch generation
* badge reassignment
* operation price changes
* sheet finalization
* payroll close
* sync event application

Avoid partial business writes.

---

## Worker Identity

`workers.id` is the permanent identity.

All production/payroll aggregation uses `worker_id`.

Never aggregate by:

```text
full_name
badge_number
```

Badge resolution must use:

```text
badge_number
+
operation timestamp
```

to determine the valid worker assignment.

---

## Price History

Never calculate old payroll from the current operation price.

Historical rows must preserve immutable price snapshots.

Any implementation that allows a later operation-price edit to change old payroll is incorrect.

---

## Sync API

Sync is two-way.

Required conceptual endpoints:

```text
POST /api/v1/sync/push
GET  /api/v1/sync/pull
```

Push rules:

* every event has `event_id`
* duplicate events are idempotent
* server validates current permissions
* server validates business constraints
* conflict responses are explicit

Pull rules:

* use a monotonic server cursor/change sequence
* order changes deterministically
* support pagination/batching
* never lose delete/tombstone events

Do not implement universal last-write-wins.

---

## Sync Idempotency

Processed events must be stored.

Concept:

```text
processed_sync_events.event_id UNIQUE
```

Repeated delivery of the same event must not repeat the business mutation.

Idempotency is mandatory.

---

## Redis

Redis is optional infrastructure for:

* cache
* short locks
* rate limiting
* permission cache

Redis is not the system of record.

If Redis fails, the correct answer must still be obtainable from PostgreSQL.

Use tenant-specific key namespaces.

---

## Authentication

Use secure password hashing such as Argon2id.

Never store plaintext passwords.

Access tokens should be short-lived.

Refresh token handling should support rotation.

Do not trust frontend authorization.

Every protected backend operation must enforce permissions server-side.

---

## RBAC

Platform permissions and tenant permissions are separate domains.

Tenant admin must never be able to grant platform permissions.

Authorization must be enforced in the backend even if the UI hides controls.

---

## Validation

Validate all DTOs.

Prefer strict validation.

Reject unknown/invalid values where appropriate.

Examples of invariants:

```text
price >= 0
soni > 0
valid_to > valid_from
Patta key unique
sync event unique
badge interval non-overlapping
price history non-overlapping
```

Important invariants should also exist as database constraints.

---

## API Errors

Use a consistent structured error format.

Example:

```json
{
  "code": "BADGE_NOT_FOUND",
  "message": "Jeton topilmadi",
  "request_id": "...",
  "details": {}
}
```

Never return raw SQL errors or secrets to clients.

---

## Audit

Audit sensitive mutations.

At minimum consider:

```text
worker changes
badge reassignment
price change
role/permission changes
Patta reopen
payroll adjustment
payroll close
license action
```

Audit logs should be append-only from normal application flows.

---

## Logging

Use structured logging.

Include useful context where available:

```text
request_id
company_id
user_id
device_id
route
status
duration
```

Never log:

```text
passwords
JWT secrets
private keys
database passwords
full connection strings
```

---

## Database Tests

For DB-sensitive features, test constraints and transactions, not only service mocks.

Critical backend tests include:

```text
tenant isolation
company slug uniqueness
badge interval overlap
price history overlap
duplicate sync event
Patta uniqueness
rollback behavior
permission enforcement
```

---

## Verification

Before considering API work complete, run the relevant available commands.

Typical:

```powershell
npm run lint --workspace=apps/api
npm run test --workspace=apps/api
npm run build --workspace=apps/api
```

If scripts differ, inspect `apps/api/package.json` first.

Do not claim success without actually running available validation.

---

## Current Development Discipline

Do not implement future modules prematurely.

If current repository work is on:

```text
Master DB
```

finish Master DB first.

If current repository work is on:

```text
Tenant provisioning
```

do not jump directly to Patta or Payroll.

Preserve the project delivery order defined in root `AGENTS.md`.
