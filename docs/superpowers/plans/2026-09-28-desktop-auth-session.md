# Desktop Authentication Session Implementation Plan

> **For agentic workers:** Use inline execution task-by-task. Each task has a focused test cycle and interface notes; keep all work on `feature/desktop-auth-session`.

**Goal:** Add a secure tenant login/session lifecycle to Electron main and connect it to the existing two-way SyncEngine without exposing credentials or sharing SQLite data across companies.

**Architecture:** Electron main owns `DesktopAuthService`, Electron `safeStorage`, a company-scoped SQLite runtime, and `AuthenticatedHttpClient`. A pre-provisioned `DeviceIdentityService` feeds the existing authenticated transport; the renderer gets only validated fixed IPC methods and safe session metadata.

**Tech Stack:** Electron `44.4.5`, TypeScript, React, `safeStorage`, `better-sqlite3`, existing fetch transport, Vitest, Zod (already installed).

## Global Constraints

- Keep the active branch `feature/desktop-auth-session`.
- Keep Electron pinned exactly at `44.4.5`; add no secure-storage dependency and write no custom encryption.
- Check `safeStorage.isEncryptionAvailable()`; never persist a refresh token in plaintext.
- Keep access token in Electron main-process memory only; never persist or expose either token to renderer or SyncEngine.
- Resolve tenant identity from the existing API hostname contract; never send `tenant_id` in login/refresh.
- Derive `tenant-<company_uuid>.sqlite` only from the server-authenticated company UUID or the validated encrypted session envelope during offline restore.
- Do not open, migrate, overwrite, or auto-bind legacy `textile-erp.sqlite`.
- Keep one active tenant DB/runtime; DB `company_id` ownership must match the authenticated company UUID.
- Read only `{version: 1, device_id}` from `userData/device-config.json`; never generate a device UUID or persist company/session/password data there.
- Preserve `AuthenticatedSyncTransport` and SyncEngine's token-agnostic contract; signed-out sync stays `AUTH_REQUIRED`.
- Renderer text is Uzbek Latin; IPC exposes only fixed typed methods and safe metadata.
- Do not change production API auth/tenant/sync behavior or add backend auth/logout endpoints. Test-only changes to the existing API sync integration harness are permitted to supply real desktop login fixtures. Do not implement device enrollment, license, Patta varag'i, payroll, or reports.

---

## File Map

Create focused modules under the existing `apps/desktop/src/main` and `src/preload` roots:

- `main/auth/secure-session-store.ts`: persisted session contract and versioned payload type.
- `main/auth/electron-secure-session-store.ts`: Electron safeStorage encryption and atomic filesystem replacement.
- `main/auth/tenant-auth-api-client.ts`: URL validation, login/refresh fetch, response parsing, and safe API error mapping.
- `main/auth/desktop-auth.service.ts`: auth states, login/restore/refresh/logout, token memory, rotation single-flight.
- `main/auth/desktop-tenant-runtime.ts`: tenant DB activation, transport/SyncEngine composition, device-not-configured status, teardown.
- `main/device/device-identity.service.ts`: pre-provisioned UUID file reader; no generator or renderer API.
- `main/logging/sanitize-structured-fields.ts`: structured log field redaction for secret-bearing keys.
- `main/database/migrations/002-tenant-ownership.ts`: additive tenant DB ownership/application identity schema.
- `main/database/tenant-database-manager.ts`: safe company-UUID filenames, owner validation, one active handle.
- `main/auth/electron-secure-session-store.spec.ts`, `tenant-auth-api-client.spec.ts`, `desktop-auth.service.spec.ts`, and `desktop-tenant-runtime.spec.ts`: auth/session/runtime tests.
- `main/device/device-identity.service.spec.ts`, `main/logging/sanitize-structured-fields.spec.ts`, and `main/database/tenant-database-manager.spec.ts`: device, logging, and ownership tests.
- Modify existing `main/sync/authenticated-http-client.ts` and its spec for rejected-token generation and transient refresh failures.
- Modify `main/index.ts`, `main/ipc/register-ipc-handlers.ts`, `main/ipc/main-ipc.spec.ts`, `preload/erp-api.ts`, `preload/index.d.ts`, and `renderer/src/App.tsx`/CSS for production wiring and UI.
- Add a gated real-API desktop auth/sync acceptance test under `main/auth` and update `docs/architecture.md`, `docs/database.md`, `docs/sync-protocol.md`, and `docs/testing.md`.

