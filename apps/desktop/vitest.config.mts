import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const desktopRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: desktopRoot,
  test: {
    include: ['src/main/**/*.spec.ts'],
    environment: 'node'
  }
})
