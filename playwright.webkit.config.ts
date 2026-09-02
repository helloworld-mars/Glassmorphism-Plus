import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

/**
 * WebKit is a release gate, not a Chromium-snapshot substitute. Both native
 * Playwright device contexts run the complete functional suite, while their
 * visual baselines remain isolated by project name.
 */
export default defineConfig({
  testDir: './tests/visual',
  outputDir: 'test-results/webkit-artifacts',
  snapshotPathTemplate: '{testDir}/snapshots/{projectName}/{arg}{ext}',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
      threshold: 0.25,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari'],
      },
    },
    {
      name: 'webkit-iphone',
      use: {
        ...devices['iPhone 13'],
      },
    },
  ],
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
