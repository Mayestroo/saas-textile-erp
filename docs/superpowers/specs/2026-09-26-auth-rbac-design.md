# Authentication and RBAC Foundation Design

## Goal

Implement the platform and tenant authentication boundary, refresh sessions,
database-backed RBAC, protected company provisioning, and login brute-force
protection. Preserve the completed Master database and tenant provisioning
behavior, and do not implement later business modules or Electron authentication.

## Security domains

Platform and tenant identity remain separate throughout routing, persistence,
tokens, guards, and permissions. Platform authentication reads only Master
`platform_users`; tenant authentication reads only the resolved company's
`users` table. Platform sessions and role/permission checks use Master data.
Tenant sessions and role/permission checks use only the authenticated company's
database. No generic scope-switching guard or cross-domain permission lookup is
introduced.

Platform login is `POST /api/v1/platform/auth/login`; tenant login is
`POST /api/v1/auth/login`. Tenant login extracts a hostname slug, resolves an
ACTIVE company in Master, and only then obtains that company's tenant connection.
The request body never selects the tenant. Protected tenant requests additionally
require the verified JWT company ID to match the hostname-resolved Master company.

## Tokens and sessions

Use the already-installed `jose` and `argon2` packages. Platform and tenant
access/refresh JWTs have separate environment secrets, issuer/audience values,
and required scope claims. Access tokens are short-lived. Claims include the
user subject and session ID; tenant claims also include company ID, while
platform claims never include company ID.

Add separate additive Master and tenant migrations for session storage. Store
only a cryptographic hash of each refresh token, with a unique constraint and
foreign key to the user in that security domain. Refresh rotates the hash
atomically. A previously used, correctly signed refresh token for an active
session is treated as reuse and revokes that session. Revoked, expired, wrong
scope, wrong issuer/audience, and invalid-signature tokens are rejected.

## RBAC and company provisioning

Separate platform and tenant permission decorators/guards query their own
database on each authorization decision. Tenant role assignment accepts only
permission codes present in that tenant's `permissions` table; platform
permissions are absent from this table and cannot be granted through tenant
services. Provisioning continues to seed `Korxona administratori`, tenant
permissions, and its Argon2id default administrator.

Add `POST /api/v1/platform/companies`, protected by platform authentication and
`companies.create`. The controller validates the request and delegates to the
existing `CompaniesService.createAndProvision()`; provisioning remains
synchronous and isolated per tenant.

## Login rate limiting

PostgreSQL is the sole authoritative rate-limit store. Platform and tenant
databases each receive their own additive migration and bucket table. Store
hashed IP/account bucket keys rather than raw passwords or account identifiers.
The window counter uses a single atomic PostgreSQL upsert that either increments
the current window or starts a new one; concurrent requests cannot lose
increments. Window length and attempt limits are environment-configurable.

Redis is only an optional short-lived deny/cache accelerator. It never owns a
counter and cannot override the PostgreSQL decision. Therefore Redis failure or
recovery does not reset or fork the active window. If the relevant PostgreSQL
database is unavailable, login fails closed with a structured `503` response.
Expired buckets are indexed by expiry and removed in bounded batches during
login-limit checks, so cleanup does not depend on a separate scheduler.

## Errors, password policy, and offline extension point

Centralize password policy and login validation. Unknown email, wrong password,
and blocked account use the same `INVALID_CREDENTIALS` response. Passwords never
enter persistence, logs, audits, or responses. API errors use the structured
`code`, Uzbek `message`, `request_id`, and `details` envelope.

Define only a server-side offline-capability claims contract for future use;
do not issue offline tokens or implement desktop behavior in this stage.

## Validation

Unit and API tests cover valid/invalid/blocked logins, JWT domain isolation,
refresh rotation/reuse/revocation/expiry, permission allow/deny, hostname and
company isolation, tenant platform-permission rejection, and Redis unavailable
behavior. Provisioning integration verifies a company is created through the
protected platform endpoint and its default tenant admin can authenticate.

Dedicated PostgreSQL integration tests apply each additive migration, revert it,
and apply it again. They verify session foreign keys/unique constraints, the
rate-limit atomic upsert under concurrent requests, and the tenant provisioning
plus login flow. Tests use only the configured `_test` database and generated
test tenants.

## Scope boundaries

Do not implement models, operations, workers, badges, Patta, offline sync,
Patta varag'i, licensing workflows, payroll, reports, or Electron auth UI.
Existing committed migrations are immutable; all schema changes are additive.
