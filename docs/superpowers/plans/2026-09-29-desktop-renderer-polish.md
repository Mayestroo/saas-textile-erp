# Desktop Renderer UI/UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved screenshots into a consistent, permission-aware desktop UI and make the existing/new typed flows usable without a mouse.

**Architecture:** Replace the centered starter layout with a collapsible sidebar/app header and small internal UI primitives. Screen state remains in React, but all reads/writes cross narrow preload APIs to the main process. Patta/manual business operations continue to use the repositories, API services, and sync contracts implemented in the preceding plans.

**Tech Stack:** React 19, TypeScript, CSS custom properties, Electron 44.4.5, Vite 8, Vitest 5, `@testing-library/react`, `@testing-library/user-event`, `jsdom`.

## Dependencies

This plan consumes safe company/permission projections from `2026-09-29-desktop-auth-permission-projection.md`, the linked/Standalone Entry contract from `2026-09-29-standalone-patta-entry.md`, and manual adjustment/report IPC from `2026-09-29-model-account-adjustments.md`. Do not start final page integration before those typed contracts land.

## Global Constraints

- Work only on `feature/desktop-ui-ux`.
- UI copy is Uzbek Latin; empty values render `—` or `Noma’lum` according to the field meaning.
- No License, Payroll, General Oylik Hisobot, or Oyni yopish menu/action in this phase.
- Sidebar contains only implemented routes; `Patta-Hisob (Jurnal)` maps to Kiritilgan Pattalar, `Konveyer` opens the specified read-only production report.
- Keep Electron sandbox/context isolation settings; renderer never receives raw HTTP, filesystem, SQLite or unrestricted IPC.
- `Patta` linked quantity remains immutable/read-only. Model-account `Soni` additions are manual adjustment records, never mutations of Patta quantities.
- Current operation rate is labelled `Amaldagi narx`; historic money totals use each Patta/manual source’s `unit_price_snapshot`.
- Badge keystrokes resolve against local SQLite; no network request per keystroke. Do not add virtualization/memoization until measured row counts or profiling require it.
- Desktop uses root workspaces and lockfile; do not add a large UI framework.

## File map

- Test setup: `apps/desktop/vitest.config.mts`, renderer component `*.spec.tsx`, `src/renderer/src/test/mock-erp-api.tsx`.
- Tokens/primitives: new `src/renderer/src/assets/tokens.css` and `src/renderer/src/components/ui/{actions,forms,feedback,overlay,layout,data-table}.tsx`.
- Safe UI errors: new `src/renderer/src/lib/operator-error-message.ts` and unit specs.
- Shell: new `components/shell/{AppShell,Sidebar,AppHeader}.tsx`; modify `App.tsx` and `assets/main.css`.
- Pages: `PattaPrintPage.tsx`, `PattaEntryPage.tsx`, `PattaHistoryPage.tsx`, `PattaTrashPage.tsx`, `ModelAccountPage.tsx`; add `ModelCreatePage.tsx`, `ConveyorAccountPage.tsx`.
- Main/preload methods: new `apps/desktop/src/main/api/tenant-model-api.ts`, `src/main/auth/desktop-tenant-runtime.ts`, `src/main/ipc/register-ipc-handlers.ts`, `src/preload/erp-api.ts`, and IPC tests.

### Task 1: Renderer test environment and API fixtures

**Files:**
- Modify: `apps/desktop/package.json`, `apps/desktop/vitest.config.mts`.
- Create: `apps/desktop/src/renderer/src/test/mock-erp-api.tsx` and a small smoke component spec.

- [ ] Install only the lightweight DOM test dependencies from repository root: `npm install -D --workspace=apps/desktop jsdom @testing-library/react @testing-library/user-event`.
- [ ] Extend Vitest `include` to `src/main/**/*.spec.ts` and `src/renderer/**/*.spec.tsx`; keep default environment `node` and set `// @vitest-environment jsdom` only in renderer specs.
- [ ] Add `mockErpApi(overrides)` with typed default implementations for every `window.erp` method. A test must fail if a UI invokes an unconfigured method.
- [ ] Add this smoke component test with a real user interaction assertion:

```tsx
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from '../components/ui/actions'

function ButtonDemo(): React.JSX.Element {
  const [status, setStatus] = React.useState('')
  return <>
    <Button onClick={() => setStatus('Saqlandi')}>Saqlash</Button>
    <p role="status">{status}</p>
  </>
}

it('renders an Uzbek-labeled primary action and announces success', async () => {
  const user = userEvent.setup()
  render(<ButtonDemo />)
  await user.click(screen.getByRole('button', { name: 'Saqlash' }))
  expect(screen.getByRole('status').textContent).toBe('Saqlandi')
})
```

