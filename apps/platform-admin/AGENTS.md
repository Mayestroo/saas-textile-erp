# Platform Admin — Codex Instructions

These instructions apply to `apps/platform-admin/**`.

Also follow all repository-level rules from the root `AGENTS.md`.

## Scope

This React application is the SaaS platform administration panel.

It is for platform-level administrators.

Primary capabilities:

* list companies
* create companies
* inspect provisioning status
* suspend/reactivate companies where authorized
* inspect database migration status
* view registered devices
* issue/view/revoke licenses
* manage platform users and roles
* inspect platform-level health/status

This application is not the tenant factory operations UI.

---

## Strict Boundary

Platform Admin must not provide normal UI for:

```text
Patta
Patta varag'i
workers
worker payroll
factory production
factory reports
tenant operational data
```

Superadmin manages the platform, not factory production operations.

Do not add cross-tenant production browsing for convenience.

---

## Data Access

Platform Admin communicates only through the backend API.

Never connect directly to:

```text
PostgreSQL
Redis
tenant databases
```

Never embed database credentials in frontend code.

---

## Authentication

Platform authentication is separate from tenant user authentication.

Do not reuse tenant roles as platform roles.

Platform permissions include concepts such as:

```text
companies.view
companies.create
companies.suspend
companies.migrate

licenses.view
licenses.create
licenses.revoke

platform_users.manage
```

Do not expose tenant permission catalog items such as:

```text
patta.*
workers.*
payroll.*
```

as platform permissions.

---

## Authorization

Frontend permission checks control visibility and UX only.

They are not security boundaries.

Backend must still enforce all permissions.

Do not assume hidden buttons make an operation secure.

---

## Main Areas

Expected pages may include:

```text
Login
Dashboard
Companies
Company details
Provisioning
Migrations
Devices
Licenses
Platform users
Platform roles
```

Keep navigation focused on platform management.

---

## Company List

Useful company information may include:

```text
name
slug
status
schema version
provisioning status
last migration
device count
license state
created date
```

Do not fetch tenant production information just to enrich the company list.

---

## Provisioning UI

Provisioning state should be understandable.

Conceptual states:

```text
REQUESTED
CREATING_DATABASE
RUNNING_MIGRATIONS
SEEDING_PERMISSIONS
CREATING_DEFAULT_ADMIN
ACTIVE
FAILED
```

When failed, show safe useful information such as:

```text
failure step
failure reason
retry availability
```

Do not expose secrets, connection strings or passwords.

---

## License UI

Platform Admin may support:

```text
license issue
license status
validity dates
device association
revocation
device replacement/rebind workflow
```

Never show Ed25519 private key material.

Never send private signing keys to the browser.

---

## Device UI

Display safe metadata only.

Examples:

```text
device name
installation id
status
first seen
last seen
license state
```

Avoid displaying raw sensitive hardware fingerprints if a masked/hash representation is sufficient.

---

## Language

All normal end-user UI should use Uzbek Latin unless the product specification explicitly adds another language later.

Do not mix Russian or Cyrillic into production screens.

Technical identifiers and developer logs may remain English.

---

## React Architecture

Keep components focused.

Prefer:

```text
pages
features
components
api
hooks
types
```

Do not put large API/business workflows directly in presentation components.

Use shared API client utilities.

Use React Query or the established data-fetching layer consistently.

---

## Server State

Treat backend data as server state.

Use the project's established query/cache library for:

```text
loading
cache
refetch
mutation
error state
```

Do not create duplicate ad-hoc fetch logic across many components.

---

## Forms

Use validated form data.

Client validation improves UX but never replaces backend validation.

Surface backend structured error codes in understandable Uzbek messages.

Do not show raw backend stack traces.

---

## Status UI

Use consistent semantics.

Examples:

```text
ACTIVE        → positive
FAILED        → error
SUSPENDED     → warning/error
REVOKED       → error
PROVISIONING  → in progress
```

Do not rely on color alone; include text/status labels.

---

## Destructive Actions

Actions such as:

```text
company suspension
license revocation
device replacement
```

should require deliberate confirmation.

Do not make destructive actions one-click accidental operations.

Do not add bulk destructive actions unless explicitly required.

---

## Secrets

Never place these in frontend source or Vite environment variables exposed to the browser:

```text
database passwords
JWT signing secrets
Ed25519 private key
Redis password
tenant DB credentials
```

Public API base URLs are acceptable.

Private server secrets are not.

---

## API Contracts

Prefer shared types/contracts where appropriate.

Do not independently redefine backend enums if shared packages already provide them.

Keep platform-specific types distinct from tenant business types.

---

## Error Handling

Handle:

```text
401
403
404
409
422
500
network errors
```

explicitly where useful.

A failed provisioning request is not the same as a network failure.

Do not silently swallow API errors.

---

## Loading States

Platform actions such as tenant creation may be long-running.

Represent server state honestly.

Do not fake completion while backend provisioning is still running.

Poll or refresh status only through an approved mechanism.

Avoid aggressive unnecessary polling.

---

## Testing

Important Platform Admin tests include:

```text
permission-gated controls
company creation form validation
provisioning status rendering
license revocation confirmation
API error rendering
no tenant-production navigation
```

---

## Verification

Before considering Platform Admin work complete, run relevant scripts.

Typical:

```powershell
npm run typecheck --workspace=apps/platform-admin
npm run lint --workspace=apps/platform-admin
npm run build --workspace=apps/platform-admin
```

If script names differ, inspect `apps/platform-admin/package.json`.

When behavior changes substantially, also run the app in development mode.

---

## Do Not

Do not:

```text
connect to databases from the browser
expose secrets
add tenant production browsing
reuse tenant RBAC as platform RBAC
trust frontend authorization
show raw SQL/backend stack traces
silently hide failed provisioning
```

The Platform Admin application's job is platform management and observability, not tenant production operations.
