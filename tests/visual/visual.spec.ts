import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { comparePingTaskOrder, createPingTaskOrderMap, orderPingTasksByBackend } from '../../src/utils/metricSeries'
import { createPingTimeWindow, getPingTimeBucketIndex, parsePingTimestampMs } from '../../src/utils/pingTime'
import { installKomariFixture, PRIMARY_NODE_UUID } from './fixtures/komari'

const STABLE_STYLE = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    transition: none !important;
  }
  html { scroll-behavior: auto !important; }
  .earth-globe-host canvas,
  .earth-globe-canvas { opacity: 0 !important; }
`

async function openStablePage(page: Page, path = '/', siteName = 'Komari Visual Lab'): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: siteName })).toBeVisible()
  await page.addStyleTag({ content: STABLE_STYLE })
  await page.waitForTimeout(700)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
}

async function expectNodeMetricIcons(page: Page): Promise<void> {
  for (const metric of ['cpu', 'memory', 'disk', 'traffic'])
    await expect(page.locator(`[data-node-metric-icon="${metric}"]`).first()).toBeVisible()
}

async function expectNodePingBars(page: Page): Promise<void> {
  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  for (const metric of ['latency', 'loss']) {
    const bars = card.locator(`[data-node-ping-bars="${metric}"]`)
    await expect(bars).toBeVisible()
    await expect.poll(() => bars.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
  }
}

function primaryNodeCard(page: Page) {
  return page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
}

function nodeCardPingPanel(page: Page, metric: 'latency' | 'loss') {
  return primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"]`).locator('..')
}

async function expectNodeCardPing(page: Page, latency: string, loss: string): Promise<void> {
  await expect(nodeCardPingPanel(page, 'latency')).toContainText(latency)
  await expect(nodeCardPingPanel(page, 'loss')).toContainText(loss)
}

async function expectNodeCardPingTooltip(page: Page, metric: 'latency' | 'loss', text: string): Promise<void> {
  const tooltips = primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"] [role="tooltip"]`)
  await expect.poll(async () => (await tooltips.allTextContents()).some(content => content.includes(text))).toBe(true)
}

test('Ping timestamps use one strict [start, end) twenty-bucket contract', () => {
  const start = Date.parse('2026-07-25T19:59:00.000Z')
  const end = Date.parse('2026-07-25T20:59:00.000Z')
  const window = createPingTimeWindow(start, end, 20)
  expect(window).not.toBeNull()
  if (!window)
    return

  const exactSample = parsePingTimestampMs('2026-07-25T20:00:00.000Z')
  expect(exactSample).toBe(Date.parse('2026-07-25T20:00:00.000Z'))
  expect(parsePingTimestampMs('2026-07-25T20:00:00.000+00:00')).toBe(exactSample)
  expect(parsePingTimestampMs('1785009600')).toBe(exactSample)
  expect(parsePingTimestampMs(exactSample!)).toBe(exactSample)
  expect(parsePingTimestampMs('2026-07-25 20:00:00')).toBeNull()
  expect(parsePingTimestampMs('not-a-timestamp')).toBeNull()

  expect(getPingTimeBucketIndex(start, window)).toBe(0)
  expect(getPingTimeBucketIndex(exactSample!, window)).toBe(0)
  for (let index = 0; index < 20; index++) {
    expect(getPingTimeBucketIndex(start + index * window.bucketWidth, window)).toBe(index)
  }
  expect(getPingTimeBucketIndex(end - 1, window)).toBe(19)
  expect(getPingTimeBucketIndex(end, window)).toBeNull()
})

test('Ping task displays retain the raw public task order instead of weight or numeric ID order', () => {
  const publicTasks = [{ id: 30 }, { id: 10 }, { id: 20 }]
  const taskOrder = createPingTaskOrderMap(publicTasks)
  const metricSeries = [
    { id: 20, tags: { task_id: '20' } },
    { id: 30, tags: { task_id: '30' } },
    { id: 10, tags: { task_id: '10' } },
  ]

  expect([...metricSeries].sort((left, right) => comparePingTaskOrder(left.tags, right.tags, taskOrder)).map(item => item.id))
    .toEqual([30, 10, 20])
  expect(orderPingTasksByBackend([...metricSeries, { id: 5, tags: { task_id: '5' } }], publicTasks).map(item => item.id))
    .toEqual([30, 10, 20, 5])
})

