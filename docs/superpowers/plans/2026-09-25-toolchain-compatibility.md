# Toolchain Compatibility Implementation Plan

> **For agentic workers:** Execute the steps in order and validate each workspace before moving to the next.

**Goal:** Make the API and desktop builds, desktop lint, and API Nest test work with the selected TypeScript 7, Vite 8, and ESLint 10 versions.

**Architecture:** Use SWC to transpile Nest API code while invoking the TypeScript 7 CLI separately for type checking. Replace electron-vite with the Vite 8-compatible vite-plugin-electron integration, while keeping React isolated in the renderer behind the current preload. Wrap the legacy React ESLint plugin with ESLint's compatibility utilities.

**Tech Stack:** npm workspaces, TypeScript 7, NestJS 12, SWC, Vitest 5, Vite 8, React plugin 6, vite-plugin-electron 1, ESLint 10.

## Global Constraints

- Keep `"electron": "44.4.5"` exactly pinned.
- Keep the selected TypeScript 7, Vite 8, React plugin 6, and ESLint 10 versions; do not downgrade them to work around the compatibility failures.
- Keep renderer access to Electron limited to the existing preload boundary; do not add a Node/Electron renderer shim.
- Preserve the current `BrowserWindow` security settings during this build-tooling change.
- Update workspace package manifests, root `package.json` for the shared Vite 8 resolution, and root `package-lock.json`; do not add nested lockfiles.
- Do not approve package install scripts as part of this work.

---

