import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // esbuild minify only — terser toplevel + javascript-obfuscator
      // both made the packaged main process exit after a few seconds.
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve('electron/main.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve('shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve('src'),
    // Surfaced in Cài đặt → Về ezaff so the version never goes stale.
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/index.html'),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve('src'),
        '@shared': resolve('shared'),
      },
    },
  },
})