test('brand metadata and homepage footer retain current and original attribution', async ({ page }) => {
  const themeManifest = JSON.parse(readFileSync(new URL('../../komari-theme.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const packageMetadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const originalGlassmorphismManifest = { name: 'Komari Glassmorphism', short: 'Glassmorphism' }

  expect(themeManifest).toMatchObject({
    name: 'Komari Glassmorphism Plus',
    short: 'glassmorphism-plus',
    description: 'A customized Glassmorphism theme for Komari, based on the original theme by sanrokamlan.',
    version: '1.3.0',
    author: 'helloworld-mars',
    url: 'https://github.com/helloworld-mars/Glassmorphism-Plus',
  })
  expect(packageMetadata).toMatchObject({
    name: 'komari-theme-glassmorphism-plus',
    version: '1.3.0',
    homepage: 'https://github.com/helloworld-mars/Glassmorphism-Plus',
  })
  expect(themeManifest.short).toMatch(/^[\w-]+$/)
  expect(themeManifest.short).not.toBe(originalGlassmorphismManifest.short)
  expect(new Set([originalGlassmorphismManifest.short, themeManifest.short]).size).toBe(2)

  const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  expect(indexHtml).toContain('<title>Komari</title>')
  expect(indexHtml).toContain('name="apple-mobile-web-app-title" content="Komari"')

  const managedItems = (themeManifest.configuration as { data: Array<Record<string, unknown>> }).data
  const bindingSectionIndex = managedItems.findIndex(item => item.type === 'title' && item.name === '09 · 延迟任务绑定')
  const entrySettingIndex = managedItems.findIndex(item => item.key === 'hidePingTaskBindingEntry')
  const bindingsSettingIndex = managedItems.findIndex(item => item.key === 'nodeCardPingTaskBindings')
  expect(bindingSectionIndex).toBeGreaterThanOrEqual(0)
  expect(entrySettingIndex).toBe(bindingSectionIndex + 1)
  expect(bindingsSettingIndex).toBe(entrySettingIndex + 1)
  expect(managedItems[entrySettingIndex]).toMatchObject({
    name: '隐藏延迟任务绑定入口',
    type: 'switch',
    default: false,
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { hideEarth: true })
  await openStablePage(page)

  const footer = page.locator('footer')
  await expect(footer.getByRole('link', { name: 'Glassmorphism Plus' })).toHaveAttribute('href', 'https://github.com/helloworld-mars/Glassmorphism-Plus')
  await expect(footer.getByText('v1.3.0 · helloworld-mars', { exact: true }).first()).toBeVisible()
  await expect(footer.getByRole('link', { name: 'Based on the original theme by sanrokamlan' }))
    .toHaveAttribute('href', 'https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism')
  await expect(footer).not.toContainText('unknown')
})

test('browser title follows the public Komari site name across home, detail, and binding views', async ({ page }) => {
  const fixture = await installKomariFixture(page, { adminAccess: 'admin', siteName: 'MyVpsMonitor' })

  await openStablePage(page, '/', 'MyVpsMonitor')
  await expect.poll(() => page.title()).toBe('MyVpsMonitor')
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'MyVpsMonitor')

  fixture.setSiteName('Marcus Monitor')
  await openStablePage(page, `/instance/${PRIMARY_NODE_UUID}`, 'Marcus Monitor')
  await expect.poll(() => page.title()).toBe('Marcus Monitor')

  await openStablePage(page, '/?view=pingsettings', 'Marcus Monitor')
  await expect.poll(() => page.title()).toBe('Marcus Monitor')
})

test('browser title falls back to Komari when the public site name is blank', async ({ page }) => {
  await installKomariFixture(page, { siteName: '   ' })
  await openStablePage(page, '/', 'Komari')
  await expect.poll(() => page.title()).toBe('Komari')
})

for (const scenario of [
  { name: 'guest with the entry setting disabled', adminAccess: 'guest' as const, hidden: false, visible: true },
  { name: 'guest with the entry setting enabled', adminAccess: 'guest' as const, hidden: true, visible: false },
  { name: 'administrator with the entry setting disabled', adminAccess: 'admin' as const, hidden: false, visible: true },
  { name: 'administrator with the entry setting enabled', adminAccess: 'admin' as const, hidden: true, visible: false },
  { name: 'authenticated non-administrator with the entry setting disabled', adminAccess: 'forbidden' as const, hidden: false, visible: true },
  { name: 'authenticated non-administrator with the entry setting enabled', adminAccess: 'forbidden' as const, hidden: true, visible: false },
]) {
  test(`Ping binding entry visibility: ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      adminAccess: scenario.adminAccess,
      hidePingTaskBindingEntry: scenario.hidden,
    })
    await openStablePage(page)

    const entry = page.getByRole('button', { name: '延迟任务绑定', exact: true })
    await expect(entry).toHaveCount(scenario.visible ? 1 : 0)
    if (scenario.visible) {
      await expect(entry).toHaveAttribute('title', '延迟任务绑定')
      await entry.hover()
      const tooltip = page.locator('[data-slot="tooltip-content"]')
      await expect(tooltip).toContainText('延迟任务绑定')
      await expect(tooltip).not.toContainText('09')
    }
    await expect(page.getByRole('button', { name: /主题/ })).toBeVisible()
  })
}

test('home light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expectNodePingBars(page)
  await expect(page).toHaveScreenshot('home-light-desktop.png', { fullPage: false })
})

test('home dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-dark-mobile.png', { fullPage: false })
})

test('home accessible list desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { colorVisionFriendly: true, viewMode: 'list', hideEarth: true })
  await openStablePage(page)
  await expect(page).toHaveScreenshot('home-accessible-list-desktop.png', { fullPage: false })
})

test('home cobe layout desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { earthRenderer: 'cobe' })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-cobe-desktop.png', { fullPage: false })
})

test('home tiled layout desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { earthRenderer: 'tiled' })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-tiled-desktop.png', { fullPage: false })
})

test('home mini card metric icons remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardSize: 'mini', hideEarth: true })
  await openStablePage(page)

  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  await expect(card.locator('[data-node-metric-icon="cpu"]')).toBeVisible()
  await expect(card.locator('[data-node-metric-icon="memory"]')).toBeVisible()
  await expect(card.locator('[data-node-metric-icon="traffic"]')).toBeVisible()
  await expect(card.getByRole('img', { name: 'CPU' })).toBeVisible()
  await expect(card.getByRole('img', { name: '内存' })).toBeVisible()
})

test('node card expiry uses red through 5 days and yellow through 10 days', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { expiryThresholds: true, hideEarth: true })
  await openStablePage(page)

  const criticalCard = primaryNodeCard(page)
  const warningCard = page.getByRole('button', { name: '查看节点 香港边缘节点-超长名称布局测试 详情' })
  const criticalExpiry = criticalCard.getByText('剩余', { exact: true }).locator('..')
  const warningExpiry = warningCard.getByText('剩余', { exact: true }).locator('..')

  await expect(criticalExpiry).toContainText('剩余5天')
  await expect(criticalExpiry).toHaveClass(/text-destructive/)
  await expect(warningExpiry).toContainText('剩余10天')
  await expect(warningExpiry).toHaveClass(/text-warning/)
})

test('node card renders an invalid expiry as a muted unknown value', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { invalidExpiry: true, hideEarth: true })
  await openStablePage(page)

  const unknownExpiry = primaryNodeCard(page).locator('.text-muted-foreground').filter({ hasText: /^-$/ })
  await expect(unknownExpiry).toHaveCount(1)
  await expect(unknownExpiry).toBeVisible()
})

test('free node pricing stays semantic across home, finance, and detail', async ({ page }) => {
  const freeNodeName = '主控-洛杉矶'
  const freeNodeUuid = '00000000-0000-4000-8000-000000000001'
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { freePriceNode: true, hideEarth: true })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: `查看节点 ${freeNodeName} 详情` })
  await expect(nodeCard.getByText('免费', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('无', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('免费 / 年', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '查看剩余价值明细' }).click()
  const financeDialog = page.getByRole('dialog', { name: '价值与费用明细' })
  await expect(financeDialog.getByText(freeNodeName, { exact: true })).toHaveCount(0)
  await financeDialog.getByLabel('排除免费节点').uncheck()
  const freeNodeRow = financeDialog.getByRole('cell', { name: freeNodeName, exact: true }).locator('..')
  await expect(freeNodeRow).toBeVisible()
  await expect(freeNodeRow.getByText('免费', { exact: true })).toBeVisible()
  await expect(freeNodeRow.getByText('无', { exact: true })).toBeVisible()

  await page.goto(`/instance/${freeNodeUuid}`)
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
  await expect(page.getByText('节点价格', { exact: true })).toBeVisible()
  await expect(page.getByText('剩余价值', { exact: true })).toBeVisible()
  await expect(page.getByText('无', { exact: true })).toBeVisible()
  await expect(page.getByText('免费 / 月', { exact: true })).toHaveCount(0)
})

test('detail light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-light-desktop.png', { fullPage: false })
})

test('detail dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-dark-mobile.png', { fullPage: false })
})

test('detail short history falls back when metric history omits CPU', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { missingCpuMetricHistory: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')

  const cpuValue = page.locator('[data-load-chart-card="cpu"] [data-latest-cpu]')
  const loadRange = page.getByRole('tablist').first()
  // The preset tabs are fixed as realtime, 4h, 1d, 7d, 30d, custom. Indexing
  // avoids coupling this regression test to the host browser's text decoding.
  for (const tabIndex of [1, 2]) {
    await loadRange.getByRole('tab').nth(tabIndex).click()
    await expect(cpuValue).toHaveText(/^\d+\.\d$/)
  }
})

test('detail ping requests stay scoped to the current node', async ({ page }) => {
  const currentUuid = '00000000-0000-4000-8000-000000000001'
  const metricCalls: Array<{ method: string, params: Record<string, unknown> }> = []
  const isPingMetricCall = (call: { method: string, params: Record<string, unknown> }): boolean => {
    const metricKeys = Array.isArray(call.params.metric_keys) ? call.params.metric_keys : []
    return call.method === 'public:getPingMetricStats'
      || metricKeys.includes('ping.latency_ms')
      || metricKeys.includes('ping.loss')
  }

  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return

    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics' || payload?.method === 'public:getPingMetricStats') {
      metricCalls.push({ method: payload.method, params: payload.params ?? {} })
    }
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)

  await expect.poll(() => metricCalls.filter(isPingMetricCall).length).toBeGreaterThan(0)
  const homeSummaryCalls = metricCalls.filter(call => call.method === 'public:queryMetrics' && isPingMetricCall(call))
  expect(homeSummaryCalls.length).toBeGreaterThan(0)
  expect(homeSummaryCalls.every(call => call.params.max_points === 150)).toBe(true)

  metricCalls.length = 0
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(`/instance/${currentUuid}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.waitForTimeout(2_000)

  const detailPingCalls = metricCalls.filter(isPingMetricCall)
  expect(detailPingCalls.length).toBeGreaterThan(0)
  expect(new Set(detailPingCalls.map(call => call.params.entity_id))).toEqual(new Set([currentUuid]))
})

function primaryBinding(taskId: unknown): string {
  return JSON.stringify({ [PRIMARY_NODE_UUID]: taskId })
}

function allNodeBindings(taskId: number): string {
  return JSON.stringify(Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      taskId,
    ]),
  ))
}

