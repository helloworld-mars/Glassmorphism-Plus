import type { Page, Route } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

const SITE_NAME = 'Komari Startup Lab'
const DIST_ROOT = resolve(import.meta.dirname, '../../dist')

function v3PingConfig(): string {
  return JSON.stringify({
    schemaVersion: 3,
    global: { threeNetworkEnabled: false, taskIds: [202, null, null] },
    nodes: {},
  })
}

function isRpcRequest(url: string): boolean {
  return new URL(url).pathname.replace(/\/+$/, '').endsWith('/rpc2')
}

function rpcErrorBody(route: Route, code: number, message: string): string {
  const payload = route.request().postDataJSON() as { id?: unknown } | null
  return JSON.stringify({
    jsonrpc: '2.0',
    id: payload?.id ?? null,
    error: { code, message },
  })
}

async function expectPublicNodes(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: SITE_NAME })).toBeVisible()
  await expect.poll(() => page.locator('[data-node-card-uuid]').count()).toBeGreaterThan(0)
  const firstCard = page.locator('[data-node-card-uuid]').first()
  await expect(firstCard).toBeVisible()
  for (const metric of ['cpu', 'memory', 'disk', 'traffic'])
    await expect(firstCard.locator(`[data-node-metric-icon="${metric}"]`)).toBeVisible()
  await expect(page.getByText('RPC 服务错误')).toHaveCount(0)
  await expect(page.getByText('网络连接错误')).toHaveCount(0)
  await expect(page.getByText('主题初始化错误')).toHaveCount(0)
}

async function installNormalStartupProviderStubs(page: Page): Promise<void> {
  for (const pattern of ['https://api.ip.sb/**', 'https://ipapi.co/**', 'https://ipinfo.io/**']) {
    await page.route(pattern, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    }))
  }
  await page.route('https://open.er-api.com/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ result: 'success', rates: { CNY: 7, USD: 1 } }),
  }))
  await page.route('https://api.frankfurter.app/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ rates: { CNY: 7, USD: 1 } }),
  }))
}

test('public startup uses the Komari 1.4.3 RPC path and renders non-empty node data', async ({ page }) => {
  const rpcPaths: string[] = []
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  page.on('request', (request) => {
    if (isRpcRequest(request.url()))
      rpcPaths.push(new URL(request.url()).pathname)
  })
  page.on('pageerror', error => pageErrors.push(error))
  page.on('console', (message) => {
    if (message.type() === 'error' && /Uncaught|Unhandled|TypeError|ReferenceError/i.test(message.text()))
      consoleErrors.push(message.text())
  })

  await installNormalStartupProviderStubs(page)
  await installKomariFixture(page, { siteName: SITE_NAME })
  await page.goto('/')
  await expectPublicNodes(page)
  await expect.poll(() => rpcPaths.length).toBeGreaterThan(2)
  expect(new Set(rpcPaths)).toEqual(new Set(['/api/rpc2']))
  await expect(page.locator('[data-general-card-key="remainingValue"]')).not.toContainText('¥0.00')
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('optional Ping catalog failure degrades only the Ping strips', async ({ page }) => {
  await installKomariFixture(page, {
    siteName: SITE_NAME,
    nodeCardPingDisplayConfigV3: v3PingConfig(),
  })
  await page.route('**/api/rpc2', async (route) => {
    const payload = route.request().postDataJSON() as { method?: string } | null
    if (payload?.method === 'public:getPublicPingTasks') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: rpcErrorBody(route, -32601, 'Fixture Ping catalog unavailable'),
      })
      return
    }
    await route.fallback()
  })

  await page.goto('/')
  await expectPublicNodes(page)
  await expect(page.locator('[data-node-card-uuid]').first()).toContainText('更新失败')
})

