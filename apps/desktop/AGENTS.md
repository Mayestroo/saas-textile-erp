# Desktop — Codex Instructions

These instructions apply to `apps/desktop/**`.

Also follow all repository-level rules from the root `AGENTS.md`.

## Scope

This is the Electron desktop application installed on factory workstations.

Primary responsibilities:

* fast operator UI
* local SQLite storage
* offline-first workflows
* Patta entry
* local badge lookup
* local Patta lookup
* sync queue
* push/pull synchronization
* license verification
* device identity
* secure local credentials
* tenant admin screens where appropriate

Each PC works independently.

There is:

```text
NO LAN dependency
NO local factory server
```

---

## Process Separation

Keep Electron layers separated.

Required conceptual architecture:

```text
React Renderer
      │
      ▼
Typed Preload API
      │
      ▼
Electron Main
      │
      ├── SQLite
      ├── Sync
      ├── License
      ├── Secure Storage
      └── Network
```

React renderer must not directly access Node.js, SQLite, filesystem, or unrestricted IPC.

---

## Electron Security

Required baseline:

```ts
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Do not weaken these options to make development easier.

Do not expose full `ipcRenderer` to the renderer.

Expose narrow typed methods through preload.

Example concept:

```ts
window.erp.patta.find(...)
window.erp.sync.status()
window.erp.license.getStatus()
```

not unrestricted IPC access.

---

## Electron Version

Electron must remain pinned exactly unless explicitly upgraded.

Required:

```json
"electron": "44.4.5"
```

Not:

```json
"electron": "^44.4.5"
```

`electron-builder` requires an exact version for native dependency rebuilds.

Do not run an uncontrolled dependency upgrade that changes Electron to a range.

---

## better-sqlite3

`better-sqlite3` is a native dependency.

Keep it out of React renderer.

Use it in:

```text
Electron main process
```

or a deliberately designed worker.

After Electron/native dependency changes, ensure native modules are rebuilt for the actual Electron runtime.

Do not work around ABI errors by disabling native rebuild logic.

---

## SQLite Role

SQLite is an operational local database, not merely a cache.

It must preserve offline work.

Expected local concepts include:

```text
workers
worker_badge_history
models
model_operations
patta_templates
patta_hisob
patta_operation_snapshots
patta_sheets
patta_sheet_rows
patta_number_blocks
sync_queue
sync_state
sync_conflicts
```

Use migrations for SQLite schema changes.

Do not silently delete or recreate the user database to resolve migration issues.

---

## Offline-First Rule

User actions should write locally first when the workflow supports offline operation.

Concept:

```text
User action
    ↓
SQLite transaction
    ↓
sync_queue event
    ↓
background synchronization
```

Do not require the network for normal data entry if all required reference data is already local.

---

## Local Transactions

Business mutation + sync queue insertion should usually occur atomically.

For example:

```text
create Patta sheet row
+
enqueue sync event
```

should not leave one without the other due to a crash.

Use a SQLite transaction.

---

## Sync Queue

Every outbound mutation must have a stable:

```text
event_id UUID
```

The same event must retain the same ID across retries.

Never generate a new event ID just because a retry occurs.

Queue states may include:

```text
PENDING
SYNCING
SYNCED
CONFLICT
FAILED
```

Network failure is not equivalent to permanent failure.

---

## Push/Pull Order

Preferred background sync cycle:

```text
1. Push pending events
2. Process server results
3. Store conflicts
4. Pull server changes
5. Apply pull batch in SQLite transaction
6. Save new cursor
7. Repeat if more data exists
```

Do not advance the pull cursor before the SQLite batch has committed successfully.

---

## Retry

Use bounded exponential backoff for transient network failures.

Normal operator work must continue while sync is retrying.

Do not block the entire UI because the server is temporarily unreachable.

---

## Conflicts

Never silently overwrite conflicts.

Persist them to local conflict storage.

Show human-readable Uzbek UI.

Examples:

```text
Jeton ma'lumoti o'zgargan
Patta boshqa qurilmada yangilangan
Varaq yakunlangan
Hisob davri yopilgan
```

Do not expose raw JSON as the normal user experience.

---

## Badge Lookup

Patta data entry must resolve badges locally first.

Concept:

```text
badge_number
+
performed_at
    ↓
local worker_badge_history
    ↓
worker_id
    ↓
