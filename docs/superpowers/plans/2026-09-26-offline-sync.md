# Offline Synchronization Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task with checkpoints. Do not delegate to subagents unless the user explicitly requests delegation.

**Goal:** Deliver shared sync contracts, race-safe tenant push/pull/bootstrap, SQLite offline Patta persistence, and a main-process two-way SyncEngine.

**Architecture:** The API records every sync-visible business mutation in the tenant transaction and exposes idempotent per-event push, sequence pull, and materialized keyset bootstrap. Electron main owns a migrated SQLite database, local repositories, staged bootstrap, atomic Patta/queue writes, and a single-flight engine behind an authenticated transport boundary. The shared protocol package is the only wire-contract source.

**Tech Stack:** NestJS, TypeORM, PostgreSQL 16, tenant additive migrations, npm workspaces, TypeScript, Electron 44.4.5, `better-sqlite3`, Vitest, Node crypto.

## Global Constraints

- Work only on `feature/offline-sync`.
- Keep tenant data database-per-tenant and validate tenant JWT/company/device on every sync route.
- Every sync-visible PostgreSQL mutation and change-log insert share one transaction.
- All recorders acquire the same transaction advisory lock before sequence allocation and hold it until commit/rollback; sequence gaps from aborts are expected.
- Bootstrap acquires the device session lock and shared change-log lock; releases the change-log lock immediately after establishing the REPEATABLE READ snapshot and watermark; it does not hold that lock during materialization or HTTP paging.
- No PostgreSQL transaction, MVCC snapshot, or checked-out QueryRunner survives an HTTP request; the reusable tenant pool may retain an idle connection.
- Offline local business row plus its queue event commit in one SQLite transaction.
- SQLite pull apply plus cursor advance commit in one SQLite transaction.
- Retries preserve the original `event_id`; event identity binds to its Master-validated device ID and deterministic RFC 8785 request fingerprint.
- Never reprice an offline Patta using current reference prices.
- Offline Patta and operation-snapshot UUIDs are generated locally and preserved by the server.
- Client `client_created_at` and `occurred_at` are not trusted server/security time; reject future skew greater than 300 seconds.
- Push entity scope is `patta/CREATE` only; reference offline mutation, Patta varag‘i UI, payroll, reports, and license workflow remain out of scope.
- Keep Electron exactly pinned at `44.4.5`; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- PostgreSQL BIGINT/cursor/worker IDs and NUMERIC prices use decimal strings at API/SQLite boundaries.
- Additive migrations only; do not delete/recreate SQLite or tenant databases to mask migration errors.
- All user-facing desktop strings are Uzbek Latin; no unrestricted IPC, Node, filesystem, token, or SQLite access in renderer.

---

## File and module map

### Shared contract

- Create `packages/sync-protocol/package.json` and fill `packages/sync-protocol/src/index.ts` with type-only public protocol definitions.
- Create `packages/sync-protocol/type-tests/protocol-consumer.ts` as a strict compile-only consumer of the public contracts.
- Link that package from `apps/api/package.json` and `apps/desktop/package.json`; update the root `package-lock.json` from repository root.

### API

- Create `database/tenant-migrations/20260926000600-AddOfflineSyncInfrastructure.js` for processed events, change log, bootstrap sessions/items, and additive offline Patta timestamps.
- Modify `apps/api/src/database/tenant/tenant-database-manager.ts` to grant runtime roles only the required sync table privileges; sequences remain covered by existing sequence grants.
- Modify `apps/api/src/tenant/rbac/tenant-permission.seed.ts` to seed `sync.push` and `sync.pull` (the tenant administrator already receives all seeded permissions).
- Create `apps/api/src/tenant/sync/sync.config.ts`, `sync-protocol.dto.ts`, `canonical-event.ts`, `sync-change-recorder.ts`, `sync-projections.ts`, `sync-entity-handler.ts`, `sync-handler.registry.ts`, `sync-event-processor.ts`, `sync.service.ts`, `sync-bootstrap.service.ts`, `sync.controller.ts`, `sync.module.ts`, and focused DTO files under `apps/api/src/tenant/sync/dto/`.
- Add `apps/api/src/tenant/sync/sync-core.module.ts`; existing mutation modules import this recorder-only module to avoid a dependency cycle with push handlers.
- Modify `apps/api/src/tenant/tenant.module.ts` to register the sync API module.
- Integrate recorder calls in `models/models.service.ts`, `operations/operations.service.ts`, `operations/operation-price.service.ts`, `workers/workers.service.ts`, `badges/badge-history.service.ts`, `patta/patta-templates.service.ts`, `patta/patta-number-blocks.service.ts`, and `patta/patta.service.ts`.
- Extend `patta/patta-offline-registration.validator.ts` to accept a transaction executor and validate client snapshot UUIDs and reference context without bypassing existing block/business-key checks.
- Add unit tests beside services and `sync.e2e-spec.ts` / `sync.integration.spec.ts` under `apps/api/src/tenant/sync/`.

### Desktop