## Interfaces Shared Between Tasks

Use these stable shapes:

```ts
export interface SecureSessionPayload {
  version: 1
  refreshToken: string
  tenantOrigin: string
  tenantHost: string
  companyId: string
  companySlug: string
  userId: string
  email: string
  fullName: string
}

export interface SecureSessionStore {
  load(): Promise<SecureSessionPayload | null>
  save(session: SecureSessionPayload): Promise<void>
  clear(): Promise<void>
}

export type DesktopAuthState =
  | 'SIGNED_OUT'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'REFRESHING'
  | 'OFFLINE_SESSION_PENDING'
  | 'ERROR'

export interface SafeDesktopSession {
  state: DesktopAuthState
  user: { id: string; email: string; full_name: string } | null
  company: { id: string; slug: string } | null
  tenant_host: string | null
}

export interface DeviceIdentity {
  deviceId(): string
}

export type DeviceIdentityStatus =
  | { state: 'CONFIGURED'; deviceId: string }
  | { state: 'DEVICE_NOT_CONFIGURED' }
```

The existing `AuthenticatedSessionProvider` remains main-process-only and gains the rejected access token as an optional argument to `refreshAfterUnauthorized(rejectedToken?: string)`. Runtime switching is explicit: `openTenant(companyId)`, `startSync(tenantOrigin)`, and `clearTenant()`; `clearTenant()` disposes the engine before closing SQLite. A definitive refresh rejection returns `false`; a transient network/5xx failure throws so SyncEngine classifies it as offline.

---

### Task 1: Secure OS-backed session storage

**Files:**
- Create `apps/desktop/src/main/auth/secure-session-store.ts`.
- Create `apps/desktop/src/main/auth/electron-secure-session-store.ts`.
- Create `apps/desktop/src/main/auth/electron-secure-session-store.spec.ts`.

**Produces:** `SecureSessionStore` and a store implementation injected with Electron `safeStorage`, session-file path, and a small filesystem port. Disk envelope is `{ version: 1, encrypted_payload: <base64> }`; plaintext session JSON exists only in process memory.

- [ ] Write tests for save/load/clear, encrypted-only file contents, unsupported/corrupt envelope rejection, encryption-unavailable failure, and atomic replace failure.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/auth/electron-secure-session-store.spec.ts`; confirm new behaviors fail before implementation.
- [ ] Implement safeStorage availability checks and save with sibling temp file → file sync → close → atomic rename/replace. Remove an incomplete temp file on error and leave the old destination intact where replace did not occur.
- [ ] Verify tests pass and confirm neither the refresh token nor email/password values occur in raw file bytes.

### Task 2: Device identity and structured-log sanitization

**Files:**
- Create `apps/desktop/src/main/device/device-identity.service.ts`.
- Create `apps/desktop/src/main/device/device-identity.service.spec.ts`.
- Create `apps/desktop/src/main/logging/sanitize-structured-fields.ts`.
- Create `apps/desktop/src/main/logging/sanitize-structured-fields.spec.ts`.

**Produces:** `DeviceIdentityService.load()` returning a typed configured/unconfigured result and `requireDeviceId()` throwing `LocalDomainError('DEVICE_NOT_CONFIGURED', ...)`. The service reads only `userData/device-config.json`, accepts only version `1` and a UUID `device_id`, and never generates an ID. The sanitizer redacts nested case-insensitive keys for authorization, access/refresh token, password, and secret fields without mutating its input.

- [ ] Test a valid UUID; missing file; malformed JSON; wrong version; missing/invalid UUID; and unreadable file. Assert no random UUID is returned in failures.
- [ ] Test nested `{ headers: { Authorization }, refresh_token, password }` input is redacted while safe status/company fields remain.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/device/device-identity.service.spec.ts src/main/logging/sanitize-structured-fields.spec.ts` and verify it fails before implementation.
- [ ] Implement the strict file reader and sanitizer; rerun the focused test command and verify all tests pass.

### Task 3: Tenant-owned SQLite files

**Files:**
- Create `apps/desktop/src/main/database/migrations/002-tenant-ownership.ts`.
- Create `apps/desktop/src/main/database/tenant-database-manager.ts`.
- Create `apps/desktop/src/main/database/tenant-database-manager.spec.ts`.
- Modify `apps/desktop/src/main/database/sqlite-database.ts` and `sqlite-database.spec.ts` to register migration version `2` without changing existing generic test-database semantics.

