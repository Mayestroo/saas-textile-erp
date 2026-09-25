# Toolchain Compatibility Design

## Goal

Make the API, desktop, and platform-admin workspaces build, lint, and test with the repository's currently selected TypeScript 7, Vite 8, and ESLint 10 toolchain. Keep Electron pinned to `44.4.5` and preserve current application behavior and security settings.

## Current incompatibilities

- Nest CLI 12 initializes TypeScript's compiler API before selecting its builder, which TypeScript 7.0.2 does not expose; even its SWC builder therefore fails before compilation.
- `electron-vite` 5 accepts Vite 5–7, while the installed React Vite plugin 6 requires Vite 8.
- `eslint-plugin-react` 7.37.5 uses the pre-ESLint-10 rule context API.
- Vitest's default TypeScript transform does not emit the constructor type metadata Nest's testing module uses for dependency injection.

## Design

### API build and tests

Use `@swc/cli` directly for JavaScript emission, configured for legacy decorators and decorator metadata. Keep TypeScript 7 and make the API build run a separate `tsc --noEmit` typecheck before SWC, so moving off Nest CLI compilation does not remove type validation. Use SWC watch mode with Node's built-in watch mode for API development scripts, avoiding Nest CLI startup paths that require the unavailable compiler API. Configure Vitest's transform with SWC decorator metadata as well, preserving the existing Nest testing-module test instead of weakening it to a direct controller call.

### Desktop build

Replace `electron-vite` with `vite-plugin-electron`, which supports Vite 8. Keep the existing Vite 8 and React plugin 6 versions. The renderer currently accesses Electron only through preload, so do not add a Node/Electron renderer shim. Adapt the Vite config, workspace scripts, and Electron package entry/output paths to the new integration. Preserve existing IPC/preload behavior and do not change BrowserWindow security settings or Electron's exact version pin.

### Desktop lint

Keep ESLint 10 and the current React rules. Wrap the legacy React plugin using `@eslint/compat` so its rules receive the context methods they expect under ESLint 10. Keep the React Hooks plugin and verify all existing lint targets.

### Lockfile and install scripts

Update the affected workspace package manifests, the root package manifest when needed to resolve the shared Vite 8 toolchain, and the root npm lockfile only; do not add nested lockfiles. Do not approve native or other package install scripts as part of this change; report any resulting environment limitation separately.

## Validation

Run the root `npm run build`, `npm run lint`, and `npm run test` commands, plus focused workspace checks if a failure needs isolation. Confirm the API test exercises Nest dependency injection and confirm the desktop production bundle resolves its configured main, preload, and renderer outputs.

## Scope boundaries

No business logic, data model, API contract, UI behavior, Electron security setting, or Electron version changes are included. The platform-admin toolchain is left intact unless workspace-wide validation reveals a failure caused by this change.
