# Offline synchronization protocol

This document describes the two-way, database-per-tenant sync foundation. The
API is authoritative for server writes; each Electron workstation persists its
own durable mirror/queue in SQLite. Desktop never connects directly to
PostgreSQL. There is no LAN or local factory server dependency.

## Shared contracts and representations

Wire DTOs live in `packages/sync-protocol` and are consumed by both `apps/api`
and `apps/desktop`. The package contains `SyncEvent`, push/pull requests and
results, `SyncChange`, versioned `SyncProjection`, conflicts/failures, bootstrap
session/page DTOs, and block projection records. Desktop additionally validates
all HTTP responses against strict projection schemas before SQLite sees them.

The first outbound mutation is `entity_type: "patta"`, `operation: "CREATE"`,
and `base_version: "0"`. Its payload carries canonical `partiya_number`,
server-assigned `block_id`, immutable model/template and operation version
context, and client-generated UUID operation snapshots with exact decimal
`unit_price_snapshot` values. The resulting server mirror entity is
`patta_hisob`; its snapshot rows are `patta_operation_snapshots`. Other
`SyncEntityType` values are server-authoritative reference projections, not
offline mutation permissions.

Representation rules:

- `event_id`, Patta IDs, operation-snapshot IDs and UUID references are generated
  once and retained over every retry.
- PostgreSQL BIGINT worker IDs, Patta numbers, versions and change cursors are
  canonical decimal strings. NUMERIC prices are decimal strings; JavaScript
  floating-point arithmetic is not used for money or block ranges.
- Timestamps are ISO-8601 UTC with microsecond precision in server projections.
  `client_created_at`, business-effective `occurred_at`, and server
  `created_at`/receipt time are distinct. Client timestamps are not security
  time; the API rejects client time more than 300 seconds in the future.
- Event mutation operations are `CREATE`/`UPDATE`/`DELETE`; pull change
  operations are `UPSERT`/`DELETE`. Projection version is explicit and currently
  `1`.

The protocol error codes include `VERSION_CONFLICT`, `PATTA_ALREADY_EXISTS`,
`PATTA_NUMBER_OUTSIDE_BLOCK`, `PATTA_BLOCK_DEVICE_MISMATCH`,
`PATTA_SNAPSHOT_MISMATCH`, `REFERENCE_DATA_STALE`, `DEVICE_NOT_ACTIVE`,
`PAYLOAD_INVALID`, `SYNC_BOOTSTRAP_EXPIRED`, and `EVENT_ID_REUSE_MISMATCH`.
The shared error-code type remains extensible. APIs return structured errors;
desktop maps normal operator-facing status to Uzbek Latin and does not show raw
SQL or queue JSON.

## API routes and authorization

All endpoints require tenant JWT authentication, resolve tenant database from
the tenant host and authenticated company, and validate the requested device
through Master `DeviceAccessService`. A client-supplied device ID is not a
tenant selector. Push is constrained to tenant permissions `sync.push` and
`patta.chiqarish.create`; pull/bootstrap use `sync.pull`.

| Method and route | Purpose |
| --- | --- |
| `POST /api/v1/sync/push` | Apply a bounded per-event push batch. |
| `GET /api/v1/sync/pull?device_id=...&cursor=...&limit=...` | Read ordered changes after a decimal cursor. |
| `POST /api/v1/sync/bootstrap` | Create a device-bound full baseline session. |
| `GET /api/v1/sync/bootstrap/:sessionId?device_id=...&after=...&limit=...` | Read one stable keyset page. |
| `POST /api/v1/sync/bootstrap/:sessionId/complete` | Mark server staging complete after local commit. |
| `POST /api/v1/patta-number-blocks/allocate` | Allocate the next server-owned block to a validated device. |
| `POST /api/v1/patta-number-blocks/:id/usage` | Monotonically report workstation block usage. |

No raw tenant ID or company ID is accepted as authority. Device IDs are resolved
in Master and must belong to the authenticated company and remain ACTIVE. The
Master database does not receive workers, Patta, production or payroll data.

### Push, idempotency and errors

Every local mutation has one stable UUID `event_id`. The API computes a
SHA-256/RFC-8785 canonical fingerprint including the Master-validated device ID
and stores it in the tenant's `processed_sync_events` table. Each event is
processed in its own tenant transaction with an uncommitted reservation and a
savepoint around domain work:

1. Reserve event UUID and request fingerprint.
2. On duplicate, compare device/fingerprint and return the saved terminal result
   without rerunning the handler. Same UUID/different data returns
   `EVENT_ID_REUSE_MISMATCH`.
3. Apply the supported `patta/CREATE` handler and its change-log records.
4. Store `SYNCED`, `CONFLICT`, or `FAILED` result and commit.