- Create `apps/desktop/src/main/database/` with the SQLite connection, migration runner and numbered migrations; no prior desktop database exists, so create the initial migration but preserve the versioned additive migration mechanism thereafter.
- Create `apps/desktop/src/main/local/` repositories/services for sync queue/state/conflicts, staging, mirror projections, Patta lookup/creation, and number blocks.
- Create `apps/desktop/src/main/sync/` for authenticated transport contracts/REST adapter, network status, retry policy, and SyncEngine.
- Modify `apps/desktop/src/main/index.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, renderer `App.tsx`, and `components/Versions.tsx` to remove starter unrestricted `window.electron` use and expose only narrow typed APIs.
- Create `apps/desktop/scripts/run-electron-tests.mjs` and Vitest specs under `apps/desktop/src/main/**` so native SQLite tests execute in the Electron ABI-compatible Node mode.
- Add a desktop `test` script and Vitest dev dependency; leave Electron and native rebuild pins/configuration unchanged.

### Documentation

- Update `docs/sync-protocol.md`, `docs/database.md`, and `docs/testing.md` after behavior is implemented and tested.
- Design authority: `docs/superpowers/specs/2026-09-26-offline-sync-design.md`.

---

## Task 1: Publish the shared sync protocol workspace

**Files:**

- Create: `packages/sync-protocol/package.json`
- Modify: `packages/sync-protocol/src/index.ts`
- Create: `packages/sync-protocol/type-tests/protocol-consumer.ts`
- Modify: `apps/api/package.json`

- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`

**Interfaces produced:**

```ts
export type SyncMutationOperation = "CREATE" | "UPDATE" | "DELETE";
export type SyncChangeOperation = "UPSERT" | "DELETE";
export type SyncResultStatus = "SYNCED" | "CONFLICT" | "FAILED";

export interface SyncEvent<
  TEntityType extends string = string,
  TPayload = unknown,
> {
  event_id: string;
  entity_type: TEntityType;
  entity_id: string | null;
  operation: SyncMutationOperation;
  base_version: string | null;
  client_created_at: string;
  occurred_at: string;
  reference_cursor: string;
  payload: TPayload;
}

export interface SyncPattaOperationSnapshotInput {
  id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
}

export interface SyncPattaCreatePayload {
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  block_id: string;
  reference_versions: {
    model: string;
    template: string | null;
    operations: Readonly<Record<string, string>>;
  };
  operations: readonly SyncPattaOperationSnapshotInput[];
}

export type OfflinePattaCreateEvent = Omit<
  SyncEvent<"patta", SyncPattaCreatePayload>,
  "entity_id" | "operation" | "base_version"
> & { entity_id: string; operation: "CREATE"; base_version: "0" };

export interface SyncPushRequest {
  device_id: string;
  events: readonly SyncEvent[];
}

export interface SyncPushResponse {
  results: readonly SyncPushResult[];
}

export interface SyncPullRequest {
  device_id: string;
  cursor: string;
  limit?: number;
}

export interface SyncPullResponse {
  changes: readonly SyncChange[];
  next_cursor: string;
  has_more: boolean;
}

export type SyncPushResult =
  | {
      event_id: string;
      status: "SYNCED";
      entity_version: string | null;
      projection: SyncProjection;
      change_sequence: string;
    }
  | { event_id: string | null; status: "CONFLICT"; conflict: SyncConflict }
  | { event_id: string | null; status: "FAILED"; error: SyncFailure };

export interface SyncConflict {
  code: SyncErrorCode;
  message: string;
  details: Record<string, unknown>;
  local_payload: unknown;
  server_payload: unknown;
}

export interface SyncFailure {
  code: SyncErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export interface SyncChange {
  sequence_id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncChangeOperation;
  entity_version: string | null;
  projection_version: 1;
  payload: SyncProjection | null;
  changed_at: string;
}

export type SyncEntityType =
  | "workers"
  | "worker_badge_history"
  | "models"
  | "model_operations"
  | "model_operation_prices"
  | "patta_templates"
  | "patta_hisob"
  | "patta_operation_snapshots"
  | "patta_number_blocks";

export type SyncProjection =
  | {
      projection_version: 1;
      entity_type: "workers";
      entity_id: string;
      entity_version: string;
      data: SyncWorkerProjection;
    }
  | {
      projection_version: 1;
      entity_type: "worker_badge_history";
      entity_id: string;
      entity_version: null;
      data: SyncBadgeProjection;
    }
  | {
      projection_version: 1;
      entity_type: "models";
      entity_id: string;
      entity_version: string;
      data: SyncModelProjection;
    }
  | {
      projection_version: 1;
      entity_type: "model_operations";
      entity_id: string;
      entity_version: string;
      data: SyncOperationProjection;
    }
  | {
      projection_version: 1;
      entity_type: "model_operation_prices";
      entity_id: string;
      entity_version: null;
      data: SyncPriceProjection;
    }
  | {
      projection_version: 1;
      entity_type: "patta_templates";
      entity_id: string;
      entity_version: string;
      data: SyncTemplateProjection;
    }
  | {
      projection_version: 1;
      entity_type: "patta_hisob";
      entity_id: string;
      entity_version: string;
      data: SyncPattaProjection;
    }
  | {
      projection_version: 1;
      entity_type: "patta_operation_snapshots";
      entity_id: string;
      entity_version: null;
      data: SyncPattaOperationSnapshotProjection;
    }
  | {
      projection_version: 1;
      entity_type: "patta_number_blocks";
      entity_id: string;
      entity_version: null;
      data: PattaNumberBlockProjection;
    };

export interface SyncWorkerProjection {
  id: string;
  full_name: string;
  status: "ACTIVE" | "INACTIVE";
  version: string;
  created_at: string;
  updated_at: string;
}
export interface SyncBadgeProjection {
  id: string;
  badge_number: string;
  worker_id: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}
export interface SyncModelProjection {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  version: string;
  created_at: string;
  updated_at: string;
}
export interface SyncOperationProjection {
  id: string;
  model_id: string;
  name: string;
  sort_order: number;
  status: "ACTIVE" | "INACTIVE";
  version: string;
  created_at: string;
  updated_at: string;
}
export interface SyncPriceProjection {
  id: string;
  operation_id: string;
  price: string;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}
export interface SyncTemplateProjection {
  id: string;
  name: string;
  model_id: string;
  konveyer: string;
  razmer: string | null;
  rang: string | null;
  status: "ACTIVE" | "INACTIVE";
  version: string;
  created_at: string;
  updated_at: string;
}
export interface SyncPattaProjection {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  ish_soni: number;
  created_device_id: string;
  created_from_block_id: string | null;
  created_at: string;
  client_created_at: string | null;
  occurred_at: string | null;
}
export interface SyncPattaOperationSnapshotProjection {
  id: string;
  patta_hisob_id: string;
  operation_id: string;
  operation_name_snapshot: string;
  unit_price_snapshot: string;
  sort_order: number;
  created_at: string;
}
export interface PattaNumberBlockProjection {
  id: string;
  device_id: string;
  range_start: string;
  range_end: string;
  reported_used_count: string;
  status: "ACTIVE" | "EXHAUSTED" | "CANCELLED";
  allocated_at: string;
  exhausted_at: string | null;
}

export interface SyncBootstrapSession {
  id: string;
  device_id: string;
  watermark: string;
  status: "ACTIVE" | "COMPLETED" | "EXPIRED";
  expires_at: string;
}
export interface SyncBootstrapPage {
  session_id: string;
  watermark: string;
  items: readonly { order_key: string; projection: SyncProjection }[];
  next_order_key: string | null;
  has_more: boolean;
}
export interface SyncBootstrapRequest {
  device_id: string;
}
export interface SyncBootstrapPageRequest {
  device_id: string;
  session_id: string;
  after: string | null;
  limit?: number;
}
export interface SyncBootstrapCompleteRequest {
  device_id: string;
  session_id: string;
}

export type SyncErrorCode =
  | "VERSION_CONFLICT"
  | "PATTA_ALREADY_EXISTS"
  | "PATTA_NUMBER_OUTSIDE_BLOCK"
  | "PATTA_BLOCK_DEVICE_MISMATCH"
  | "PATTA_SNAPSHOT_MISMATCH"
  | "REFERENCE_DATA_STALE"
  | "DEVICE_NOT_ACTIVE"
  | "PAYLOAD_INVALID"
  | "SYNC_BOOTSTRAP_EXPIRED"
  | "EVENT_ID_REUSE_MISMATCH"
  | "SYNC_CURSOR_EXPIRED"
  | (string & {});
```

Also define `SyncPushResult` as a discriminated status/code/result union with `event_id: string | null` for unidentifiable malformed items; `SyncConflict`; an extensible `SyncErrorCode`; `SyncChange` with sequence/entity version/projection version/UPSERT-or-DELETE; bootstrap create/page/complete contracts; `PattaNumberBlockProjection`; and versioned explicit projections for the nine bootstrap entities. Keep all definitions type-only so API SWC and Electron bundling erase imports at runtime.

- [ ] **Step 1: Add the compile-only consumer first.** Import the contract types and assign a valid event, pull response, discriminated push result and every projection union member in `type-tests/protocol-consumer.ts`.
- [ ] **Step 2: Run `npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext packages/sync-protocol/type-tests/protocol-consumer.ts`; verify resolution fails because the package manifest/types do not exist yet.**
- [ ] **Step 3: Add the package manifest and types.** Set package name/version to `@textile/sync-protocol`/`0.1.0`, `type: module`, `types: ./src/index.ts`, and a type-only export map. Add exact workspace version `0.1.0` to both consuming app manifests.
- [ ] **Step 4: Refresh the single root lockfile without running native install hooks.** Run `npm install --package-lock-only --ignore-scripts` at repository root; confirm the lock contains one workspace link and Electron remains exactly `44.4.5`.
- [ ] **Step 5: Re-run the compile-only consumer command; it must pass with no emitted files.** Then run API/desktop typechecks and API lint.
- [ ] **Step 6: Commit the shared boundary.** `git add packages/sync-protocol apps/api/package.json apps/desktop/package.json package-lock.json`; commit `feat: add shared sync protocol contracts`.

## Task 2: Add validated sync configuration and tenant permissions

**Files:**

- Create: `apps/api/src/tenant/sync/sync.config.ts`
- Create: `apps/api/src/tenant/sync/sync.config.spec.ts`
- Modify: `apps/api/src/tenant/rbac/tenant-permission.seed.ts`

**Interfaces produced:**

```ts
export interface SyncConfiguration {
  pushMaxEvents: number;
  pullMaxChanges: number;
  bootstrapPageSize: number;
  bootstrapSessionTtlMinutes: number;
  bootstrapMaxActiveSessionsPerDevice: number;
  bootstrapCleanupBatchSize: number;
  bootstrapTerminalRetentionHours: number;
  maxFutureSkewSeconds: number;
}
```

Implementation shape:

```ts
const DEFAULTS = {
  SYNC_PUSH_MAX_EVENTS: 100,
  SYNC_PULL_MAX_CHANGES: 500,
  SYNC_BOOTSTRAP_PAGE_SIZE: 250,
  SYNC_BOOTSTRAP_SESSION_TTL_MINUTES: 30,
  SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE: 1,
  SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE: 100,
  SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS: 24,
  SYNC_MAX_FUTURE_SKEW_SECONDS: 300,
} as const;

export function loadSyncConfiguration(
  config: Record<string, unknown>,
): SyncConfiguration {
  const positive = (
    key: keyof typeof DEFAULTS,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const raw = config[key] ?? String(DEFAULTS[key]);
    if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
      throw new Error(`${key} must be a positive integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum) {
      throw new Error(`${key} exceeds its supported range`);
    }
    return value;
  };

  return {
    pushMaxEvents: positive("SYNC_PUSH_MAX_EVENTS"),
    pullMaxChanges: positive("SYNC_PULL_MAX_CHANGES"),
    bootstrapPageSize: positive("SYNC_BOOTSTRAP_PAGE_SIZE", 500),
    bootstrapSessionTtlMinutes: positive("SYNC_BOOTSTRAP_SESSION_TTL_MINUTES"),
    bootstrapMaxActiveSessionsPerDevice: positive(
      "SYNC_BOOTSTRAP_MAX_ACTIVE_SESSIONS_PER_DEVICE",
      1,
    ),
    bootstrapCleanupBatchSize: positive("SYNC_BOOTSTRAP_CLEANUP_BATCH_SIZE"),
    bootstrapTerminalRetentionHours: positive(
      "SYNC_BOOTSTRAP_TERMINAL_RETENTION_HOURS",
    ),
    maxFutureSkewSeconds: positive("SYNC_MAX_FUTURE_SKEW_SECONDS"),
  };
}
```

- [ ] **Step 1: Write config tests for defaults, valid overrides, empty/noninteger/unsafe/zero/over-max values.** Defaults are push 100 (maximum 1,000), pull 500 (maximum 5,000), page 250 (maximum 500), session TTL 30 minutes (maximum 1,440), active sessions/device 1 (maximum 1 because the database enforces one ACTIVE session), cleanup batch 100 (maximum 1,000), terminal staging retention 24 hours (maximum 168), future skew 300 seconds (hard maximum 300).
- [ ] **Step 2: Run `npm run test --workspace=apps/api -- src/tenant/sync/sync.config.spec.ts`; confirm expected failures.**
- [ ] **Step 3: Implement `loadSyncConfiguration(config)` following `loadPattaConfiguration` validation style and export `SYNC_CONFIGURATION`.** Reject invalid startup values without echoing secrets.
- [ ] **Step 4: Add Uzbek tenant permission seeds `sync.push` and `sync.pull`; keep `patta.chiqarish.create` as an additional permission on push.**
- [ ] **Step 5: Run `npm run test --workspace=apps/api -- src/tenant/sync/sync.config.spec.ts src/tenant/rbac/tenant-rbac.service.spec.ts`; run API typecheck.**

The parser must fail with a setting name only; it must never include configuration values in thrown messages.

## Task 3: Create the additive tenant sync migration and runtime grants

**Files:**

- Create: `database/tenant-migrations/20260926000600-AddOfflineSyncInfrastructure.js`
- Modify: `apps/api/src/database/tenant/tenant-database-manager.ts`
- Modify: `apps/api/src/database/tenant/tenant-provisioning.integration.spec.ts` only where it asserts explicit grants
- Test: `apps/api/src/tenant/sync/sync.integration.spec.ts`

Migration table shape:

```sql
CREATE TABLE "processed_sync_events" (
  "event_id" uuid PRIMARY KEY,
  "device_id" uuid NULL,
  "user_id" uuid NULL,
  "entity_type" varchar NOT NULL,
  "entity_id" varchar NULL,
  "operation" varchar NOT NULL,
  "request_fingerprint" char(64) NOT NULL,
  "result_status" varchar NOT NULL,
  "result_json" jsonb NULL,
  "processed_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK ("result_status" IN ('PROCESSING', 'SYNCED', 'CONFLICT', 'FAILED'))
);
CREATE TABLE "server_change_log" (
  "sequence_id" bigserial PRIMARY KEY,
  "entity_type" varchar NOT NULL,
  "entity_id" varchar NOT NULL,
  "operation" varchar NOT NULL CHECK ("operation" IN ('UPSERT', 'DELETE')),
  "entity_version" varchar NULL,
  "projection_version" integer NOT NULL CHECK ("projection_version" > 0),
  "payload_json" jsonb NULL,
  "changed_at" timestamptz NOT NULL DEFAULT transaction_timestamp()
);
```

Add `bootstrap_sessions`, `bootstrap_items`, their indexes/triggers, and only nullable `client_created_at`/`occurred_at` on `patta_hisob` in that same additive migration.

- [ ] **Step 1: Add migration contract tests before SQL.** Assert created tables/columns/indexes/checks/triggers and safe down behavior. Assert migration down refuses to remove processed events or change history, while disposable bootstrap staging can be deleted safely.
- [ ] **Step 2: Run the focused PostgreSQL test with the dedicated test env when configured; verify the new migration test fails because the migration is absent.** Use only `TEST_MASTER_DB_*` and a database ending in `_test`.
- [ ] **Step 3: Add `processed_sync_events`.** Use `event_id UUID PRIMARY KEY`, `device_id/user_id` nullable, entity/operation fields, `request_fingerprint CHAR(64)`, `PROCESSING|SYNCED|CONFLICT|FAILED` status check, JSONB result, `processed_at`, a trigger that permits only immutable identity plus one `PROCESSING -> terminal` transition, and a deferred constraint trigger that rejects commit if a reservation remains PROCESSING; reject deletes.
- [ ] **Step 4: Add `server_change_log`.** Use `BIGSERIAL sequence_id`, entity type/ID, `UPSERT|DELETE`, nullable entity version, projection version, JSONB payload, server timestamp, sequence/entity indexes, and append-only trigger.
- [ ] **Step 5: Add `bootstrap_sessions` and `bootstrap_items`.** Store device/watermark/status/timestamps and session/order/entity/projection payload; add partial unique ACTIVE session per device, unique `(session_id, order_key)` and `(session_id, entity_type, entity_id)`, page index, and `ON DELETE CASCADE` only from temporary items to temporary session.
- [ ] **Step 6: Add nullable `client_created_at` and `occurred_at` to `patta_hisob`; add a CHECK requiring both when `created_from_block_id IS NOT NULL`; do not alter existing columns or online generation semantics.** Existing online generation leaves both null and its `created_at` remains server time.
- [ ] **Step 7: Extend `grantRuntimePrivileges()` to grant SELECT/INSERT/UPDATE/DELETE on the four new sync tables to the per-tenant runtime role.** Existing sequence grant covers `server_change_log` sequence.
- [ ] **Step 8: Apply/down/reapply using generated tenant DBs in the dedicated `_test` Master database; verify `git diff` contains no edits to migrations `20260926000000` through `20260926000500`.**
- [ ] **Step 9: Commit migration and grants as `feat: add tenant sync persistence schema`.**

## Task 4: Implement deterministic fingerprinting and the shared change recorder

**Files:**

- Create: `apps/api/src/tenant/sync/canonical-event.ts`
- Create: `apps/api/src/tenant/sync/canonical-event.spec.ts`
- Create: `apps/api/src/tenant/sync/sync-change-recorder.ts`
- Create: `apps/api/src/tenant/sync/sync-change-recorder.spec.ts`
- Create: `apps/api/src/tenant/sync/sync-projections.ts`
- Create: `apps/api/src/tenant/sync/sync-core.module.ts`

**Interfaces produced:**

```ts
export interface SyncChangeInput {
  entityType: string;
  entityId: string;
  operation: "UPSERT" | "DELETE";
  entityVersion: string | null;
  projectionVersion: number;
  payload: object | null;
}

export interface RecordedSyncChange {
  sequenceId: string;
}

export class SyncChangeRecorder {
  record(
    manager: EntityManager,
    change: SyncChangeInput,
  ): Promise<RecordedSyncChange>;
}
```

Recorder write order is fixed:

```ts
await manager.query("SELECT pg_advisory_xact_lock($1::bigint)", [
  SYNC_CHANGE_LOCK_KEY,
]);
const rows: Array<{ sequence_id: string }> = await manager.query(
  `INSERT INTO "server_change_log"
     ("entity_type", "entity_id", "operation", "entity_version", "projection_version", "payload_json")
   VALUES ($1, $2, $3, $4, $5, $6::jsonb)
   RETURNING "sequence_id"::text AS "sequence_id"`,
  [
    change.entityType,
    change.entityId,
    change.operation,
    change.entityVersion,
    change.projectionVersion,
    change.payload === null ? null : JSON.stringify(change.payload),
  ],
);
```

- [ ] **Step 1: Write canonical-event tests.** Cover recursively sorted object keys, preserved array order, Unicode strings, numbers, and invalid non-finite/unsupported values. Fingerprint input is the validated event plus Master-validated `device_id`; do not include bearer token or request ID.
- [ ] **Step 2: Run focused tests and observe missing-module failures.**
- [ ] **Step 3: Implement RFC 8785-compatible canonical JSON with built-in JS JSON primitive encoding, sorted UTF-16 keys and recursively canonical object values; hash UTF-8 bytes with `createHash('sha256')`.** Keep helper pure and return lowercase hex SHA-256.
- [ ] **Step 4: Write recorder tests asserting the lock query precedes the first insert and the returned BIGINT sequence is a decimal string.** Assert the manager, never DataSource, executes both operations.
- [ ] **Step 5: Implement one exported constant advisory key.** `record()` runs `SELECT pg_advisory_xact_lock($1::bigint)` using the exact shared key before `INSERT ... RETURNING sequence_id::text`; projection input is explicit and validated. Do not add `MAX()+1` or direct change-log writes elsewhere.
- [ ] **Step 6: Add explicit versioned projection builders and export recorder from `TenantSyncCoreModule`; import the core module into mutation modules in later tasks.**
- [ ] **Step 7: Run API lint/typecheck and unit tests.**

## Task 5: Record model, operation, and effective-price mutations

**Files:**

- Modify: `apps/api/src/tenant/models/models.module.ts`
- Modify: `apps/api/src/tenant/models/models.service.ts`
- Modify: `apps/api/src/tenant/operations/operations.module.ts`
- Modify: `apps/api/src/tenant/operations/operations.service.ts`
- Modify: `apps/api/src/tenant/operations/operation-price.service.ts`
- Test: corresponding existing `*.service.spec.ts` files and `models-operations.integration.spec.ts`

Each existing transaction records its canonical returned domain projection before leaving the callback:

```ts
const created = serializeModel(row);
await this.syncChangeRecorder.record(manager, {
  entityType: "models",
  entityId: created.id,
  operation: "UPSERT",
  entityVersion: created.version,
  projectionVersion: 1,
  payload: { projection_version: 1, entity_type: "models", data: created },
});
```

- [ ] **Step 1: Add unit assertions that each create/update/price change calls the recorder with the returned explicit projection inside its manager transaction.** For operation price updates assert one event closes the old interval and one event opens the new interval, plus the operation UPSERT/version.
- [ ] **Step 2: Run model/operation/price unit tests and capture the expected recorder-missing failures.**
- [ ] **Step 3: Import `TenantSyncCoreModule` and inject the same `SyncChangeRecorder` into model, operation and price services.**
- [ ] **Step 4: Record model create/update, operation create/update/status change, initial/current operation price and both changed historical price rows inside the existing transaction.** Preserve audit transactions and expected-version behavior; never write `model_operations.price` as an effective snapshot source.
- [ ] **Step 5: Add a PostgreSQL rollback assertion: force recorder insertion failure and assert the business mutation/audit/history rows all roll back.**
- [ ] **Step 6: Run `npm run test:models-operations --workspace=apps/api`, focused service unit tests, API typecheck and lint.**

## Task 6: Record worker, badge, template, block, and online Patta changes

**Files:**

- Modify: `apps/api/src/tenant/workers/workers.module.ts`
- Modify: `apps/api/src/tenant/workers/workers.service.ts`
- Modify: `apps/api/src/tenant/badges/badge-history.service.ts`
- Modify: `apps/api/src/tenant/patta/patta.module.ts`
- Modify: `apps/api/src/tenant/patta/patta-templates.service.ts`
- Modify: `apps/api/src/tenant/patta/patta-number-blocks.service.ts`
- Modify: `apps/api/src/tenant/patta/patta.service.ts`
- Test: existing workers/badges, Patta, and price/badge service/integration tests

For reassignment, append the two interval projections in the same transaction in this order:

```ts
await this.syncChangeRecorder.record(manager, toBadgeChange(closedAssignment));
await this.syncChangeRecorder.record(
  manager,
  toBadgeChange(insertedAssignment),
);
```

`toBadgeChange(record: BadgeAssignmentRecord): SyncChangeInput` is the explicit version-1 `worker_badge_history` projection builder in `sync-projections.ts`.

- [ ] **Step 1: Add recorder expectation tests before each service change.** Badge reassignment expects `UPSERT` for the closed old assignment then the inserted assignment. Worker deactivation expects each closed badge plus worker state. Block usage reports and online Pattas must emit changes too.
- [ ] **Step 2: Run focused unit tests and confirm recorder assertions fail.**
- [ ] **Step 3: Import the recorder-only core module in the relevant Nest modules and inject it into the transaction-owning services.** Avoid importing `SyncModule` from mutation modules.
- [ ] **Step 4: Add deterministic projections for worker/badge, template, number block, Patta and operation snapshot IDs.** Record badge interval closure and new assignment in one existing transaction. Record price history close/open in transaction order.
- [ ] **Step 5: Record every online Patta plus its operation snapshots in the generation transaction; preserve online effective-price behavior.**
- [ ] **Step 6: Extend real PostgreSQL tests to assert recorder event order, payload immutability after later entity changes, and transaction rollback parity.**
- [ ] **Step 7: Run `npm run test:workers-badges --workspace=apps/api`, `npm run test:patta --workspace=apps/api`, `npm run test:models-operations --workspace=apps/api`, plus focused API tests/typecheck/lint.**
- [ ] **Step 8: Review and commit the transaction recorder integrations.** Run `git status` and `git diff --check`; stage only the recorder, projections, core module, and modified reference service/module/test files. Commit `feat: record tenant sync changes`.

## Task 7: Implement push event transaction/idempotency processor

**Files:**

- Create: `apps/api/src/tenant/sync/sync-event-processor.ts`
- Create: `apps/api/src/tenant/sync/sync-handler.registry.ts`
- Create: `apps/api/src/tenant/sync/sync-entity-handler.ts`
- Create: `apps/api/src/tenant/sync/sync-event-processor.spec.ts`

**Interfaces produced:**

```ts
export interface SyncApplyContext {
  actorUserId: string;
  companyId: string;
  validatedDeviceId: string;
}

export class SyncEventProcessor {
  process(
    dataSource: DataSource,
    context: SyncApplyContext,
    rawEvent: unknown,
  ): Promise<SyncPushResult>;
}

export interface SyncHandlerResult {
  entityVersion: string | null;
  projection: VersionedSyncProjection;
  changeSequence: string;
}

export interface SyncEntityHandler {
  supports(entityType: string, operation: SyncMutationOperation): boolean;
  apply(
    manager: EntityManager,
    context: SyncApplyContext,
    event: SyncEvent,
  ): Promise<SyncHandlerResult>;
}
```

The unique reservation is the first write and the concurrency gate:

```sql
INSERT INTO "processed_sync_events"
  ("event_id", "device_id", "user_id", "entity_type", "entity_id", "operation",
   "request_fingerprint", "result_status")
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'PROCESSING')
ON CONFLICT ("event_id") DO NOTHING
RETURNING "event_id";
```

If `RETURNING` is empty, the unique-index conflict has waited for the concurrent transaction. Read its terminal result, compare fingerprints, and do not call a handler.

- [ ] **Step 1: Test same-ID race logic with two independent mocked query runners.** Assert reservation insert (with `ON CONFLICT DO NOTHING`) precedes handler call, duplicate lookup follows a conflict, a matching fingerprint returns stored result, and mismatched fingerprint returns `EVENT_ID_REUSE_MISMATCH` without handler invocation.
- [ ] **Step 2: Test event savepoint failure.** A domain HTTP/constraint error must `ROLLBACK TO SAVEPOINT`, store terminal conflict/failed result, and commit reservation; an injected infrastructure error must rollback the whole transaction and leave no event row.
- [ ] **Step 3: Implement one event per QueryRunner/transaction.** First extract/require a UUID `event_id`; compute RFC 8785 fingerprint over the received JSON event plus validated device ID; attempt unique reservation insert before full event validation or handler call; never rely on SELECT-before-INSERT for race safety. If event_id is unusable, return a per-item PAYLOAD_INVALID result with `event_id: null` because no UUID reservation can be stored.
- [ ] **Step 4: On duplicate reservation, query the committed winner only after unique insert contention resolves; compare device-bound fingerprint and return its immutable result.**
- [ ] **Step 5: After reservation/fingerprint matching, validate the full raw item as `SyncEvent` inside a named SQL savepoint, then call the registered handler.** Classify expected payload/domain failures to stable terminal results; rollback domain work to savepoint, write stored conflict/failed result, and commit. Let unexpected errors rollback the outer transaction.
- [ ] **Step 6: Require exactly one registered handler for supported entity/operation; unsupported entity/operation stores permanent `FAILED/PAYLOAD_INVALID` result without mutation.**
- [ ] **Step 7: Run processor unit tests, API typecheck/lint, and add PostgreSQL concurrency coverage in Task 16.**

## Task 8: Implement offline Patta registration handler

**Files:**

- Modify: `apps/api/src/tenant/patta/patta-offline-registration.validator.ts`
- Modify: `apps/api/src/tenant/patta/patta-offline-registration.validator.spec.ts`
- Modify: `apps/api/src/tenant/patta/patta-number-blocks.service.ts`
- Modify: `apps/api/src/tenant/patta/patta-number-blocks.service.spec.ts`
- Modify: `apps/api/src/tenant/patta/patta.service.ts`
- Modify: `apps/api/src/tenant/patta/patta.module.ts`
- Create: `apps/api/src/tenant/sync/patta-sync-handler.ts`
- Create: `apps/api/src/tenant/sync/patta-sync-handler.spec.ts`

Registration contract preserves identity and never derives historical prices from the current operation row:

```ts
const created = await this.pattaService.registerOffline(
  manager,
  context.actorUserId,
  context.validatedDeviceId,
  event,
);
return {
  entityVersion: created.version,
  projection: {
    projection_version: 1,
    entity_type: "patta",
    data: created.record,
  },
  changeSequence: created.changeSequence,
};
```

`PattaService.registerOffline` records the Patta and each client-ID-preserved operation snapshot in the supplied transaction and returns `record`, `version`, and exact `changeSequence`.

- [ ] **Step 1: Extend validator tests for Patta UUID, snapshot UUID, CREATE `base_version='0'`, numeric range, duplicate operation/snapshot IDs, decimal price, canonical names/order/count, and validated device/block ownership.**
- [ ] **Step 2: Add test cases for a current model/template/operation-version set, stale model/operation/template, renamed operation, missing/inactive operation, invalid reference cursor, and client price differing from present-day price.** Historical client price must be retained when references validate; stale state must return the designated conflict.
- [ ] **Step 3: Generalize block membership and business-key availability validation to `DataSource | EntityManager`; use the event manager so checks and inserts share one transaction.**
- [ ] **Step 4: Add `PattaService.registerOffline(manager, actorUserId, validatedDeviceId, event): Promise<{ record: PattaRecord; version: string; changeSequence: string }>` which verifies references and inserts Patta + snapshots using client UUIDs, block ID, validated historical snapshot prices, server DB `created_at`, and event `client_created_at`/`occurred_at`.** Derive `ish_soni` from validated snapshot rows.
- [ ] **Step 5: Keep the Patta unique constraint as race-safe business-key authority and map primary/business-key/snapshot-ID collisions to stable `PATTA_ALREADY_EXISTS` or `PATTA_SNAPSHOT_MISMATCH`; never overwrite an existing row.**
- [ ] **Step 6: Append an audit event marked `source: 'OFFLINE_SYNC'` and `SyncChangeRecorder` UPSERTs for Patta and each snapshot through the same manager transaction.** Return canonical projection and exact recorded sequence for the processed event result.
- [ ] **Step 7: Implement `PattaSyncHandler` for `supports('patta','CREATE')` only; test other entity operations are unsupported.**
- [ ] **Step 8: Run Patta unit tests, `npm run test:patta --workspace=apps/api`, API e2e regressions and typecheck.**

## Task 9: Add tenant push/pull HTTP surface and authorization

**Files:**

- Create: `apps/api/src/tenant/sync/sync.controller.ts`
- Create: `apps/api/src/tenant/sync/sync.service.ts`
- Create/modify: `apps/api/src/tenant/sync/dto/sync-push-envelope.dto.ts` and pull/bootstrap query DTOs
- Create: `apps/api/src/tenant/sync/sync.e2e-spec.ts`
- Create: `apps/api/src/tenant/sync/sync.module.ts`
- Modify: `apps/api/src/tenant/tenant.module.ts`

Controller remains thin and delegates using only authenticated context plus validated device:

```ts
export class SyncPushEnvelopeDto {
  @IsUUID()
  device_id!: string;

  @IsArray()
  events!: unknown[];
}

@Post('push')
@TenantPermissions('sync.push', 'patta.chiqarish.create')
async push(@Req() request: TenantAuthenticatedRequest, @Body() body: SyncPushEnvelopeDto) {
  const context = requireTenantContext(request);
  const device = await this.deviceAccessService.assertActiveDevice(context.companyId, body.device_id);
  return this.syncService.push(context, device.id, body);
}
```

- [ ] **Step 1: Write e2e tests for missing/platform tokens, tenant permission denial, cross-company hostname mismatch, unknown DTO properties, malformed device/event IDs, and configured batch maximum.**
- [ ] **Step 2: Test a three-event request produces ordered `SYNCED`, `CONFLICT`, `SYNCED` results and does not make the controller one giant DB transaction.**
- [ ] **Step 3: Add a strict envelope DTO and pull/bootstrap query DTOs.** Validate outer `device_id`, configured maximum event count (`SYNC_PUSH_MAX_EVENTS`), decimal-string cursor and bounded limit at request level. Represent push items as `unknown[]` at this envelope boundary (do not nested-validate the entire batch); the event processor validates each item as shared `SyncEvent` so one malformed event becomes its own `FAILED/PAYLOAD_INVALID` result instead of rejecting valid siblings.
- [ ] **Step 4: Add `SyncController` under `api/v1/sync` with `POST /push` and `GET /pull`.** Push requires `sync.push` and `patta.chiqarish.create`; pull/bootstrap require `sync.pull`. Each route obtains `requireTenantContext()` and calls `DeviceAccessService.assertActiveDevice(companyId, device_id)` before sync work.
- [ ] **Step 5: Return a per-event result array from `POST /api/v1/sync/push`; unexpected infra failure is structured 5xx, not a permanent event outcome.**
- [ ] **Step 6: Add pull query parsing and call a service that reads `sequence_id > cursor ORDER BY sequence_id ASC LIMIT $bounded`, returns decimal string `next_cursor` (input when empty) and `has_more`.**
- [ ] **Step 7: Register module without creating a core-module dependency cycle; add tests that both platform tokens and cross-company devices are rejected before tenant sync access.**
- [ ] **Step 8: Run `npm run test:e2e --workspace=apps/api -- src/tenant/sync/sync.e2e-spec.ts`, API unit tests, lint, typecheck and build.**

## Task 10: Materialize and page server bootstrap snapshots

**Files:**

- Create: `apps/api/src/tenant/sync/sync-bootstrap.service.ts`
- Create: `apps/api/src/tenant/sync/sync-bootstrap-projections.ts`
- Create: `apps/api/src/tenant/sync/sync-bootstrap.service.spec.ts`
- Modify: `apps/api/src/tenant/sync/sync.controller.ts`
- Modify: `apps/api/src/tenant/sync/sync.module.ts`

The critical create-session transaction sequence is:

```ts
await runner.connect();
await acquireDeviceBootstrapLock(runner, deviceId);
await acquireChangeLogSessionLock(runner);
await runner.startTransaction("REPEATABLE READ");
await runner.query("SELECT txid_current_snapshot()");
const watermarkRows: Array<{ watermark: string }> = await runner.query(
  'SELECT COALESCE(MAX("sequence_id"), 0)::text AS watermark FROM "server_change_log"',
);
const watermark = watermarkRows[0]?.watermark;
if (!watermark) throw new Error("Bootstrap watermark was not returned");
await releaseChangeLogSessionLock(runner);
await materializeBootstrapSession(runner, sessionId, deviceId, watermark);
await runner.commitTransaction();
```

Wrap it in `try/catch/finally`: rollback only if transaction is active, release any still-held session locks on the same QueryRunner, and always release the QueryRunner. Release the global lock before `materializeBootstrapSession`.

- [ ] **Step 1: Add unit tests for exact route contract, keyset cursor validation, page-size cap, expiry, device mismatch and completion idempotency.**
- [ ] **Step 2: Add SQL projection test fixtures for all nine bootstrap entities; assert payload keys are explicit versioned DTO fields and never include users/password/session/audit columns.**
- [ ] **Step 3: Implement session creation on one dedicated `QueryRunner`: acquire a device-scoped session lock, acquire the exact recorder lock key session-level, start REPEATABLE READ, establish the MVCC snapshot, read `COALESCE(MAX(sequence_id),0)`, then release only the global change-log lock.**
- [ ] **Step 4: In that same transaction, expire/remove any old active session for the device, insert the new ACTIVE session, and materialize one deterministic union projection into `bootstrap_items` using database `INSERT ... SELECT` and `row_number() OVER (ORDER BY entity_type_order, entity_id)`.** Do not create a JS array or use OFFSET. Commit before returning; release all session-level locks and QueryRunner in `finally`.
- [ ] **Step 5: Implement `GET /api/v1/sync/bootstrap/:sessionId?after=<decimal>&limit=...` using `order_key > after`, `ORDER BY order_key ASC`, `LIMIT pageSize + 1`.** Return the next key and `has_more`; validate session/device/status/expiry for every page.
- [ ] **Step 6: Expose `POST /api/v1/sync/bootstrap` for session creation and `POST /api/v1/sync/bootstrap/:sessionId/complete` for staging completion; completion changes only session lifecycle and never represents SQLite truth.**
- [ ] **Step 7: Add bounded terminal/expired cleanup and configured active-session limit; all cleanup deletes only `bootstrap_items`/`bootstrap_sessions`.**
- [ ] **Step 8: Ensure a full page/session only exposes staged payload after the session transaction commits; map expired/missing sessions to `SYNC_BOOTSTRAP_EXPIRED`.**
- [ ] **Step 9: Run focused API tests and typecheck; the real MVCC race tests are in Task 16.**
- [ ] **Step 10: Review and commit the tenant sync API slice.** Run `git status` and `git diff --check`; stage only push/pull/bootstrap handlers, DTOs, API module wiring, service tests and PostgreSQL integration work. Commit `feat: add tenant sync APIs and bootstrap`.

## Task 11: Build versioned SQLite startup and migrations

**Files:**

- Create: `apps/desktop/src/main/database/sqlite-database.ts`
- Create: `apps/desktop/src/main/database/sqlite-migration-runner.ts`
- Create: `apps/desktop/src/main/database/migrations/001-sync-foundation.ts`
- Create: `apps/desktop/src/main/database/sqlite-database.spec.ts`
- Create: `apps/desktop/scripts/run-electron-tests.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop/src/main/index.ts`

The first migration contains the queue/state/conflict invariant shape:

```sql
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  operation TEXT NOT NULL,
  base_version TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  last_error TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SYNCING','SYNCED','CONFLICT','FAILED'))
);
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
  conflict_code TEXT NOT NULL, local_payload_json TEXT, server_payload_json TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
);
```

Electron-compatible Vitest launcher uses the workspace's pinned Electron binary:

```js
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const vitestPath = require.resolve("vitest/vitest.mjs");
const child = spawnSync(
  electronPath,
  [vitestPath, "run", ...process.argv.slice(2)],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);
process.exit(child.status ?? 1);
```

- [x] **Step 1: Add Electron-runtime test for opening a temporary database, migration version recording, FK/WAL settings, and migration rollback after an injected DDL failure.**
- [x] **Step 2: Add desktop Vitest devDependency `^5.0.2`, script `"test": "node scripts/run-electron-tests.mjs"`, and root lockfile entry.** Then run `npm install --package-lock-only --ignore-scripts` from repository root. The runner resolves the pinned Electron executable and Vitest entry, launches Electron with `ELECTRON_RUN_AS_NODE=1`, forwards CLI arguments, inherits stdio and exits with the child status.
- [x] **Step 3: Run `npm run test --workspace=apps/desktop -- src/main/database/sqlite-database.spec.ts`; verify the new test runs and fails on the missing database module.**
- [x] **Step 4: Add `better-sqlite3` connection factory using `app.getPath('userData')`, `PRAGMA foreign_keys=ON`, WAL and busy timeout; do not add DB reset/recreate fallback.**
- [x] **Step 5: Add `schema_migrations(version,name,applied_at)` and apply each migration under an exclusive SQLite transaction; version is monotonic and already-applied migration names cannot be changed.**
- [x] **Step 6: Define SQLite schema with TEXT for every PostgreSQL BIGINT/decimal/time boundary, bounded INTEGER only for counters, and explicit constraints/indexes.** Include queue, state, conflict, reference mirrors, Patta/snapshot tables, blocks/local next number, bootstrap local session/staging and ownership/server sequence metadata.
- [x] **Step 7: Initialize the DB before creating BrowserWindow, keep the handle in main, close it on app shutdown, and surface migration failure without deleting local data.**
- [x] **Step 8: Run Electron ABI-compatible SQLite specs and desktop `typecheck:node`.**

## Task 12: Add local repositories and atomic bootstrap staging/finalization

**Files:**

- Create: `apps/desktop/src/main/local/local-unit-of-work.ts`
- Create: `apps/desktop/src/main/local/sync-queue.repository.ts`
- Create: `apps/desktop/src/main/local/sync-state.repository.ts`
- Create: `apps/desktop/src/main/local/sync-conflict.repository.ts`
- Create: `apps/desktop/src/main/local/bootstrap-staging.repository.ts`
- Create: `apps/desktop/src/main/local/reference-mirror.repository.ts`
- Create: `apps/desktop/src/main/local/local-repositories.spec.ts`

Local mutation transaction stays synchronous:

```ts
const save = this.database.transaction(() => {
  this.pattaRepository.insert(localPatta);
  for (const snapshot of snapshots)
    this.pattaRepository.insertSnapshot(snapshot);
  this.syncQueueRepository.enqueue(event);
});
save.immediate();
```

`LocalUnitOfWork` owns this transaction wrapper; repositories receive the same `Database` and never open their own connection.

- [x] **Step 1: Test queue insert + business-row write rollback together using an injected throwing repository operation.**
- [x] **Step 2: Test staging pages persist individually, repeated page save is idempotent, and a staging failure cannot change live mirrors or `last_server_cursor`.**
- [x] **Step 3: Implement synchronous `LocalUnitOfWork.transaction<T>(action: (database: Database) => T): T` using better-sqlite3 transactions; do not await/network-call inside it.**
- [x] **Step 4: Implement queue/state/conflict repository methods matching the exact schema and keep JSON serialization centralized.** Recover stale `SYNCING` rows to `PENDING` at startup.
- [x] **Step 5: Implement staging by bootstrap session/order key; persist one page transactionally and store watermark/page completion metadata without publishing it to live reference tables.**
- [x] **Step 6: Implement one finalization transaction that UPSERTs all nine mirrors from staging, tombstones absent server-owned rows, preserves `LOCAL_PENDING`/`CONFLICT`/`FAILED` Pattas/snapshots, applies server block state without reducing `local_next_number`, sets `last_server_cursor=watermark`, and marks the local session complete.**
- [x] **Step 7: Inject failure during table reconciliation and assert transaction rollback leaves live data and cursor byte-for-byte unchanged; re-run finalization to prove idempotency.**
- [x] **Step 8: Run desktop database/repository tests, node typecheck and lint.**

## Task 13: Implement local badge/price lookups, number blocks, and offline Patta writes

**Files:**

- Create: `apps/desktop/src/main/local/worker-local.repository.ts`
- Create: `apps/desktop/src/main/local/badge-local.repository.ts`
- Create: `apps/desktop/src/main/local/model-local.repository.ts`
- Create: `apps/desktop/src/main/local/patta-local.repository.ts`
- Create: `apps/desktop/src/main/local/patta-number-block.repository.ts`
- Create: `apps/desktop/src/main/local/offline-patta.service.ts`
- Create: `apps/desktop/src/main/local/offline-patta.service.spec.ts`

Define these dependencies in the service module:

```ts
export interface Clock {
  nowIsoUtc(): string;
}
export interface LocalBlockConsumption {
  blockId: string;
  pattaNumber: string;
  shouldPrefetch: boolean;
}
export type LocalPattaOperationSnapshot = SyncPattaOperationSnapshotInput;
export interface LocalPattaRecord {
  id: string;
  partiya_number: string;
  patta_number: string;
  model_id: string;
  model_name_snapshot: string;
  template_id: string | null;
  konveyer_snapshot: string;
  razmer: string | null;
  rang: string | null;
  ish_soni: number;
  created_from_block_id: string;
  reference_versions: SyncPattaCreatePayload["reference_versions"];
  client_created_at: string;
  occurred_at: string;
  operations: readonly LocalPattaOperationSnapshot[];
}
export interface PattaCreateEventFactory {
  pattaCreate(input: {
    eventId: string;
    patta: LocalPattaRecord;
    referenceCursor: string;
    clientCreatedAt: string;
    occurredAt: string;
  }): OfflinePattaCreateEvent;
}
```

The service creates all identities before the transaction and enqueues the exact immutable payload within it:

```ts
const eventId = randomUUID();
const pattaId = randomUUID();
const clientCreatedAt = this.clock.nowIsoUtc();
const occurredAt = input.occurredAt;
const result = this.unitOfWork.transaction(() => {
  const allocation = this.blockRepository.consumeNext();
  const snapshot = this.modelRepository.snapshotAt(input.modelId, occurredAt);
  const patta = this.pattaRepository.createLocal({
    id: pattaId,
    ...allocation,
    ...snapshot,
  });
  this.syncQueueRepository.enqueue(
    this.eventFactory.pattaCreate({
      eventId,
      patta,
      referenceCursor: this.syncStateRepository.lastServerCursor(),
      clientCreatedAt,
      occurredAt,
    }),
  );
  return { patta, shouldPrefetch: allocation.shouldPrefetch };
});
```

- [x] **Step 1: Test badge lookup by badge-number string plus timestamp: before reassignment returns old worker ID; after reassignment returns new worker ID; absent assignment returns no worker.**
- [x] **Step 2: Test effective local prices before and after a `[valid_from,valid_to)` transition; assert decimal strings and never inspect `model_operations.price`.**
- [x] **Step 3: Test allocator exhaustion/promotion and parallel local calls over one block; each number must be unique and within inclusive range.**
- [x] **Step 4: Test exact 80% threshold (`consumed * 100 >= capacity * 80` using BigInt) and that server `reported_used_count` does not overwrite a greater local next number.**
- [x] **Step 5: Implement repository methods with parameterized SQL and stable ordering; use `BEGIN IMMEDIATE`/better-sqlite3 transaction for number consumption.**
- [x] **Step 6: Implement `OfflinePattaService.create(input)` resolving `last_server_cursor`, model/template/ACTIVE operations, effective price snapshots and local block number.** Generate Patta UUID, every operation snapshot UUID, and one event UUID exactly once.
- [x] **Step 7: In one SQLite transaction insert `LOCAL_PENDING` Patta, snapshots, advance only `local_next_number`, and enqueue the fully typed Patta event with `reference_cursor`, `client_created_at`, `occurred_at`, version context and immutable snapshot payload.** A forced queue error must roll back Patta and number consumption.
- [x] **Step 8: Return a typed `should_prefetch` signal at >=80%; do not perform network IO inside the local transaction.**
- [x] **Step 9: Run local service/repository tests under Electron runtime plus desktop typecheck/lint.**
- [x] **Step 10: Review and commit durable SQLite/offline Patta storage.** Run `git status` and `git diff --check`; commit `feat: add desktop offline persistence` with only desktop database/local service files and focused tests.

## Task 14: Implement authenticated transport boundary and single-flight SyncEngine

**Files:**

- Create: `apps/desktop/src/main/sync/authenticated-sync-transport.ts`
- Create: `apps/desktop/src/main/sync/rest-sync-transport.ts`
- Create: `apps/desktop/src/main/sync/network-status.service.ts`
- Create: `apps/desktop/src/main/sync/retry-policy.ts`
- Create: `apps/desktop/src/main/sync/sync-engine.ts`
- Create: `apps/desktop/src/main/sync/sync-engine.spec.ts`

**Interfaces produced:**

```ts
export interface AuthenticatedSyncTransport {
  deviceId(): string;
  push(request: Omit<SyncPushRequest, "device_id">): Promise<SyncPushResponse>;
  pull(request: Omit<SyncPullRequest, "device_id">): Promise<SyncPullResponse>;
  createBootstrap(): Promise<SyncBootstrapSession>;
  bootstrapPage(
    sessionId: string,
    after: string | null,
    limit: number,
  ): Promise<SyncBootstrapPage>;
  completeBootstrap(sessionId: string): Promise<void>;
  allocatePattaNumberBlock(): Promise<PattaNumberBlockProjection>;
  reportPattaBlockUsage(
    blockId: string,
    reportedUsedCount: string,
  ): Promise<PattaNumberBlockProjection>;
}
```

Single-flight wrapper shape:

```ts
private activeRun: Promise<SyncCycleResult> | null = null;

runOnce(): Promise<SyncCycleResult> {
  if (this.activeRun) return this.activeRun;
  const run = this.runCycle();
  this.activeRun = run.finally(() => { this.activeRun = null; });
  return this.activeRun;
}
```

- [x] **Step 1: Unit-test retry classification: network/timeout/502/503/504 transient; 400/401/403/409 non-transient; 401 delegates to the injected authenticated HTTP/session layer.**
- [x] **Step 2: Test single-flight behavior by calling `runOnce()` twice before the first promise resolves; both calls share one push/pull run.**
- [x] **Step 3: Test full cycle order: bootstrap when cursor absent; push stable event IDs; persist per-event SYNCED/CONFLICT/FAILED; pull one or more pages; atomically apply change and cursor; stop on empty/non-more page.** Also test a local `should_prefetch` signal while online calls allocation once, stores the returned next block, and later reports monotonically increasing usage through the existing Patta API.
- [x] **Step 4: Implement `AuthenticatedSyncTransport`; SyncEngine never stores access/refresh tokens, creates Authorization headers, or reads device identity directly.** REST adapter receives an `AuthenticatedHttpClient` and tenant API base URL through construction; the injected client owns Authorization and 401 refresh behavior.
- [x] **Step 5: Implement `NetworkStatusService` using real request outcomes, not `navigator.onLine`; represent `ONLINE`/`OFFLINE` and pending/conflict counts without blocking local work.**
- [x] **Step 6: Implement bounded retry schedule 5/15/30/60 seconds with jitter and cancellable timer; transport failure returns claimed `SYNCING` rows to `PENDING` with same `event_id`, incremented attempt count and last error.**
- [x] **Step 7: Implement push outcomes in one SQLite transaction per response: SYNCED persists returned authoritative Patta projection and change sequence; CONFLICT writes `sync_conflicts`; FAILED stores permanent error.**
- [x] **Step 8: Implement pull apply and `last_server_cursor` update in a single SQLite transaction; reject invalid/non-monotonic cursors and rollback the whole page on any projection error.**
- [x] **Step 9: Bootstrap pages go to SQLite staging; only all-pages-finalize advances cursor. If bootstrap fails/expires, discard only its staging rows and retain live mirrors/cursor/local pending Pattas.** Apply `DELETE` changes as local tombstones with their server sequence, never as an unsafe hard delete of referenced history.
- [x] **Step 10: During an online cycle, inspect local block prefetch candidates, allocate/store a next server block through `allocatePattaNumberBlock()`, and monotonically report block usage through `reportPattaBlockUsage()`.** Never perform these calls from the local SQLite transaction; preserve `local_next_number` independently from server-reported usage.
- [x] **Step 11: Add synced queue retention cleanup (default 30 days) that never deletes PENDING/SYNCING/CONFLICT/FAILED events; run Electron runtime tests and desktop typecheck/lint.**

## Task 15: Secure Electron IPC and remove starter unrestricted bridge

Before editing React renderer files, load `vercel-react-best-practices`; this task removes starter IPC/version access only and adds no broad UI workflow.

**Files:**

- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/renderer/src/App.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Versions.tsx`
- Test: `apps/desktop/src/main/sync/sync-engine.spec.ts` plus preload/main contract tests

Expose fixed IPC operations rather than `ipcRenderer` itself:

```ts
contextBridge.exposeInMainWorld("erp", {
  app: { getVersion: () => ipcRenderer.invoke("app:get-version") },
  sync: {
    status: () => ipcRenderer.invoke("sync:status"),
    run: () => ipcRenderer.invoke("sync:run"),
  },
  patta: {
    lookup: (partiyaNumber: string, pattaNumber: string) =>
      ipcRenderer.invoke("patta:lookup", { partiyaNumber, pattaNumber }),
  },
});
```

- [x] **Step 1: Add typed bridge tests for only `app.getVersion`, `sync.status`, `sync.run`, and the narrow local lookup methods required by the foundation; assert no `ipcRenderer`, process object, token or database handle appears.**
- [x] **Step 2: Set `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false` explicitly in BrowserWindow.**
- [x] **Step 3: Replace `electronAPI`/generic `api` exposure and unsafe fallback with a typed `window.erp` API that invokes fixed channel names only.** Keep database, fetch, timers, and SyncEngine in main.
- [x] **Step 4: Register IPC handlers after SQLite/repositories/services initialize; return sanitized Uzbek-readable status values, not raw queue payload/conflict JSON.**
- [x] **Step 5: Remove the `ping` handler and renderer `window.electron.ipcRenderer` use.** Replace starter version access with a narrow version method or remove the starter-only version widget; keep any visible strings Uzbek Latin.
- [x] **Step 6: Run renderer/node typechecks, lint, build and Electron runtime smoke launch.** Confirm Electron remains `44.4.5` and `better-sqlite3` rebuild hooks were not disabled.
- [x] **Step 7: Review and commit main-process synchronization and IPC.** Run `git status` and `git diff --check`; commit `feat: add desktop sync engine` with SyncEngine, transport, preload/main integration and unit tests.

## Task 16: Real PostgreSQL/SQLite concurrency and two-PC acceptance

**Files:**

- Create/modify: `apps/api/src/tenant/sync/sync.integration.spec.ts`
- Create: `apps/desktop/src/main/sync/two-client-sync.integration.spec.ts`
- Modify: `apps/api/package.json`

The real concurrency assertion sends the identical event through ten API transactions:

```ts
const outcomes = await Promise.all(
  Array.from({ length: 10 }, () =>
    processor.process(tenant.dataSource, validatedContext, event),
  ),
);
expect(outcomes.map((result) => result.status)).toEqual(
  Array(10).fill("SYNCED"),
);
const pattaRows: Array<{ count: string }> = await tenant.dataSource.query(
  'SELECT count(*)::text AS count FROM "patta_hisob" WHERE "id" = $1::uuid',
  [pattaId],
);
const eventRows: Array<{ count: string }> = await tenant.dataSource.query(
  'SELECT count(*)::text AS count FROM "processed_sync_events" WHERE "event_id" = $1::uuid',
  [event.event_id],
);
expect(pattaRows[0]?.count).toBe("1");
expect(eventRows[0]?.count).toBe("1");
```

Two-PC test orchestration: the API PostgreSQL integration test starts the real tenant-authenticated Nest HTTP app on an ephemeral loopback port, creates two active Master devices and tenant permissions, supplies short-lived test tenant tokens/device IDs to the child process, and asynchronously spawns `npm run test --workspace=apps/desktop -- src/main/sync/two-client-sync.integration.spec.ts`. Keep the parent event loop alive so the real API serves the Electron-runtime child. The desktop test opens two independent temporary SQLite files and uses the real HTTP transport; it must not use an in-memory fake for push/pull.

Spawn the child without blocking the test server event loop:

```ts
import { spawn, type ChildProcess } from "node:child_process";

function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Desktop acceptance child exited: code=${code}, signal=${signal}`,
          ),
        );
    });
  });
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath)
  throw new Error("npm_execpath is required for the two-PC acceptance runner");
const child = spawn(
  process.execPath,
  [
    npmExecPath,
    "run",
    "test",
    "--workspace=apps/desktop",
    "--",
    "src/main/sync/two-client-sync.integration.spec.ts",
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      SYNC_TEST_API_BASE_URL: testApiBaseUrl,
      SYNC_TEST_TENANT_HOST: tenantHost,
      SYNC_TEST_TENANT_TOKEN: tenantAccessToken,
      SYNC_TEST_DEVICE_PC1: devicePc1.id,
      SYNC_TEST_DEVICE_PC2: devicePc2.id,
    },
    stdio: "inherit",
  },
);
await waitForSuccessfulExit(child);
```

`waitForSuccessfulExit` is a local Promise over the child's `error`/`exit` events; test credentials remain process-local and are never printed or persisted.

- [x] **Step 1: Add real PostgreSQL event harness using generated `tenant_test_<uuid>` databases and the existing `TenantTestDatabaseCleanup`; never accept arbitrary database names or use `textile_master`.**
- [x] **Step 2: Test ten serial deliveries of the same event ID and two concurrent same-ID transactions.** Assert one Patta, one processed event row, same result and one change sequence.
- [x] **Step 3: Test same event ID/different fingerprint returns `EVENT_ID_REUSE_MISMATCH`; conflict event retried ten times returns the stored conflict and handler call count remains one; injected 500 rolls reservation back so retry applies once.**
- [x] **Step 4: Test three-event partial results `SYNCED/CONFLICT/SYNCED`, immutable event results, transaction rollback parity and a real pull page sequence with no duplicate/loss across `cursor=0`, first page, next cursor, next page.**
- [x] **Step 5: Test bootstrap with more than one page, stable order, wrong device/tenant, expiry, replacement-session limit and bounded cleanup; verify no auth/password/audit projections.** For bootstrap-first-sync coverage, apply migrations only through `20260926000500`, seed all nine reference entities, then apply migration `20260926000600` and assert the first materialized snapshot contains those pre-existing rows despite an empty change log.
- [x] **Step 6: Coordinate concurrent mutation at bootstrap barriers.** A mutation committed before watermark is reflected in the staged snapshot; a mutation that waits behind the global lock commits after release with sequence greater than watermark and is returned by pull. While projection materialization is blocked on a test barrier, an ordinary writer must complete, proving the global lock was released.
- [x] **Step 7: Test page-3-of-10 desktop crash: staged pages persist, live mirror and cursor do not advance, and restart/new bootstrap reconciles safely.** Seed a `LOCAL_PENDING`/`CONFLICT` Patta before re-bootstrap and assert its row and snapshots survive reconciliation.
- [x] **Step 8: Test local offline Patta UUID/snapshot UUIDs, server push, response-loss retry with the same event ID, pull echo UPSERT to the same single row, and second local DB pull followed by offline Patta lookup.** Assert echo marks ownership `SERVER_SYNCED` without changing the immutable local operation snapshot JSON.
- [x] **Step 9: Test two tenants with overlapping local worker IDs/names/business values and two devices; neither bootstrap nor pull crosses tenant/device boundaries.**
- [x] **Step 10: Test old/new effective price history and old/new badge worker resolution after pull; test concurrent local number block allocation, next-block promotion, exhaustion and 80% prefetch.**
- [x] **Step 11: Add `test:sync` API script targeting `src/tenant/sync/sync.integration.spec.ts`; the desktop Electron test runner was added in Task 11.** In the PostgreSQL suite, asynchronously spawn the desktop acceptance test with loopback API URL, temporary DB path, tenant token, and each validated device ID; await child exit without blocking the API event loop.
- [x] **Step 12: Run real PostgreSQL sync tests with all five `TEST_MASTER_DB_*` settings pointing to a dedicated `_test` database; without them report blocked, not pass.**

## Task 17: Documentation, regression verification, and feature delivery

**Files:**

- Modify: `docs/sync-protocol.md`
- Modify: `docs/database.md`
- Modify: `docs/testing.md`
- Final review: all changed API/desktop/shared files

- [x] **Step 1: Document event/projection DTO versions, errors, permissions, idempotency/fingerprint/device binding, endpoints, retry and conflict behavior in `docs/sync-protocol.md`.**
- [x] **Step 2: Document migration tables/grants, one-lock sequence ordering, bootstrap snapshot/session/page/expiry/cleanup semantics, local DB boundaries and conservative stale-Patta limitation in `docs/database.md`.**
- [x] **Step 3: Document dedicated PostgreSQL environment, Electron-ABI SQLite test command, concurrency/race and two-PC suites in `docs/testing.md`.**
- [x] **Step 4: Run the required API commands:**

```powershell
npm run lint --workspace=apps/api
npm run typecheck --workspace=apps/api
npm run test --workspace=apps/api
npm run test:e2e --workspace=apps/api
npm run build --workspace=apps/api
npm run test:sync --workspace=apps/api
```

- [x] **Step 5: Run the required desktop commands:**

```powershell
npm run lint --workspace=apps/desktop
npm run typecheck --workspace=apps/desktop
npm run test --workspace=apps/desktop
npm run build --workspace=apps/desktop
```

- [x] **Step 6: Run real regression suites:**

```powershell
npm run test:tenant-provisioning --workspace=apps/api
npm run test:models-operations --workspace=apps/api
npm run test:workers-badges --workspace=apps/api
npm run test:patta --workspace=apps/api
```

- [x] **Step 7: Review all changes with `git status`, `git diff --check`, `git diff`, and `git log --oneline -10`; verify only `feature/offline-sync`, no secret changes, no generated renderer artifacts, no migration edits to prior migrations, and no Electron version drift.**
- [x] **Step 8: Commit the documentation and regression closeout as `docs: complete offline sync documentation`; keep all previously committed implementation checkpoints and the design commit `b6bf289` intact.**
- [x] **Step 9: Push only `feature/offline-sync` with `git push -u origin feature/offline-sync`; record the actual result and commit hash.**

## Completion criteria

- API and desktop use the same shared protocol types.
- Duplicate/concurrent event delivery produces one business write; mismatched payload identity cannot reuse an event ID.
- Push returns per-event outcomes; conflict result is stored and stable; infra failure leaves no processed reservation.
- Every current reference/Patta mutation emits an immutable change projection in its source transaction.
- Pull sequence ordering and cursor are deterministic and serialized; cursors remain decimal strings.
- Bootstrap creates a consistent nine-entity materialized snapshot with no long-lived request transaction, uses keyset pages, enforces device/tenant/expiry/resource limits, and cannot lose concurrent mutations.
- Desktop stages all bootstrap pages, atomically reconciles live mirrors/cursor, and preserves local pending/conflict/failed Pattas.
- Local Patta, UUID snapshots, local block consumption, and queue event commit atomically; effective historical price and badge identity lookup are correct.
- SyncEngine is single-flight, token-agnostic, retries transient failures without changing event IDs, persists conflicts, applies pull+cursor atomically, and handles server echo idempotently.
- Tenant/device isolation, two-PC acceptance, PostgreSQL concurrency tests and Electron-ABI SQLite tests pass.
- API/desktop lint, typecheck, tests, e2e where applicable, build, regression suites, documentation, commit and push are complete.