test('optional Ping Metric and Legacy failures do not clear base node metrics', async ({ page }) => {
  const failedPingMethods: string[] = []
  await installKomariFixture(page, {
    siteName: SITE_NAME,
    nodeCardPingDisplayConfigV3: v3PingConfig(),
    nodeCardPingFixture: { metric: 'valid', legacy: 'valid' },
  })
  await page.route('**/api/rpc2', async (route) => {
    const payload = route.request().postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    const isLegacyPing = (payload?.method === 'common:getRecords' && payload.params?.type === 'ping')
      || payload?.method === 'public:getPingRecords'
    const isMetricPing = payload?.method === 'public:getPingMetricStats'
      || payload?.method === 'public:queryMetrics'
    if (isLegacyPing || isMetricPing) {
      failedPingMethods.push(payload?.method ?? '')
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: rpcErrorBody(route, -32601, 'Fixture optional Ping history unavailable'),
      })
      return
    }
    await route.fallback()
  })

  await page.goto('/')
  await expectPublicNodes(page)
  await expect.poll(() => failedPingMethods.length).toBeGreaterThan(0)
  await expect.poll(() => page.locator('[data-node-ping-state="error"]').count()).toBeGreaterThan(0)
})

test('optional exchange-rate failures fall back without blocking the homepage', async ({ page }) => {
  const failedRateRequests: string[] = []
  for (const pattern of ['https://open.er-api.com/**', 'https://api.frankfurter.app/**']) {
    await page.route(pattern, async (route) => {
      failedRateRequests.push(route.request().url())
      await route.abort('connectionfailed')
    })
  }
  await installKomariFixture(page, { siteName: SITE_NAME })

  await page.goto('/')
  await expectPublicNodes(page)
  await expect.poll(() => failedRateRequests.length).toBeGreaterThan(0)
  await page.getByRole('button', { name: '查看剩余价值明细' }).click()
  await page.getByRole('tab', { name: '汇率设置' }).click()
  await expect(page.getByText(/内置参考汇率/)).toBeVisible()
  await expect(page.locator('[data-node-card-uuid]').first()).toBeVisible()
})

test('HTTP 200 JSON-RPC application errors are not reported as browser offline', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(message.text())
  })
  await installKomariFixture(page, { siteName: SITE_NAME })
  await page.route('**/api/rpc2', async (route) => {
    const payload = route.request().postDataJSON() as { method?: string } | null
    if (payload?.method === 'common:getNodes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: rpcErrorBody(route, -32602, 'Fixture incompatible node parameters'),
      })
      return
    }
    await route.fallback()
  })

  await page.goto('/')
  await expect(page.getByText('RPC 服务错误')).toBeVisible()
  await expect(page.getByText('服务器 RPC 返回错误，请稍后重试。')).toBeVisible()
  await expect(page.getByText('网络连接错误')).toHaveCount(0)
  await expect.poll(() => consoleErrors.some(message => message.includes('Fixture incompatible node parameters'))).toBe(true)
  expect(consoleErrors.some(message => message.includes('Network error'))).toBe(false)
})

test('a real base-network failure shows the global network error and Retry recovers', async ({ page }) => {
  let networkDown = true
  await installKomariFixture(page, { siteName: SITE_NAME })
  await page.route('**/api/rpc2', async (route) => {
    if (networkDown) {
      await route.abort('connectionfailed')
      return
    }
    await route.fallback()
  })

  await page.goto('/')
  await expect(page.getByText('网络连接错误')).toBeVisible()
  await expect(page.getByText('无法连接服务器，请检查网络后重试。')).toBeVisible()
  await expect(page.getByText('RPC 服务错误')).toHaveCount(0)

  networkDown = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expectPublicNodes(page)
})

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })
}

test('built index and dynamic imports contain no dangling local asset references', () => {
  const indexPath = resolve(DIST_ROOT, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  const missing: string[] = []

  for (const match of html.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const reference = match[1]
    if (!reference.startsWith('/') || reference.startsWith('//'))
      continue
    const localPath = resolve(DIST_ROOT, reference.replace(/^\/+/, ''))
    if (!existsSync(localPath))
      missing.push(`${indexPath} -> ${reference}`)
  }

  for (const scriptPath of collectFiles(DIST_ROOT).filter(path => extname(path) === '.js')) {
    const script = readFileSync(scriptPath, 'utf8')
    for (const match of script.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      const reference = match[1]
      if (/^(?:https?:)?\/\//.test(reference))
        continue
      const localPath = reference.startsWith('/')
        ? resolve(DIST_ROOT, reference.replace(/^\/+/, ''))
        : resolve(dirname(scriptPath), reference)
      if (!existsSync(localPath))
        missing.push(`${scriptPath} -> ${reference}`)
    }
  }

  expect(missing).toEqual([])
})