Business conflicts roll back to the event savepoint but preserve an immutable
terminal conflict result. Unexpected database/infra failures roll back the
reservation; retry uses the same event ID. One invalid event does not roll back
valid siblings. A successful Patta response includes the authoritative parent
projection, entity version and change sequence. Operation snapshots are emitted
as their own ordered pull changes.

The server never substitutes the current operation price for a historical
offline snapshot. It checks model/template/operation versions, reference cursor,
block membership, canonical business key and each effective-time historical
price. If reference history cannot prove a snapshot is current, the API returns
`REFERENCE_DATA_STALE` or `PATTA_SNAPSHOT_MISMATCH`; this initial policy is
deliberately conservative and can require manual conflict handling.

### Pull cursor

The API returns `sequence_id > cursor ORDER BY sequence_id ASC` with a bounded
limit (default 500). `next_cursor` is the last returned sequence, or the input
cursor for an empty page; `has_more` indicates another page. Sequence IDs are
decimal strings and are strictly monotonic for committed sync-visible writes.
BIGSERIAL gaps from rolled-back transactions are expected and do not represent
lost rows. The API currently does not prune `server_change_log`; old cursors
remain pullable.

## Race-safe bootstrap

`POST /api/v1/sync/bootstrap` obtains a repeatable-read snapshot and watermark,
then materializes exactly nine explicit reference projection types:

1. `workers`
2. `worker_badge_history`
3. `models`
4. `model_operations`
5. `model_operation_prices`
6. `patta_templates`
7. `patta_hisob`
8. `patta_operation_snapshots`
9. `patta_number_blocks`

Bootstrap does not include user/password/auth-session/audit/platform records.
Pages use stable ascending session-local decimal `order_key` values and bounded
keyset pagination (default 250). Active server sessions expire after 30 minutes;
one active session per device is enforced. Starting a replacement expires that
device's old session. Cleanup is bounded and removes only terminal/expired
staging after its retention period.

Ordering is essential: reference writers and bootstrap watermark acquisition
share one PostgreSQL advisory lock. The bootstrap locks the device session,
acquires the global change lock, establishes its REPEATABLE READ snapshot, reads
the maximum committed sequence, and releases the global lock immediately. It
materializes from that same MVCC snapshot while ordinary writes continue. A
mutation represented in the baseline is not lost; a mutation outside its
snapshot receives a sequence above the watermark and is returned by pull.
Tests hold projection materialization on a barrier and prove a writer can commit
after the watermark.

Client stages each page durably in SQLite. Partial pages never update live
mirrors or `last_server_cursor`. After the final page, one SQLite transaction
reconciles all nine mirrors, writes tombstones for absent server-owned rows,
preserves local `LOCAL_PENDING`/`CONFLICT`/`FAILED` Pattas and snapshots, sets
`last_server_cursor=watermark`, and records local completion. A failed
reconciliation leaves the mirror and cursor unchanged. Only after that local
commit does the client call the server completion route; server completion
failure cannot roll back local business data. An expired session discards only
its staging and restarts the baseline.

## Offline desktop behavior

Electron main owns SQLite, local repositories, transport and SyncEngine. The
renderer sees only fixed `window.erp` APIs (`app.getVersion`, sync status/run,
and a sanitized local Patta lookup). It receives no `ipcRenderer`, Node/process
object, bearer/refresh token or database handle. Electron stays exactly pinned at
`44.4.5`; `contextIsolation`, `sandbox`, and disabled `nodeIntegration` are
explicit.

The single-flight cycle recovers stale `SYNCING` queue rows, pushes stable event
IDs, persists per-event outcomes, pulls pages, applies each page and its cursor
atomically, then reports local block usage/prefetch when online. Temporary
network/timeout/502/503/504 failures use jittered 5/15/30/60 second backoff;
401 is delegated to the authenticated session provider; domain conflicts are
stored, not retried as connectivity failures. Successful queue rows may be
retained for 30 days; PENDING/SYNCING/CONFLICT/FAILED rows and unresolved
conflicts are never silently cleaned.

`AuthenticatedHttpClient` is the auth boundary: it obtains a short-lived access
token from a main-process session provider, performs one provider-owned refresh
after 401, and retries once. SyncEngine and SQLite never store access or refresh
tokens. This repository currently has the transport/session-provider interface
but no desktop login/session provider; until one is installed in the main
process registry, the UI truthfully reports `Tizimga kirish kerak` and does not
attempt authenticated sync.

Two-PC acceptance uses real PostgreSQL and HTTP: PC-1 creates locally with a
server-owned block, loses the first successful push response, retries the same
event ID, and PC-2 pulls the same UUID into a separate SQLite database before
disconnecting. The same Patta remains available offline on PC-2; operation
snapshot UUIDs/prices remain immutable.