- [ ] Run `npm run test --workspace=apps/desktop` and confirm both the Electron-compatible main tests and renderer DOM test execute.

### Task 2: Design tokens and reusable primitives

**Files:**
- Create: `assets/tokens.css` and `components/ui/actions.tsx`, `forms.tsx`, `feedback.tsx`, `overlay.tsx`, `layout.tsx`, `data-table.tsx`.
- Modify: `src/renderer/src/main.tsx`, `assets/base.css`, `assets/main.css`.

**Required component interfaces:**

```ts
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet'
  pending?: boolean
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm(): void
  onCancel(): void
}
```

- [ ] Add token tests for semantic CSS variables and focus-ring visibility; use neutral/light surfaces and calm green active/success accents, amber warning, red destructive/error.
- [ ] Implement labeled Button/IconButton, Input/SearchInput, Select, Checkbox, Badge/StatusBadge, Dialog/ConfirmDialog, Table, Empty/Error/Loading states, Toast, Tooltip, Tabs, PageHeader/SectionHeader, Toolbar, Card and FormField in the grouped component files above.
- [ ] Use semantic buttons/labels/ARIA, keyboard focus indicators, reduced-motion CSS, focus trap for dialogs and safe Escape handling.
- [ ] Add component tests for disabled/pending/destructive buttons, labeled forms, dialog focus/escape, toast `role=status`, and color-independent status labels.
- [ ] Run `npm run lint --workspace=apps/desktop`, `npm run typecheck --workspace=apps/desktop`, and `npm run test --workspace=apps/desktop`.

### Task 3: App shell, permissions, sync status and login

**Files:**
- Create: `components/shell/AppShell.tsx`, `Sidebar.tsx`, `AppHeader.tsx`.
- Modify: `src/renderer/src/App.tsx`, `assets/main.css`, renderer tests.

- [ ] Add a permission predicate `hasPermission(permissionCodes, code)` that returns false for an empty/missing projection; test each supported page/action mapping.
- [ ] Test error sanitization: `new Error('SQLITE_BUSY')` and a raw JSON message return the supplied fallback; a recognized `BADGE_NOT_FOUND` returns `Jeton topilmadi`.
- [ ] Move the existing routes into the collapsible screenshot-matched sidebar: Patta chiqarish, Patta kiritish, Patta-Hisob (Jurnal/Kiritilgan Pattalar), Korzinka, Model hisob; add Model tree, Model qo‘shish and Konveyer hisobi when their typed interfaces are present. Do not render inactive/unimplemented General Oylik, Payroll, or License links.
- [ ] Add header title, Master company `name`, signed-in user, connectivity/sync status, pending count, conflict warning and logout. Map statuses to `Sinxronlandi`, `Sinxronlanmoqda`, `Internet yo‘q`, `Ziddiyat mavjud`; offline remains a calm nonblocking state.
- [ ] Keep current 2-second session/sync polling or replace it only with the same typed calls; avoid duplicate unbounded polls.
- [ ] Restyle login as `Korxona`, `Email`, `Parol`, `Kirish`; map known codes to Uzbek Latin, never show raw JSON, and retain existing password clearing before and after submit.
- [ ] Add `operatorErrorMessage(error, fallback)` that recognizes supported auth/Patta/model/manual error codes and returns a fixed Uzbek Latin message; unknown Error/JSON/SQLite/stack text returns only the supplied fallback. Replace page-level direct `error.message` rendering with this formatter.
- [ ] Add component tests for sign-in pending/offline/wrong-password/company/device states, password cleanup, permission route/action visibility, empty permission cache fail-closed behavior, offline status and conflicts.
- [ ] Run desktop lint/typecheck/test.

### Task 4: Patta chiqarish and persisted-batch print preview

**Files:**
- Modify: `pages/PattaPrintPage.tsx`, `components/ui/overlay.tsx`, `assets/main.css`, renderer specs.
- Verify `src/main/local/patta-print-document.ts` and `patta-print-document.spec.ts` against stored-batch output; change a print-layout rule only if the explicit A4/two-up/page-count test fails.

- [ ] Preserve model selection, positive `ish_soni`, rang, size distribution, allocator-owned Partiya/Patta numbers, correction reason/version and existing print-event behavior.
- [ ] Add an accessible preview action using the persisted `DesktopPattaPrintBatchResult`: A4 portrait, two Pattas per page, batch summary, model/partiya/patta/quantity/rang/size/date/operations/Jeton lines. The preview must not allocate or mutate batch state.
- [ ] Keep `Pechat qilish` and `Qayta pechat` on the existing narrow `window.erp.pattaPrint.printBatch(batchId)` route; renderer must not invoke raw Electron APIs.
- [ ] Test preview ordering and 1/2/3/13 Patta slot counts; 13 produces 7 pages with a blank final slot. Preserve existing HTML escaping and `@page A4` print test.
- [ ] Run desktop tests/build and inspect the preview at the three target window sizes.