display full_name
```

`full_name` is display-only.

The saved business identity is `worker_id`.

If no valid badge assignment exists:

```text
Topilmadi
```

must be shown and the row must not be saved as valid.

---

## Patta Lookup

Lookup order:

```text
1. SQLite
2. API if not found and online
3. save returned data locally
4. use local copy
```

Do not make every Patta lookup depend on server latency.

---

## Patta Number Blocks

Offline Patta creation may only consume server-assigned blocks.

Never implement local:

```text
MAX(patta_number) + 1
```

across independent PCs.

Maintain current and optionally reserved next blocks.

At approximately 80% use, request another block while online.

When all allocated numbers are exhausted while offline:

* disable new Patta generation
* show a clear Uzbek warning
* allow unrelated existing-data work to continue

---

## UI Language

All normal operator-facing UI is Uzbek Latin.

Avoid mixed Russian/Cyrillic labels.

Developer logs may remain English.

---

## Spreadsheet UX

Patta screens must be optimized for factory data entry.

Support:

```text
Tab
Enter
keyboard navigation
fast focus movement
```

Do not make mouse use mandatory for repetitive entry.

Read-only automatic fields should be visibly different from editable fields.

---

## Column Semantics

One column = one meaning.

Never combine:

```text
Nuqson
O'chirish
```

into a single control.

They are separate actions and separate columns.

---

## Automatic Fields

Fields populated from existing Patta/reference data should be read-only.

Examples:

```text
Konveyer
Model
Razmer
Rang
Partiya №
Patta №
Ishchi name
```

Mark automatic fields clearly in UI.

---

## Display Rules

Empty cell:

```text
—
```

Error:

```text
qizil
```

Positive result:

```text
yashil
```

Defect/penalty/shortage:

```text
qizil
```

Keep color semantics consistent across the desktop app.

---

## Money and Units

Display units explicitly.

Correct:

```text
140 kun
50 000 so'm
```

Avoid:

```text
140
50000
```

Do not calculate payroll with unsafe floating-point arithmetic.

Use decimal-safe calculations.

---

## Name Formatting

Display:

```text
Abdullayeva Nodira
```

Avoid forced uppercase:

```text
ABDULLAYEVA NODIRA
```

---

## Jami

Calculation/report grids should keep the `Jami` column visible where practical.

Sticky right-column behavior is acceptable.

---

## Licensing

License verification happens locally.

Desktop receives:

* signed license
* public verification key

Desktop must never contain the private Ed25519 signing key.

Verify:

```text
signature
device identity
validity period
offline grace
trusted time state
revocation status after online check
```

Do not rely exclusively on Windows system time.

---

## Secure Storage

Do not store sensitive refresh/device secrets as normal plaintext SQLite rows if secure OS-backed storage is available.

Business cache and sensitive credential storage are different concerns.

---

## Network State

Desktop should expose clear state:

```text
Onlayn
Oflayn
```

Also expose useful pending sync state, e.g.:

```text
Sinxronlanmagan: 14 ta
```

Do not pretend everything is synchronized when queue/conflicts remain.

---

## Renderer State

React state is not the authoritative persistence layer.

Do not treat in-memory state as durable business storage.

Important offline mutations must reach SQLite before being considered saved.

---

## Shared Contracts

Reuse contracts from:

```text
packages/shared-types
packages/sync-protocol
packages/validation
```

when appropriate.

Avoid maintaining incompatible duplicate API payload types in desktop code.

---

## Testing

Critical desktop tests include:

```text
SQLite migration
local transaction rollback
queue event persistence
duplicate retry retains event_id
pull cursor commits only after data
offline badge lookup
offline Patta lookup
Patta number exhaustion behavior
license tamper rejection
```

For integration testing, simulate network loss and recovery.

---

## Verification

Before considering desktop work complete, run relevant scripts.

Typical:

```powershell
npm run typecheck --workspace=apps/desktop
npm run lint --workspace=apps/desktop
npm run build --workspace=apps/desktop
```

Also run desktop in development mode when runtime behavior changed:

```powershell
npm run dev --workspace=apps/desktop
```

If script names differ, inspect the workspace `package.json`.

Do not claim Electron runtime success unless the app was actually launched or the relevant runtime test ran.

---

## Do Not

Do not:

```text
enable nodeIntegration
disable contextIsolation
connect directly to PostgreSQL
write sensitive secrets into source
delete SQLite to hide migration problems
regenerate sync event IDs on retry
silently ignore sync conflicts
use current operation prices for old work
use badge_number as permanent worker identity
```

Preserve offline durability and historical correctness above convenience.