function isPingMetricQuery(params: Record<string, unknown>): boolean {
  const metricKeys = Array.isArray(params.metric_keys) ? params.metric_keys.map(String) : []
  return metricKeys.includes('ping.latency_ms') || metricKeys.includes('ping.loss')
}

function isPingLegacyRequest(call: { method: string, params: Record<string, unknown> }): boolean {
  return call.method === 'common:getRecords' && call.params.type === 'ping'
}

test.describe('node-card per-node ping task bindings', () => {
  test('12 valid bindings load one task catalog and only their selected Metric pairs', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)

    await expect.poll(() => calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202').length).toBe(12)
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics' && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(12)

    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)
  })

  test('12 bound nodes perform only one selected Metric pair in the next successful sample cycle', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleTimes: ['2026-07-25T12:00:00.000Z'],
        task202Latency: 7,
        task202Loss: 0,
      },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '7 ms', '0.0%')
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(12)

    fixture.setNodeCardPingFixture({
      sampleTimes: ['2026-07-25T12:00:00.000Z', '2026-07-25T12:01:00.000Z'],
      task202Latency: 9,
    })
    await fixture.advanceTime(65_000)
    await expectNodeCardPing(page, '9 ms', '0.0%')
    await expect.poll(() => calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === '202').length).toBe(24)
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(24)

    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(2)
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics'
      && isPingMetricQuery(call.params)
      && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('accepts sanitized Komari 1.4.1 HAR Metric data when loss_approximate is omitted', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: {
        metric: 'valid',
        komari141HarShape: true,
        task202Latency: 7,
        task202Loss: 0,
      },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '7 ms', '0.0%')

    const selectedStatsCalls = calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && call.params.task_id === '202')
    const selectedQueryCalls = calls.filter(call => call.method === 'public:queryMetrics'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')
    expect(selectedStatsCalls).toHaveLength(1)
    expect(selectedQueryCalls).toHaveLength(1)
    expect(selectedQueryCalls[0]?.params.metric_keys).toEqual(['ping.latency_ms', 'ping.loss'])
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)

    const latencyBars = primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [role="tooltip"]')
    const lossBars = primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [role="tooltip"]')
    await expect(latencyBars).toHaveCount(20)
    await expect(lossBars).toHaveCount(20)
    expect((await latencyBars.allTextContents()).every(text => !text.includes('无采样数据'))).toBe(true)
    expect((await lossBars.allTextContents()).every(text => !text.includes('无采样数据'))).toBe(true)
  })

  test('reuses an in-flight selected-task request after the card view remounts', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    const resumePingResponses = fixture.pausePingResponses()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expect.poll(() => calls.filter(call => call.method === 'public:getPublicPingTasks').length).toBe(1)

    await page.getByLabel('列表视图').click()
    await page.getByLabel('卡片视图').click()
    resumePingResponses()

    await expectNodeCardPing(page, '200 ms', '25.0%')
    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')).toHaveLength(1)
  })

  test('refreshes the task catalog and selected task data after their TTLs expire', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(1)

    await fixture.advanceTime(61_000)
    await page.getByLabel('列表视图').click()
    await page.getByLabel('卡片视图').click()
    await expect.poll(() => calls.filter(call => call.method === 'public:getPublicPingTasks').length).toBe(2)
    await expect.poll(() => calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202').length).toBe(2)
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics' && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(2)
  })

  test('keeps the last accepted snapshot until a delayed real sample arrives and then updates without navigation', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    const oldSampleTimes = [
      '2026-07-25T22:59:00.000+08:00',
      '2026-07-25T23:00:00.000+08:00',
      '2026-07-25T23:01:00.000+08:00',
      '2026-07-25T23:02:00.000+08:00',
    ]
    const fixture = await installKomariFixture(page, {
      clockNow: '2026-07-25T23:02:55.000+08:00',
      fakeTimers: true,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleTimes: oldSampleTimes,
        task202Latency: 7,
        task202Loss: 0,
      },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '7 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '23:00:00\n7 ms')

    const selectedQueries = () => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')

    // At the expected sample boundary plus grace, the backend still has only 23:02.
    await fixture.advanceTime(10_000)
    await expect.poll(() => selectedQueries().length).toBe(2)
    await expectNodeCardPing(page, '7 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '23:00:00\n7 ms')
    expect((await primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [role="tooltip"]').allTextContents())
      .some(text => text.includes('23:03:00') && text.includes('无采样数据'))).toBe(false)

    // First retry still sees no newer timestamp and must not replace the old snapshot.
    await fixture.advanceTime(5_000)
    await expect.poll(() => selectedQueries().length).toBe(3)
    await expectNodeCardPing(page, '7 ms', '0.0%')

    // The real 23:03 sample becomes visible on the next retry; no reload or route change occurs.
    fixture.setNodeCardPingFixture({
      sampleTimes: [...oldSampleTimes, '2026-07-25T23:03:00.000+08:00'],
      task202Latency: 9,
      task202Loss: 0,
    })
    await fixture.advanceTime(10_000)
    await expect.poll(() => selectedQueries().length).toBe(4)
    await expectNodeCardPing(page, '9 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '23:03:00\n9 ms')
  })

  test('hydrates an exact selected-task snapshot before a reload network refresh completes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
      preserveStorageOnReload: true,
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    expect(await page.evaluate(() => Object.keys(localStorage)
      .some(key => key.startsWith('komari-theme-emerald:selected-node-ping-stats:')))).toBe(true)

    const resumePingResponses = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('加载中')
    resumePingResponses()
  })

  test('rejects an expired selected-task cache schema instead of rendering it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
      preserveStorageOnReload: true,
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')

    await page.evaluate(() => {
      const key = Object.keys(localStorage)
        .find(value => value.startsWith('komari-theme-emerald:selected-node-ping-stats:'))
      if (!key)
        throw new Error('selected Ping snapshot was not persisted')
      const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
      localStorage.setItem(key, JSON.stringify({ ...value, version: 999 }))
    })

    const resumePingResponses = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expect(nodeCardPingPanel(page, 'latency')).toContainText('加载中')
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('200 ms')
    resumePingResponses()
    await expectNodeCardPing(page, '200 ms', '25.0%')
  })

  test('releases the selected-task scheduler when its card view unmounts', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await page.getByLabel('列表视图').click()
    calls.length = 0
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(300)
    expect(calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')).toHaveLength(0)
  })

  test('visibility and online recovery trigger shared silent selected-task refreshes', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    const selectedQueryCount = () => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length
    expect(selectedQueryCount()).toBe(1)

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(selectedQueryCount).toBe(2)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('加载中')

    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(selectedQueryCount).toBe(3)
    await expectNodeCardPing(page, '200 ms', '25.0%')
  })

  test('a selected Metric failure uses only that node legacy data and leaves other nodes on Metric', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: { metric: 'valid', metricErrorUuids: [PRIMARY_NODE_UUID], legacy: 'valid' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')

    await expect.poll(() => calls.filter(isPingLegacyRequest).length).toBe(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('selected Metric and Legacy failures keep each valid binding empty without querying the aggregate', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: { metric: 'error', legacy: 'selected-empty' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '-', '-')

    await expect.poll(() => calls.filter(isPingLegacyRequest).length).toBe(12)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  for (const sampleCount of [1, 4, 10, 20, 48, 150]) {
    test(`normalizes ${sampleCount} selected Metric samples into 20 aligned buckets`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 })
      await installKomariFixture(page, {
        nodeCardPingTaskBindings: primaryBinding(202),
        nodeCardPingFixture: { metric: 'valid', sampleCount },
      })
      await openStablePage(page)
      await expectNodeCardPing(page, '200 ms', '25.0%')

      const latencyBars = primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [role="tooltip"]')
      const lossBars = primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [role="tooltip"]')
      await expect(latencyBars).toHaveCount(20)
      await expect(lossBars).toHaveCount(20)

      const latencyTimes = (await latencyBars.allTextContents()).map(text => text.trim().split(/\s+/)[0])
      const lossTimes = (await lossBars.allTextContents()).map(text => text.trim().split(/\s+/)[0])
      expect(latencyTimes).toEqual(lossTimes)
      expect(latencyTimes).toEqual([...latencyTimes].sort())

      if (sampleCount === 1) {
        const latencyClasses = await primaryNodeCard(page)
          .locator('[data-node-ping-bars="latency"] span')
          .evaluateAll(elements => elements.map(element => element.className))
        expect(latencyClasses.filter(className => className.includes('bg-muted-foreground/15'))).toHaveLength(19)
      }
    })
  }

  test('keeps the 20:00 Metric latency and loss sample in the first shared bucket', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      clockNow: '2026-07-25T12:58:00.000Z',
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        task202Latency: 7,
        task202Loss: 0,
        sampleTimes: ['2026-07-25T12:00:00.000Z'],
      },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '7 ms', '0.0%')

    const latencyBars = primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [role="tooltip"]')
    const lossBars = primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [role="tooltip"]')
    await expect(latencyBars).toHaveCount(20)
    await expect(lossBars).toHaveCount(20)
    await expect(latencyBars.first()).toContainText('20:00:00')
    await expect(latencyBars.first()).toContainText('7 ms')
    await expect(lossBars.first()).toContainText('20:00:00')
    await expect(lossBars.first()).toContainText('0.0%')
  })

  test('uses selected Legacy history instead of a stats.latest-only synthetic Metric point', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', metricQueryOmitTaskIds: [202], legacy: 'valid' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expect.poll(() => calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBe(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.entity_id === PRIMARY_NODE_UUID && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && call.params.entity_id === PRIMARY_NODE_UUID && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('keeps a valid binding empty when stats lack selected history and Legacy also lacks data', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', metricQueryOmitTaskIds: [202], legacy: 'selected-empty' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '-', '-')
    await expect.poll(() => calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBe(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.entity_id === PRIMARY_NODE_UUID && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && call.params.entity_id === PRIMARY_NODE_UUID && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('empty setting retains the all-task aggregate and does not request a task catalog', async ({ page }) => {
    let publicTaskCalls = 0
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string } | null
      if (payload?.method === 'public:getPublicPingTasks')
        publicTaskCalls += 1
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, { nodeCardPingFixture: { metric: 'valid' } })
    await openStablePage(page)

    await expectNodeCardPing(page, '91 ms', '12.5%')
    await expectNodeCardPingTooltip(page, 'latency', '105 ms')
    await expectNodeCardPingTooltip(page, 'loss', '12.5%')
    expect(publicTaskCalls).toBe(0)
  })

  test('valid selected task uses only that task\'s Metric latency, loss, and trend data', async ({ page }) => {
    const selectedMetricCalls: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method === 'public:queryMetrics' || payload?.method === 'public:getPingMetricStats')
        selectedMetricCalls.push(payload.params ?? {})
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expectNodeCardPingTooltip(page, 'latency', '200 ms')
    await expectNodeCardPingTooltip(page, 'loss', '25.0%')
    expect(selectedMetricCalls.some(call => call.task_id === '202')).toBe(true)
    expect(selectedMetricCalls.some(call => (call.tags as Record<string, unknown> | undefined)?.task_id === '202')).toBe(true)
    await expect(page.getByRole('textbox', { name: '节点卡片延迟监控任务' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: '节点卡片延迟监控任务' })).toHaveCount(0)
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.includes('nodeCardPingTaskBindings')))).toBe(false)
  })

  test('0 ms and 0% are valid selected Metric values', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', task202Latency: 0, task202Loss: 0 },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '0 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '0 ms')
    await expectNodeCardPingTooltip(page, 'loss', '0.0%')
  })

  test('a valid 100% loss Metric binding keeps latency empty, uses only its task, and recovers automatically', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        task202Latency: null,
        task202Loss: 100,
        sampleTimes: ['2026-07-25T12:00:00.000Z'],
      },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '-', '100.0%')
    await expect(primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [role="tooltip"]')).toHaveCount(20)
    await expect(primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [role="tooltip"]')).toHaveCount(20)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics'
      && isPingMetricQuery(call.params)
      && call.params.entity_id === PRIMARY_NODE_UUID
      && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)

    fixture.setNodeCardPingFixture({
      task202Latency: 17,
      task202Loss: 0,
      sampleTimes: ['2026-07-25T12:00:00.000Z', '2026-07-25T12:01:00.000Z'],
    })
    await fixture.advanceTime(65_000)
    await expectNodeCardPing(page, '17 ms', '0.0%')
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(2)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && call.params.task_id === undefined)).toHaveLength(0)
  })

  test('selected Legacy full-loss records keep a valid binding task-scoped when Metric requests fail', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'error', legacy: 'valid', task202Latency: null, task202Loss: 100 },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '-', '100.0%')
    await expect.poll(() => calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBe(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics'
      && isPingMetricQuery(call.params)
      && call.params.entity_id === PRIMARY_NODE_UUID
      && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('invalid task ID falls back to the original all-task aggregate', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding('2e2'),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '91 ms', '12.5%')
  })

  test('missing or deleted task falls back even when historical task data remains', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', task202Exists: false },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '91 ms', '12.5%')
  })

  test('task not assigned to the node falls back to the original all-task aggregate', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', task202Assigned: false },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '91 ms', '12.5%')
  })

  test('task with no Metric or Legacy data remains empty when its binding is valid', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'selected-empty', legacy: 'selected-empty' },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '-', '-')
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics'
      && isPingMetricQuery(call.params)
      && call.params.entity_id === PRIMARY_NODE_UUID
      && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('uses selected Legacy records when selected Metric requests fail', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'error', legacy: 'valid' },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expectNodeCardPingTooltip(page, 'latency', '200 ms')
    await expectNodeCardPingTooltip(page, 'loss', '100.0%')
  })

  test('keeps a valid binding empty when selected Metric and Legacy data are unavailable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'error', legacy: 'selected-empty' },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '-', '-')
  })

  test('malformed selected Metric data stays empty without accepting mismatched or aggregate task data', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'malformed', legacy: 'selected-empty' },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '-', '-')
  })

  test('changing task IDs cannot render a previous selected task from persistent cache', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
      preserveStorageOnReload: true,
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    expect(await page.evaluate((uuid) => {
      return Object.keys(localStorage).some(key => key.includes(`node-ping-stats:${uuid}:`))
    }, PRIMARY_NODE_UUID)).toBe(false)

    fixture.setNodeCardPingTaskBindings(primaryBinding(101))
    const resumeFirstReload = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('200 ms')
    resumeFirstReload()
    await expectNodeCardPing(page, '10 ms', '0.0%')

    fixture.setNodeCardPingTaskBindings(primaryBinding(202))
    const resumeSecondReload = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('10 ms')
    resumeSecondReload()
    await expectNodeCardPing(page, '200 ms', '25.0%')
  })

  test('list and detail Ping consumers remain unfiltered by node-card setting', async ({ page }) => {
    const detailPingCalls: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/rpc2'))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method === 'public:queryMetrics') {
        const metricKeys = Array.isArray(payload.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
        if (metricKeys.includes('ping.latency_ms') || metricKeys.includes('ping.loss'))
          detailPingCalls.push(payload.params ?? {})
      }
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
      viewMode: 'list',
    })
    await openStablePage(page)
    const listPingCell = page.getByRole('button', { name: '打开延迟和丢包监测' }).first()
    await expect(listPingCell.locator('span[aria-label$=" ms"]').first()).toHaveAttribute('aria-label', /105 ms$/)
    await expect(listPingCell.locator('span[aria-label$="%"]').first()).toHaveAttribute('aria-label', /12\.5%$/)

    detailPingCalls.length = 0
    await page.goto('/instance/00000000-0000-4000-8000-000000000001')
    await expect(page.getByText('硬件信息')).toBeVisible()
    await expect.poll(() => detailPingCalls.length).toBeGreaterThan(0)
    expect(detailPingCalls.every((params) => {
      const tags = params.tags as Record<string, unknown> | undefined
      return params.task_id === undefined && tags?.task_id === undefined
    })).toBe(true)
    expect(detailPingCalls.every((params) => {
      return params.start === '2026-07-25T11:03:00.000Z'
        && params.end === '2026-07-25T12:03:00.000Z'
    })).toBe(true)
  })

  test('the management page is node-centred, filters candidates by task clients, and saves UUID-to-ID mappings', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      hidePingTaskBindingEntry: true,
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page, '/?view=pingsettings')

    await expect(page.getByRole('heading', { name: '延迟任务绑定', exact: true })).toHaveClass(/text-2xl/)
    await expect(page.getByTestId('node-ping-binding-manager')).not.toContainText('09 · 延迟任务绑定')
    await expect(page.getByTestId('node-ping-binding-manager').getByText('09', { exact: true })).toHaveCount(0)

    const primaryRow = page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)
    await expect(primaryRow).toBeVisible()
    await expect(primaryRow).toContainText('2 个候选')
    await primaryRow.getByRole('button', { name: '选择任务' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Fixture Tokyo')
    await expect(dialog).toContainText('Fixture Hong Kong')
    await expect(dialog).not.toContainText('Fixture Seoul (not assigned to primary)')
    await dialog.locator('input[type="radio"][value="202"]').check()
    await dialog.getByRole('button', { name: '保存' }).click()

    await expect(primaryRow).toContainText('Fixture Hong Kong')
    expect(fixture.getThemeSaveCount()).toBe(1)
    const savedSettings = fixture.getSavedThemeSettings()
    expect(savedSettings.fixtureUnrelatedSetting).toBe('preserve-me')
    expect(savedSettings.hidePingTaskBindingEntry).toBe(true)
    expect(JSON.parse(String(savedSettings.nodeCardPingTaskBindings))).toEqual({ [PRIMARY_NODE_UUID]: 202 })
  })

  test('the management page searches nodes, filters unbound rows, and clears a binding', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCardPingTaskBindings: primaryBinding(202),
    })
    await openStablePage(page, '/?view=pingsettings')

    const search = page.getByRole('textbox', { name: '搜索节点延迟任务绑定' })
    await search.fill(PRIMARY_NODE_UUID)
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
    await search.fill('no-such-node')
    await expect(page.getByText('没有匹配的节点。')).toBeVisible()
    await search.fill(PRIMARY_NODE_UUID)
    await page.getByRole('checkbox', { name: '仅显示未绑定节点' }).check()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toHaveCount(0)
    await page.getByRole('checkbox', { name: '仅显示未绑定节点' }).uncheck()

    const primaryRow = page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)
    await primaryRow.getByRole('button', { name: '清除绑定' }).click()
    await expect(primaryRow).toContainText('未绑定')
    expect(JSON.parse(String(fixture.getSavedThemeSettings().nodeCardPingTaskBindings))).toEqual({})
  })

  test('saving cleanup removes deleted-node and no-longer-assigned task mappings', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCardPingTaskBindings: JSON.stringify({
        [PRIMARY_NODE_UUID]: 303,
        '00000000-0000-4000-8000-000000000999': 202,
      }),
    })
    await openStablePage(page, '/?view=pingsettings')

    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toContainText('失效绑定 · ID 303')
    await page.getByRole('button', { name: '清理 1 条失效映射' }).click()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toContainText('未绑定')
    expect(JSON.parse(String(fixture.getSavedThemeSettings().nodeCardPingTaskBindings))).toEqual({})
  })

  test('guests can open the page shell without requesting or displaying administrator data', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const adminRequests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/admin/'))
        adminRequests.push(`${request.method()} ${url.pathname}`)
    })
    await installKomariFixture(page, { adminAccess: 'guest' })
    await openStablePage(page, '/?view=pingsettings')
    await expect(page.getByTestId('node-ping-binding-unauthenticated')).toContainText('此页面仅允许已登录管理员操作。')
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '搜索节点延迟任务绑定' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
    expect(adminRequests).toEqual([])
  })

  test('an authenticated non-administrator sees forbidden state after the single permission probe', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const adminRequests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/admin/'))
        adminRequests.push(`${request.method()} ${url.pathname}`)
    })
    await installKomariFixture(page, { adminAccess: 'forbidden' })
    await openStablePage(page, '/?view=pingsettings')
    await expect(page.getByTestId('node-ping-binding-forbidden')).toContainText('当前账户没有管理员权限，无法读取或保存延迟任务绑定。')
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0)
    expect(adminRequests).toEqual(['GET /api/admin/ping'])
  })

  test('an administrator can open the known management URL while the toolbar entry is hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, {
      adminAccess: 'admin',
      hidePingTaskBindingEntry: true,
    })
    await openStablePage(page, '/?view=pingsettings')

    await expect(page.getByRole('heading', { name: '延迟任务绑定', exact: true })).toBeVisible()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
    await expect(page.getByRole('button', { name: '延迟任务绑定', exact: true })).toHaveCount(0)
  })

  test('the binding page title and return action remain separated on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installKomariFixture(page, { adminAccess: 'admin' })
    await openStablePage(page, '/?view=pingsettings')

    const heading = page.getByRole('heading', { name: '延迟任务绑定', exact: true })
    const returnButton = page.getByRole('button', { name: '返回首页' })
    await expect(heading).toBeVisible()
    await expect(returnButton).toBeVisible()
    const headingBox = await heading.boundingBox()
    const returnBox = await returnButton.boundingBox()
    expect(headingBox).not.toBeNull()
    expect(returnBox).not.toBeNull()
    expect(returnBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height)
  })

  test('the toolbar uses pingsettings and preserves unrelated query parameters', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, { adminAccess: 'guest', hidePingTaskBindingEntry: false })
    await openStablePage(page, '/?source=toolbar')

    await page.getByRole('button', { name: '延迟任务绑定', exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('pingsettings')
    expect(new URL(page.url()).searchParams.get('source')).toBe('toolbar')
    await expect(page.getByTestId('node-ping-binding-unauthenticated')).toBeVisible()
  })

  test('the legacy binding URL replaces itself with pingsettings without dropping other query parameters', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, { adminAccess: 'admin' })
    await openStablePage(page, '/?view=node-ping-bindings&source=legacy')

    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('pingsettings')
    expect(new URL(page.url()).searchParams.get('source')).toBe('legacy')
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
  })

  test('returning home removes only the binding view query', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, { adminAccess: 'admin' })
    await openStablePage(page, '/?view=pingsettings&source=return')

    await page.getByRole('button', { name: '返回首页' }).click()
    await expect.poll(() => new URL(page.url()).searchParams.has('view')).toBe(false)
    expect(new URL(page.url()).searchParams.get('source')).toBe('return')
  })
})