### Task 5: Keyboard-first linked and Standalone Patta Entry

**Files:**
- Modify: `pages/PattaEntryPage.tsx`, `App.tsx` if entry-selection state is needed, renderer tests.
- Consume: `pattaSheet.lookup`, `pattaSheet.get`, `pattaSheet.models`, `pattaSheet.modelOperations`, `pattaSheet.resolveBadge`, `pattaSheet.create`, `pattaSheet.update`, and permission projection from earlier plans.

- [ ] Render one default-ON switch beside Partiya/Patta fields. ON requires both and calls existing local-first lookup; OFF never calls Patta lookup even when both informational values are filled.
- [ ] Linked mode presents model/partiya/patta/ish_soni/rang/razmer/printed date as read-only auto values. Standalone mode requires an active model and positive `ish_soni`; Partiya/Patta are optional informational values, Rang/Razmer/Konveyer optional; missing IDs display `Noma’lum`.
- [ ] Add the dense spreadsheet grid with operation name/price, Jeton, worker, Nuqson, and separate O‘chirish. Quantity is not an editable column. Resolve badges locally on Enter, display `Topilmadi` and hold focus on invalid rows, advance to the next Jeton on valid resolution, save on last Enter, show `Patta kiritildi`, and focus the first lookup field.
- [ ] Add custom operation form using the existing domain method and same-model price snapshot rules. Add edit-existing Entry state without changing `entry_kind` or `entered_at`; map version conflicts to `Ma’lumot boshqa qurilmada o‘zgartirilgan`.
- [ ] Test linked auto metadata, Standalone metadata/quantity, no Patta lookup in OFF, valid/invalid badges, deterministic Enter focus, worker_id-required save, Nuqson/O‘chirish independence, custom operations, edit and version conflict.
- [ ] Run desktop focused renderer and main tests.

### Task 6: Kiritilgan Pattalar tables and Korzinka

**Files:**
- Modify: `pages/PattaHistoryPage.tsx`, `pages/PattaTrashPage.tsx`, `App.tsx`, `components/ui/data-table.tsx`, renderer tests.
- Consume: typed Entry history/get methods, local ownership/sync status and actor-name snapshot.

- [ ] Replace history cards with a compact table: date, partiya, patta, model, size, color, ish soni, conveyor, sync/status, actions. Show standalone blanks as `Noma’lum`; support search, date/model/sync filters and pagination without new virtualization dependency.
- [ ] Add View/Edit/O‘chirish actions under their respective permission codes. O‘chirish soft-trashes through the existing Entry lifecycle and confirmation.
- [ ] Add Korzinka table columns from the spec, show deleted actor name snapshot (old missing snapshots display `Noma’lum`), restore with a safe action, and purge with destructive confirmation text `Bu amalni ortga qaytarib bo‘lmaydi.`.
- [ ] Ensure manual account adjustments are not confused with Patta Entry rows or Patta Korzinka items; their source breakdown/restore controls remain in the Model-account adjustment detail.
- [ ] Test history search/filter/page actions, standalone display, read-only entered_at, trash/restore/purge confirmations and sync state labels.
- [ ] Run desktop lint/typecheck/test.

### Task 7: Model create and operation management

**Files:**
- Create: `apps/desktop/src/renderer/src/pages/ModelCreatePage.tsx`, `apps/desktop/src/main/api/tenant-model-api.ts`.
- Modify: sidebar model tree, `src/preload/erp-api.ts`, `src/main/auth/desktop-tenant-runtime.ts`, `src/main/ipc/register-ipc-handlers.ts`, and tests.
- Consume: effective permissions and existing Models/Operations REST contracts.

**Typed main/preload interfaces produced:**

```ts
interface DesktopModelRecord {
  id: string
  name: string
  status: 'ACTIVE' | 'INACTIVE'
  version: string
}

interface DesktopOperationRecord {
  id: string
  model_id: string
  name: string
  price: string
  sort_order: number
  status: 'ACTIVE' | 'INACTIVE'
  version: string
}

interface DesktopOperationPriceChange {
  operation_id: string
  price: string
  valid_from: string
  valid_to: string | null
  operation_version: string
}

interface ModelsApi {
  list(): Promise<readonly DesktopModelRecord[]>
  create(input: { name: string }): Promise<DesktopModelRecord>
}

interface OperationsApi {
  listByModel(modelId: string): Promise<readonly DesktopOperationRecord[]>
  create(modelId: string, input: { name: string; price: string; sort_order: number }): Promise<DesktopOperationRecord>
  changePrice(operationId: string, input: { price: string; expected_version: string }): Promise<DesktopOperationPriceChange>
  setStatus(operationId: string, input: { status: 'ACTIVE' | 'INACTIVE'; expected_version: string }): Promise<DesktopOperationRecord>
}
```

