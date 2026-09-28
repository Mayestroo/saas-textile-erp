# Desktop auth session design

## Status

Approved for implementation on `feature/desktop-auth-session`.

This feature adds tenant authentication and session lifecycle to Electron main,
connects the existing authenticated sync transport to that session, and keeps
local SQLite data isolated by authenticated company identity. It does not add
Patta varag'i, device enrollment, license binding, payroll, reports, or a backend
logout endpoint.

## Existing contracts and constraints

- Tenant login is `POST /api/v1/auth/login`; tenant refresh is
  `POST /api/v1/auth/refresh`. The API selects a tenant from the request
  hostname, never a body/query `tenant_id`.
- Access and refresh tokens are separate tenant JWT types. Access is short
  lived. Refresh tokens rotate and server sessions store only a token hash.
- The API currently has no logout/revoke route. Wrong credentials and blocked
  users both return `INVALID_CREDENTIALS`; tenant missing/inactive currently
  share `TENANT_CONTEXT_MISMATCH`; rate limiting uses
  `TOO_MANY_LOGIN_ATTEMPTS`.
- Desktop already has `AuthenticatedSessionProvider`,
  `FetchAuthenticatedHttpClient`, `AuthenticatedSyncTransport`,
  `RestSyncTransport`, and a token-agnostic `SyncEngine`. The main process does
  not yet install a real provider/runtime.
- SQLite currently uses one `textile-erp.sqlite` file without tenant ownership.
  That legacy file must remain untouched and must never be guessed/bound to a
  company.
- Electron is exactly pinned at `44.4.5`. Electron's built-in `safeStorage` is
  available; on Windows its secure storage is backed by DPAPI. No separate
  keychain dependency or custom encryption is needed.
- `DeviceIdentity` currently exists only as a transport contract. Sync endpoints
  validate every submitted device ID with Master `DeviceAccessService` against
  the authenticated company and ACTIVE status.

## Architecture

```text
Renderer
  └─ window.erp.auth (fixed typed methods)
       └─ preload validation + fixed IPC channels
            └─ DesktopAuthService (Electron main)
                 ├─ SecureSessionStore (safeStorage + atomic file replacement)
                 ├─ TenantDatabaseManager (company-scoped SQLite)
                 ├─ DeviceIdentityService (pre-provisioned UUID config)
                 └─ AuthenticatedHttpClient
                      └─ AuthenticatedSyncTransport
                           └─ SyncEngine (never sees tokens)
```

Electron remains configured with `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: true`. Renderer access is limited to
approved auth, sync, app-version, and existing local lookup methods. No token,
password hash, SQLite handle, filesystem capability, or unrestricted
`ipcRenderer` is returned to renderer code.

## Tenant login and API origin

The login screen accepts a company/tenant host or base URL, email, and password.
The main process normalizes and validates the URL, requires HTTPS except
approved loopback development origins, and sends only `{ email, password }` to
`/api/v1/auth/login` on that tenant host. The client sends no company or tenant
ID. The host's first DNS label is the tenant slug according to the API's
hostname contract.

Login responses are parsed and validated before use: token types and bounded
token strings, user UUID/email/name, company UUID/slug, and host/slug agreement.
API response bodies are never passed through as user-facing text. Safe errors
are mapped to Uzbek Latin messages. Current combined backend errors remain
combined to preserve account/tenant privacy; known additive codes such as
`USER_BLOCKED`, `TENANT_NOT_FOUND`, and `TENANT_INACTIVE` may be mapped if the
server introduces them later. No API change is planned for this feature.

Passwords exist only for the login call, are never logged or persisted, and the
renderer clears its password field when the attempt completes.

## Secure session store and auth lifecycle

`SecureSessionStore` provides `load`, `save`, and `clear`. Its Electron
implementation:

1. Checks `safeStorage.isEncryptionAvailable()` before any operation.
2. Encrypts the entire versioned session payload; the file contains only a
   versioned envelope and encrypted bytes.
3. Writes a sibling temporary file, flushes and closes it, then atomically
   replaces the active session file. An incomplete temporary write cannot
   become the accepted session.
4. Rejects malformed, unsupported, or undecryptable envelopes. There is no
   plaintext fallback.

The payload stores refresh token plus safe metadata needed for restore:
tenant origin/host, company UUID/slug, user UUID, email, and display name. The
access token is memory-only. No password or device company identity is stored
in `device-config.json`.

`DesktopAuthService` owns typed states `SIGNED_OUT`, `AUTHENTICATING`,
`AUTHENTICATED`, `REFRESHING`, `OFFLINE_SESSION_PENDING`, and `ERROR` (or
equivalent discriminated states), plus `login`, `restoreSession`,
`refreshAccessToken`, `logout`, and safe `currentSession` operations.

At startup, a valid stored envelope is refreshed. Success activates the new
session. Definitive expired/revoked/reused credentials clear secure state and
sign out. Transient connectivity/server failures preserve the secure refresh
credential, set `OFFLINE_SESSION_PENDING`, and permit opening only the local DB
named by the envelope's previously validated company UUID. This state does not
claim fresh server authentication. Retry after connectivity returns must
refresh before authenticated sync can run.

On tenant switch, old access memory is cleared, the old sync engine/repositories
are disposed, and the old DB handle is closed. The new company-scoped DB is
opened only after a valid login response supplies the trusted server company
UUID. The new access token is made active only after the new secure refresh
payload is saved successfully. If saving fails, local auth state is cleared and
the user must log in again.

Logout always clears access-token memory, secure refresh/session metadata,
active sync context, and the current tenant DB handle, including when offline.
Because the API has no revoke endpoint, logout cannot revoke the server
session. The server refresh session may remain valid until expiry or another
server-side invalidation; desktop does not queue an unverifiable revoke retry.
This limitation must be explicit in user/developer documentation.

