# Desktop Auth and Permission Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop a trusted company display name and a cached, narrow list of effective tenant permission codes for permission-aware navigation/actions.

**Architecture:** Add a tenant-authenticated, read-only permissions endpoint and pass Master’s company name through login/refresh. Electron main retrieves and stores permission codes in the versioned encrypted session; renderer only receives a safe projection and uses it for visibility. Server guards continue to authorize every mutation.

**Tech Stack:** NestJS, TypeORM query against tenant RBAC, Master tenant resolver, Electron `safeStorage`, typed preload, Vitest.

## Global Constraints

- Work only on `feature/desktop-ui-ux`.
- Do not put permissions in access-token claims or expose credentials/tokens to renderer.
- If cached permission data is absent, hide permission-gated mutations; read-only offline views may remain visible.
- API permission guards, not renderer visibility, are authoritative.
- Keep secure session compatibility for payload versions 1 and 2; add version 3 without plaintext fallback.
- Do not add general HTTP IPC; use fixed `auth.permissions()` and `auth.session()` methods.

## File map

- API: `apps/api/src/tenant/auth/tenant-auth.controller.ts`, `tenant-auth.service.ts`, `tenant-auth.module.ts`, `tenant-resolver.service.ts`, `master-tenant-lookup.service.ts`, plus focused service/controller specs.
- Desktop auth transport/session: `apps/desktop/src/main/auth/tenant-auth-api-client.ts`, `desktop-auth.service.ts`, `secure-session-store.ts`, `electron-secure-session-store.ts` and their specs.
- Desktop boundary: `apps/desktop/src/preload/erp-api.ts`, `src/preload/index.d.ts`, `src/main/ipc/register-ipc-handlers.ts` and `main-ipc.spec.ts`.

### Task 1: Tenant permissions endpoint and effective projection

**Files:**
- Create: `apps/api/src/tenant/auth/tenant-permissions-projection.service.ts`
- Create: `apps/api/src/tenant/auth/tenant-permissions-projection.service.spec.ts`
- Modify: `tenant-auth.controller.ts`, `tenant-auth.module.ts`.

**Interface:**

```ts
export interface TenantPermissionsProjection {
  permission_codes: readonly string[]
}

listForUser(dataSource: DataSource, userId: string): Promise<TenantPermissionsProjection>
```

- [ ] Add a failing test that the result contains only codes assigned to the authenticated tenant user’s active role and is sorted/deduplicated.

```ts
it('returns sorted effective permission codes for the authenticated user', async () => {
  const result = await service.listForUser(dataSource, activeUserId)
  expect(result).toEqual({ permission_codes: ['models.manage', 'patta.hisob.view'] })
})
```

- [ ] Add authenticated `GET /api/v1/auth/permissions`. Read user ID and tenant DataSource from `TenantAuthenticatedRequest`/`requireTenantContext`; accept no user/company ID from request input.
- [ ] Implement the projection query using `users -> roles -> role_permissions -> permissions`; return only `{ permission_codes }`, not role structure or assignments.
- [ ] Test empty permission set, inactive user rejection, cross-tenant context rejection, and platform-token rejection through the existing guards.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/auth/tenant-permissions-projection.service.spec.ts src/tenant/auth/tenant-auth.service.spec.ts`.

### Task 2: Company name in login and refresh responses

**Files:**
- Modify: `apps/api/src/tenant/tenant-resolver/tenant-resolver.service.ts`, `master-tenant-lookup.service.ts`, `tenant-auth.service.ts` and resolver/auth specs.

- [ ] Add failing tests asserting the Master company `name` is returned while existing UUID, slug, and timezone are unchanged.
- [ ] Extend `MasterTenantMetadata` and both Master lookup queries to select the company’s existing `name` field.
- [ ] Add `name` to `ResolvedTenantContext`; propagate it through `resolve()` and `resolveForLogin()` without changing slug/host equality checks.
- [ ] Return `company.name` in both tenant login and refresh JSON responses; no tenant operational data is added to Master lookups.
- [ ] Run `npm run test --workspace=apps/api -- src/tenant/tenant-resolver/tenant-resolver.service.spec.ts src/tenant/auth/tenant-auth.service.spec.ts`.

### Task 3: Secure desktop session version 3

**Files:**
- Modify: `apps/desktop/src/main/auth/secure-session-store.ts`, `electron-secure-session-store.ts`, `desktop-auth.service.ts`, `tenant-auth-api-client.ts`, and matching specs.

**Interfaces:**

```ts
export interface SecureSessionPayload {
  version: 3
  companyName: string
  permissionCodes: readonly string[]
  // Existing encrypted session fields remain.
}

export interface TenantAuthApi {
  permissions(tenantOrigin: string, accessToken: string): Promise<readonly string[]>
}
```

- [ ] Add tests that v1/v2 payloads remain loadable, normalize with `companyName = companySlug` and `permissionCodes = []`, and grant no permission-gated write UI.
- [ ] Add parser tests for valid/invalid company names and permission code arrays.
- [ ] Add a fixed authenticated GET for `/api/v1/auth/permissions` in `TenantAuthApiClient`; only main process calls it.
- [ ] On online login/refresh, cache company name and latest permission codes in secure version-3 session. On transient permission refresh failure, retain prior cached codes; if none exist, use an empty array and keep authentication valid.
- [ ] Extend `SafeDesktopSession` with company `name` and `permission_codes`; never add access/refresh tokens to the safe projection.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/auth/electron-secure-session-store.spec.ts src/main/auth/desktop-auth.service.spec.ts src/main/auth/tenant-auth-api-client.spec.ts`.

### Task 4: Typed renderer projection and verification

**Files:**
- Modify: `apps/desktop/src/preload/erp-api.ts`, `src/preload/index.d.ts`, `src/main/ipc/register-ipc-handlers.ts`, and `src/main/ipc/main-ipc.spec.ts`.

- [ ] Add strict parsing for `company.name` and `permission_codes: string[]` in `DesktopSafeSession`.
- [ ] Keep `window.erp.auth.session()` as the safe read boundary; do not expose generic HTTP, database, or IPC methods.
- [ ] Test malformed projections reject, permissionless sessions fail closed for writes, and logout clears cached permissions/company profile with the encrypted session.
- [ ] Run `npm run typecheck --workspace=apps/desktop`, `npm run lint --workspace=apps/desktop`, and the focused desktop auth tests.
- [ ] Commit as `feat: expose desktop tenant permission projection`.
