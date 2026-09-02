import type { Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import vueDevTools from 'vite-plugin-vue-devtools'

import { ensureReleaseWorkspace } from './scripts/release-paths'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const archiver = require('archiver')

interface ThemeManifest {
  preview?: unknown
  version?: unknown
}

const themeJsonPath = resolve(__dirname, 'komari-theme.json')
const devApiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:25774'

function readThemeManifest(): ThemeManifest {
  if (!existsSync(themeJsonPath))
    throw new Error('komari-theme.json not found')

  return JSON.parse(readFileSync(themeJsonPath, 'utf-8')) as ThemeManifest
}

function getThemeVersion(): string {
  const version = readThemeManifest().version

  if (typeof version !== 'string' || !version.trim())
    throw new TypeError('komari-theme.json does not contain a top-level string version field')

  return version.trim()
}

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    return 'unknown'
  }
}

/**
 * Vite 插件：构建后打包 Komari 主题 Zip
 * theme.zip
 * ├── komari-theme.json
 * ├── preview.png
 * └── dist/
 */
function komariThemeZip(): Plugin {
  return {
    name: 'komari-theme-zip',
    apply: 'build',
    closeBundle: async () => {
      if (process.env.KOMARI_SKIP_PACKAGE === '1') {
        console.log('[komari-theme-zip] Test build requested; installer packaging skipped')
        return
      }

      const distDir = resolve(__dirname, 'dist')
      const previewPath = resolve(__dirname, 'docs/preview.png')
      const themeManifest = readThemeManifest()
      const releasePaths = ensureReleaseWorkspace(__dirname, getThemeVersion())
      const { installerPath: outputPath } = releasePaths
      const partialOutputPath = `${outputPath}.partial-${process.pid}`
      const manifestPreviewName = typeof themeManifest.preview === 'string' && themeManifest.preview.trim()
        ? themeManifest.preview.trim()
        : 'preview.png'

      if (!existsSync(distDir)) {
        console.log('[komari-theme-zip] dist directory not found, skipping zip creation')
        return
      }

      if (existsSync(partialOutputPath)) {
        throw new Error(`Refusing to reuse an existing partial installer: ${partialOutputPath}`)
      }

      const output = fs.createWriteStream(partialOutputPath, { flags: 'wx' })
      const archive = archiver('zip', { zlib: { level: 9 } })

      return new Promise((resolve, reject) => {
        let settled = false

        const removePartialInstaller = () => {
          if (existsSync(partialOutputPath)) {
            unlinkSync(partialOutputPath)
          }
        }

        const fail = (error: Error) => {
          if (settled)
            return

          settled = true
          output.destroy()

          try {
            removePartialInstaller()
          }
          catch (cleanupError) {
            console.error('[komari-theme-zip] Partial installer cleanup failed:', cleanupError)
          }

          console.error('[komari-theme-zip] Error:', error)
          reject(error)
        }

        output.on('error', fail)
        output.on('close', () => {
          if (settled) {
            try {
              removePartialInstaller()
            }
            catch (cleanupError) {
              console.error('[komari-theme-zip] Partial installer cleanup failed:', cleanupError)
            }
            return
          }

          try {
            renameSync(partialOutputPath, outputPath)
            settled = true
            const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2)
            console.log(`[komari-theme-zip] Created ${relative(__dirname, outputPath)} (${sizeMB} MB)`)
            console.log(`[komari-theme-zip] Reserved snapshot paths: ${relative(__dirname, releasePaths.publishDirectory)}, ${relative(__dirname, releasePaths.releaseDirectory)}`)
            resolve(undefined)
          }
          catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })

        archive.on('error', fail)

        archive.pipe(output)

        archive.file(themeJsonPath, { name: 'komari-theme.json' })

        if (existsSync(previewPath)) {
          archive.file(previewPath, { name: 'preview.png' })
          if (manifestPreviewName !== 'preview.png') {
            archive.file(previewPath, { name: manifestPreviewName })
          }
        }

        archive.directory(distDir, 'dist')

        void archive.finalize().catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error(String(error)))
        })
      })
    },
  }
}

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(getThemeVersion()),
    __BUILD_GIT_HASH__: JSON.stringify(getCommitHash()),
  },
  plugins: [
    vue(),
    vueDevTools(),
    tailwindcss(),
    komariThemeZip(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: devApiTarget,
        changeOrigin: true,
        headers: { Origin: devApiTarget },
        rewriteWsOrigin: true,
        ws: true,
      },
      '/themes': {
        target: devApiTarget,
        changeOrigin: true,
        headers: { Origin: devApiTarget },
      },
    },
  },
  build: {
    target: ['es2018', 'safari15.4'],
    cssTarget: 'safari15.4',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'echarts': ['echarts', 'vue-echarts'],
          'globe': ['globe.gl', 'three'],
          'reka-ui': ['reka-ui'],
          'vueuse': ['@vueuse/core'],
          'v3-services': [
            './src/services/history.service.ts',
            './src/services/metrics.service.ts',
            './src/services/request.service.ts',
            './src/services/cache.service.ts',
            './src/utils/osImageHelper.ts',
            './src/utils/metricSeries.ts',
            './src/composables/useNodePingDisplay.ts',
          ],
        },
      },
    },
  },
})
