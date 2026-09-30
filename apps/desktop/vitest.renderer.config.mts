import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const desktopRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: desktopRoot,
  test: {
    include: ['src/renderer/src/**/*.spec.tsx'],
    environment: 'jsdom',
    setupFiles: ['src/renderer/src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true
  }
})
