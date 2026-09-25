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
