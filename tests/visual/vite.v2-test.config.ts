import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

/** Minimal source server used by targeted v2 browser tests without packaging a release ZIP. */
export default defineConfig({
  root: projectRoot,
  define: {
    __BUILD_VERSION__: JSON.stringify('2.0.0-test'),
    __BUILD_GIT_HASH__: JSON.stringify('playwright'),
  },
  plugins: [vue(), tailwindcss()],
  optimizeDeps: {
    include: ['dayjs'],
    noDiscovery: true,
  },
  resolve: {
    alias: { '@': resolve(projectRoot, 'src') },
  },
})