`models.list()` and `operations.listByModel()` read the local mirror (including effective price at current tenant time). Create/price/status mutations use fixed authenticated API methods in main process and pull after server success; renderer never receives a generic request URL.

- [ ] Add narrow typed main-process methods for model create and operation create/change-price/deactivate via the existing authenticated HTTP client. `models.list()` and `operations.listByModel()` read local mirrors so the model tree and current effective price remain available offline; model/operation mutations require internet, then run the existing sync pull.
- [ ] Add Model qo‘shish route under `models.manage`; create by existing `POST /api/v1/models`, show server duplicate-name errors safely, and navigate to the new model’s account after sync.
- [ ] Add operation `Faolsizlantirish` action (not hard delete), with versioned API update, confirmation, and history preserved.
- [ ] Test Model list/create permissions, duplicate-name mapping, offline-disabled mutations, operation create/deactivate, price update’s expected-version conflict, and history preservation.
- [ ] Run desktop focused IPC/page tests and `npm run typecheck --workspace=apps/desktop`.

### Task 8: Editable Model hisob manual additions and source details

**Files:**
- Modify: `apps/desktop/src/renderer/src/pages/ModelAccountPage.tsx` and renderer specs.
- Consume: `modelAccount.addManual/updateManual/trashManual/restoreManual/workerDetails` from the Model-account adjustment plan.

- [ ] Render operation groups with current effective-price row and manual-inclusive editable `Soni`; show `Jami dona` and snapshot-priced gross `Jami so‘m` as strings.
- [ ] Allow `Amaldagi narx` edit only with `models.manage`; explicit save calls `OperationsApi.changePrice` with the displayed operation version, is disabled offline, and refreshes the local mirror after sync. Existing Patta/manual price snapshots remain unchanged.
- [ ] Double-click/Enter on a `Soni` cell opens source detail: Patta-derived amount, separate manual records, `+ Qo‘lda qo‘shish`, edit quantity, trash and restore. Gate all manual mutations on `patta.hisob.manual_manage` and submit expected versions.
- [ ] Double-click/keyboard activate a worker row and call `workerDetails(worker_id)`; show all models/operations and source `PATTA` versus `MANUAL` amounts using permanent worker ID.
- [ ] Test that manual addition changes the Model hisob quantity and gross amount but leaves Patta `ish_soni`/rows unchanged, historical price changes do not alter prior totals, and trash/restore subtracts/restores only manual contributions.
- [ ] Run focused ModelAccountPage and main manual-adjustment tests.

### Task 9: Offline Conveyor hisobi report

**Files:**
- Create: `apps/desktop/src/renderer/src/pages/ConveyorAccountPage.tsx` and renderer specs.
- Modify: sidebar route and `App.tsx`.
- Consume: `window.erp.conveyorAccount.get()` and `ConveyorAccountRow` from the Model-account adjustment plan.

- [ ] Render model/conveyor filters and a read-only table with Patta count, Standalone Entry count, manual-add count, and total work count. Missing conveyor and manual additions without a conveyor go to `Noma’lum`.
- [ ] Test mixed source totals, unknown bucket, excluded trash rows, operation-row non-duplication, filtering, empty/error/loading states, and offline local query.
- [ ] Run focused Conveyor page and query tests.

### Task 10: Visual, accessibility and Electron review

**Files:** renderer specs and any affected CSS/page fixes only.

- [ ] Inspect Login, Patta chiqarish/preview, both Patta Entry modes, history, Korzinka, Model qo‘shish, Model hisob, and Konveyer hisob at 1280×720, 1366×768, 1920×1080.
- [ ] Verify focus visibility, keyboard-only lookup→badge→save→reset flow, dialog focus/escape, sticky table identity/header, overflow, no clipped Uzbek labels, calm offline state, and destructive confirmation.
- [ ] Launch `npm run dev --workspace=apps/desktop`; verify Electron starts with sandbox/contextIsolation intact and typed preload methods work.
- [ ] Print persisted batches with 1, 2, 3, and 13 Pattas; verify A4 two-up, last blank slot, readable monochrome, and no shell chrome.
- [ ] Run the exact desktop/API commands in the parent plan and inspect `git status`, `git diff`, and `git diff --check`.
- [ ] Commit the completed renderer workstream as `feat: polish desktop ERP user experience`; push only the feature branch after all approved workstreams pass.
