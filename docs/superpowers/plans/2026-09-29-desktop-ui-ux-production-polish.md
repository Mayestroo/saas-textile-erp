# Desktop UI/UX Production Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved desktop polish design, including screenshot-matched Model hisob, standalone Patta Entry, and offline-synced manual Model hisob additions without rewriting existing Patta quantity or historical-price invariants.

**Architecture:** Implement four separately testable workstreams in dependency order: tenant display/permission projection; Standalone Entry contracts; manual Model hisob adjustment contracts; then renderer shell and pages. All renderer mutations go through narrow typed preload methods to Electron main, local-first SQLite transactions, and the existing idempotent sync engine.

**Tech Stack:** NestJS/TypeScript, PostgreSQL migrations, shared `@textile/sync-protocol`, Electron main/preload, SQLite `better-sqlite3`, React 19, Vite/Vitest, CSS.

## Global Constraints

- Work only on `feature/desktop-ui-ux`; do not merge to `main`.
- Electron remains exactly `44.4.5`; keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- No renderer direct HTTP, SQLite, filesystem, or unrestricted IPC.
- Tenant records stay in tenant databases; server permission checks remain authoritative.
- Preserve Patta/Partiya allocation, Patta-linked duplicate rules, `ish_soni`, worker ID, badge history, `entered_at`, sync idempotency, two-way sync, and conflict behavior.
- Patta-linked `quantity_snapshot` remains equal to Patta `ish_soni`; manual additions are a separate model-account source and never update a Patta row.
- Add SyncProtocolVersion 3 as a superset; keep V1/V2 semantics intact and return `SYNC_PROTOCOL_UPGRADE_REQUIRED` to V2 clients before cursor advancement when V3-only data is present.
- Keep price snapshots immutable; calculate gross `Jami so‘m` with decimal-safe amounts from each contribution’s snapshot, never today’s price.
- Normal operator UI copy is Uzbek Latin; no General Oylik Hisobot, net payroll formula, or month-close action in this phase.
- Use root npm workspaces and the root `package-lock.json`; do not create nested lockfiles.
- New offline writes are local SQLite transactions plus stable-ID queue events; do not create a parallel sync transport.

## Workstream order and dependencies

1. [`2026-09-29-desktop-auth-permission-projection.md`](2026-09-29-desktop-auth-permission-projection.md) — company display name and cached effective permissions.
2. [`2026-09-29-standalone-patta-entry.md`](2026-09-29-standalone-patta-entry.md) — PATTA_LINKED/STANDALONE Entry migration, local flow, server validation, sync.
3. [`2026-09-29-model-account-adjustments.md`](2026-09-29-model-account-adjustments.md) — separate manual adjustments, their price snapshots, sync, and mixed-source aggregation.
4. [`2026-09-29-desktop-renderer-polish.md`](2026-09-29-desktop-renderer-polish.md) — component system, app shell, existing pages, Model create/account, and Konveyer report.

Workstream 2 establishes the V3 sync envelope and linked/Standalone Entry projection. Workstream 3 follows workstream 2 because it extends V3 with manual adjustments, and is independently tested. Workstream 4 consumes all three contracts. Close each workstream with its tests and a focused commit before beginning the next.

## Final acceptance commands

From repository root, run:

```powershell
npm run lint --workspace=apps/desktop
npm run typecheck --workspace=apps/desktop
npm run test --workspace=apps/desktop
npm run build --workspace=apps/desktop
npm run lint --workspace=apps/api
npm run typecheck --workspace=apps/api
npm run test --workspace=apps/api
npm run build --workspace=apps/api
git diff --check
```

API database integration commands are `npm run test:patta --workspace=apps/api`, `npm run test:patta-sheets --workspace=apps/api`, and `npm run test:sync --workspace=apps/api`; they count as passes only when their configured PostgreSQL `_test` database tests actually run, not when skipped. Launch Electron with `npm run dev --workspace=apps/desktop` for runtime smoke and inspect screenshots at 1280×720, 1366×768, and 1920×1080. Print review covers 1, 2, 3, and 13 Pattas (13 = 7 A4 pages, final slot blank).
