# RBAC security domains

Platform and tenant permissions are separate database authorities. A platform
permission exists only in Master `platform_permissions` and is assigned through
`platform_roles`, `platform_role_permissions`, and `platform_user_roles`. A
tenant permission exists only in that company's `permissions`, `roles`,
`role_permissions`, and `users` tables. Neither guard queries the other
security domain.

## Platform permissions

The seeded platform catalog is:

- `companies.view`
- `companies.create`
- `companies.suspend`
- `companies.migrate`
- `licenses.view`
- `licenses.create`
- `licenses.revoke`
- `platform_users.manage`

Use `@PlatformPermissions('companies.create')` together with
`PlatformAuthGuard` and `PlatformPermissionGuard`. A route that enables the
permission guard without permission metadata is denied. Permission decisions
are read from Master on each request.

`POST /api/v1/platform/companies` requires `scope=platform` and
`companies.create`. It is not anonymous and invokes the existing
`CompaniesService.createAndProvision()` only after the permission check.

## Tenant permissions

Tenant permissions are seeded in `tenant-permission.seed.ts` for each isolated
database. They include the models, workers/badges, Patta, Patta varag'i, users,
roles, reports, payroll, license-view, and audit-view codes. Platform codes are
not part of this catalog.

Use `@TenantPermissions('workers.view')` with `TenantAuthGuard` and
`TenantPermissionGuard`. The guard uses the `DataSource` attached after verified
hostname/company resolution and reads only the current tenant's role and
permission tables.

`TenantRbacService.grantRolePermissions()` checks requested codes against the
canonical tenant seed allowlist and the current tenant's persisted permission
catalog before inserting assignments. Consequently, adding a row named
`companies.create` to a tenant `permissions` table does not let a tenant admin
grant it. The provisioned `Korxona administratori` is a protected system role
and receives only the tenant catalog.

## Token scope

- Platform access/refresh tokens use separate platform secrets, issuer,
  audience, and platform sessions. Platform claims have `scope=platform` and no
  `company_id`.
- Tenant access/refresh tokens use separate tenant secrets, issuer, audience,
  and per-company tenant sessions. Tenant claims have `scope=tenant` and the
  verified `company_id`.
- Both guards verify signature algorithm, issuer, audience, expiration, scope,
  token type, user state, session state, and session ID. A token from one domain
  is rejected by the other.
