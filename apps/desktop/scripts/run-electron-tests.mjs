import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const vitestPackagePath = require.resolve('vitest/package.json')
const vitestPackage = JSON.parse(readFileSync(vitestPackagePath, 'utf8'))
const vitestPath = resolve(dirname(vitestPackagePath), vitestPackage.bin.vitest)
const configPath = resolve(process.cwd(), 'vitest.config.mts')
const result = spawnSync(
  electronPath,
  [vitestPath, 'run', '--config', configPath, ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  }
)

if (result.error) {
  console.error('Electron-compatible Vitest process could not start')
  process.exit(1)
}
process.exit(result.status ?? 1)
