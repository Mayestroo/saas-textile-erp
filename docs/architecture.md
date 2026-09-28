# Authentication and authorization boundaries

The API has two independent security domains:

```text
Platform user → Master platform_users → platform sessions/RBAC → platform routes
Tenant user   → hostname → Master company lookup → isolated tenant DB → tenant sessions/RBAC
```

Platform authentication is available at `POST /api/v1/platform/auth/login`; tenant
authentication is available at `POST /api/v1/auth/login`. Tenant login resolves
the hostname slug to an ACTIVE Master company before opening its tenant
connection. Protected tenant requests resolve the hostname again and require it
to match the verified JWT `company_id`. Request bodies and query strings are
never tenant selectors.

Platform and tenant access/refresh tokens have independent signing secrets,
issuer, audience, scope, and session storage. Platform tokens have no
`company_id`. Every protected route uses a domain-specific authentication guard;
permission guards query only that domain's RBAC tables.

Company creation is a protected platform operation at
`POST /api/v1/platform/companies` and requires the platform `companies.create`
permission. It delegates to the existing synchronous, isolated
`CompaniesService.createAndProvision()` flow.

Login rate limits are owned by PostgreSQL. Platform and tenant databases have
separate hashed bucket tables with atomic fixed-window increments and indexed
expiry cleanup. Redis is not in the login decision path; loss or recovery of
Redis cannot reset, split, or override the PostgreSQL window. If the applicable
PostgreSQL database is unavailable, login fails closed with HTTP 503.

## Desktop tenant session

Electron keeps tenant login, refresh, access-token memory, secure refresh-token
storage, and authenticated HTTP inside the main process. Renderer access is
limited to fixed `window.erp.auth` login/logout/status/safe-session methods.
Login sends only email and password to the entered tenant hostname; the server
resolves the company from the hostname and returns the authoritative company
UUID. No desktop request selects a tenant with a body/query `tenant_id`.

Electron `safeStorage` encrypts a versioned session envelope at rest (Windows
uses DPAPI); there is no plaintext fallback. Access tokens are process-memory
only. Refresh rotation writes the new encrypted refresh token atomically before
activating its access token. When startup refresh is transiently unavailable,
the state is `OFFLINE_SESSION_PENDING`: the company DB may open from the
previously encrypted company UUID, but the desktop does not claim that the
server has just authenticated the session.

Tenant mirrors are isolated in
`userData/tenants/tenant-<authenticated-company-uuid>.sqlite`. The DB's internal
company/application identity must match its UUID-derived filename and the
authenticated session. The previous shared `textile-erp.sqlite` is left
untouched and is never guessed/bound to a tenant. A pre-provisioned
`userData/device-config.json` supplies only the registered Master `device_id`;
sync still asks `DeviceAccessService` to validate that device against the
authenticated company on every protected operation. Device identity is not a
JWT claim and is not company ownership.

The current tenant auth API has no logout/revoke route. Desktop logout clears
memory, encrypted local session state, runtime services, and the open DB even
when offline. It cannot revoke the server refresh session, which may remain
valid until expiry or server-side invalidation; the desktop does not queue a
remote revoke retry.
