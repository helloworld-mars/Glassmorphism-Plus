import { defineConfig } from '@playwright/test'
import baseConfig from '../../playwright.config'

/** Target current source without running the release-packaging Vite plugin. */
export default defineConfig({
  ...baseConfig,
  testDir: '.',
  outputDir: '../../test-results/v2-source-artifacts',
  use: {
    ...baseConfig.use,
    baseURL: 'http://127.0.0.1:4174',
  },
  webServer: {
    command: 'node ../../node_modules/vite/bin/vite.js --config vite.v2-test.config.ts --configLoader runner --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