## Refresh and authenticated HTTP semantics

`FetchAuthenticatedHttpClient` obtains access tokens only from the main-process
session provider. For a 401, it requests refresh with the rejected token
generation. The auth service implements one in-flight refresh promise. A late
401 for an older token generation reuses the already-refreshed access token
instead of starting another rotation. A request is retried at most once.

The refresh response is validated. The new refresh token is persisted before
the new access token becomes active. If persistence fails after server-side
rotation, the client clears local session state and does not use the new access
token; it never falls back to the now potentially invalid old token.

Definitive refresh rejection clears the secure session and returns to signed
out. Transient network/5xx errors preserve refresh state and surface as offline,
not as false `AUTH_REQUIRED`. Authorization headers, raw tokens, password
values, and sensitive JWT payloads are excluded from structured logs. A
sanitization helper and focused tests protect structured logging paths.

## Tenant-owned SQLite

Tenant databases use a path of the form
`<userData>/tenants/tenant-<authenticated-company-uuid>.sqlite`. Only a strictly
validated company UUID from a trusted login response, or an already validated
company UUID in the encrypted session envelope during offline restore, may
determine this filename. Host, email, arbitrary IPC input, and device config
are never filename authority.

An additive SQLite migration adds application/database identity and
`company_id` ownership metadata. On open, the file's company UUID, stored
ownership UUID, and expected authenticated UUID must match. A mismatch or an
unowned DB containing business rows fails closed; no data is overwritten or
reassigned. The old shared `textile-erp.sqlite` is not opened as a tenant DB,
modified, migrated, or bound automatically. Tenant files are retained on logout
so offline work remains durable.

Only one tenant database handle and its repositories/runtime may be active in
one process. A tenant switch disposes the previous `SyncEngine`, drops its
repositories, closes its DB handle, then opens the new company DB after the
server identity is confirmed. Per-company files plus in-file ownership metadata
are separate, reinforcing checks.

## Device identity and sync

`DeviceIdentityService` reads only the pre-provisioned
`<userData>/device-config.json` shape:

```json
{ "version": 1, "device_id": "<registered Master device UUID>" }
```

It strictly validates the UUID and does not generate an ID, expose the file to
the renderer, or persist company/token/password values there. A missing,
unreadable, corrupt, or invalid config leaves login and tenant-local SQLite
available but blocks sync with a safe `DEVICE_NOT_CONFIGURED` state and Uzbek
message `Qurilma ro‘yxatdan o‘tkazilmagan`.

The validated ID flows from `DeviceIdentityService` through
`RestSyncTransport`; SyncEngine does not read config. It is not a JWT claim or
auth identity. Master `DeviceAccessService` continues to verify existence,
company ownership, and ACTIVE state for each sync/block API operation. A
registered device belonging to another company is rejected by the server and
mapped to a safe Uzbek status; a local database/company match cannot substitute
for device validation.

No enrollment writer, hardware fingerprint, license signing, or device/session
binding is added. The future License/Device Enrollment stage may replace the
file reader with the official enrollment contract.

## Preload and UI

Fixed IPC methods expose:

```text
window.erp.auth.login({ tenantUrl, email, password })
window.erp.auth.logout()
window.erp.auth.status()
window.erp.auth.session()
```

Runtime validation occurs at both bridge and main-process boundaries. Session
responses contain only safe user/company display metadata, tenant host, and
typed state; no credential or token fields. Renderer errors are a closed set
of safe Uzbek messages and never raw server JSON/stack traces.

The minimal production-capable screen uses Uzbek Latin labels for company
address, email, password, and login. Authenticated users see their safe company
identity, sync status, and logout. Offline session-pending state clearly reports
that internet is unavailable while local data remains available. Device
misconfiguration has a distinct visible status.

## Tests and acceptance

Desktop unit tests cover:

- valid/invalid login, mapped blocked-user and tenant errors, and rate limiting;
- refresh restore success, definitive expired/revoked credentials, and
  transient offline restore;
- token rotation and write-before-access activation;
- ten concurrent 401s produce one refresh; a delayed old-token 401 does not
  produce a second refresh;
- secure store save/load/clear, unavailable encryption, corrupt payload, atomic
  replacement failure, and absence of plaintext fallback;
- local logout clearing tokens/session/runtime/DB handle;
- fixed IPC methods, malformed inputs, and renderer-visible safe metadata only;
- two company UUID SQLite files, ownership mismatch rejection, DB A closure on
  B switch, and no access to A local rows from B;
- valid/missing/invalid/unreadable device config and no generated UUID;
- configured device plus another-company device rejection by the API;
- existing SyncEngine signed-out `AUTH_REQUIRED` behavior and authenticated
  transport push/pull behavior.

An environment-gated desktop/API acceptance test uses real tenant login and a
pre-provisioned ACTIVE device to run authenticated bootstrap/push/pull. Existing
two-PC sync acceptance remains intact and uses independent tenant SQLite files.
API auth/provisioning/sync contracts are regressed; no API source modification
is expected.

Required desktop verification:

```powershell
npm run lint --workspace=apps/desktop
npm run typecheck --workspace=apps/desktop
npm run test --workspace=apps/desktop
npm run build --workspace=apps/desktop
```

Also perform an Electron runtime smoke test, retain Electron `44.4.5`, run
available auth/provisioning/offline-sync/two-PC/SQLite regressions, and finish
with `git status`, `git diff`, and `git diff --check`. Commit only intended
feature files on `feature/desktop-auth-session`; push that feature branch when
the remote/authentication permits.