**Produces:** `TenantDatabaseManager.activate(companyId)` opens only `<userData>/tenants/tenant-<lowercase-uuid>.sqlite`, verifies the singleton `tenant_database_identity` row (`application_id`, `company_id`), and exposes only the active DB. `closeActive()` closes it and clears the active company/database. A never-owned empty DB may be claimed on first activation; an unowned DB with business rows or an identity mismatch is rejected and closed.

- [ ] Test migration v2 creates ownership identity storage while migration v1 business schemas and rows remain intact.
- [ ] Test A and B create different paths and separate local Patta data; activating B closes A; returning to A reads only A's file.
- [ ] Test a filename/company UUID mismatch, an internal owner mismatch, invalid company UUID, and unowned populated DB all fail closed without row changes.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/database/sqlite-database.spec.ts src/main/database/tenant-database-manager.spec.ts`; new manager/ownership tests must fail before implementation and all SQLite tests must pass after it.
- [ ] Confirm production startup no longer opens the legacy `textile-erp.sqlite` as a tenant database.

### Task 4: Tenant auth API client and safe errors

**Files:**
- Create `apps/desktop/src/main/auth/tenant-auth-api-client.ts`.
- Create `apps/desktop/src/main/auth/auth-error-mapper.ts`.
- Create `apps/desktop/src/main/auth/tenant-auth-api-client.spec.ts`.

**Produces:** `TenantAuthApiClient.login(tenantOrigin, { email, password })` and `.refresh(tenantOrigin, refreshToken)`, plus `normalizeTenantOrigin(input)`. Login sends only `{email,password}`; refresh sends only `{refresh_token}`. Fetch uses no credentials, no-store, and redirect error. Responses strictly validate bearer type, token lengths, `expires_in`, user/company IDs and safe strings, and company slug against the hostname slug. Non-HTTPS origins are rejected except approved loopback development URLs.

- [ ] Test tenant hostname and full URL normalization, credential/path/query rejection, HTTPS enforcement, login body without tenant/company IDs, and refresh body shape.
- [ ] Test response rejection for malformed tokens, invalid UUIDs, unexpected token type, and host/company slug mismatch.
- [ ] Test safe Uzbek mappings for `INVALID_CREDENTIALS`, `USER_BLOCKED`, `TENANT_CONTEXT_MISMATCH`, `TENANT_NOT_FOUND`, `TENANT_INACTIVE`, `TOO_MANY_LOGIN_ATTEMPTS`, `RATE_LIMITED`, `INVALID_REFRESH_TOKEN`, `SESSION_REVOKED`, `AUTH_REQUIRED`, and network failures. Current API combined codes map to combined messages.
- [ ] Run `npm run test --workspace=apps/desktop -- src/main/auth/tenant-auth-api-client.spec.ts`; verify new cases fail before implementation, then pass after it. No API production source is changed.

### Task 5: Desktop auth lifecycle and refresh rotation

**Files:**
- Create `apps/desktop/src/main/auth/desktop-auth.service.ts`.
- Create `apps/desktop/src/main/auth/desktop-auth.service.spec.ts`.
- Create any small shared auth types in `apps/desktop/src/main/auth/auth-types.ts`.

**Produces:** `DesktopAuthService` implementing the main-process session-provider boundary, safe `status()`/`currentSession()`, and `login`, `restoreSession`, `refreshAccessToken`, and `logout`. Its runtime port is:

```ts
interface TenantSessionRuntime {
  openTenant(companyId: string): Promise<void>
  startSync(tenantOrigin: string): Promise<void>
  clearTenant(): Promise<void>
}
```

- [ ] Add tests: valid login stores refresh and safe metadata before active access is observable; invalid credentials and rate limit map safely; blocked/current combined errors stay non-enumerating; tenant resolution failure maps safely.
- [ ] Add restore tests: successful refresh returns `AUTHENTICATED`; invalid/expired/revoked refresh clears store and returns `SIGNED_OUT`; transient fetch/503 preserves store, opens only the stored company DB, and returns `OFFLINE_SESSION_PENDING`.
- [ ] Add rotation test where `SecureSessionStore.save(newPayload)` rejects after server rotation; assert no new access token is exposed, store clear is attempted, runtime closes, and state requires login.
- [ ] Add tenant-switch/logout tests: A runtime closes and old token clears before B activation; local logout clears token/store/runtime when offline; server revoke is not attempted.
- [ ] Implement a single in-flight `refreshAccessToken()` promise. When a rejected token differs from current memory token, return success without a new refresh request. Preserve secure session and throw on TypeError/network/408/502/503/504; clear store and return false only for definitive invalid/revoked refresh responses.
- [ ] Make `accessToken()` retry a pending stored refresh before returning null; transient failures must propagate so sync reports OFFLINE rather than AUTH_REQUIRED.
- [ ] Run the focused auth service tests; verify all branches pass and no test or logging path receives raw password/token fields.

### Task 6: Authenticated HTTP refresh generation and transient failures

**Files:**
- Modify `apps/desktop/src/main/sync/authenticated-http-client.ts`.
- Modify `apps/desktop/src/main/sync/authenticated-http-client.spec.ts`.

**Consumes:** `AuthenticatedSessionProvider` from Task 5. **Produces:** Each request captures the exact access-token generation used; on 401 it supplies that token to `refreshAfterUnauthorized(token)`, retries once with current memory token, and propagates transient refresh/network failures as transient errors rather than synthetic 401s.

- [ ] Extend tests with ten gated concurrent requests returning 401 and one gated refresh; assert exactly one refresh and ten retries with the new bearer token.
- [ ] Add a delayed old-token 401 after refresh completion; assert provider sees the rejected generation and no second refresh occurs.
- [ ] Add a transient refresh failure case; assert the transient error survives for SyncEngine offline classification.
- [ ] Retain tests for 401 when signed out, URL-origin rejection before token access, and retry-at-most-once; run `npm run test --workspace=apps/desktop -- src/main/sync/authenticated-http-client.spec.ts` and verify all tests pass.

### Task 7: Production tenant runtime composition

**Files:**
- Create `apps/desktop/src/main/auth/desktop-tenant-runtime.ts`.
- Modify `apps/desktop/src/main/index.ts`.
- Modify `apps/desktop/src/main/ipc/register-ipc-handlers.ts` and IPC tests for dynamic active runtime/status.
- Modify `apps/desktop/src/main/sync/network-status.service.ts` and `apps/desktop/src/preload/erp-api.ts` to represent `DEVICE_NOT_CONFIGURED` as a distinct desktop connectivity/run status without changing the SyncEngine transport contract.

**Produces:** A main-process runtime that opens company DB only after trusted login response or validated secure-store restore metadata; constructs repositories, `RestSyncTransport`, `FetchAuthenticatedHttpClient`, and `createDesktopSyncRuntime`; installs SyncEngine only after refresh/authentication; and tears down registry → repositories → DB on switch/logout. Missing device config leaves the authenticated local tenant runtime available but returns `DEVICE_NOT_CONFIGURED` from sync status/run. A configured but wrong-company device reaches the API and preserves the server's `DeviceAccessService` rejection.

- [ ] Test signed-out startup has no tenant DB/runtime and reports `AUTH_REQUIRED`.
- [ ] Test offline-pending restore can open its own tenant DB but cannot create an authenticated sync request or claim authenticated connectivity.
- [ ] Test missing device config permits login/DB activation but blocks sync with a safe distinct state and creates no UUID.
- [ ] Test A-to-B activation disposes A engine/repositories and closes A DB before B DB opens; ensure active transport origin follows B only.
- [ ] Test a valid local device UUID owned by another company reaches the API, returns `DEVICE_TENANT_MISMATCH`, and is mapped to a safe Uzbek status without treating login or SQLite ownership as failed.
- [ ] When restore returns `OFFLINE_SESSION_PENDING`, schedule bounded background restore retries; stop retrying on authenticated/signed-out state. `sync.run()` also attempts restore first when the pending session has no access token.
- [ ] Run focused runtime, IPC, SQLite, and SyncEngine tests; implement production wiring with one active tenant runtime.

### Task 8: Narrow preload API and runtime IPC validation

**Files:**
- Modify `apps/desktop/src/preload/erp-api.ts` and `index.d.ts`.
- Modify `apps/desktop/src/main/ipc/register-ipc-handlers.ts` and `main-ipc.spec.ts`.
- Modify `apps/desktop/src/preload/index.ts` to expose only the added fixed `auth` methods through `contextBridge`.

**Produces:** `window.erp.auth.login({tenantUrl,email,password})`, `logout()`, `status()`, and `session()` on exact fixed channels. Validate host/email/password structure at preload and main boundaries. `session()` contains only state, user/company safe fields, and tenant host. It must not contain token fields, DB paths/handles, device ID, or arbitrary IPC methods.

- [ ] Update bridge tests to assert approved channels only and safe metadata fields only; assert no `ipcRenderer`, `database`, `filesystem`, `accessToken`, or `refreshToken` bridge property.
- [ ] Test malformed login objects, extra `company_id`/`tenant_id`, invalid email, oversized password, and invalid URL reject before API calls.
- [ ] Test logout/status/session IPC delegates to main auth service and serializes only safe output.
- [ ] Run focused IPC tests and desktop renderer/node typechecks; preserve existing app/sync/Patta method behavior.

### Task 9: Uzbek login and session UI

**Files:**
- Modify `apps/desktop/src/renderer/src/App.tsx`.
- Modify `apps/desktop/src/renderer/src/assets/main.css` and `base.css` only for required login/session styles.

**Produces:** A minimal login view with `Korxona manzili`, `Email`, `Parol`, and `Kirish`; authenticated view shows safe company/user metadata, sync status, and logout. Show Uzbek safe errors, `Internet bilan aloqa yo‘q`, `Sessiya muddati tugagan`, and `Qurilma ro‘yxatdan o‘tkazilmagan` for their states. Password React state/input is cleared immediately after completion and on logout.

- [ ] Implement controlled login fields with `type="password"`, submit disable/loading state, status live region, and safe status text only.
- [ ] Keep existing local sync/local-work affordances usable when auth state is offline-pending; do not show local data in signed-out or another-company state.
- [ ] Verify all user-facing copy is Uzbek Latin and inspect `npm run typecheck --workspace=apps/desktop` and `npm run lint --workspace=apps/desktop`.

### Task 10: Real auth/sync acceptance, documentation, and full verification

**Files:**
- Create `apps/desktop/src/main/auth/desktop-auth-sync.integration.spec.ts` using the existing desktop test runner and real tenant API.
- Modify only the test fixture/child environment in `apps/api/src/tenant/sync/sync.integration.spec.ts` so its ephemeral API integration provisions login passwords/devices and launches the desktop auth test; do not change API controller/service/guard/DTO behavior.
- Modify `docs/architecture.md`, `docs/database.md`, `docs/sync-protocol.md`, and `docs/testing.md`.
- Keep `apps/desktop/src/main/sync/two-client-sync.integration.spec.ts` as the existing test-only `SYNC_TEST_*` acceptance and verify it still passes with separate SQLite files; the auth acceptance uses the production login/provider stack.

- [ ] Add an environment-gated test that logs in using tenant host/email/password, opens the response's company DB, installs the real authenticated HTTP/transport/SyncEngine, and verifies authenticated bootstrap/pull plus a valid push using a pre-provisioned ACTIVE device. Never print auth environment values or tokens.
- [ ] Add a real two-tenant SQLite acceptance test proving A data cannot be read through B session/runtime; the two companies use distinct server-issued UUID identities.
- [ ] Update docs to describe safeStorage/Windows DPAPI, atomic rotation, pending offline session, local-only logout limitation/no remote revoke retry, company-owned DB files and legacy DB handling, device config contract, and current gated test requirements.
- [ ] Run `npm run lint --workspace=apps/desktop`, `npm run typecheck --workspace=apps/desktop`, `npm run test --workspace=apps/desktop`, and `npm run build --workspace=apps/desktop`.
- [ ] Run API auth/RBAC, tenant provisioning, API sync, desktop SQLite, and existing two-PC acceptance commands available in package scripts; identify DB-gated tests accurately if test credentials are absent.
- [ ] Launch Electron `44.4.5` in dev or packaged smoke mode and verify login, offline restore presentation, logout, and no renderer token access.
- [ ] Finish with `git status`, `git diff`, `git diff --check`; stage only intended feature files, commit the completed feature as `feat: add desktop authentication session`, and push with `git push -u origin feature/desktop-auth-session` if credentials/network permit.

## Plan Self-review

- Spec coverage is mapped across Tasks 1–10: secure storage/rotation (1, 5, 6), device identity/log redaction (2, 7), tenant ownership/switching (3, 7, 10), API contracts/errors (4), session lifecycle (5), sync boundary (6–7, 10), IPC (8), Uzbek UI/password lifetime (9), docs/regression/smoke (10).
- No API contract edits, new dependency, Electron upgrade, plaintext token fallback, device UUID generation, or legacy SQLite auto-binding is in scope.
- Shared interface names and types are defined above and reused by their task descriptions.