### Task 1: Use SWC for API compilation and metadata-aware tests

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/.swcrc`
- Modify: `apps/api/vitest.config.ts`
- Modify: root `package-lock.json`

**Interfaces:**
- Produces API scripts `typecheck`, `build`, and SWC-based Node start/watch commands; `build` typechecks with the TypeScript CLI before compiling directly through `@swc/cli`.
- Produces a Vitest transformer that emits the legacy decorator metadata required by `@nestjs/testing`.

- [x] **Step 1: Confirm the existing API test is red**

Run from the repository root:

```powershell
npm run test --workspace=apps/api
```

Expected before the fix: the existing `AppController` test fails because `appService` is undefined.

- [x] **Step 2: Add only the SWC packages needed by Nest and Vitest**

Run from the repository root:

```powershell
npm install --workspace=apps/api --save-dev @swc/cli@0.8.1 @swc/core@1.16.2 unplugin-swc@2.0.0
```

- [x] **Step 3: Configure direct SWC compilation and the TypeScript CLI check**

Create `apps/api/.swcrc`:

```json
{
  "$schema": "https://swc.rs/schema.json",
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "decorators": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    },
    "keepClassNames": true,
    "target": "es2022"
  },
  "module": {
    "type": "es6"
  },
  "sourceMaps": true
}
```

In `apps/api/package.json`, use direct SWC compilation for build and Node start scripts:

```json
"build": "npm run typecheck && swc src --out-dir dist --config-file .swcrc --ignore \"**/*.spec.ts\" --strip-leading-paths --delete-dir-on-start",
"start": "npm run build && node dist/main.js",
"start:dev": "npm run build && concurrently -k \"npm run watch:compile\" \"node --watch dist/main.js\"",
"start:debug": "npm run build && concurrently -k \"npm run watch:compile\" \"node --inspect-brk --watch dist/main.js\"",
"start:prod": "node dist/main.js",
"typecheck": "tsc --noEmit -p tsconfig.build.json",
"watch:compile": "swc src --out-dir dist --config-file .swcrc --ignore \"**/*.spec.ts\" --strip-leading-paths --watch"
```

- [x] **Step 4: Make Vitest emit the same decorator metadata**

Update `apps/api/vitest.config.ts` to add the SWC Vite transformer before the path plugin:

```ts
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [swc.vite({ tsconfigFile: './tsconfig.json' }), tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
```

- [x] **Step 5: Verify the API test and build**

Run:

```powershell
npm run test --workspace=apps/api
npm run build --workspace=apps/api
```

Expected: the controller test passes with the Nest testing module, and the build completes both TypeScript type checking and direct SWC compilation without invoking Nest CLI.

### Task 2: Migrate the desktop build to Vite 8-compatible Electron tooling

**Files:**
- Modify: `apps/desktop/package.json`
- Rename: `apps/desktop/electron.vite.config.ts` to `apps/desktop/vite.config.mts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/tsconfig.node.json`
- Modify: `apps/desktop/tsconfig.web.json`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: root `.gitignore`
- Modify: root `package.json`
- Modify: root `package-lock.json`

**Interfaces:**
- Produces a Vite 8 config that builds the renderer, Electron main process, and preload process.
- The packaged Electron entry becomes `dist-electron/main.js`; the renderer output becomes `dist/renderer/index.html`; the preload output is `dist-electron/preload.js` for this CommonJS package.

- [x] **Step 1: Confirm the current desktop config typecheck is red**

Run:

```powershell
npm run typecheck:node --workspace=apps/desktop
```

Expected before the fix: Vite plugin type incompatibility between Vite 7 and Vite 8.

- [x] **Step 2: Replace only the incompatible Electron integration package**

Run from the repository root:

```powershell
npm uninstall --workspace=apps/desktop electron-vite
npm install --workspace=apps/desktop --save-dev vite-plugin-electron@1.1.2
npm install --save-dev vite@8.3.1
```

Keep Vite 8 as a root development dependency so the hoisted Electron plugin, desktop renderer, API test runner, and platform admin resolve the same Vite major instead of the API's older peer Vite.

- [x] **Step 3: Configure Vite 8, React, main, and preload entries**

Use this `apps/desktop/vite.config.mts` configuration, retaining the existing renderer alias:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

const projectRoot = process.cwd()
const rendererRoot = resolve(projectRoot, 'src/renderer')

export default defineConfig({
  root: rendererRoot,
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve(projectRoot, 'src/renderer/src')
    }
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: { main: resolve(projectRoot, 'src/main/index.ts') },
        vite: { root: projectRoot }
      },
      preload: {
        input: { preload: resolve(projectRoot, 'src/preload/index.ts') },
        vite: { root: projectRoot }
      }
    })
  ],
  build: {
    outDir: resolve(projectRoot, 'dist/renderer'),
    emptyOutDir: true,
    rolldownOptions: {
      input: resolve(rendererRoot, 'index.html')
    }
  }
})
```

In `apps/desktop/src/renderer/index.html`, change the renderer entry from `/src/main.tsx` to `./src/main.tsx` so Vite resolves it relative to the nested HTML entry. In `apps/desktop/package.json`, set `main` to `./dist-electron/main.js`; change `dev` to `vite`, `build` to `npm run typecheck && npm run clean:electron && vite build`, and `start` to `electron .`. Add `clean:electron` with `node -e "require('node:fs').rmSync('dist-electron',{recursive:true,force:true})"` so old main/preload output names cannot leak into packages. Make the platform build scripts invoke `npm run build` before `electron-builder`.

- [x] **Step 4: Point the main process at the new outputs and dev-server variable**

In `apps/desktop/src/main/index.ts`, replace the electron-vite-specific `?asset` import with the packaged/unpackaged resource path:

```ts
const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked/resources/icon.png')
  : join(app.getAppPath(), 'resources/icon.png')
```

Use `icon: iconPath` in the Linux-only BrowserWindow option. The existing `asarUnpack: resources/**` setting keeps the packaged image at the referenced path. Also use the new output paths while preserving the current `webPreferences` values:

```ts
preload: join(__dirname, 'preload.js')
```

```ts
if (process.env['VITE_DEV_SERVER_URL']) {
  mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL'])
} else {
  mainWindow.loadFile(join(__dirname, '../dist/renderer/index.html'))
}
```

Update the HMR comment to refer to vite-plugin-electron. Do not change `sandbox`, `contextIsolation`, or `nodeIntegration` in this task.

- [x] **Step 5: Update config discovery and packaged-file exclusions**

In `apps/desktop/tsconfig.node.json`, include `vite.config.mts` and remove the `electron-vite/node` type override. In `apps/desktop/tsconfig.web.json`, remove the removed TypeScript 7 `baseUrl` option and make the `@renderer/*` path mapping relative with `./`. In `apps/desktop/electron-builder.yml`, exclude `vite.config.{js,ts,mts,mjs,cjs}` rather than `electron.vite.config.{js,ts,mjs,cjs}`. In root `.gitignore`, ignore `*.tsbuildinfo` and `apps/desktop/dist-electron/` so TypeScript and Electron build outputs stay untracked. Ignore `**/dist-electron` in `apps/desktop/eslint.config.mjs` so lint skips generated Electron bundles.

- [x] **Step 6: Verify desktop types and production build**

Run:

```powershell
npm run typecheck --workspace=apps/desktop
npm run build --workspace=apps/desktop
```

Expected: type checking passes, and the build produces `dist-electron/main.js`, `dist-electron/preload.js`, and `dist/renderer/index.html`.

### Task 3: Adapt the React ESLint plugin to ESLint 10

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/eslint.config.mjs`
- Modify: root `package-lock.json`

**Interfaces:**
- Keeps ESLint 10 and existing React lint rules while adapting the older React plugin's rule context.

- [x] **Step 1: Add ESLint's compatibility utility to the desktop workspace**

Run from the repository root:

```powershell
npm install --workspace=apps/desktop --save-dev @eslint/compat@2.1.1
```

- [x] **Step 2: Wrap the imported React flat configs**

In `apps/desktop/eslint.config.mjs`, import `fixupConfigRules` and spread its wrapped React configs in the same position as the existing React configs:

```js
import { fixupConfigRules } from '@eslint/compat'
```

```js
...fixupConfigRules([
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime']
]),
```

Leave the React settings, hooks rules, refresh rules, TypeScript rules, and Prettier config intact.

- [x] **Step 3: Verify desktop lint**

Run:

```powershell
npm run lint --workspace=apps/desktop
```

Expected: ESLint traverses the workspace without the `react/display-name` context API exception.

### Task 4: Validate the full workspace and lockfile

**Files:**
- Verify: root `package-lock.json`
- Verify: all files changed in Tasks 1–3

- [x] **Step 1: Confirm the dependency tree contains no incompatible duplicate desktop Vite**

Run:

```powershell
npm ls --workspace=apps/desktop vite @vitejs/plugin-react vite-plugin-electron
npm pkg get devDependencies.electron-vite devDependencies.electron --workspace=apps/desktop
```

Expected: desktop directly uses Vite 8 and vite-plugin-electron; `electron-vite` is absent from its manifest; Electron remains exactly `44.4.5`.

- [x] **Step 2: Run root validation**

Run:

```powershell
npm run build
npm run lint
npm run test
```

Expected: all configured workspace builds, lint commands, and tests pass. Report separately if blocked by install scripts or unavailable native binaries; do not approve scripts implicitly.

- [x] **Step 3: Inspect the final diff and Git state**

Run:

```powershell
git status --short --branch
git diff --check
git diff
```

Confirm that only the toolchain spec, implementation plan, affected workspace manifests/configuration, and root lockfile changed. Do not commit unless requested.
