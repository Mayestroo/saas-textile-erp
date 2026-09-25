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
