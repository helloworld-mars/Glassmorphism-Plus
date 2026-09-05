import type { Locator, Page } from '@playwright/test'
import type { NodeCardPingHistoryPoint } from '../../src/types/node-card-ping'
import type { MetricQueryParams, MetricQueryResponse } from '../../src/utils/rpc'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { getQueryMetricsRequestKey } from '../../src/services/metrics.service'
import { loadPingMetricCoverage } from '../../src/services/pingMetricCoverage.service'
import { RequestManager } from '../../src/services/request.service'
import { comparePingTaskOrder, createPingTaskOrderMap, orderPingTasksByBackend } from '../../src/utils/metricSeries'
import { inspectNodeCardPingConfig } from '../../src/utils/nodeCardPingConfig'
import { latencyBucketSeverity, lossBucketSeverity } from '../../src/utils/nodeCardPingPresentation'
import { resolvePingChartDisplayDomain } from '../../src/utils/pingChartDisplayDomain'
import { smoothPingChartDisplayRows } from '../../src/utils/pingChartSmoothing'
import { resolvePingHistoryBucketState } from '../../src/utils/pingHistoryState'
import { mergePingMetricCoverageResponses } from '../../src/utils/pingMetricCoverage'
import { normalizePingMetricSamples } from '../../src/utils/pingMetricSamples'
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

const MULTI_PING_CACHE_PREFIX = 'komari-theme-emerald:multi-node-ping-stats:'

test('Plus documentation keeps its own version identity and preserves upstream attribution', () => {
  const readRootFile = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')
  const readme = readRootFile('README.md')
  const changelog = readRootFile('CHANGELOG.md')
  const upstream = readRootFile('UPSTREAM.md')
  const credits = readRootFile('CREDITS.md')
  const license = readRootFile('LICENSE')

  expect(readme).toContain('# 🌌 Komari Glassmorphism Plus')
  expect(readme).toContain('当前 Plus 版本')
  expect(readme).toContain('**v2.7.3**')
  expect(readme).toContain('sanrokamlan Glassmorphism v3.3.7')
  expect(readme).toContain('Glassmorphism-Plus-release-2.7.3.zip')
  expect(readme).toContain('Source code (zip)')
  expect(readme).not.toMatch(/^#{2,}\s+(?:\S.*)?v3\.\d/m)

  const changelogVersions = Array.from(changelog.matchAll(/^## \[([^\]]+)\]/gm), match => match[1])
  expect(changelogVersions).toEqual(['2.7.3', '2.7.2', '2.7.1', '2.7.0', '2.6.0', '2.5.0', '2.3.1', '2.3.0', '2.2.0', '2.1.0', '2.0.0', '1.4.0', '1.3.6', '1.3.5', '1.3.4', '1.3.3', '1.3.2', '1.3.1', '1.3.0', '1.2.1'])
  expect(upstream).toContain('Current upstream baseline')
  expect(upstream).toContain('v3.3.7')
  expect(credits).toContain('VoyagerProbe')
  expect(credits).toContain('sanrokamlan')
  expect(credits).toContain('Komari-Theme-LuminaPlus')
  expect(credits).toContain('clean-room reimplementation')
  expect(credits).toContain('not the upstream')
  expect(credits).toContain('Tony Liu')
  expect(createHash('sha256').update(license).digest('hex').toUpperCase()).toBe('4703F29BF392157FC005B92C18AE015C270BEEC13EF33A4A603D28A1B4E166D8')

  for (const document of [readme, changelog, upstream, credits]) {
    expect(document).not.toContain('C:\\Users\\')
    expect(document).not.toContain('.codex/attachments')
  }
})

interface CoverageTestSample {
  time: string
  latency: number | null
  loss: number | null
  count?: number
  taskId?: number
}

function buildCoverageTestResponse(
  start: string,
  end: string,
  intervalSeconds: number,
  samples: CoverageTestSample[],
  taskIds = [...new Set(samples.map(sample => sample.taskId ?? 202))],
): MetricQueryResponse {
  const series = ['ping.latency_ms', 'ping.loss'].flatMap(metricKey => taskIds.map((taskId) => {
    const taskSamples = samples.filter(sample => (sample.taskId ?? 202) === taskId)
    return {
      metric_key: metricKey,
      entity_id: PRIMARY_NODE_UUID,
      tags: { task_id: String(taskId), task_name: `Task ${taskId}` },
      downsampled: true,
      fill_empty: true,
      interval_seconds: intervalSeconds,
      count: taskSamples.length,
      points: taskSamples.map(sample => ({
        time: sample.time,
        value: metricKey === 'ping.loss' ? sample.loss : sample.latency,
        count: sample.count ?? 1,
      })),
    }
  }))

  return {
    start,
    end,
    series,
    count: series.reduce((total, item) => total + item.points.length, 0),
  }
}

function coverageTestParams(hours: number): MetricQueryParams {
  const end = Date.parse('2026-08-13T08:00:00.000Z')
  return {
    metric_keys: ['ping.latency_ms', 'ping.loss'],
    entity_id: PRIMARY_NODE_UUID,
    start: new Date(end - hours * 3_600_000).toISOString(),
    end: new Date(end).toISOString(),
    max_points: 6000,
    aggregation: 'avg',
    downsample: true,
    fill_empty: true,
  }
}

function responseForCoverageRequest(params: MetricQueryParams, intervalSeconds: number, taskIds = [202]): MetricQueryResponse {
  const start = String(params.start)
  const end = String(params.end)
  const sampleTime = new Date(Date.parse(start) + Math.min(intervalSeconds * 1000, 3_600_000)).toISOString()
  return buildCoverageTestResponse(start, end, intervalSeconds, taskIds.map(taskId => ({
    time: sampleTime,
    taskId,
    latency: 30 + taskId / 1000,
    loss: 0,
    count: intervalSeconds >= 3600 ? 60 : 1,
  })), taskIds)
}

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
  const card = primaryNodeCard(page)
  for (const metric of ['latency', 'loss']) {
    const bars = card.locator(`[data-node-ping-bars="${metric}"]`)
    await expect(bars).toBeVisible()
    await expect.poll(() => bars.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
  }
}

function primaryNodeCard(page: Page) {
  return page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"]`)
}

function nodeCardPingPanel(page: Page, metric: 'latency' | 'loss') {
  const card = primaryNodeCard(page)
  return card.locator('[data-node-ping-task-id]').first().or(card.locator(`[data-node-ping-bars="${metric}"]`).locator('..')).first()
}

async function expectNodeCardPing(page: Page, latency: string, loss: string): Promise<void> {
  const card = primaryNodeCard(page)
  const latencySummary = card.locator('[data-node-ping-summary="latency"]').first()
  if (await latencySummary.count()) {
    await expect.poll(async () => (await latencySummary.textContent() ?? '').replace(/\s+/g, '')).toContain(latency.replace(/\s+/g, ''))
    await expect.poll(async () => (await card.locator('[data-node-ping-summary="loss"]').first().textContent() ?? '').replace(/\s+/g, '')).toContain(loss.replace(/\s+/g, ''))
    return
  }
  await expect.poll(async () => (await card.textContent() ?? '').replace(/\s+/g, '')).toContain(latency.replace(/\s+/g, ''))
  await expect.poll(async () => (await card.textContent() ?? '').replace(/\s+/g, '')).toContain(loss.replace(/\s+/g, ''))
}

async function openPrimaryPingDialog(page: Page): Promise<Locator> {
  await nodeCardPingPanel(page, 'latency').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-ping-chart]')).toBeVisible()
  return dialog
}

function readPingRangeHours(params: Record<string, unknown>): number {
  return (Date.parse(String(params.end)) - Date.parse(String(params.start))) / 3_600_000
}

function isRpc2Request(requestUrl: string): boolean {
  return new URL(requestUrl).pathname.replace(/\/+$/, '').endsWith('/rpc2')
}

type VisitorThemeMode = 'light' | 'beijing' | 'dark'

async function expectVisitorThemeState(page: Page, selected: VisitorThemeMode, effective: 'light' | 'dark'): Promise<void> {
  const root = page.locator('html')
  for (const mode of ['light', 'beijing', 'dark'] as const)
    await expect(page.getByTestId(`theme-mode-${mode}`)).toHaveAttribute('aria-pressed', String(mode === selected))
  await expect(root).toHaveClass(effective === 'dark' ? /dark/ : /^(?!.*\bdark\b)/)
  await expect.poll(() => root.evaluate(element => element.style.colorScheme)).toBe(effective)
}

test('RPC request observers accept clean and prefixed rpc2 paths without overmatching', () => {
  expect(isRpc2Request('http://127.0.0.1:4173/rpc2')).toBe(true)
  expect(isRpc2Request('http://127.0.0.1:4173/api/rpc2')).toBe(true)
  expect(isRpc2Request('http://127.0.0.1:4173/custom/rpc2/?request=1')).toBe(true)
  expect(isRpc2Request('http://127.0.0.1:4173/rpc20')).toBe(false)
})

test('v2.3.1 presentation keeps severe degradation distinct from a paired confirmed outage', () => {
  const point = (latency: number | null, loss: number | null): NodeCardPingHistoryPoint => ({
    time: '2026-09-03T00:56:00.000Z',
    latency,
    loss,
    latencySampleTime: '2026-09-03T00:56:00.000Z',
    lossSampleTime: '2026-09-03T00:56:00.000Z',
    latencyState: 'data',
    lossState: 'data',
  })

  expect(latencyBucketSeverity(point(180, 0))).toBe('elevated')
  expect(latencyBucketSeverity(point(204, 50))).toBe('critical')
  expect(lossBucketSeverity(point(204, 50))).toBe('critical')
  expect(latencyBucketSeverity(point(null, 100))).toBe('unreachable')
  expect(lossBucketSeverity(point(null, 100))).toBe('unreachable')
  expect(latencyBucketSeverity({ ...point(null, 100), latencyState: 'pending' })).toBe('waiting')
  expect(latencyBucketSeverity({ ...point(null, null), latencyState: 'confirmed-missing', lossState: 'confirmed-missing' })).toBe('no-sample')
  expect(lossBucketSeverity({ ...point(null, null), latencyState: 'confirmed-missing', lossState: 'confirmed-missing' })).toBe('no-sample')
  expect(latencyBucketSeverity({ ...point(null, null), latencyState: 'pending', lossState: 'pending' }, true)).toBe('error')
  expect(latencyBucketSeverity(point(999, 100))).toBe('critical')
  expect(lossBucketSeverity(point(999, 100))).toBe('critical')
})

test('v2.7.2 finalizes only successfully queried closed Ping buckets after the existing retry budget', () => {
  const timing = {
    bucketStart: 0,
    bucketEnd: 180_000,
    now: 60_000,
    latestAcceptedSampleAt: null,
    firstObservedAt: 0,
    taskIntervalMs: 60_000,
    canConfirmMissing: true,
  }

  expect(resolvePingHistoryBucketState(false, timing)).toBe('pending')
  expect(resolvePingHistoryBucketState(false, { ...timing, now: 180_000 })).toBe('pending')
  expect(resolvePingHistoryBucketState(false, { ...timing, now: 219_999 })).toBe('pending')
  expect(resolvePingHistoryBucketState(false, { ...timing, now: 220_000 })).toBe('confirmed-missing')
  expect(resolvePingHistoryBucketState(false, { ...timing, now: 500_000, canConfirmMissing: false })).toBe('pending')
  expect(resolvePingHistoryBucketState(true, { ...timing, now: 500_000 })).toBe('data')
})

async function expectNodeCardPingTooltip(page: Page, metric: 'latency' | 'loss', text: string): Promise<void> {
  const buckets = primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)
  if (await primaryNodeCard(page).locator('[data-node-ping-task-id]').count()) {
    await expect.poll(async () => (await buckets.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? '')))
      .some(content => content.includes(text))).toBe(true)
    return
  }
  let found = false
  for (let index = 0; index < await buckets.count(); index += 1) {
    await buckets.nth(index).hover({ force: true })
    const tooltip = page.locator('[data-slot="data-tooltip-content"]').last()
    if (await tooltip.isVisible() && (await tooltip.textContent() ?? '').includes(text)) {
      found = true
      break
    }
  }
  expect(found).toBe(true)
}

async function expectNodeCardPingInfoStatus(page: Page, expectedStatus: string): Promise<void> {
  const button = primaryNodeCard(page).getByRole('button', { name: '查看该 Ping 任务详情' }).first()
  await button.hover()
  const tooltip = page.locator('[data-slot="data-tooltip-content"]')
  await expect(tooltip).toBeVisible({ timeout: 200 })
  const status = tooltip.locator('dt').filter({ hasText: /^当前状态$/ }).locator('xpath=following-sibling::dd[1]')
  await expect(status).toHaveText(expectedStatus)
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
}

function nodeCardPingBucket(page: Page, metric: 'latency' | 'loss', time: string): Locator {
  return primaryNodeCard(page)
    .locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bucket-time="${time}"]`)
}

async function expectNodeCardPingBucketState(
  page: Page,
  metric: 'latency' | 'loss',
  time: string,
  state: 'pending' | 'data' | 'confirmed-missing' | 'error' | 'unreachable',
): Promise<void> {
  await expect(nodeCardPingBucket(page, metric, time)).toHaveAttribute('data-node-ping-state', state)
}

async function expectAllNodeCardPingBucketStates(
  page: Page,
  metric: 'latency' | 'loss',
  state: 'pending' | 'data' | 'confirmed-missing' | 'error' | 'unreachable',
): Promise<void> {
  const bars = primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)
  await expect(bars).toHaveCount(20)
  await expect.poll(async () => bars.evaluateAll((elements, expectedState) => elements.every((element) => {
    return element.getAttribute('data-node-ping-state') === expectedState
  }), state)).toBe(true)
}

async function readNodeCardPingBarGeometry(card: Locator, metric: 'latency' | 'loss') {
  return card.locator(`[data-node-ping-bars="${metric}"]`).evaluate((element) => {
    const strip = element.getBoundingClientRect()
    const columnGap = Number.parseFloat(getComputedStyle(element).columnGap) || 0
    const bars = Array.from(element.querySelectorAll<HTMLElement>(':scope > [data-node-ping-bar]')).map((bar) => {
      const rect = bar.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
    })
    return {
      left: strip.left,
      right: strip.right,
      columnGap,
      bars,
    }
  })
}

async function expectUniformNodeCardPingBars(card: Locator): Promise<void> {
  for (const metric of ['latency', 'loss'] as const) {
    await expect.poll(async () => {
      const geometry = await readNodeCardPingBarGeometry(card, metric)
      if (geometry.bars.length !== 20)
        return false

      const widths = geometry.bars.map(bar => bar.width)
      if (widths.some(width => width <= 0))
        return false

      // WebKit distributes fractional CSS pixels across grid tracks, so adjacent
      // cells can legitimately differ by one device pixel while still forming a
      // uniform 20-column rail. Assert that bounded distribution and the declared
      // CSS gap instead of requiring Chromium-identical subpixel rectangles.
      const widthSpread = Math.max(...widths) - Math.min(...widths)
      return widthSpread <= 1.01 && geometry.bars.every((bar, index) => {
        const previous = geometry.bars[index - 1]
        return index === 0 || Math.abs(bar.left - previous!.right - geometry.columnGap) <= 1.01
      })
    }).toBe(true)

    const geometry = await readNodeCardPingBarGeometry(card, metric)
    expect(geometry.bars).toHaveLength(20)
    expect(geometry.bars[0]!.left).toBeGreaterThanOrEqual(geometry.left - 0.01)
    expect(geometry.bars.at(-1)!.right).toBeLessThanOrEqual(geometry.right + 0.01)
  }
}

async function readNodeCardPingPanelVerticalGeometry(card: Locator, metric: 'latency' | 'loss') {
  return card.locator(`[data-node-ping-panel="${metric}"]`).evaluate((element, panelMetric) => {
    const header = element.querySelector<HTMLElement>(`[data-node-ping-header="${panelMetric}"]`)
    const bars = element.querySelector<HTMLElement>(`[data-node-ping-bars="${panelMetric}"]`)
    if (!header || !bars)
      return null

    const panelRect = element.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const barsRect = bars.getBoundingClientRect()
    return {
      panel: { top: panelRect.top, bottom: panelRect.bottom },
      header: { top: headerRect.top, bottom: headerRect.bottom },
      bars: { top: barsRect.top, bottom: barsRect.bottom },
    }
  }, metric)
}

async function expectMatchingNodeCardPingPanelVerticalGeometry(card: Locator): Promise<void> {
  if (await card.locator('[data-node-ping-task-id], [data-node-ping-task-placeholder]').count()) {
    await expect.poll(async () => {
      const widths = await Promise.all((['latency', 'loss'] as const).map(metric => card
        .locator(`[data-node-ping-bars="${metric}"]`)
        .first()
        .evaluate(element => element.getBoundingClientRect().width)))
      return Math.abs(widths[0] - widths[1])
    }).toBeLessThanOrEqual(0.01)
    return
  }

  await expect.poll(async () => {
    const [latency, loss] = await Promise.all([
      readNodeCardPingPanelVerticalGeometry(card, 'latency'),
      readNodeCardPingPanelVerticalGeometry(card, 'loss'),
    ])
    if (!latency || !loss)
      return false

    return [
      [latency.panel.top, loss.panel.top],
      [latency.panel.bottom, loss.panel.bottom],
      [latency.header.top, loss.header.top],
      [latency.header.bottom, loss.header.bottom],
      [latency.bars.top, loss.bars.top],
      [latency.bars.bottom, loss.bars.bottom],
    ].every(([latencyY, lossY]) => Math.abs(latencyY! - lossY!) <= 0.01)
  }).toBe(true)
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

test('v2.7.0 trims only a relative Ping display tail to the latest finalized visible sample', () => {
  const requestedStart = Date.parse('2026-09-04T10:20:00.000Z')
  const requestedEnd = Date.parse('2026-09-04T11:20:00.000Z')
  const samples = [
    { taskId: 101, time: '2026-09-04T11:15:00.000Z', finalized: true },
    { taskId: 202, time: '2026-09-04T11:17:00.000Z', finalized: true },
    { taskId: 303, time: '2026-09-04T11:16:00.000Z', finalized: true },
    // A fill-empty marker is not a real finalized observation and must not
    // manufacture the endpoint that the display-domain correction removes.
    { taskId: 202, time: '2026-09-04T11:20:00.000Z', finalized: false },
    { taskId: 404, time: '2026-09-04T11:19:00.000Z', finalized: true },
  ]

  expect(resolvePingChartDisplayDomain({
    requestedStart,
    requestedEnd,
    selectedTaskIds: [101, 202, 303],
    samples,
    preserveRequestedEnd: false,
  })).toEqual({
    min: requestedStart,
    max: Date.parse('2026-09-04T11:17:00.000Z'),
    latestFinalizedTimestamp: Date.parse('2026-09-04T11:17:00.000Z'),
  })

  expect(resolvePingChartDisplayDomain({
    requestedStart,
    requestedEnd,
    selectedTaskIds: [101, 303],
    samples,
    preserveRequestedEnd: false,
  }).max).toBe(Date.parse('2026-09-04T11:16:00.000Z'))

  expect(resolvePingChartDisplayDomain({
    requestedStart,
    requestedEnd,
    selectedTaskIds: [202],
    samples: [{ taskId: 202, time: '2026-09-04T11:18:00.000Z', finalized: true }],
    preserveRequestedEnd: false,
  }).max).toBe(Date.parse('2026-09-04T11:18:00.000Z'))

  expect(resolvePingChartDisplayDomain({
    requestedStart,
    requestedEnd,
    selectedTaskIds: [],
    samples,
    preserveRequestedEnd: false,
  })).toEqual({
    min: requestedStart,
    max: requestedEnd,
    latestFinalizedTimestamp: null,
  })

  expect(resolvePingChartDisplayDomain({
    requestedStart,
    requestedEnd,
    selectedTaskIds: [202],
    samples,
    preserveRequestedEnd: true,
  })).toEqual({
    min: requestedStart,
    max: requestedEnd,
    latestFinalizedTimestamp: Date.parse('2026-09-04T11:17:00.000Z'),
  })
})

test('v2.5.0 maps real samples into one fixed 09:09–10:09 three-minute window', () => {
  const start = Date.parse('2026-09-03T09:09:00+08:00')
  const end = Date.parse('2026-09-03T10:09:00+08:00')
  const window = createPingTimeWindow(start, end, 20)
  expect(window).not.toBeNull()
  if (!window)
    return

  const samples = [
    ['2026-09-03T09:58:00+08:00', 16],
    ['2026-09-03T10:02:00+08:00', 17],
    ['2026-09-03T10:05:00+08:00', 18],
    ['2026-09-03T10:07:00+08:00', 19],
  ] as const
  for (const [time, index] of samples)
    expect(getPingTimeBucketIndex(Date.parse(time), window)).toBe(index)

  expect(Array.from({ length: 6 }, (_, offset) => {
    const index = 14 + offset
    return [
      new Date(window.start + index * window.bucketWidth).toISOString(),
      new Date(window.start + (index + 1) * window.bucketWidth).toISOString(),
    ]
  })).toEqual([
    ['2026-09-03T01:51:00.000Z', '2026-09-03T01:54:00.000Z'],
    ['2026-09-03T01:54:00.000Z', '2026-09-03T01:57:00.000Z'],
    ['2026-09-03T01:57:00.000Z', '2026-09-03T02:00:00.000Z'],
    ['2026-09-03T02:00:00.000Z', '2026-09-03T02:03:00.000Z'],
    ['2026-09-03T02:03:00.000Z', '2026-09-03T02:06:00.000Z'],
    ['2026-09-03T02:06:00.000Z', '2026-09-03T02:09:00.000Z'],
  ])
  expect(getPingTimeBucketIndex(end, window)).toBeNull()
})

test('v2.5.0 sorts and deduplicates out-of-order Ping samples without crossing task, node, or window identity', () => {
  const start = Date.parse('2026-09-03T09:09:00+08:00')
  const end = Date.parse('2026-09-03T10:09:00+08:00')
  const tags = { task_id: '22', task_name: 'Guangdong Telecom' }
  const samples = normalizePingMetricSamples([
    {
      metric_key: 'ping.latency_ms',
      entity_id: PRIMARY_NODE_UUID,
      tags,
      points: [
        { time: '2026-09-03T10:05:00+08:00', value: 9, count: 1 },
        { time: '2026-09-03T09:58:00+08:00', value: 8, count: 1 },
        { time: '2026-09-03T10:02:00+08:00', value: 7, count: 1 },
        { time: '2026-09-03T10:02:00+08:00', value: 8, count: 1 },
        { time: '2026-09-03T10:07:00+08:00', value: 9, count: 1 },
        { time: '2026-09-03T10:09:00+08:00', value: 99, count: 1 },
      ],
    },
    {
      metric_key: 'ping.loss',
      entity_id: PRIMARY_NODE_UUID,
      tags,
      points: [
        { time: '2026-09-03T10:07:00+08:00', value: 0, count: 1 },
        { time: '2026-09-03T10:02:00+08:00', value: 0.1, count: 1 },
        { time: '2026-09-03T09:58:00+08:00', value: 1 / 3, count: 1 },
        { time: '2026-09-03T10:02:00+08:00', value: 0, count: 1 },
        { time: '2026-09-03T10:05:00+08:00', value: 0, count: 1 },
      ],
    },
    {
      metric_key: 'ping.latency_ms',
      entity_id: PRIMARY_NODE_UUID,
      tags: { task_id: '23' },
      points: [{ time: '2026-09-03T10:02:00+08:00', value: 123, count: 1 }],
    },
    {
      metric_key: 'ping.latency_ms',
      entity_id: '00000000-0000-4000-8000-999999999999',
      tags,
      points: [{ time: '2026-09-03T10:02:00+08:00', value: 456, count: 1 }],
    },
  ], { entityId: PRIMARY_NODE_UUID, taskId: '22', start, end })

  expect(samples.map(sample => sample.time)).toEqual([
    '2026-09-03T01:58:00.000Z',
    '2026-09-03T02:02:00.000Z',
    '2026-09-03T02:05:00.000Z',
    '2026-09-03T02:07:00.000Z',
  ])
  expect(samples.map(sample => [sample.latency, sample.loss])).toEqual([
    [8, 1 / 3],
    [8, 0],
    [9, 0],
    [9, 0],
  ])
  expect(new Set(samples.map(sample => sample.timestamp)).size).toBe(samples.length)
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

test('Ping display smoothing keeps raw timestamps, missing gaps, and zero-valued real samples intact', () => {
  const raw = [
    { time: '2026-07-25T11:00:00.000Z', 202: 10 },
    { time: '2026-07-25T11:01:00.000Z', 202: null },
    { time: '2026-07-25T11:02:00.000Z', 202: 0 },
    { time: '2026-07-25T11:03:00.000Z', 202: 20 },
  ]

  const display = smoothPingChartDisplayRows(raw, [202])
  expect(display).not.toBe(raw)
  expect(display.map(row => row.time)).toEqual(raw.map(row => row.time))
  expect(display[1]![202]).toBeNull()
  expect(display[2]![202]).toBe(0)
  expect(display[3]![202]).toBe(7)
  expect(raw).toEqual([
    { time: '2026-07-25T11:00:00.000Z', 202: 10 },
    { time: '2026-07-25T11:01:00.000Z', 202: null },
    { time: '2026-07-25T11:02:00.000Z', 202: 0 },
    { time: '2026-07-25T11:03:00.000Z', 202: 20 },
  ])
})

test('paired Ping rollups restore successful RTT, preserve true low latency, and keep outages null', () => {
  const entityId = PRIMARY_NODE_UUID
  const tags = { task_id: '17', task_name: 'Hinet' }
  const times = [
    '2026-08-07T00:00:00.000Z',
    '2026-08-07T01:00:00.000Z',
    '2026-08-07T06:00:00.000Z',
    '2026-08-07T07:00:00.000Z',
    '2026-08-07T08:00:00.000Z',
  ]
  const samples = normalizePingMetricSamples([
    {
      metric_key: 'ping.latency_ms',
      entity_id: entityId,
      tags,
      downsampled: true,
      count: times.length,
      points: [
        { time: times[0]!, value: 11.166666666666666, count: 60 },
        { time: times[1]!, value: null, count: 60 },
        { time: times[2]!, value: 9.4, count: 60 },
        { time: times[3]!, value: 9, count: 60 },
        { time: times[4]!, value: 12, count: 60 },
      ],
    },
    {
      metric_key: 'ping.loss',
      entity_id: entityId,
      tags,
      downsampled: true,
      count: times.length,
      points: [
        { time: times[0]!, value: 0.6, count: 60 },
        { time: times[1]!, value: 1, count: 60 },
        { time: times[2]!, value: 2 / 3, count: 60 },
        { time: times[3]!, value: 0, count: 60 },
        { time: times[4]!, value: 0, count: 60 },
      ],
    },
  ])

  expect(samples.map(sample => sample.taskId)).toEqual(['17', '17', '17', '17', '17'])
  expect(samples[0]?.latency).toBeCloseTo(29.4166666667, 8)
  expect(samples[1]).toMatchObject({ latency: null, loss: 1, observed: true })
  expect(samples[2]?.latency).toBeCloseTo(30.2, 8)
  expect(samples[3]?.latency).toBe(9)
  expect(samples[4]?.latency).toBe(12)

  const rows = samples.map(sample => ({ time: sample.time, 17: sample.latency }))
  const smoothed = smoothPingChartDisplayRows(rows, [17])
  expect(rows[1]?.[17]).toBeNull()
  expect(smoothed[1]?.[17]).toBeNull()
  expect(smoothed[2]?.[17]).toBeCloseTo(30.2, 8)
})

test('Ping Metric request identities isolate 7-day, 14-day, and 30-day windows', () => {
  const requestKey = (hours: number) => getQueryMetricsRequestKey({
    metric_keys: ['ping.latency_ms', 'ping.loss'],
    entity_id: PRIMARY_NODE_UUID,
    hours,
    start: new Date(Date.UTC(2026, 7, 13) - hours * 3_600_000).toISOString(),
    end: new Date(Date.UTC(2026, 7, 13)).toISOString(),
    max_points: 6000,
    aggregation: 'avg',
    downsample: true,
    fill_empty: true,
  })

  expect(new Set([requestKey(168), requestKey(336), requestKey(720)]).size).toBe(3)
})

test('Metric request identities isolate per-metric aggregation maps deterministically', () => {
  const base: MetricQueryParams = {
    metric_keys: ['cpu.usage', 'net.total.up', 'net.total.down'],
    entity_id: PRIMARY_NODE_UUID,
    hours: 24,
    max_points: 700,
    aggregation: 'avg',
    downsample: true,
    fill_empty: true,
  }
  const lastCounters = {
    'net.total.up': 'last',
    'net.total.down': 'last',
  } as const
  const reversedLastCounters = {
    'net.total.down': 'last',
    'net.total.up': 'last',
  } as const

  const baseKey = getQueryMetricsRequestKey(base)
  const lastKey = getQueryMetricsRequestKey({ ...base, aggregation_by_metric: lastCounters })
  const reversedKey = getQueryMetricsRequestKey({ ...base, aggregation_by_metric: reversedLastCounters })
  const avgKey = getQueryMetricsRequestKey({
    ...base,
    aggregation_by_metric: { 'net.total.up': 'avg', 'net.total.down': 'avg' },
  })
  const aliasKey = getQueryMetricsRequestKey({ ...base, algorithm_by_metric: lastCounters })

  expect(lastKey).not.toBe(baseKey)
  expect(lastKey).not.toBe(avgKey)
  expect(lastKey).toBe(reversedKey)
  expect(aliasKey).not.toBe(lastKey)
})

test('Ping multi-tier merge keeps coarse history, lets finer observations win, and preserves explicit outage gaps', () => {
  const start = '2026-07-14T08:00:00.000Z'
  const end = '2026-08-13T08:00:00.000Z'
  const coarse = buildCoverageTestResponse(start, end, 86_400, [
    { time: '2026-07-15T00:00:00.000Z', latency: 40, loss: 0, count: 1440 },
    { time: '2026-08-07T00:00:00.000Z', latency: 20, loss: 0, count: 1440 },
    { time: '2026-08-08T00:00:00.000Z', latency: 25, loss: 0, count: 1440 },
    { time: '2026-08-07T00:00:00.000Z', latency: 18, loss: 0, count: 1440, taskId: 303 },
  ])
  const fine = buildCoverageTestResponse('2026-07-19T08:00:00.000Z', end, 3600, [
    { time: '2026-08-07T00:00:00.000Z', latency: 31, loss: 0, count: 60 },
    { time: '2026-08-08T00:00:00.000Z', latency: null, loss: 1, count: 60 },
    { time: '2026-08-09T00:00:00.000Z', latency: 9, loss: 0, count: 60 },
    { time: '2026-08-10T00:00:00.000Z', latency: 12, loss: 0, count: 60 },
    { time: '2026-08-07T00:00:00.000Z', latency: 17, loss: 0, count: 60, taskId: 303 },
  ])

  const merged = mergePingMetricCoverageResponses([coarse, fine])
  expect(merged.start).toBe(start)
  expect(merged.end).toBe(end)

  const task202 = normalizePingMetricSamples(merged.series, {
    entityId: PRIMARY_NODE_UUID,
    taskId: '202',
  })
  expect(task202.map(sample => sample.time)).toEqual([
    '2026-07-15T00:00:00.000Z',
    '2026-08-07T00:00:00.000Z',
    '2026-08-08T00:00:00.000Z',
    '2026-08-09T00:00:00.000Z',
    '2026-08-10T00:00:00.000Z',
  ])
  expect(task202.map(sample => sample.latency)).toEqual([40, 31, null, 9, 12])
  expect(task202[2]).toMatchObject({ loss: 1, observed: true })
  expect(new Set(task202.map(sample => sample.timestamp)).size).toBe(task202.length)

  const task303 = normalizePingMetricSamples(merged.series, {
    entityId: PRIMARY_NODE_UUID,
    taskId: '303',
  })
  expect(task303).toHaveLength(1)
  expect(task303[0]?.latency).toBe(17)

  const smoothed = smoothPingChartDisplayRows(task202.map(sample => ({ time: sample.time, 202: sample.latency })), [202])
  expect(smoothed[2]?.[202]).toBeNull()
  expect(smoothed[3]?.[202]).toBe(9)
})

test('Ping long-range loader adapts to custom retention with a bounded batched request budget', async () => {
  const runProfile = async (
    outerHours: number,
    intervalForHours: (hours: number) => number,
    taskIds = [202],
  ) => {
    const calls: number[] = []
    const result = await loadPingMetricCoverage(coverageTestParams(outerHours), async (params) => {
      const hours = readPingRangeHours(params as Record<string, unknown>)
      calls.push(hours)
      return responseForCoverageRequest(params, intervalForHours(hours), taskIds)
    })
    return { calls, result }
  }

  const defaultRetention = await runProfile(720, hours => hours > 600 ? 86_400 : 3600, Array.from({ length: 12 }, (_, index) => 200 + index))
  expect(defaultRetention.calls).toEqual([720, 600])
  expect(defaultRetention.result.requests).toHaveLength(2)
  expect(defaultRetention.result.response.series).toHaveLength(24)

  const shorterRetention = await runProfile(719, hours => hours > 300 ? 86_400 : 3600)
  expect(shorterRetention.calls).toEqual([719, 600, 300])
  expect(shorterRetention.result.requests).toHaveLength(3)

  const shorterRetentionCacheHit = await runProfile(719, hours => hours > 300 ? 86_400 : 3600)
  expect(shorterRetentionCacheHit.calls).toEqual([719, 300])
  expect(shorterRetentionCacheHit.result.requests).toHaveLength(2)

  const completeDailyWithFineRecent = await runProfile(718, hours => hours > 600 ? 86_400 : 3600)
  expect(completeDailyWithFineRecent.calls).toEqual([718, 600])
  expect(completeDailyWithFineRecent.result.response.series.every(series => series.points.length >= 1)).toBe(true)

  const sparseDailyWithoutFineTier = await runProfile(717, () => 86_400)
  expect(sparseDailyWithoutFineTier.calls).toEqual([717, 600, 300, 150])
  expect(sparseDailyWithoutFineTier.result.requests).toHaveLength(4)

  const fourteenDays = await runProfile(336, () => 3600)
  expect(fourteenDays.calls).toEqual([336])
  expect(fourteenDays.result.requests).toHaveLength(1)
})

test('identical Ping Metric segments share the existing in-flight RequestManager promise', async () => {
  const manager = new RequestManager()
  const key = getQueryMetricsRequestKey(coverageTestParams(720))
  let executions = 0
  let resolveTask: ((value: string) => void) | undefined
  const taskResult = new Promise<string>((resolve) => {
    resolveTask = resolve
  })
  const task = async () => {
    executions += 1
    return taskResult
  }

  const first = manager.run(key, task, { timeout: 1000, retryAttempts: 0 })
  const second = manager.run(key, task, { timeout: 1000, retryAttempts: 0 })
  expect(second).toBe(first)
  expect(executions).toBe(1)
  resolveTask?.('ok')
  await expect(first).resolves.toBe('ok')
  await expect(second).resolves.toBe('ok')
  expect(executions).toBe(1)
})

test('Ping modal and detail restore the smoothing control without changing the raw data contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardPingFixture: { metric: 'valid' } })
  await openStablePage(page)

  const dialog = await openPrimaryPingDialog(page)
  const dialogChart = dialog.locator('[data-ping-chart]')
  const dialogSmooth = dialogChart.getByRole('button', { name: '平滑峰值', exact: true })
  await expect(dialogSmooth).toHaveAttribute('aria-pressed', 'false')
  await expect(dialogChart).toHaveAttribute('data-ping-chart-smoothing', 'disabled')
  await dialogSmooth.click()
  await expect(dialogSmooth).toHaveAttribute('aria-pressed', 'true')
  await expect(dialogChart).toHaveAttribute('data-ping-chart-smoothing', 'enabled')
  await dialogSmooth.click()
  await expect(dialogChart).toHaveAttribute('data-ping-chart-smoothing', 'disabled')

  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toHaveCount(0)

  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  const detailChart = page.locator('[data-ping-chart]').first()
  const detailSmooth = detailChart.getByRole('button', { name: '平滑峰值', exact: true })
  await expect(detailSmooth).toHaveAttribute('aria-pressed', 'false')
  await detailSmooth.click()
  await expect(detailChart).toHaveAttribute('data-ping-chart-smoothing', 'enabled')
})

test('v2.7.0 uses the latest finalized selected Ping sample as the relative display endpoint in modal and detail', async ({ page }) => {
  const chartMetricCalls: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (!payload?.method)
      return
    const keys = Array.isArray(payload.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
    const tags = payload.params?.tags as Record<string, unknown> | undefined
    const isPingMetric = keys.includes('ping.latency_ms')
    if (payload.method === 'public:queryMetrics' && isPingMetric && tags?.task_id === undefined && payload.params?.max_points === 6000)
      chartMetricCalls.push(payload.params ?? {})
  })

  const requestedStart = Date.parse('2026-09-04T10:21:00.000Z')
  const requestedEnd = Date.parse('2026-09-04T11:21:00.000Z')
  const latest101 = Date.parse('2026-09-04T11:15:00.000Z')
  const latest202 = Date.parse('2026-09-04T11:17:00.000Z')
  const latest303 = Date.parse('2026-09-04T11:16:00.000Z')
  await page.setViewportSize({ width: 1280, height: 800 })
  await installKomariFixture(page, {
    clockNow: '2026-09-04T11:19:00.000Z',
    fakeTimers: true,
    nodeCardPingFixture: {
      metric: 'valid',
      thirdSharedTask: true,
      metricSamples: [
        { time: '2026-09-04T10:25:00.000Z', taskId: 101, latency: 8, loss: 0, latencyCount: 1, lossCount: 1 },
        { time: '2026-09-04T11:15:00.000Z', taskId: 101, latency: 9, loss: 0, latencyCount: 1, lossCount: 1 },
        { time: '2026-09-04T10:25:00.000Z', taskId: 202, latency: 17, loss: 0, latencyCount: 1, lossCount: 1 },
        { time: '2026-09-04T11:17:00.000Z', taskId: 202, latency: 18, loss: 0, latencyCount: 1, lossCount: 1 },
        { time: '2026-09-04T11:20:00.000Z', taskId: 202, latency: null, loss: null, latencyCount: 0, lossCount: 0 },
        { time: '2026-09-04T10:25:00.000Z', taskId: 303, latency: 31, loss: 0, latencyCount: 1, lossCount: 1 },
        { time: '2026-09-04T11:16:00.000Z', taskId: 303, latency: 32, loss: 0, latencyCount: 1, lossCount: 1 },
      ],
    },
  })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  const chart = dialog.locator('[data-ping-chart]')

  await expect(chart).toHaveAttribute('data-ping-chart-window-start', String(requestedStart))
  await expect(chart).toHaveAttribute('data-ping-chart-window-end', String(requestedEnd))
  await expect(chart).toHaveAttribute('data-ping-chart-display-start', String(requestedStart))
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest202))
  await expect(chart).toHaveAttribute('data-ping-chart-latest-finalized', String(latest202))
  await expect(chart).toHaveAttribute('data-ping-chart-visible-task-ids', '101,202,303')
  await expect(chart).toHaveAttribute('data-ping-chart-record-count', '7')

  const requestCountBeforeLocalUi = chartMetricCalls.length
  const echarts = chart.locator('.echarts')
  const chartBounds = await echarts.boundingBox()
  expect(chartBounds).not.toBeNull()
  if (!chartBounds)
    throw new Error('Ping chart bounds are unavailable')
  const toggleMiddleLegend = () => page.mouse.click(
    chartBounds.x + chartBounds.width / 2,
    chartBounds.y + chartBounds.height - 14,
  )

  await toggleMiddleLegend()
  await expect(chart).toHaveAttribute('data-ping-chart-visible-task-ids', '101,303')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest303))
  await toggleMiddleLegend()
  await expect(chart).toHaveAttribute('data-ping-chart-visible-task-ids', '101,202,303')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest202))
  await chart.locator('[data-ping-chart-task-id="202"]').click()
  await expect(chart).toHaveAttribute('data-ping-chart-visible-task-ids', '101,303')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest303))
  await chart.locator('[data-ping-chart-task-id="303"]').click()
  await expect(chart).toHaveAttribute('data-ping-chart-visible-task-ids', '101')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest101))
  await chart.getByRole('button', { name: '全不选', exact: true }).click()
  await expect(chart).toHaveAttribute('data-ping-chart-visible-task-ids', '')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(requestedEnd))
  await expect(chart).not.toHaveAttribute('data-ping-chart-latest-finalized', /.+/)
  await chart.getByRole('button', { name: '全选', exact: true }).click()
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest202))
  await chart.getByRole('button', { name: '平滑峰值', exact: true }).click()
  await chart.locator('[data-ping-chart-task-id="101"]').hover()
  await page.setViewportSize({ width: 1180, height: 760 })
  await page.evaluate(() => {
    const themeButton = document.querySelector<HTMLElement>('[data-testid="theme-mode-dark"]')
    if (!themeButton)
      throw new Error('theme control is unavailable')
    themeButton.click()
  })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(latest202))
  expect(chartMetricCalls).toHaveLength(requestCountBeforeLocalUi)

  await dialog.getByRole('button', { name: '关闭' }).click()
  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  const detailChart = page.locator('[data-ping-chart]').first()
  await expect(detailChart).toHaveAttribute('data-ping-chart-window-start', String(requestedStart))
  await expect(detailChart).toHaveAttribute('data-ping-chart-window-end', String(requestedEnd))
  await expect(detailChart).toHaveAttribute('data-ping-chart-display-start', String(requestedStart))
  await expect(detailChart).toHaveAttribute('data-ping-chart-display-end', String(latest202))
  await expect(detailChart).toHaveAttribute('data-ping-chart-latest-finalized', String(latest202))
})

test('v2.7.0 keeps the requested Ping domain finite when every history source is empty or unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, {
    clockNow: '2026-09-04T11:19:00.000Z',
    nodeCardPingFixture: { metric: 'error', legacy: 'error' },
  })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  const chart = dialog.locator('[data-ping-chart]')
  await expect(chart.locator('.text-red-500')).toBeVisible()

  const domain = await chart.evaluate(element => ({
    start: Number(element.getAttribute('data-ping-chart-window-start')),
    end: Number(element.getAttribute('data-ping-chart-window-end')),
    displayStart: Number(element.getAttribute('data-ping-chart-display-start')),
    displayEnd: Number(element.getAttribute('data-ping-chart-display-end')),
    latest: element.getAttribute('data-ping-chart-latest-finalized'),
    text: element.textContent ?? '',
  }))
  expect(Number.isFinite(domain.displayStart)).toBe(true)
  expect(Number.isFinite(domain.displayEnd)).toBe(true)
  expect(domain.displayStart).toBe(domain.start)
  expect(domain.displayEnd).toBe(domain.end)
  expect(domain.displayEnd).toBeGreaterThan(domain.displayStart)
  expect(domain.latest).toBeNull()
  expect(domain.text).not.toContain('1970')
})

test('Ping-only 7-day and 14-day ranges use their own Metric windows and do not alter load ranges', async ({ page }) => {
  const pingMetricCalls: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics') {
      const keys = Array.isArray(payload.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
      if (keys.includes('ping.latency_ms'))
        pingMetricCalls.push(payload.params ?? {})
    }
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardPingFixture: { metric: 'valid' }, pingRecordPreserveTime: 720 })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  const rangeTabs = dialog.locator('[data-ping-chart] [role="tab"]')
  await expect(rangeTabs).toHaveText(['1 小时', '6 小时', '12 小时', '1 天', '7 天', '14 天', '30 天', '自定义'])

  for (const [label, hours] of [['6 小时', 6], ['12 小时', 12], ['1 天', 24], ['7 天', 168], ['14 天', 336], ['1 小时', 1]] as const) {
    pingMetricCalls.length = 0
    await rangeTabs.getByText(label, { exact: true }).click()
    await expect.poll(() => pingMetricCalls.map(readPingRangeHours)).toEqual([hours])
    const chart = dialog.locator('[data-ping-chart]')
    await expect(chart).toHaveAttribute('data-ping-chart-display-start', await chart.getAttribute('data-ping-chart-window-start') ?? '')
    await expect(chart).toHaveAttribute('data-ping-chart-display-end', await chart.getAttribute('data-ping-chart-latest-finalized') ?? '')
  }

  pingMetricCalls.length = 0
  await rangeTabs.getByText('7 天', { exact: true }).click()
  await expect.poll(() => pingMetricCalls.map(readPingRangeHours)).toEqual([168])
  const sevenDay = pingMetricCalls[0]!
  expect(sevenDay.max_points).toBe(6000)
  expect(sevenDay.metric_keys).toEqual(['ping.latency_ms', 'ping.loss'])

  pingMetricCalls.length = 0
  await rangeTabs.getByText('14 天', { exact: true }).click()
  await expect.poll(() => pingMetricCalls.map(readPingRangeHours)).toEqual([336])

  pingMetricCalls.length = 0
  await rangeTabs.getByText('30 天', { exact: true }).click()
  await expect.poll(() => pingMetricCalls.some(params => readPingRangeHours(params) === 720)).toBe(true)
  const thirtyDay = pingMetricCalls.find(params => readPingRangeHours(params) === 720)!
  const chart = dialog.locator('[data-ping-chart]')
  await expect(chart).toHaveAttribute('data-ping-chart-axis-type', 'time')
  await expect.poll(async () => {
    const start = Number(await chart.getAttribute('data-ping-chart-window-start'))
    const end = Number(await chart.getAttribute('data-ping-chart-window-end'))
    return (end - start) / 3_600_000
  }).toBe(720)
  await expect(chart).toHaveAttribute('data-ping-chart-display-start', await chart.getAttribute('data-ping-chart-window-start') ?? '')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', await chart.getAttribute('data-ping-chart-latest-finalized') ?? '')
  expect(thirtyDay.max_points).toBe(6000)
  expect(thirtyDay.metric_keys).toEqual(['ping.latency_ms', 'ping.loss'])

  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page.locator('[data-ping-chart] [role="tab"]')).toContainText(['7 天', '14 天'])
  await expect(page.locator('[data-load-chart-range]')).toHaveText(/实时\s*4 小时\s*1 天\s*7 天\s*30 天\s*自定义/)
  await expect(page.locator('[data-load-chart-range]')).not.toContainText('14 天')
})

test('Ping range availability respects the public Ping retention setting', async ({ page }) => {
  await installKomariFixture(page, { nodeCardPingFixture: { metric: 'valid' }, pingRecordPreserveTime: 168 })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  const rangeTabs = dialog.locator('[data-ping-chart] [role="tab"]')
  await expect(rangeTabs).toHaveText(['1 小时', '6 小时', '12 小时', '1 天', '7 天', '自定义'])
})

test('a long custom Ping range reuses the bounded coverage loader without changing shorter presets', async ({ page }) => {
  const queryCalls: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics') {
      const keys = Array.isArray(payload.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
      if (keys.includes('ping.latency_ms'))
        queryCalls.push(payload.params ?? {})
    }
  })
  const coarse = [{ time: '2026-07-15T00:00:00.000Z', latency: 40, loss: 0, latencyCount: 1440, lossCount: 1440 }]
  const fine = [{ time: '2026-08-01T00:00:00.000Z', latency: 30, loss: 0, latencyCount: 60, lossCount: 60 }]
  await installKomariFixture(page, {
    clockNow: '2026-08-13T08:00:00.000Z',
    pingRecordPreserveTime: 720,
    nodeCardPingFixture: {
      metric: 'valid',
      metricRangeSamples: [
        { minHours: 601, intervalSeconds: 86_400, samples: coarse },
        { maxHours: 600, intervalSeconds: 3600, samples: fine },
      ],
    },
  })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  const chart = dialog.locator('[data-ping-chart]')
  await chart.locator('[role="tab"]').getByText('自定义', { exact: true }).click()
  const customInputs = chart.locator('input[type="datetime-local"]')
  await expect(customInputs.nth(0)).not.toHaveValue('')
  await expect(customInputs.nth(1)).not.toHaveValue('')
  await customInputs.nth(0).fill('2026-07-14T08:00')
  await customInputs.nth(0).press('Tab')
  await customInputs.nth(1).fill('2026-08-13T08:00')
  await customInputs.nth(1).press('Tab')
  await expect(customInputs.nth(0)).toHaveValue('2026-07-14T08:00')
  await expect(customInputs.nth(1)).toHaveValue('2026-08-13T08:00')
  await expect(chart).not.toContainText('结束时间必须晚于开始时间')
  await expect(chart.getByRole('button', { name: '应用', exact: true })).toBeEnabled()
  queryCalls.length = 0
  await chart.getByRole('button', { name: '应用', exact: true }).click()

  await expect.poll(() => queryCalls.map(readPingRangeHours)).toEqual([720, 600])
  await expect.poll(async () => {
    const start = Number(await chart.getAttribute('data-ping-chart-window-start'))
    const end = Number(await chart.getAttribute('data-ping-chart-window-end'))
    return (end - start) / 3_600_000
  }).toBe(720)
  await expect(chart).toHaveAttribute('data-ping-chart-display-start', await chart.getAttribute('data-ping-chart-window-start') ?? '')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', await chart.getAttribute('data-ping-chart-window-end') ?? '')
})

test('30-day Ping stitches sparse daily history with the retained hourly tier in both modal and detail', async ({ page }) => {
  const queryCalls: Array<Record<string, unknown>> = []
  const legacyCalls: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics') {
      const keys = Array.isArray(payload.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
      if (keys.includes('ping.latency_ms'))
        queryCalls.push(payload.params ?? {})
    }
    if (payload?.method === 'public:getPingRecords'
      || (payload?.method === 'common:getRecords' && payload.params?.type === 'ping')) {
      legacyCalls.push(payload.params ?? {})
    }
  })

  const coarseSamples = [
    ...Array.from({ length: 5 }, (_, index) => ({
      time: new Date(Date.UTC(2026, 6, 15 + index)).toISOString(),
      taskId: 202,
      latency: 40 + index,
      loss: 0,
      latencyCount: 1440,
      lossCount: 1440,
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      time: new Date(Date.UTC(2026, 7, 7 + index)).toISOString(),
      taskId: 202,
      latency: 30 + index / 10,
      loss: 0,
      latencyCount: 1440,
      lossCount: 1440,
    })),
  ]
  const fineStart = Date.parse('2026-07-31T23:00:00.000Z')
  const fineEnd = Date.parse('2026-08-13T08:00:00.000Z')
  const fineSamples = Array.from({ length: (fineEnd - fineStart) / 3_600_000 }, (_, index) => {
    const timestamp = fineStart + index * 3_600_000
    const outage = timestamp >= Date.parse('2026-08-07T08:00:00.000Z')
      && timestamp < Date.parse('2026-08-07T14:00:00.000Z')
    const trueLow = timestamp === Date.parse('2026-08-07T14:00:00.000Z')
      ? 9
      : timestamp === Date.parse('2026-08-07T15:00:00.000Z') ? 12 : null
    return {
      time: new Date(timestamp).toISOString(),
      taskId: 202,
      latency: outage ? null : (trueLow ?? 30 + Math.sin(index / 12)),
      loss: outage ? 1 : 0,
      latencyCount: 60,
      lossCount: 60,
    }
  })

  await installKomariFixture(page, {
    clockNow: '2026-08-13T08:00:00.000Z',
    pingRecordPreserveTime: 720,
    nodeCardPingFixture: {
      metric: 'valid',
      metricRangeSamples: [
        { minHours: 601, intervalSeconds: 86_400, samples: coarseSamples },
        { maxHours: 600, intervalSeconds: 3600, samples: fineSamples },
      ],
    },
  })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  queryCalls.length = 0
  legacyCalls.length = 0
  await dialog.locator('[data-ping-chart] [role="tab"]').getByText('30 天', { exact: true }).click()
  await expect.poll(() => queryCalls.map(readPingRangeHours)).toEqual([720, 600])

  const chart = dialog.locator('[data-ping-chart]')
  await expect(chart).toHaveAttribute('data-ping-chart-axis-type', 'time')
  await expect(chart).toHaveAttribute('data-ping-chart-record-count', '302')
  await expect.poll(async () => {
    const start = Number(await chart.getAttribute('data-ping-chart-window-start'))
    const end = Number(await chart.getAttribute('data-ping-chart-window-end'))
    return (end - start) / 3_600_000
  }).toBe(720)
  await expect(chart).toHaveAttribute('data-ping-chart-display-start', await chart.getAttribute('data-ping-chart-window-start') ?? '')
  await expect(chart).toHaveAttribute('data-ping-chart-display-end', String(Date.parse('2026-08-13T07:00:00.000Z')))
  expect(legacyCalls.filter(call => Number(call.hours) === 720)).toHaveLength(0)

  await dialog.getByRole('button', { name: '关闭' }).click()
  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  const detailChart = page.locator('[data-ping-chart]').first()
  await detailChart.locator('[role="tab"]').getByText('30 天', { exact: true }).click()
  await expect(detailChart).toHaveAttribute('data-ping-chart-record-count', '302')
  await expect.poll(async () => {
    const start = Number(await detailChart.getAttribute('data-ping-chart-window-start'))
    const end = Number(await detailChart.getAttribute('data-ping-chart-window-end'))
    return (end - start) / 3_600_000
  }).toBe(720)
  await expect(detailChart).toHaveAttribute('data-ping-chart-display-start', await detailChart.getAttribute('data-ping-chart-window-start') ?? '')
  await expect(detailChart).toHaveAttribute('data-ping-chart-display-end', String(Date.parse('2026-08-13T07:00:00.000Z')))
  await expect.poll(() => queryCalls.map(readPingRangeHours).filter(hours => hours > 1)).toEqual([720, 600, 720, 600])
  expect(legacyCalls.filter(call => Number(call.hours) === 720)).toHaveLength(0)
})

test('rapid 14-day, 30-day, 7-day, 30-day switching rejects stale multi-tier responses', async ({ page }) => {
  const sample = (time: string, latency: number) => ({
    time,
    taskId: 202,
    latency,
    loss: 0,
    latencyCount: 60,
    lossCount: 60,
  })
  await installKomariFixture(page, {
    clockNow: '2026-08-13T08:00:00.000Z',
    pingRecordPreserveTime: 720,
    nodeCardPingFixture: {
      metric: 'valid',
      metricQueryDelayMsByHours: { 168: 200, 336: 300, 600: 20, 720: 20 },
      metricRangeSamples: [
        { maxHours: 168, intervalSeconds: 3600, samples: [sample('2026-08-12T00:00:00.000Z', 7)] },
        { minHours: 169, maxHours: 336, intervalSeconds: 3600, samples: [
          sample('2026-08-01T00:00:00.000Z', 14),
          sample('2026-08-02T00:00:00.000Z', 15),
        ] },
        { minHours: 337, maxHours: 600, intervalSeconds: 3600, samples: [
          sample('2026-07-25T00:00:00.000Z', 30),
          sample('2026-07-26T00:00:00.000Z', 31),
          sample('2026-07-27T00:00:00.000Z', 32),
        ] },
        { minHours: 601, intervalSeconds: 86_400, samples: [
          sample('2026-07-15T00:00:00.000Z', 40),
          sample('2026-07-16T00:00:00.000Z', 41),
          sample('2026-07-17T00:00:00.000Z', 42),
          sample('2026-07-18T00:00:00.000Z', 43),
        ] },
      ],
    },
  })
  await openStablePage(page)
  const dialog = await openPrimaryPingDialog(page)
  const chart = dialog.locator('[data-ping-chart]')
  const tabs = chart.locator('[role="tab"]')

  await tabs.getByText('14 天', { exact: true }).click()
  await tabs.getByText('30 天', { exact: true }).click()
  await tabs.getByText('7 天', { exact: true }).click()
  await tabs.getByText('30 天', { exact: true }).click()

  await expect.poll(async () => {
    const start = Number(await chart.getAttribute('data-ping-chart-window-start'))
    const end = Number(await chart.getAttribute('data-ping-chart-window-end'))
    return (end - start) / 3_600_000
  }).toBe(720)
  await expect(chart).toHaveAttribute('data-ping-chart-record-count', '7')
})

test('mobile viewport keeps Ping dialogs and route transitions above the page canvas without stale body lock', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardPingFixture: { metric: 'valid' } })
  await openStablePage(page)

  const dialog = await openPrimaryPingDialog(page)
  await expect(page.locator('[data-app-dialog-safe-overlay]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => ({
    overflow: document.body.style.overflow,
    pointerEvents: document.body.style.pointerEvents,
    paddingRight: document.body.style.paddingRight,
    marginRight: document.body.style.marginRight,
  }))).toEqual({ overflow: '', pointerEvents: '', paddingRight: '', marginRight: '' })
  await page.locator('[data-app-dialog-safe-overlay]').click({ position: { x: 2, y: 2 } })
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-app-dialog-safe-overlay]')).toHaveCount(0)

  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('#app')
    const viewport = document.querySelector<HTMLElement>('[data-app-viewport]')
    const visualHeight = window.visualViewport?.height ?? window.innerHeight
    return Boolean(app && viewport
      && app.getBoundingClientRect().height >= visualHeight
      && viewport.getBoundingClientRect().height >= visualHeight
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => ({
    overflow: document.body.style.overflow,
    pointerEvents: document.body.style.pointerEvents,
    paddingRight: document.body.style.paddingRight,
    marginRight: document.body.style.marginRight,
  }))).toEqual({ overflow: '', pointerEvents: '', paddingRight: '', marginRight: '' })
})

test('brand metadata and shared footer keep current identity and a compact version line', async ({ page }) => {
  const themeManifest = JSON.parse(readFileSync(new URL('../../komari-theme.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const packageMetadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const originalGlassmorphismManifest = { name: 'Komari Glassmorphism', short: 'Glassmorphism' }

  expect(themeManifest).toMatchObject({
    name: 'Komari Glassmorphism Plus',
    short: 'glassmorphism-plus',
    description: 'A customized Glassmorphism theme for Komari, based on the original theme by sanrokamlan.',
    version: '2.7.3',
    author: 'VoyagerProbe',
    url: 'https://github.com/VoyagerProbe/Glassmorphism-Plus',
  })
  expect(packageMetadata).toMatchObject({
    name: 'komari-theme-glassmorphism-plus',
    version: '2.7.3',
    author: { name: 'VoyagerProbe', url: 'https://github.com/VoyagerProbe' },
    homepage: 'https://github.com/VoyagerProbe/Glassmorphism-Plus',
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
  const v2BindingsSettingIndex = managedItems.findIndex(item => item.key === 'nodeCardPingDisplayConfigV2')
  const v3BindingsSettingIndex = managedItems.findIndex(item => item.key === 'nodeCardPingDisplayConfigV3')
  expect(bindingSectionIndex).toBeGreaterThanOrEqual(0)
  expect(entrySettingIndex).toBe(bindingSectionIndex + 1)
  expect(bindingsSettingIndex).toBe(entrySettingIndex + 1)
  expect(v2BindingsSettingIndex).toBe(bindingsSettingIndex + 1)
  expect(v3BindingsSettingIndex).toBe(v2BindingsSettingIndex + 1)
  expect(managedItems[entrySettingIndex]).toMatchObject({
    name: '隐藏延迟任务绑定入口',
    type: 'switch',
    default: false,
  })
  expect(managedItems[v2BindingsSettingIndex]).toMatchObject({
    name: '首页多 Ping 安全配置',
    type: 'richtext',
  })
  expect(String(managedItems[v2BindingsSettingIndex].default)).toMatch(/^v2:/)
  expect(managedItems[v3BindingsSettingIndex]).toMatchObject({
    name: '首页 Ping 安全配置',
    type: 'richtext',
    default: '',
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { hideEarth: true })
  await openStablePage(page)

  const footer = page.locator('footer')
  await expect(footer.getByRole('link', { name: 'Glassmorphism Plus' })).toHaveAttribute('href', 'https://github.com/VoyagerProbe/Glassmorphism-Plus')
  await expect(footer.getByText('v2.7.3 · VoyagerProbe', { exact: true }).first()).toBeVisible()
  await expect(footer).not.toContainText('Based on the original theme')
  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  await expect(footer.getByText('v2.7.3 · VoyagerProbe', { exact: true }).first()).toBeVisible()
  await expect(footer).not.toContainText('Based on the original theme')
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

    const entry = page.getByTestId('ping-center-entry')
    await expect(entry).toHaveCount(scenario.visible ? 1 : 0)
    if (scenario.visible) {
      await expect(entry).toHaveAttribute('title', '延迟监测中心')
      await expect(entry).toHaveAttribute('aria-label', '延迟监测中心')
      await entry.hover()
      await page.waitForTimeout(300)
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
    }
    await expect(page.getByRole('group', { name: '主题模式' })).toBeVisible()
  })
}

test('v2.7.1 header exposes the three direct theme choices before the unchanged visitor tools', async ({ page }) => {
  await installKomariFixture(page, { adminAccess: 'admin' })
  await openStablePage(page)

  const expectedLabels = ['浅色模式', '北京时间自动', '深色模式', '显示首页工具', '延迟监测中心', '后台管理']
  const controls = page.getByTestId('header-actions').locator('button')
  await expect(controls).toHaveCount(expectedLabels.length)
  expect(await controls.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(expectedLabels)

  for (const accessibleName of expectedLabels) {
    const button = page.getByRole('button', { name: accessibleName, exact: true })
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('title', accessibleName)
    await expect(button).toHaveAttribute('aria-label', accessibleName)
    await button.focus()
    await expect(button).toBeFocused()
    await button.hover()
    await page.waitForTimeout(300)
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
  }
})

for (const scenario of [
  { mode: 'light' as const, managed: 'dark' as const, clockNow: '2026-09-04T12:30:00.000Z', effective: 'light' as const },
  { mode: 'beijing' as const, managed: 'light' as const, clockNow: '2026-09-04T12:30:00.000Z', effective: 'dark' as const },
  { mode: 'dark' as const, managed: 'light' as const, clockNow: '2026-09-04T00:30:00.000Z', effective: 'dark' as const },
]) {
  test(`v2.7.1 ${scenario.mode} is a direct local preference and persists across reload`, async ({ page }) => {
    const adminThemeWrites: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/admin/theme/settings' && request.method() !== 'GET')
        adminThemeWrites.push(`${request.method()} ${url.pathname}`)
    })
    const fixture = await installKomariFixture(page, {
      managedThemeMode: scenario.managed,
      clockNow: scenario.clockNow,
      fakeTimers: true,
      preserveStorageOnReload: true,
    })
    await openStablePage(page)

    await page.getByTestId(`theme-mode-${scenario.mode}`).click()
    await expectVisitorThemeState(page, scenario.mode, scenario.effective)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('themeMode'))).toBe(scenario.mode)
    expect(adminThemeWrites).toEqual([])
    expect(fixture.getThemeSaveCount()).toBe(0)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expectVisitorThemeState(page, scenario.mode, scenario.effective)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('themeMode'))).toBe(scenario.mode)
    expect(adminThemeWrites).toEqual([])
    expect(fixture.getThemeSaveCount()).toBe(0)
  })
}

for (const scenario of [
  { managed: 'light' as const, clockNow: '2026-09-04T12:30:00.000Z', effective: 'light' as const },
  { managed: 'beijing' as const, clockNow: '2026-09-04T12:30:00.000Z', effective: 'dark' as const },
  { managed: 'dark' as const, clockNow: '2026-09-04T00:30:00.000Z', effective: 'dark' as const },
]) {
  test(`v2.7.1 visitors without a local preference follow the managed ${scenario.managed} default`, async ({ page }) => {
    const fixture = await installKomariFixture(page, {
      managedThemeMode: scenario.managed,
      clockNow: scenario.clockNow,
      fakeTimers: true,
    })
    await openStablePage(page)

    await expectVisitorThemeState(page, scenario.managed, scenario.effective)
    expect(fixture.getThemeSaveCount()).toBe(0)
  })
}

for (const boundary of [
  {
    name: '19:00 changes Beijing automatic from light to dark',
    clockNow: '2026-09-04T18:59:30+08:00',
    before: 'light' as const,
    after: 'dark' as const,
  },
  {
    name: '07:00 changes Beijing automatic from dark to light across the night window',
    clockNow: '2026-09-05T06:59:30+08:00',
    before: 'dark' as const,
    after: 'light' as const,
  },
]) {
  test(`v2.7.1 ${boundary.name} while keeping only the automatic preference active`, async ({ page }) => {
    const fixture = await installKomariFixture(page, {
      managedThemeMode: 'light',
      clockNow: boundary.clockNow,
      fakeTimers: true,
      preserveStorageOnReload: true,
    })
    await openStablePage(page)
    await page.getByTestId('theme-mode-beijing').click()
    await expectVisitorThemeState(page, 'beijing', boundary.before)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('themeMode'))).toBe('beijing')

    await fixture.advanceTime(60_000)
    await expectVisitorThemeState(page, 'beijing', boundary.after)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('themeMode'))).toBe('beijing')
    expect(fixture.getThemeSaveCount()).toBe(0)
  })
}

test('v2.7.1 theme selection reuses the existing central Beijing clock without scheduling per-click timers', async ({ page }) => {
  await installKomariFixture(page, {
    managedThemeMode: 'beijing',
    fakeTimers: true,
  })
  await openStablePage(page)
  await page.evaluate(() => {
    const host = window as typeof window & { __themeSelectionTimerCount?: () => number }
    const nativeSetInterval = window.setInterval.bind(window)
    let intervalCount = 0
    window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
      intervalCount += 1
      return nativeSetInterval(...args)
    }) as typeof window.setInterval
    host.__themeSelectionTimerCount = () => intervalCount
  })

  for (const mode of ['light', 'beijing', 'dark'] as const)
    await page.getByTestId(`theme-mode-${mode}`).click()
  expect(await page.evaluate(() => (window as typeof window & { __themeSelectionTimerCount?: () => number }).__themeSelectionTimerCount?.())).toBe(0)
})

test('v2.7.1 Beijing automatic source keeps the single UTC+8 07:00-18:59 schedule without system-theme hooks', () => {
  const source = readFileSync(new URL('../../src/stores/app.ts', import.meta.url), 'utf8')
  expect(source.match(/window\.setInterval\(/g)).toHaveLength(1)
  expect(source).toContain('timeZone: \'Asia/Shanghai\'')
  expect(source).toContain('hour >= 7 && hour < 19')
  expect(source).not.toContain('prefers-color-scheme')
  expect(source).not.toContain('visibilitychange')
})

test('v2.7.1 theme and visitor tools remain visible, ordered, and non-overlapping at 360-430px', async ({ page }) => {
  await installKomariFixture(page, {
    adminAccess: 'admin',
    siteName: 'MyVpsMonitor Long Mobile Header',
  })
  await openStablePage(page, '/', 'MyVpsMonitor Long Mobile Header')

  const controls = page.getByTestId('header-actions').locator('button')
  for (const width of [360, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(controls).toHaveCount(6)
    for (let index = 0; index < 6; index += 1)
      await expect(controls.nth(index)).toBeVisible()

    const layout = await page.getByTestId('header-actions').evaluate((actions) => {
      const header = actions.parentElement
      const site = header?.firstElementChild
      const actionBox = actions.getBoundingClientRect()
      const siteBox = site?.getBoundingClientRect()
      const buttonBoxes = Array.from(actions.querySelectorAll('button'), button => button.getBoundingClientRect())
      return {
        contained: actions.scrollWidth <= actions.clientWidth + 1,
        headerContained: header ? header.scrollWidth <= header.clientWidth + 1 : false,
        separated: siteBox ? siteBox.right <= actionBox.left + 1 : false,
        buttonsInsideViewport: buttonBoxes.every(box => box.left >= 0 && box.right <= window.innerWidth),
        buttonWidths: buttonBoxes.map(box => box.width),
      }
    })
    expect(layout.contained).toBe(true)
    expect(layout.headerContained).toBe(true)
    expect(layout.separated).toBe(true)
    expect(layout.buttonsInsideViewport).toBe(true)
    expect(layout.buttonWidths.every(value => value >= 32)).toBe(true)
  }
})

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

for (const background of [
  { name: 'default with earth', options: { hideEarth: false } },
  {
    name: 'custom image with blur and overlay',
    options: {
      hideEarth: true,
      backgroundEnabled: true,
      backgroundType: 'image' as const,
      lightBackgroundUrl: '/images/default-background-v2.webp',
      backgroundBlur: 6,
      backgroundOverlay: 24,
    },
  },
  {
    name: 'video loading or fallback with blur and overlay',
    options: {
      hideEarth: true,
      backgroundEnabled: true,
      backgroundType: 'video' as const,
      lightBackgroundUrl: '/images/default-background-v2.webp',
      backgroundBlur: 4,
      backgroundOverlay: 18,
    },
  },
] as const) {
  test(`v2.7.0 keeps light NodeCard surface edges visible over ${background.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await installKomariFixture(page, {
      ...background.options,
      nodeCardPingDisplayConfigV3: v3GlobalPingConfig(true),
      nodeCardPingFixture: { metric: 'valid', thirdSharedTask: true },
    })
    await openStablePage(page)

    const card = primaryNodeCard(page)
    await card.scrollIntoViewIfNeeded()
    const styles = await card.evaluate(element => ({
      cardBorderWidth: getComputedStyle(element).borderWidth,
      cardBorderColor: getComputedStyle(element).borderColor,
      infoShadows: Array.from(element.querySelectorAll('.node-card-info-surface'), item => getComputedStyle(item).boxShadow),
      stripShadows: Array.from(element.querySelectorAll('.node-card-ping-task-strip'), item => getComputedStyle(item).boxShadow),
      contained: element.scrollWidth <= element.clientWidth + 1,
    }))
    expect(styles.cardBorderWidth).toBe('1px')
    expect(styles.cardBorderColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(styles.infoShadows).toHaveLength(3)
    expect(styles.infoShadows.every(shadow => shadow.includes('inset'))).toBe(true)
    expect(styles.stripShadows).toHaveLength(3)
    expect(styles.stripShadows.every(shadow => shadow.includes('inset'))).toBe(true)
    expect(styles.contained).toBe(true)

    await expect(page.locator('.background-container')).toBeVisible()
    if (background.options.hideEarth)
      await expect(page.locator('.earth-globe-host')).toHaveCount(0)
    else
      await expect(page.locator('.earth-globe-host')).toHaveCount(1)
  })
}

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

const FULL_GENERAL_CARD_ORDER = [
  'currentTime',
  'memory',
  'disk',
  'remainingValue',
  'monthlyCost',
  'totalTraffic',
  'uploadSpeed',
  'downloadSpeed',
  'onlineNodes',
  'offlineNodes',
  'avgCpu',
  'avgGpu',
  'avgLoad',
  'swap',
  'processes',
  'connections',
  'cpuCores',
  'gpuNodes',
  'gpuPeakNode',
  'trafficQuota',
  'trafficPeak',
  'uploadPeakNode',
  'downloadPeakNode',
  'highLoadNodes',
  'expiringNodes',
  'trafficWarnings',
  'connectionPeakNode',
  'regionDistribution',
  'systemDistribution',
  'virtualizationDistribution',
  'yearlyCost',
]

for (const scenario of [
  {
    name: 'tiled basic light desktop',
    viewport: { width: 1280, height: 720 },
    options: { earthRenderer: 'tiled' as const, generalCardPreset: '基础' },
    expected: ['memory', 'disk', 'remainingValue', 'totalTraffic', 'uploadSpeed', 'downloadSpeed'],
  },
  {
    name: 'tiled full dark mobile',
    viewport: { width: 390, height: 844 },
    options: { earthRenderer: 'tiled' as const, generalCardPreset: '完整', dark: true },
    expected: FULL_GENERAL_CARD_ORDER,
  },
  {
    name: 'tiled custom ordered light desktop',
    viewport: { width: 1280, height: 720 },
    options: { earthRenderer: 'tiled' as const, generalCardPreset: '自定义', generalCardKeys: ['currentTime', 'offlineNodes', 'yearlyCost'] },
    expected: ['currentTime', 'offlineNodes', 'yearlyCost'],
  },
  {
    name: 'globe custom ordered dark desktop',
    viewport: { width: 1280, height: 720 },
    options: { earthRenderer: 'realistic' as const, generalCardPreset: '自定义', generalCardKeys: ['currentTime', 'offlineNodes', 'yearlyCost'], dark: true },
    expected: ['currentTime', 'offlineNodes', 'yearlyCost'],
  },
  {
    name: 'hidden-earth custom ordered light mobile',
    viewport: { width: 390, height: 844 },
    options: { hideEarth: true, generalCardPreset: '自定义', generalCardKeys: ['currentTime', 'offlineNodes', 'yearlyCost'] },
    expected: ['currentTime', 'offlineNodes', 'yearlyCost'],
  },
]) {
  test(`home summary cards honor the normalized configuration in ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize(scenario.viewport)
    await installKomariFixture(page, scenario.options)
    await openStablePage(page)

    const keys = await page.locator('[data-general-card-key]').evaluateAll(elements => elements.map(element => element.getAttribute('data-general-card-key')))
    expect(keys).toEqual(scenario.expected)
  })
}

test('home mini card metric icons remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardSize: 'mini', hideEarth: true })
  await openStablePage(page)

  const card = primaryNodeCard(page)
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
  const warningCard = page.locator('.node-card').filter({ has: page.getByText('香港边缘节点-超长名称布局测试', { exact: true }) })
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

  const nodeCard = primaryNodeCard(page)
  await expect(nodeCard.getByText('免费', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('无', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('免费 / 年', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '查看剩余价值明细' }).click()
  const financeDialog = page.getByRole('dialog', { name: '价值与费用明细' })
  await expect(financeDialog.getByText(freeNodeName, { exact: true })).toHaveCount(0)
  await financeDialog.getByRole('switch', { name: '排除免费节点' }).click()
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

for (const viewport of [
  { width: 390, height: 844 },
  { width: 393, height: 852 },
  { width: 430, height: 932 },
  { width: 375, height: 667 },
  { width: 360, height: 800 },
  { width: 844, height: 390 },
]) {
  test(`v2.5.0 finance dialog fits ${viewport.width}x${viewport.height} and restores body lock`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await installKomariFixture(page, { dark: true, hideEarth: true })
    await openStablePage(page)

    const originalBodyStyle = await page.evaluate(() => ({
      overflow: document.body.style.overflow,
      pointerEvents: document.body.style.pointerEvents,
      paddingRight: document.body.style.paddingRight,
      marginRight: document.body.style.marginRight,
    }))
    await page.getByRole('button', { name: '查看剩余价值明细' }).click()
    const dialog = page.getByRole('dialog', { name: '价值与费用明细' })
    const header = dialog.locator('[data-app-dialog-header]')
    const body = dialog.locator('[data-app-dialog-body]')
    await expect(dialog).toBeVisible()
    await expect(header).toBeVisible()
    await expect(dialog.locator('[data-finance-mobile-list]')).toBeVisible()
    await expect(dialog.locator('[data-finance-desktop-table]')).toBeHidden()
    await expect(dialog.getByRole('switch', { name: '排除免费节点' })).toBeVisible()

    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const scrollBody = element.querySelector<HTMLElement>('[data-app-dialog-body]')!
      const controls = element.querySelector<HTMLElement>('[data-finance-controls]')!
      const summary = element.querySelector<HTMLElement>('[data-finance-summary]')!
      const within = (child: DOMRect) => child.left >= rect.left - 1 && child.right <= rect.right + 1
      return {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        bodyScrollWidth: scrollBody.scrollWidth,
        bodyClientWidth: scrollBody.clientWidth,
        bodyScrollHeight: scrollBody.scrollHeight,
        bodyClientHeight: scrollBody.clientHeight,
        controlsContained: within(controls.getBoundingClientRect()),
        summaryContained: within(summary.getBoundingClientRect()),
        documentContained: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }
    })
    expect(layout.rect.left).toBeGreaterThanOrEqual(-1)
    expect(layout.rect.top).toBeGreaterThanOrEqual(-1)
    expect(layout.rect.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(layout.rect.bottom).toBeLessThanOrEqual(viewport.height + 1)
    expect(layout.rect.width).toBeGreaterThanOrEqual(viewport.width - 2)
    expect(layout.rect.height).toBeGreaterThanOrEqual(viewport.height - 2)
    expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.bodyClientWidth)
    expect(layout.bodyScrollHeight).toBeGreaterThan(layout.bodyClientHeight)
    expect(layout.controlsContained).toBe(true)
    expect(layout.summaryContained).toBe(true)
    expect(layout.documentContained).toBe(true)

    const headerBefore = await header.boundingBox()
    await body.evaluate(element => element.scrollTo(0, element.scrollHeight))
    const headerAfter = await header.boundingBox()
    expect(headerBefore?.y).toBe(headerAfter?.y)
    await dialog.getByRole('tab', { name: '按量估算' }).click()
    await expect(dialog.getByLabel('估算节点')).toBeVisible()
    await dialog.getByRole('tab', { name: '汇率设置' }).click()
    await expect(dialog.getByRole('button', { name: /恢复今日汇率/ })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)

    await dialog.getByRole('button', { name: '关闭' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => ({
      overflow: document.body.style.overflow,
      pointerEvents: document.body.style.pointerEvents,
      paddingRight: document.body.style.paddingRight,
      marginRight: document.body.style.marginRight,
    }))).toEqual(originalBodyStyle)
    await page.getByRole('button', { name: '查看剩余价值明细' }).click()
    await expect(page.getByRole('dialog', { name: '价值与费用明细' })).toBeVisible()
    await page.getByRole('dialog', { name: '价值与费用明细' }).getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.evaluate(() => ({
      overflow: document.body.style.overflow,
      pointerEvents: document.body.style.pointerEvents,
      paddingRight: document.body.style.paddingRight,
      marginRight: document.body.style.marginRight,
    }))).toEqual(originalBodyStyle)
  })
}

for (const width of [1280, 1440, 1920]) {
  test(`v2.5.0 finance dialog preserves the desktop table at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await installKomariFixture(page, { hideEarth: true })
    await openStablePage(page)
    await page.getByRole('button', { name: '查看剩余价值明细' }).click()
    const dialog = page.getByRole('dialog', { name: '价值与费用明细' })
    await expect(dialog.locator('[data-finance-desktop-table]')).toBeVisible()
    await expect(dialog.locator('[data-finance-mobile-list]')).toBeHidden()
    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const body = element.querySelector<HTMLElement>('[data-app-dialog-body]')!
      return {
        width: rect.width,
        left: rect.left,
        right: rect.right,
        bodyContained: body.scrollWidth <= body.clientWidth,
        documentContained: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }
    })
    expect(layout.width).toBeLessThan(width)
    expect(layout.left).toBeGreaterThan(0)
    expect(layout.right).toBeLessThan(width)
    expect(layout.bodyContained).toBe(true)
    expect(layout.documentContained).toBe(true)
  })
}

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

for (const scenario of [
  { name: 'dark', dark: true, expectedColorScheme: 'dark' },
  { name: 'light', dark: false, expectedColorScheme: 'light' },
]) {
  test(`detail node selector keeps its native ${scenario.name} popup palette readable`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, { dark: scenario.dark })
    await openStablePage(page, `/instance/${PRIMARY_NODE_UUID}`)

    const selector = page.getByLabel('切换节点')
    const styles = await selector.evaluate((element) => {
      const select = element as HTMLSelectElement
      const option = select.options.item(1)
      if (!option)
        throw new Error('fixture must provide another detail node')

      const selectStyle = getComputedStyle(select)
      const optionStyle = getComputedStyle(option)
      return {
        tagName: select.tagName,
        optionCount: select.options.length,
        colorScheme: selectStyle.colorScheme,
        selectColor: selectStyle.color,
        optionColor: optionStyle.color,
        optionBackground: optionStyle.backgroundColor,
      }
    })

    expect(styles.tagName).toBe('SELECT')
    expect(styles.optionCount).toBeGreaterThan(1)
    expect(styles.colorScheme).toBe(scenario.expectedColorScheme)
    expect(styles.selectColor).not.toBe(styles.optionBackground)
    expect(styles.optionColor).not.toBe(styles.optionBackground)
    expect(styles.optionBackground).not.toBe('rgba(0, 0, 0, 0)')

    await selector.focus()
    await expect(selector).toBeFocused()
    await selector.selectOption({ index: 1 })
    await expect(page).toHaveURL(`/instance/00000000-0000-4000-8000-000000000002`)
  })
}

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

test('detail historical Metric ranges keep gauges on avg and cumulative counters on last', async ({ page }) => {
  const historyQueries: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    const metricKeys = Array.isArray(payload?.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
    if (payload?.method === 'public:queryMetrics' && metricKeys.includes('cpu.usage'))
      historyQueries.push(payload.params ?? {})
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page, `/instance/${PRIMARY_NODE_UUID}`)
  const loadRange = page.locator('[data-load-chart-range]')

  for (const tabIndex of [1, 2, 3, 4]) {
    const previousCount = historyQueries.length
    await loadRange.getByRole('tab').nth(tabIndex).click()
    await expect.poll(() => historyQueries.length).toBeGreaterThan(previousCount)
  }

  const beforeCustom = historyQueries.length
  await loadRange.getByRole('tab').nth(5).click()
  await page.getByLabel('负载图开始时间').fill('2026-07-24T12:00')
  await page.getByLabel('负载图结束时间').fill('2026-07-25T12:00')
  await page.getByRole('button', { name: '应用', exact: true }).click()
  await expect.poll(() => historyQueries.length).toBeGreaterThan(beforeCustom)

  expect(historyQueries).toHaveLength(5)
  for (const params of historyQueries) {
    expect(params.aggregation).toBe('avg')
    expect(params.aggregation_by_metric).toEqual({
      'net.total.up': 'last',
      'net.total.down': 'last',
    })
    expect(params.aggregation_by_metric).not.toHaveProperty('cpu.usage')
    expect(params.aggregation_by_metric).not.toHaveProperty('memory.used')
    expect(params.aggregation_by_metric).not.toHaveProperty('load.average')
    expect(params.aggregation_by_metric).not.toHaveProperty('traffic.up')
    expect(params.aggregation_by_metric).not.toHaveProperty('traffic.down')
  }
})

test('detail cumulative counter query falls back once to Legacy when per-metric aggregation is unsupported', async ({ page }) => {
  const calls: Array<{ method: string, params: Record<string, unknown> }> = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method)
      calls.push({ method: payload.method, params: payload.params ?? {} })
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { loadMetricFixture: { rejectPerMetricAggregation: true } })
  await openStablePage(page, `/instance/${PRIMARY_NODE_UUID}`)
  await page.locator('[data-load-chart-range]').getByRole('tab').nth(1).click()

  const cpuValue = page.locator('[data-load-chart-card="cpu"] [data-latest-cpu]')
  await expect.poll(() => calls.filter(call => call.method === 'common:getRecords' && call.params.type === 'load').length).toBe(1)
  await expect(cpuValue).toHaveText(/^\d+\.\d$/)
  const mappedMetricCalls = calls.filter(call => call.method === 'public:queryMetrics' && call.params.aggregation_by_metric)
  const legacyCalls = calls.filter(call => call.method === 'common:getRecords' && call.params.type === 'load')
  expect(mappedMetricCalls).toHaveLength(1)
  expect(legacyCalls).toHaveLength(1)
})

test('detail rapid range switching ignores a delayed older Metric response', async ({ page }) => {
  const historyHours: number[] = []
  page.on('request', (request) => {
    if (!isRpc2Request(request.url()))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    const metricKeys = Array.isArray(payload?.params?.metric_keys) ? payload.params.metric_keys.map(String) : []
    if (payload?.method === 'public:queryMetrics' && metricKeys.includes('cpu.usage') && typeof payload.params?.hours === 'number')
      historyHours.push(payload.params.hours)
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, {
    loadMetricFixture: {
      delayMsByHours: { 168: 300, 720: 20 },
      cpuValueByHours: { 168: 7, 720: 30 },
    },
  })
  await openStablePage(page, `/instance/${PRIMARY_NODE_UUID}`)
  const loadRange = page.locator('[data-load-chart-range]')
  await loadRange.getByRole('tab').nth(3).click()
  await expect.poll(() => historyHours).toContain(168)
  await loadRange.getByRole('tab').nth(4).click()
  await expect.poll(() => historyHours).toContain(720)

  const cpuValue = page.locator('[data-load-chart-card="cpu"] [data-latest-cpu]')
  await expect(cpuValue).toHaveText('30.0')
  await page.waitForTimeout(350)
  await expect(loadRange.getByRole('tab').nth(4)).toHaveAttribute('data-state', 'active')
  await expect(cpuValue).toHaveText('30.0')
  await expect(page.getByText('获取数据失败', { exact: true })).toHaveCount(0)
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
    if (!isRpc2Request(request.url()))
      return

    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics' || payload?.method === 'public:getPingMetricStats') {
      metricCalls.push({ method: payload.method, params: payload.params ?? {} })
    }
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)

  await expect.poll(() => new Set(metricCalls
    .filter(call => call.method === 'public:queryMetrics' && isPingMetricCall(call))
    .map(call => call.params.entity_id)).size).toBe(12)
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

function v3GlobalPingConfig(threeNetworkEnabled: boolean): string {
  return JSON.stringify({
    schemaVersion: 3,
    global: {
      threeNetworkEnabled,
      taskIds: threeNetworkEnabled ? [101, 202, 303] : [202, null, null],
    },
    nodes: {},
  })
}

function allNodeBindings(taskId: number): string {
  return JSON.stringify(Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      taskId,
    ]),
  ))
}

const PING_INGESTION_CLOCK = '2026-07-25T12:00:00.000+08:00'
const PING_INGESTION_BUCKET = '2026-07-25T04:00:00.000Z'
const PING_PREVIOUS_BUCKET = '2026-07-25T03:57:00.000Z'
const PING_INGESTION_SAMPLE = '2026-07-25T12:00:00.000+08:00'
const PING_ARBITRARY_PHASE_CLOCK = '2026-07-25T12:00:20.000+08:00'
const PING_ARBITRARY_PHASE_PREVIOUS_SAMPLE = '2026-07-25T11:59:20.000+08:00'
const PING_ARBITRARY_PHASE_SAMPLE = '2026-07-25T12:00:22.000+08:00'
const PING_ARBITRARY_PHASE_API_VISIBLE = '2026-07-25T12:00:34.000+08:00'

function scheduledPingSamples(apiVisibleAt: string, latency = 9, previousLatency = 7) {
  return [
    {
      sampleAt: '2026-07-25T11:59:00.000+08:00',
      apiVisibleAt: '2026-07-25T11:59:00.000+08:00',
      latency: previousLatency,
      loss: 0,
    },
    {
      sampleAt: PING_INGESTION_SAMPLE,
      apiVisibleAt,
      latency,
      loss: 0,
    },
  ]
}

function selectedPingMetricTimelineEntries(timeline: ReadonlyArray<{
  method: string
  requestAt: number
  responseAt: number
  params: Record<string, unknown>
  responseSamples: ReadonlyArray<{ sampleAt: number }>
}>) {
  return timeline.filter((entry) => {
    const taskId = (entry.params.tags as Record<string, unknown> | undefined)?.task_id
    return entry.method === 'public:queryMetrics' && taskId === '202'
  })
}

function isPingMetricQuery(params: Record<string, unknown>): boolean {
  const metricKeys = Array.isArray(params.metric_keys) ? params.metric_keys.map(String) : []
  return metricKeys.includes('ping.latency_ms') || metricKeys.includes('ping.loss')
}

function isPingLegacyRequest(call: { method: string, params: Record<string, unknown> }): boolean {
  return call.method === 'common:getRecords' && call.params.type === 'ping'
}

test.describe('node-card per-node ping task bindings', () => {
  test('v2.5.0 exposes fixed bucket bounds separately from raw sample timestamps', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: '2026-09-03T10:08:30.000+08:00',
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: [
          { sampleAt: '2026-09-03T09:58:00.000+08:00', apiVisibleAt: '2026-09-03T09:58:00.000+08:00', latency: 8, loss: 33.3 },
          { sampleAt: '2026-09-03T10:02:00.000+08:00', apiVisibleAt: '2026-09-03T10:02:00.000+08:00', latency: 8, loss: 0 },
          { sampleAt: '2026-09-03T10:05:00.000+08:00', apiVisibleAt: '2026-09-03T10:05:00.000+08:00', latency: 9, loss: 0 },
          { sampleAt: '2026-09-03T10:07:00.000+08:00', apiVisibleAt: '2026-09-03T10:07:00.000+08:00', latency: 9, loss: 0 },
        ],
      },
    })
    await openStablePage(page)

    const strip = primaryNodeCard(page).locator('[data-node-ping-task-id="202"]')
    await expect(strip).toHaveAttribute('data-node-ping-node-uuid', PRIMARY_NODE_UUID)
    await expect(strip).toHaveAttribute('data-node-ping-window-start', '2026-09-03T01:09:00.000Z')
    await expect(strip).toHaveAttribute('data-node-ping-window-end', '2026-09-03T02:09:00.000Z')
    const fetchedAt = Date.parse(await strip.getAttribute('data-node-ping-fetched-at') ?? '')
    expect(fetchedAt).toBeGreaterThanOrEqual(Date.parse('2026-09-03T02:08:30.000Z'))
    expect(fetchedAt).toBeLessThan(Date.parse('2026-09-03T02:09:00.000Z'))

    const rightmost = await strip
      .locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')
      .evaluateAll(elements => elements.slice(-6).map(element => ({
        start: element.getAttribute('data-node-ping-bucket-start'),
        end: element.getAttribute('data-node-ping-bucket-end'),
        sample: element.getAttribute('data-node-ping-sample-time'),
        state: element.getAttribute('data-node-ping-state'),
      })))
    expect(rightmost).toEqual([
      { start: '2026-09-03T01:51:00.000Z', end: '2026-09-03T01:54:00.000Z', sample: null, state: 'confirmed-missing' },
      { start: '2026-09-03T01:54:00.000Z', end: '2026-09-03T01:57:00.000Z', sample: null, state: 'confirmed-missing' },
      { start: '2026-09-03T01:57:00.000Z', end: '2026-09-03T02:00:00.000Z', sample: '2026-09-03T01:58:00.000Z', state: 'data' },
      { start: '2026-09-03T02:00:00.000Z', end: '2026-09-03T02:03:00.000Z', sample: '2026-09-03T02:02:00.000Z', state: 'data' },
      { start: '2026-09-03T02:03:00.000Z', end: '2026-09-03T02:06:00.000Z', sample: '2026-09-03T02:05:00.000Z', state: 'data' },
      { start: '2026-09-03T02:06:00.000Z', end: '2026-09-03T02:09:00.000Z', sample: '2026-09-03T02:07:00.000Z', state: 'data' },
    ])

    const bucket = nodeCardPingBucket(page, 'latency', '2026-09-03T01:57:00.000Z')
    await bucket.hover()
    const tooltip = page.locator('[data-slot="data-tooltip-content"]')
    await expect(tooltip).toContainText('09:57–10:00')
    await expect(tooltip).toContainText('最新样本')
    await expect(tooltip).toContainText('09:58:00')
    await expect(tooltip).toContainText('8 ms')
    await expect(tooltip).toContainText('33.3%')
  })

  test('keeps an exact selected-task snapshot visible throughout the home-to-detail leave transition', async ({ page }) => {
    test.setTimeout(45_000)
    const selectedTaskQueries: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
        return

      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      const taskId = (payload?.params?.tags as Record<string, unknown> | undefined)?.task_id
      if (payload?.method === 'public:queryMetrics' && taskId === '202')
        selectedTaskQueries.push(payload.params ?? {})
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      disablePageAnimation: false,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expectNodeCardPingTooltip(page, 'latency', '200 ms')

    // Keep the leaving card mounted long enough for WebKit/iPhone to inspect
    // its complete snapshot under a busy full-suite run.
    await page.addStyleTag({ content: '.duration-150 { transition-duration: 15000ms !important; }' })
    selectedTaskQueries.length = 0
    await primaryNodeCard(page).click()
    await expect(page).toHaveURL(`/instance/${PRIMARY_NODE_UUID}`)
    await expect(primaryNodeCard(page)).toBeVisible()
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expectNodeCardPingTooltip(page, 'latency', '200 ms')
    await expectUniformNodeCardPingBars(primaryNodeCard(page))

    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(300)
    expect(selectedTaskQueries).toHaveLength(0)
    await expect(page.getByText('硬件信息')).toBeVisible({ timeout: 20_000 })
  })

  test('quantizes all twenty NodeCard Ping bars across desktop, mobile, empty, loading, and offline states', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await openStablePage(page)

    const primaryCard = primaryNodeCard(page)
    await expectUniformNodeCardPingBars(primaryCard)
    await expectMatchingNodeCardPingPanelVerticalGeometry(primaryCard)

    await page.setViewportSize({ width: 390, height: 844 })
    await expectUniformNodeCardPingBars(primaryCard)
    await expectMatchingNodeCardPingPanelVerticalGeometry(primaryCard)

    const offlineCard = page.locator('.node-card').filter({ has: page.getByText('伦敦-离线归档', { exact: true }) })
    await expectUniformNodeCardPingBars(offlineCard)
    await expectMatchingNodeCardPingPanelVerticalGeometry(offlineCard)

    const resumePingResponses = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expectUniformNodeCardPingBars(primaryNodeCard(page))
    await expectMatchingNodeCardPingPanelVerticalGeometry(primaryNodeCard(page))
    resumePingResponses()
  })

  test('keeps the twenty-bar geometry when a valid selected binding has no samples', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'selected-empty', legacy: 'selected-empty' },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '-', '-')
    await expectUniformNodeCardPingBars(primaryNodeCard(page))
    await expectMatchingNodeCardPingPanelVerticalGeometry(primaryNodeCard(page))
  })

  test('12 valid bindings load one task catalog and only their selected Metric pairs', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

    await expect.poll(() => calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202').length).toBe(2)
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics' && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(2)

    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)
  })

  test('v2.7.2 keeps 12 nodes and three tasks on one visible current WAITING_SAMPLE slot without request fan-out', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
        return
      const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
      if (payload?.method)
        calls.push({ method: payload.method, params: payload.params ?? {} })
    })

    await page.setViewportSize({ width: 1920, height: 1080 })
    await installKomariFixture(page, {
      clockNow: '2026-09-03T10:08:30.000+08:00',
      nodeCardPingDisplayConfigV3: v3GlobalPingConfig(true),
      nodeCardPingFixture: {
        metric: 'valid',
        thirdSharedTask: true,
        sampleTimes: [
          '2026-09-03T09:58:00.000+08:00',
          '2026-09-03T10:02:00.000+08:00',
          '2026-09-03T10:05:00.000+08:00',
        ],
      },
    })
    await openStablePage(page)

    const strips = page.locator('[data-node-card-uuid] [data-node-ping-task-id]')
    await expect(strips).toHaveCount(36)
    await expect(page.locator('[data-node-card-uuid] [data-node-ping-bars="latency"] [data-node-ping-bar]')).toHaveCount(36 * 20)
    await expect(page.locator('[data-node-card-uuid] [data-node-ping-bars="loss"] [data-node-ping-bar]')).toHaveCount(36 * 20)
    const stripIdentity = await strips.evaluateAll(elements => elements.map(element => ({
      nodeUuid: element.getAttribute('data-node-ping-node-uuid'),
      taskId: element.getAttribute('data-node-ping-task-id'),
      start: element.getAttribute('data-node-ping-window-start'),
      end: element.getAttribute('data-node-ping-window-end'),
    })))
    expect(new Set(stripIdentity.map(item => item.nodeUuid)).size).toBe(12)
    expect(new Set(stripIdentity.map(item => item.taskId))).toEqual(new Set(['101', '202', '303']))
    expect(new Set(stripIdentity.map(item => item.start))).toEqual(new Set(['2026-09-03T01:09:00.000Z']))
    expect(new Set(stripIdentity.map(item => item.end))).toEqual(new Set(['2026-09-03T02:09:00.000Z']))
    const currentBuckets = await strips.evaluateAll(elements => elements.flatMap((element) => {
      return ['latency', 'loss'].map((metric) => {
        const buckets = [...element.querySelectorAll(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)]
        const bucket = buckets.at(-1)
        return {
          count: buckets.length,
          start: bucket?.getAttribute('data-node-ping-bucket-start'),
          end: bucket?.getAttribute('data-node-ping-bucket-end'),
          state: bucket?.getAttribute('data-node-ping-state'),
          severity: bucket?.getAttribute('data-node-ping-severity'),
          ariaLabel: bucket?.getAttribute('aria-label'),
        }
      })
    }))
    expect(new Set(currentBuckets.map(item => item.count))).toEqual(new Set([20]))
    expect(new Set(currentBuckets.map(item => item.start))).toEqual(new Set(['2026-09-03T02:06:00.000Z']))
    expect(new Set(currentBuckets.map(item => item.end))).toEqual(new Set(['2026-09-03T02:09:00.000Z']))
    expect(new Set(currentBuckets.map(item => item.state))).toEqual(new Set(['pending']))
    expect(new Set(currentBuckets.map(item => item.severity))).toEqual(new Set(['waiting']))
    expect(currentBuckets.every(item => item.ariaLabel?.includes('等待采样'))).toBe(true)

    const statsCalls = calls.filter(call => call.method === 'public:getPingMetricStats'
      && ['101', '202', '303'].includes(String(call.params.task_id)))
    const seriesCalls = calls.filter(call => call.method === 'public:queryMetrics'
      && ['101', '202', '303'].includes(String((call.params.tags as Record<string, unknown> | undefined)?.task_id)))
    expect(statsCalls).toHaveLength(6)
    expect(seriesCalls).toHaveLength(6)
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)
  })

  test('12 bound nodes perform only one selected Metric pair in the next successful sample cycle', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(2)

    fixture.setNodeCardPingFixture({
      sampleTimes: ['2026-07-25T12:00:00.000Z', '2026-07-25T12:01:00.000Z'],
      task202Latency: 9,
    })
    await fixture.advanceTime(65_000)
    await expectNodeCardPing(page, '9 ms', '0.0%')
    await expect.poll(() => calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === '202').length).toBe(3)
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(3)

    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(1)
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
      if (!isRpc2Request(request.url()))
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
      && Array.isArray(call.params.entity_ids)
      && call.params.entity_ids.includes(PRIMARY_NODE_UUID)
      && call.params.task_id === '202')
    const selectedQueryCalls = calls.filter(call => call.method === 'public:queryMetrics'
      && Array.isArray(call.params.entity_ids)
      && call.params.entity_ids.includes(PRIMARY_NODE_UUID)
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')
    expect(selectedStatsCalls).toHaveLength(2)
    expect(selectedQueryCalls).toHaveLength(2)
    expect(selectedQueryCalls[0]?.params.metric_keys).toEqual(['ping.latency_ms', 'ping.loss'])
    expect(calls.filter(isPingLegacyRequest)).toHaveLength(0)

    const latencyBars = primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')
    const lossBars = primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [data-node-ping-bar]')
    await expect(latencyBars).toHaveCount(20)
    await expect(lossBars).toHaveCount(20)
    expect((await latencyBars.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))).every(text => !text.includes('无采样数据'))).toBe(true)
    expect((await lossBars.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))).every(text => !text.includes('无采样数据'))).toBe(true)
  })

  test('keeps selected-task requests bounded across an in-flight card-view remount', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

    await page.getByLabel('列表视图').click()
    await page.getByLabel('卡片视图').click()
    resumePingResponses()

    await expectNodeCardPing(page, '200 ms', '25.0%')
    expect(calls.filter(call => call.method === 'public:getPublicPingTasks')).toHaveLength(1)
    const selectedStatsCalls = calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202')
    const selectedQueryCalls = calls.filter(call => call.method === 'public:queryMetrics' && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')
    expect(selectedStatsCalls.length).toBeGreaterThanOrEqual(1)
    expect(selectedStatsCalls.length).toBeLessThanOrEqual(2)
    expect(selectedQueryCalls.length).toBeGreaterThanOrEqual(1)
    expect(selectedQueryCalls.length).toBeLessThanOrEqual(2)
  })

  test('retains one task catalog while refreshing selected task data after its TTL expires', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    await expect.poll(() => calls.filter(call => call.method === 'public:getPublicPingTasks').length).toBe(1)
    await expect.poll(() => calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202').length).toBe(3)
    await expect.poll(() => calls.filter(call => call.method === 'public:queryMetrics' && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBe(3)
  })

  test('keeps the last accepted snapshot until a delayed real sample arrives and then updates without navigation', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    await expectNodeCardPingTooltip(page, 'latency', '23:00–23:03\n延迟：7 ms\n丢包：0.0%\n最新样本：23:02:00')

    const selectedQueries = () => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202')
    const initialQueryCount = selectedQueries().length

    // At the expected sample boundary plus grace, the backend still has only 23:02.
    await fixture.advanceTime(10_000)
    await expect.poll(() => selectedQueries().length).toBe(initialQueryCount + 1)
    await expectNodeCardPing(page, '7 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '23:00–23:03\n延迟：7 ms\n丢包：0.0%\n最新样本：23:02:00')
    expect((await primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [data-node-ping-bar]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? '')))
      .some(text => text.includes('23:03:00') && text.includes('无采样数据'))).toBe(false)

    // First retry still sees no newer timestamp and must not replace the old snapshot.
    await fixture.advanceTime(5_000)
    await expect.poll(() => selectedQueries().length).toBe(initialQueryCount + 2)
    await expectNodeCardPing(page, '7 ms', '0.0%')

    // The real 23:03 sample becomes visible on the next retry; no reload or route change occurs.
    fixture.setNodeCardPingFixture({
      sampleTimes: [...oldSampleTimes, '2026-07-25T23:03:00.000+08:00'],
      task202Latency: 9,
      task202Loss: 0,
    })
    await fixture.advanceTime(10_000)
    await expect.poll(() => selectedQueries().length).toBe(initialQueryCount + 3)
    await expectNodeCardPing(page, '9 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '最新样本：23:03:00')
  })

  test('v2.7.2 shows a cold newest bucket as WAITING_SAMPLE until its real API sample becomes visible, then renders DATA without reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:00:10.000+08:00'),
      },
    })
    await openStablePage(page)

    for (const metric of ['latency', 'loss'] as const)
      await expectNodeCardPingBucketState(page, metric, PING_INGESTION_BUCKET, 'pending')
    await expectNodeCardPingBucketState(page, 'latency', PING_PREVIOUS_BUCKET, 'data')
    await expectNodeCardPingTooltip(page, 'latency', '11:57–12:00\n延迟：7 ms\n丢包：0.0%\n最新样本：11:59:00')
    await expectNodeCardPingInfoStatus(page, '数据正常')
    const pendingBucket = nodeCardPingBucket(page, 'latency', PING_INGESTION_BUCKET)
    await expect(pendingBucket).toHaveAttribute('data-node-ping-severity', 'waiting')
    await expect(pendingBucket).not.toHaveAttribute('aria-hidden', 'true')
    await expect(pendingBucket).toHaveCSS('pointer-events', 'auto')
    await expect(pendingBucket).toHaveCSS('opacity', '1')
    await expect(pendingBucket).toHaveAttribute('aria-label', '12:00–12:03\n等待采样')
    const pendingStyle = await pendingBucket.locator('[data-node-ping-bucket-fill]').evaluate((element) => {
      const style = getComputedStyle(element)
      return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage }
    })
    expect(pendingStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(pendingStyle.backgroundImage).toBe('none')
    const pendingBox = await pendingBucket.boundingBox()
    expect(pendingBox).not.toBeNull()
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    const darkPendingStyle = await pendingBucket.locator('[data-node-ping-bucket-fill]').evaluate((element) => {
      const style = getComputedStyle(element)
      return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage }
    })
    expect(darkPendingStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(darkPendingStyle.backgroundImage).toBe('none')
    expect(await pendingBucket.boundingBox()).toEqual(pendingBox)
    await page.evaluate(() => document.documentElement.classList.remove('dark'))

    for (const width of [360, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 })
      for (const metric of ['latency', 'loss'] as const) {
        const bars = primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)
        await expect(bars).toHaveCount(20)
        await expect(bars.last()).toHaveAttribute('data-node-ping-severity', 'waiting')
        await expect(bars.last()).toHaveAttribute('aria-label', /等待采样/)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    }

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.mouse.move(pendingBox!.x + pendingBox!.width / 2, pendingBox!.y + pendingBox!.height / 2)
    await expect(page.locator('[data-slot="data-tooltip-content"]')).toContainText('等待采样')
    await page.keyboard.press('Escape')
    expect(selectedPingMetricTimelineEntries(fixture.timeline)
      .some(entry => entry.responseSamples.some(sample => sample.sampleAt === Date.parse(PING_INGESTION_SAMPLE)))).toBe(false)

    const beforeRefreshUrl = page.url()
    // 12:00:05 reads the still-pending backend, then the bounded retry at
    // 12:00:10 can see the true sample. No reload or route change is allowed.
    await fixture.advanceTime(10_000)
    for (const metric of ['latency', 'loss'] as const)
      await expectNodeCardPingBucketState(page, metric, PING_INGESTION_BUCKET, 'data')
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n延迟：9 ms\n丢包：0.0%\n最新样本：12:00:00')
    await expectNodeCardPingTooltip(page, 'loss', '12:00–12:03\n延迟：9 ms\n丢包：0.0%\n最新样本：12:00:00')
    await expect(page).toHaveURL(beforeRefreshUrl)

    const firstApiVisibility = selectedPingMetricTimelineEntries(fixture.timeline).find((entry) => {
      return entry.responseSamples.some(sample => sample.sampleAt === Date.parse(PING_INGESTION_SAMPLE))
    })
    expect(firstApiVisibility).toBeDefined()
    expect(firstApiVisibility!.responseAt).toBeGreaterThanOrEqual(Date.parse('2026-07-25T12:00:10.000+08:00'))
    expect(firstApiVisibility!.requestAt).toBeLessThanOrEqual(firstApiVisibility!.responseAt)
  })

  test('v1.3.3 preserves an arbitrary probe phase instead of assuming minute or bucket-start samples', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_ARBITRARY_PHASE_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: [
          {
            sampleAt: PING_ARBITRARY_PHASE_PREVIOUS_SAMPLE,
            apiVisibleAt: PING_ARBITRARY_PHASE_PREVIOUS_SAMPLE,
            latency: 7,
            loss: 0,
          },
          {
            sampleAt: PING_ARBITRARY_PHASE_SAMPLE,
            apiVisibleAt: PING_ARBITRARY_PHASE_API_VISIBLE,
            latency: 13,
            loss: 0,
          },
        ],
      },
    })
    await openStablePage(page)

    await expectNodeCardPingBucketState(page, 'latency', PING_PREVIOUS_BUCKET, 'data')
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')
    await expectNodeCardPingTooltip(page, 'latency', '11:57–12:00\n延迟：7 ms\n丢包：0.0%\n最新样本：11:59:20')
    expect(selectedPingMetricTimelineEntries(fixture.timeline).every(entry => entry.responseSamples
      .every(sample => sample.sampleAt !== Date.parse(PING_ARBITRARY_PHASE_SAMPLE)))).toBe(true)

    // The backend does not expose the :22 sample until :34. The next bounded
    // retry sees the same raw timestamp; no logic may rewrite it to :00.
    await fixture.advanceTime(14_000)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')
    await fixture.advanceTime(6_000)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'data')
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n延迟：13 ms\n丢包：0.0%\n最新样本：12:00:22')

    const rawSampleResponse = selectedPingMetricTimelineEntries(fixture.timeline).find(entry => entry.responseSamples
      .some(sample => sample.sampleAt === Date.parse(PING_ARBITRARY_PHASE_SAMPLE)))
    expect(rawSampleResponse).toBeDefined()
    expect(rawSampleResponse!.responseAt).toBeGreaterThanOrEqual(Date.parse(PING_ARBITRARY_PHASE_API_VISIBLE))
    expect(rawSampleResponse!.responseSamples.some((sample) => {
      return sample.sampleAt === Date.parse(PING_ARBITRARY_PHASE_SAMPLE)
        && sample.latency === 13
        && sample.loss === 0
    })).toBe(true)
  })

  test('cold Metric and Legacy transport failures render ERROR buckets while retries stay bounded', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCount: 1,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'error',
        legacy: 'error',
      },
    })
    await openStablePage(page)

    await expectNodeCardPing(page, '-', '-')
    for (const metric of ['latency', 'loss'] as const)
      await expectAllNodeCardPingBucketStates(page, metric, 'error')
    await expectNodeCardPingTooltip(page, 'latency', '更新失败')
    await expectNodeCardPingTooltip(page, 'loss', '更新失败')
    await expectNodeCardPingInfoStatus(page, '更新失败')
    await primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [data-node-ping-bar]').last().hover()
    await expect(page.locator('[data-slot="data-tooltip-content"]')).toContainText('更新失败')
    await page.keyboard.press('Escape')

    const requestCountBeforeRetries = fixture.timeline.length
    await fixture.advanceTime(45_000)
    for (const metric of ['latency', 'loss'] as const)
      await expectAllNodeCardPingBucketStates(page, metric, 'error')
    expect(fixture.timeline.length).toBeGreaterThan(requestCountBeforeRetries)
    expect(fixture.timeline.some(entry => entry.method === 'public:queryMetrics')).toBe(true)
    expect(fixture.timeline.some(entry => entry.method === 'common:getRecords' || entry.method === 'public:getPingRecords')).toBe(true)
    expect(fixture.timeline.every(entry => entry.responseSamples.length === 0)).toBe(true)
  })

  for (const failure of [
    { label: 'HTTP 503', kind: 'http' as const },
    { label: 'network timeout', kind: 'abort' as const, errorCode: 'timedout' as const },
    { label: 'aborted request', kind: 'abort' as const, errorCode: 'aborted' as const },
  ]) {
    test(`v2.7.2 ${failure.label} keeps fixed ERROR rails and never manufactures NO_SAMPLE or UNREACHABLE`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 })
      const fixture = await installKomariFixture(page, {
        fakeTimers: true,
        clockNow: PING_INGESTION_CLOCK,
        nodeCount: 1,
        nodeCardPingTaskBindings: primaryBinding(202),
        nodeCardPingFixture: { metric: 'valid', legacy: 'valid' },
      })
      const failedRequests: string[] = []
      await page.route('**/rpc2', async (route) => {
        const payload = route.request().postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
        const method = payload?.method ?? ''
        const metricKeys = Array.isArray(payload?.params?.metric_keys) ? payload.params.metric_keys : []
        const isPingDataRequest = method === 'public:getPingMetricStats'
          || (method === 'public:queryMetrics' && metricKeys.some(key => String(key).startsWith('ping.')))
          || (method === 'common:getRecords' && payload?.params?.type === 'ping')
          || method === 'public:getPingRecords'
        if (!isPingDataRequest) {
          await route.fallback()
          return
        }
        failedRequests.push(method)
        if (failure.kind === 'http') {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'error', message: 'fixture unavailable' }),
          })
          return
        }
        await route.abort(failure.errorCode)
      })

      await openStablePage(page)
      for (const metric of ['latency', 'loss'] as const) {
        const bars = primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)
        await expect(bars).toHaveCount(20)
        await expectAllNodeCardPingBucketStates(page, metric, 'error')
        expect(await bars.evaluateAll(elements => elements.every(element => element.getAttribute('data-node-ping-severity') === 'error'))).toBe(true)
      }
      await expectNodeCardPingTooltip(page, 'latency', '更新失败')
      const initialFailureCount = failedRequests.length
      await fixture.advanceTime(45_000)
      expect(failedRequests.length).toBeGreaterThan(initialFailureCount)
      expect(failedRequests.length).toBeLessThan(40)
      expect(await primaryNodeCard(page).locator('[data-node-ping-state="confirmed-missing"], [data-node-ping-state="unreachable"]').count()).toBe(0)
    })
  }

  test('an observed 100% loss probe renders unreachable latency without becoming no-sample', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: [
          {
            sampleAt: '2026-07-25T11:59:00.000+08:00',
            apiVisibleAt: '2026-07-25T11:59:00.000+08:00',
            latency: 7,
            loss: 0,
          },
          {
            sampleAt: PING_INGESTION_SAMPLE,
            apiVisibleAt: PING_INGESTION_CLOCK,
            latency: null,
            loss: 100,
          },
        ],
      },
    })
    await openStablePage(page)

    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'unreachable')
    await expectNodeCardPingBucketState(page, 'loss', PING_INGESTION_BUCKET, 'unreachable')
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n延迟：不可达\n丢包：100%\n最新样本：12:00:00')
    await expectNodeCardPingTooltip(page, 'loss', '12:00–12:03\n延迟：不可达\n丢包：100%\n最新样本：12:00:00')
    const latencyTooltipContents = await primaryNodeCard(page)
      .locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')
      .evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))
    expect(latencyTooltipContents.some(text => text.includes('12:00:00') && text.includes('无采样数据'))).toBe(false)
  })

  test('v2.3.1 renders paired unreachable samples with a dedicated outage style distinct from 204 ms and 50% loss', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: [
          {
            sampleAt: '2026-07-25T11:59:00.000+08:00',
            apiVisibleAt: '2026-07-25T11:59:00.000+08:00',
            latency: 204,
            loss: 50,
          },
          {
            sampleAt: PING_INGESTION_SAMPLE,
            apiVisibleAt: PING_INGESTION_CLOCK,
            latency: null,
            loss: 100,
          },
        ],
      },
    })
    await openStablePage(page)

    const criticalLatency = nodeCardPingBucket(page, 'latency', PING_PREVIOUS_BUCKET)
    const criticalLoss = nodeCardPingBucket(page, 'loss', PING_PREVIOUS_BUCKET)
    const outageLatency = nodeCardPingBucket(page, 'latency', PING_INGESTION_BUCKET)
    const outageLoss = nodeCardPingBucket(page, 'loss', PING_INGESTION_BUCKET)
    await expect(criticalLatency).toHaveAttribute('data-node-ping-severity', 'critical')
    await expect(criticalLoss).toHaveAttribute('data-node-ping-severity', 'critical')
    await expect(outageLatency).toHaveAttribute('data-node-ping-severity', 'unreachable')
    await expect(outageLoss).toHaveAttribute('data-node-ping-severity', 'unreachable')
    await expect(primaryNodeCard(page).locator('[data-node-ping-task-id="202"]')).toHaveAttribute('data-node-ping-outage', 'true')
    await expectNodeCardPing(page, '-', '100%')
    await expect(outageLatency).toHaveAttribute('aria-label', /延迟：不可达[\s\S]*丢包：100%/)

    const styles = await Promise.all([criticalLatency, criticalLoss, outageLatency, outageLoss].map(locator => locator
      .locator('[data-node-ping-bucket-fill]')
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, opacity: style.opacity }
      })))
    expect(styles[0]?.backgroundColor).toBe(styles[1]?.backgroundColor)
    expect(styles[2]?.backgroundColor).toBe(styles[3]?.backgroundColor)
    expect(styles[0]?.backgroundColor).not.toBe(styles[2]?.backgroundColor)
    expect(styles[2]?.backgroundImage).toBe('none')
    expect(styles[3]?.backgroundImage).toBe('none')
    expect(styles[2]?.opacity).toBe('1')
    expect(styles[3]?.opacity).toBe('1')

    const infoButton = primaryNodeCard(page).getByRole('button', { name: '查看该 Ping 任务详情' })
    await infoButton.hover()
    const tooltip = page.locator('[data-slot="data-tooltip-content"]')
    await expect(tooltip).toBeVisible({ timeout: 200 })
    const tooltipRows = await tooltip.locator('dl').evaluate((element) => {
      const terms = [...element.querySelectorAll('dt')]
      return Object.fromEntries(terms.map(term => [term.textContent?.trim() ?? '', term.nextElementSibling?.textContent?.trim() ?? '']))
    })
    expect(tooltipRows).toMatchObject({
      当前延迟: '不可达',
      当前丢包: '100%',
      当前状态: '探测不可达',
    })
    expect(Object.values(tooltipRows).filter(value => value === '100%')).toHaveLength(1)
  })

  test('v2.3.1 task and bucket tooltips use the info-only portal, immediate controls, stable geometry, and zero requests', async ({ page }) => {
    const calls: Array<{ method: string }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
        return
      const payload = request.postDataJSON() as { method?: string } | null
      if (payload?.method)
        calls.push({ method: payload.method })
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    const taskName = 'Fixture Hong Kong extremely long task name for stable tooltip layout'
    await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        task202Name: taskName,
        sampleSchedule: [
          {
            sampleAt: '2026-07-25T11:59:00.000+08:00',
            apiVisibleAt: '2026-07-25T11:59:00.000+08:00',
            latency: 999,
            loss: 50,
          },
          {
            sampleAt: PING_INGESTION_SAMPLE,
            apiVisibleAt: PING_INGESTION_CLOCK,
            latency: 204,
            loss: 50,
          },
        ],
      },
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '204 ms', '50.0%')

    const card = primaryNodeCard(page)
    const strip = card.locator('[data-node-ping-task-id="202"]')
    const taskNameButton = strip.locator('.node-card-ping-task-name')
    const latencySummary = strip.locator('[data-node-ping-summary="latency"]')
    const infoButton = strip.getByRole('button', { name: '查看该 Ping 任务详情' })
    const tooltip = page.locator('[data-slot="data-tooltip-content"]')
    await expect(strip).not.toHaveAttribute('title', /.+/)
    await expect(strip.locator('[title]')).toHaveCount(0)

    await strip.dispatchEvent('pointerenter', { pointerType: 'mouse' })
    await expect(tooltip).toHaveCount(0)
    await strip.dispatchEvent('pointerleave', { pointerType: 'mouse' })
    await taskNameButton.hover()
    await expect(tooltip).toHaveCount(0)
    await latencySummary.hover()
    await expect(tooltip).toHaveCount(0)

    calls.length = 0
    await infoButton.hover()
    await expect(tooltip).toBeVisible({ timeout: 200 })
    await expect(tooltip).toContainText(taskName)
    for (const label of ['任务 ID', '当前延迟', '当前丢包', '当前状态', '窗口平均延迟', '窗口平均丢包', '最新真实样本', '数据来源'])
      await expect(tooltip).toContainText(label)
    await expect(tooltip).toContainText('204 ms')
    await expect(tooltip).toContainText('50.0%')
    expect(await tooltip.evaluate(element => element.closest('[data-node-card-uuid]'))).toBeNull()
    const taskTooltipBox = await tooltip.boundingBox()
    expect(taskTooltipBox).not.toBeNull()
    expect(taskTooltipBox!.width).toBeGreaterThanOrEqual(260)

    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await infoButton.focus()
    await expect(tooltip).toBeVisible({ timeout: 200 })
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await infoButton.click()
    await expect(tooltip).toBeVisible({ timeout: 200 })
    await page.mouse.click(2, 2)
    await expect(tooltip).toHaveCount(0)

    const bucket = nodeCardPingBucket(page, 'latency', PING_INGESTION_BUCKET)
    const bucketBefore = await bucket.boundingBox()
    const cardBefore = await card.boundingBox()
    await bucket.hover()
    await expect(tooltip).toBeVisible({ timeout: 200 })
    await expect(tooltip).toContainText('12:00–12:03')
    await expect(tooltip).toContainText('最新样本')
    await expect(tooltip).toContainText('12:00:00')
    await expect(tooltip).toContainText('204 ms')
    await expect(tooltip).toContainText('50.0%')
    const bucketTooltipBox = await tooltip.boundingBox()
    const bucketAfter = await bucket.boundingBox()
    const cardAfter = await card.boundingBox()
    expect(bucketTooltipBox).not.toBeNull()
    expect(bucketTooltipBox!.width).toBeGreaterThanOrEqual(150)
    expect(bucketBefore).toEqual(bucketAfter)
    expect(cardBefore?.height).toBe(cardAfter?.height)
    await page.keyboard.press('Escape')

    const threeDigitFullLoss = nodeCardPingBucket(page, 'latency', PING_PREVIOUS_BUCKET)
    await expect(threeDigitFullLoss).toHaveAttribute('data-node-ping-severity', 'critical')
    await threeDigitFullLoss.click()
    await expect(tooltip).toBeVisible({ timeout: 200 })
    await expect(tooltip).toContainText('999 ms')
    await expect(tooltip).toContainText('50.0%')
    expect(calls).toHaveLength(0)

    await page.setViewportSize({ width: 390, height: 844 })
    await infoButton.click()
    await expect(tooltip).toBeVisible({ timeout: 200 })
    const mobileTooltipBox = await tooltip.boundingBox()
    expect(mobileTooltipBox).not.toBeNull()
    expect(mobileTooltipBox!.x).toBeGreaterThanOrEqual(8)
    expect(mobileTooltipBox!.x + mobileTooltipBox!.width).toBeLessThanOrEqual(382)
    expect(calls).toHaveLength(0)
  })

  for (const scenario of [
    { size: 'mini', mode: 'single', viewport: { width: 390, height: 844 }, dark: false, latency: 1, loss: 0 },
    { size: 'mini', mode: 'three-network', viewport: { width: 1280, height: 800 }, dark: true, latency: 13, loss: 0 },
    { size: 'compact', mode: 'single', viewport: { width: 820, height: 900 }, dark: true, latency: 204, loss: 50 },
    { size: 'compact', mode: 'three-network', viewport: { width: 1280, height: 800 }, dark: false, latency: 999, loss: 50 },
    { size: 'comfortable', mode: 'single', viewport: { width: 390, height: 844 }, dark: true, latency: 13, loss: 0 },
    { size: 'comfortable', mode: 'three-network', viewport: { width: 820, height: 900 }, dark: false, latency: 204, loss: 50 },
    { size: 'large', mode: 'single', viewport: { width: 1280, height: 800 }, dark: true, latency: 999, loss: 50 },
    { size: 'large', mode: 'three-network', viewport: { width: 390, height: 844 }, dark: false, latency: 1, loss: 0 },
  ] as const) {
    test(`v2.3.1 keeps ${scenario.size} ${scenario.mode} Ping headers and fixed buckets stable`, async ({ page }) => {
      await page.setViewportSize(scenario.viewport)
      const threeNetworkEnabled = scenario.mode === 'three-network'
      await installKomariFixture(page, {
        dark: scenario.dark,
        hideEarth: true,
        nodeCardSize: scenario.size,
        nodeCardPingDisplayConfigV3: v3GlobalPingConfig(threeNetworkEnabled),
        nodeCardPingFixture: {
          metric: 'valid',
          thirdSharedTask: true,
          task202Name: 'Fixture Hong Kong three digit stability name that must truncate without overlap',
          task202Latency: scenario.latency,
          task202Loss: scenario.loss,
        },
      })
      await openStablePage(page)

      const card = primaryNodeCard(page)
      await card.scrollIntoViewIfNeeded()
      const strips = card.locator('[data-node-ping-task-id]')
      await expect(strips).toHaveCount(threeNetworkEnabled ? 3 : 1)
      await expect(card.locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')).toHaveCount((threeNetworkEnabled ? 3 : 1) * 20)
      await expect(card.locator('[data-node-ping-bars="loss"] [data-node-ping-bar]')).toHaveCount((threeNetworkEnabled ? 3 : 1) * 20)

      const surfaceStyles = await card.evaluate((element) => {
        const styleFor = (target: Element) => {
          const style = getComputedStyle(target)
          return {
            borderWidth: style.borderWidth,
            borderColor: style.borderColor,
            boxShadow: style.boxShadow,
          }
        }
        return {
          card: styleFor(element),
          info: Array.from(element.querySelectorAll('.node-card-info-surface'), styleFor),
          strips: Array.from(element.querySelectorAll('.node-card-ping-task-strip'), styleFor),
          contained: element.scrollWidth <= element.clientWidth + 1,
        }
      })
      expect(surfaceStyles.card.borderWidth).toBe('1px')
      expect(surfaceStyles.card.borderColor).not.toBe('rgba(0, 0, 0, 0)')
      expect(surfaceStyles.info).toHaveLength(3)
      expect(surfaceStyles.strips).toHaveLength(threeNetworkEnabled ? 3 : 1)
      expect(surfaceStyles.contained).toBe(true)
      if (scenario.dark) {
        expect(surfaceStyles.info.every(style => style.boxShadow === 'none')).toBe(true)
        expect(surfaceStyles.strips.every(style => style.boxShadow === 'none')).toBe(true)
      }
      else {
        expect(surfaceStyles.info.every(style => style.boxShadow.includes('inset'))).toBe(true)
        expect(surfaceStyles.strips.every(style => style.boxShadow.includes('inset'))).toBe(true)
      }

      const layouts = await strips.evaluateAll(elements => elements.map((element) => {
        const query = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
        const header = element.querySelector<HTMLElement>('.node-card-ping-task-header')!
        const identity = query('.node-card-ping-task-identity')
        const latency = query('[data-node-ping-summary="latency"]')
        const loss = query('[data-node-ping-summary="loss"]')
        const info = query('.node-card-ping-info-trigger')
        const barWidths = Array.from(element.querySelectorAll<HTMLElement>('[data-node-ping-bars="latency"] [data-node-ping-bar]'), bar => bar.getBoundingClientRect().width)
        return {
          noOverflow: element.scrollWidth <= element.clientWidth + 1,
          identityRight: identity.right,
          latencyLeft: latency.left,
          latencyRight: latency.right,
          lossLeft: loss.left,
          lossRight: loss.right,
          infoLeft: info.left,
          infoWidth: info.width,
          headerWidth: header.getBoundingClientRect().width,
          latencyWhiteSpace: getComputedStyle(element.querySelector<HTMLElement>('[data-node-ping-summary="latency"]')!).whiteSpace,
          lossWhiteSpace: getComputedStyle(element.querySelector<HTMLElement>('[data-node-ping-summary="loss"]')!).whiteSpace,
          bucketWidthSpread: Math.max(...barWidths) - Math.min(...barWidths),
        }
      }))

      for (const layout of layouts) {
        expect(layout.noOverflow).toBe(true)
        expect(layout.identityRight).toBeLessThanOrEqual(layout.latencyLeft)
        expect(layout.latencyRight).toBeLessThanOrEqual(layout.lossLeft)
        expect(layout.lossRight).toBeLessThanOrEqual(layout.infoLeft)
        expect(layout.infoWidth).toBe(16)
        expect(layout.headerWidth).toBeGreaterThan(0)
        expect(layout.latencyWhiteSpace).toBe('nowrap')
        expect(layout.lossWhiteSpace).toBe('nowrap')
        expect(layout.bucketWidthSpread).toBeLessThanOrEqual(0.02)
      }
    })
  }

  test('v1.3.3 renders the raw Detail sample in UI and agrees with NodeCard after a finite retry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:00:05.000+08:00', 13),
      },
    })
    await openStablePage(page)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')

    await fixture.advanceTime(5_000)
    const apiVisible = fixture.timeline.find((entry) => {
      return entry.responseSamples.some(sample => sample.sampleAt === Date.parse(PING_INGESTION_SAMPLE))
    })
    expect(apiVisible).toBeDefined()

    // Detail requests its independent unfiltered Metric payload. Check the
    // rendered task card and chart, not only the fixture RPC timeline.
    await primaryNodeCard(page).click()
    await expect(page).toHaveURL(`/instance/${PRIMARY_NODE_UUID}`)
    await expect(page.getByText('硬件信息')).toBeVisible()
    const detailTaskCard = page.getByText('Fixture Hong Kong', { exact: true })
      .locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]')
    await expect(detailTaskCard).toBeVisible()
    await detailTaskCard.getByRole('button').hover()
    await expect(page.locator('[role="tooltip"]').filter({ hasText: '13 ms' }).last()).toBeVisible()
    const detailPingRoot = detailTaskCard.locator('xpath=ancestor::div[contains(@class, "flex-col") and contains(@class, "gap-4")][1]')
    const detailChart = detailPingRoot.locator('.echarts')
    await expect(detailChart).toBeVisible()
    await expect(detailChart.locator('canvas')).toBeVisible()
    await expect.poll(() => fixture.timeline.some((entry) => {
      const taskId = (entry.params.tags as Record<string, unknown> | undefined)?.task_id
      return entry.method === 'public:queryMetrics'
        && taskId === undefined
        && entry.responseSamples.some(sample => sample.sampleAt === Date.parse(PING_INGESTION_SAMPLE))
    })).toBe(true)
    const detailVisibleAt = fixture.now()

    await fixture.advanceTime(1_000)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'data')
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n延迟：13 ms\n丢包：0.0%\n最新样本：12:00:00')
    const nodeCardVisibleAt = fixture.now()

    expect(apiVisible!.responseAt).toBeGreaterThanOrEqual(Date.parse(PING_INGESTION_SAMPLE))
    expect(detailVisibleAt).toBeGreaterThanOrEqual(apiVisible!.responseAt)
    expect(nodeCardVisibleAt).toBeGreaterThanOrEqual(detailVisibleAt)
  })

  test('v1.3.3 bridges a Detail raw Metric window into a failed selected NodeCard query', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const bridgeSample = '2026-07-25T12:00:02.000+08:00'
    const bridgeVisibleAt = '2026-07-25T12:00:05.000+08:00'
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        legacy: 'error',
        metricErrorWhenTaggedTaskIds: [202],
        sampleSchedule: [{
          sampleAt: bridgeSample,
          apiVisibleAt: bridgeVisibleAt,
          latency: 17,
          loss: 0,
        }],
      },
    })

    // NodeCard starts cold: its tagged raw query and legacy fallback fail, so
    // unresolved buckets report the transport failure rather than manufacture
    // missing telemetry.
    await openStablePage(page)
    for (const metric of ['latency', 'loss'] as const)
      await expectAllNodeCardPingBucketStates(page, metric, 'error')
    await expectNodeCardPingTooltip(page, 'latency', '更新失败')

    // The backend makes the real :02 sample visible at :05. Detail's untagged
    // paired Metric query can cache it even while tagged NodeCard queries fail.
    await fixture.advanceTime(5_000)
    await primaryNodeCard(page).click()
    await expect(page).toHaveURL(`/instance/${PRIMARY_NODE_UUID}`)
    const detailTaskCard = page.getByText('Fixture Hong Kong', { exact: true })
      .locator('xpath=ancestor::div[contains(@class, "cursor-pointer")][1]')
    await expect(detailTaskCard).toBeVisible()
    await expect(detailTaskCard.locator('span[title="平均延迟"]')).toHaveText('17ms')
    const findDetailRawQuery = () => {
      return fixture.timeline.find((entry) => {
        const tags = entry.params.tags as Record<string, unknown> | undefined
        return entry.method === 'public:queryMetrics'
          && tags?.task_id === undefined
          && entry.responseSamples.some(sample => sample.sampleAt === Date.parse(bridgeSample) && sample.latency === 17)
      })
    }
    await expect.poll(findDetailRawQuery).toBeDefined()
    const detailRawQuery = findDetailRawQuery()
    if (!detailRawQuery)
      throw new Error('Detail did not populate the expected raw Ping Metric window')
    const detailWindow = {
      start: detailRawQuery.params.start,
      end: detailRawQuery.params.end,
    }

    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'data')
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n延迟：17 ms\n丢包：0.0%\n最新样本：12:00:02')
    await expectNodeCardPingBucketState(page, 'latency', PING_PREVIOUS_BUCKET, 'error')
    await expectNodeCardPingTooltip(page, 'latency', '更新失败')

    const selectedFailures = () => selectedPingMetricTimelineEntries(fixture.timeline)
    await expect.poll(() => selectedFailures().length).toBeGreaterThan(0)
    expect(selectedFailures().every(entry => entry.responseSamples.length === 0)).toBe(true)
    expect(selectedFailures().every((entry) => {
      return entry.params.start === detailWindow.start && entry.params.end === detailWindow.end
    })).toBe(true)

    await fixture.advanceTime(45_000)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'data')
    await expectNodeCardPingBucketState(page, 'latency', PING_PREVIOUS_BUCKET, 'error')
    const latencyStates = await primaryNodeCard(page)
      .locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')
      .evaluateAll(elements => elements.map(element => element.getAttribute('data-node-ping-state')))
    expect(latencyStates).not.toContain('confirmed-missing')
  })

  test('v2.7.2 keeps open and newly closed buckets pending before finalizing a successful empty interval', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:10:00.000+08:00'),
      },
    })
    await openStablePage(page)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')

    // Exhausting the retries does not finalize an interval that is still open.
    for (const delay of [5_000, 5_000, 10_000, 20_000, 5_000])
      await fixture.advanceTime(delay)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')

    // The just-closed bucket remains provisional for the same existing 40 s
    // grace/retry budget, then a later successful empty refresh finalizes it.
    await fixture.advanceTime(135_000)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')
    await fixture.advanceTime(60_000)

    for (const metric of ['latency', 'loss'] as const)
      await expectNodeCardPingBucketState(page, metric, PING_INGESTION_BUCKET, 'confirmed-missing')
    const noSampleLatency = nodeCardPingBucket(page, 'latency', PING_INGESTION_BUCKET)
    const noSampleLoss = nodeCardPingBucket(page, 'loss', PING_INGESTION_BUCKET)
    await expect(noSampleLatency).toHaveAttribute('data-node-ping-severity', 'no-sample')
    await expect(noSampleLoss).toHaveAttribute('data-node-ping-severity', 'no-sample')
    await expect(noSampleLatency).toHaveAttribute('aria-label', /无采样/)
    await expect(noSampleLatency).not.toHaveAttribute('aria-label', /100%|不可达/)
    const noSampleStyles = await Promise.all([noSampleLatency, noSampleLoss].map(locator => locator
      .locator('[data-node-ping-bucket-fill]')
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, opacity: style.opacity }
      })))
    expect(noSampleStyles.every(style => style.backgroundImage.includes('repeating-linear-gradient'))).toBe(true)
    expect(noSampleStyles.every(style => style.backgroundImage.includes('rgba(255, 255, 255, 0.36)'))).toBe(true)
    expect(new Set(noSampleStyles.map(style => style.backgroundColor)).size).toBe(1)
    expect(noSampleStyles.every(style => style.opacity === '0.76')).toBe(true)
    const noSampleBoxes = await Promise.all([noSampleLatency.boundingBox(), noSampleLoss.boundingBox()])
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    const darkNoSampleStyles = await Promise.all([noSampleLatency, noSampleLoss].map(locator => locator
      .locator('[data-node-ping-bucket-fill]')
      .evaluate((element) => {
        const style = getComputedStyle(element)
        return { backgroundImage: style.backgroundImage, opacity: style.opacity }
      })))
    expect(darkNoSampleStyles.every(style => style.backgroundImage.includes('repeating-linear-gradient'))).toBe(true)
    expect(darkNoSampleStyles.every(style => style.opacity === '0.76')).toBe(true)
    expect(await Promise.all([noSampleLatency.boundingBox(), noSampleLoss.boundingBox()])).toEqual(noSampleBoxes)
    await page.evaluate(() => document.documentElement.classList.remove('dark'))

    for (const width of [360, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 })
      for (const metric of ['latency', 'loss'] as const) {
        const bars = primaryNodeCard(page).locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)
        await expect(bars).toHaveCount(20)
        await expect(nodeCardPingBucket(page, metric, PING_INGESTION_BUCKET)).toHaveAttribute('data-node-ping-severity', 'no-sample')
        await expect(nodeCardPingBucket(page, metric, PING_INGESTION_BUCKET)).toHaveAttribute('aria-label', /无采样/)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    }

    await page.setViewportSize({ width: 1280, height: 720 })
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n无采样')
    await nodeCardPingBucket(page, 'latency', PING_INGESTION_BUCKET).hover()
    await expect(page.locator('[data-slot="data-tooltip-content"]')).toContainText('无采样')
    await page.keyboard.press('Escape')
    await fixture.advanceTime(10_000)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'confirmed-missing')

    const selectedQueries = selectedPingMetricTimelineEntries(fixture.timeline)
    expect(selectedQueries.length).toBeGreaterThanOrEqual(4)
    expect(selectedQueries.length).toBeLessThanOrEqual(14)
    expect(selectedQueries.every(entry => entry.responseSamples
      .every(sample => sample.sampleAt !== Date.parse(PING_INGESTION_SAMPLE)))).toBe(true)
  })

  test('v2.7.2 continuously settles six successful empty slots while preserving one current WAITING_SAMPLE slot', async ({ page }) => {
    test.setTimeout(360_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCount: 1,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'selected-empty',
        legacy: 'selected-empty',
      },
    })
    await openStablePage(page)

    const strip = primaryNodeCard(page).locator('[data-node-ping-task-id="202"]')
    const readRail = (metric: 'latency' | 'loss') => strip
      .locator(`[data-node-ping-bars="${metric}"] [data-node-ping-bar]`)
      .evaluateAll(elements => elements.map(element => ({
        start: element.getAttribute('data-node-ping-bucket-start'),
        end: element.getAttribute('data-node-ping-bucket-end'),
        state: element.getAttribute('data-node-ping-state'),
        severity: element.getAttribute('data-node-ping-severity'),
        ariaLabel: element.getAttribute('aria-label'),
      })))

    const initial = await readRail('latency')
    expect(initial).toHaveLength(20)
    expect(initial.at(-1)).toMatchObject({
      start: PING_INGESTION_BUCKET,
      state: 'pending',
      severity: 'waiting',
      ariaLabel: '12:00–12:03\n等待采样',
    })
    const observedCurrentStarts = [initial.at(-1)?.start]
    let previousCurrentStart = initial.at(-1)?.start

    for (let index = 0; index < 6; index += 1) {
      // The first observation lands on the existing one-minute heartbeat after
      // the 40 s write/retry grace; later checks keep that phase each slot.
      await fixture.advanceTime(index === 0 ? 240_000 : 180_000)
      // Routed RPC continuations can finish after the stepped fake-clock helper
      // yields on slower CI hosts. Observe the actual successful finalization
      // before reading the full rails; do not advance into another slot.
      await expect(strip.locator(`[data-node-ping-bars="latency"] [data-node-ping-bucket-start="${previousCurrentStart}"]`))
        .toHaveAttribute('data-node-ping-state', 'confirmed-missing', { timeout: 15_000 })
      for (const metric of ['latency', 'loss'] as const) {
        const rail = await readRail(metric)
        expect(rail).toHaveLength(20)
        expect(rail.at(-1)).toMatchObject({ state: 'pending', severity: 'waiting' })
        expect(rail.at(-1)?.ariaLabel).toContain('等待采样')
        const settled = rail.find(bucket => bucket.start === previousCurrentStart)
        expect(settled).toMatchObject({ state: 'confirmed-missing', severity: 'no-sample' })
        expect(settled?.ariaLabel).toContain('无采样')
        expect(
          rail.slice(0, -1).filter(bucket => bucket.state !== 'confirmed-missing'),
          `unsettled ${metric} buckets after cycle ${index + 1}: ${JSON.stringify(rail)}`,
        ).toEqual([])
      }
      const current = (await readRail('latency')).at(-1)?.start
      expect(current).not.toBe(previousCurrentStart)
      observedCurrentStarts.push(current)
      previousCurrentStart = current
    }

    expect(new Set(observedCurrentStarts).size).toBe(7)
    const selectedQueries = selectedPingMetricTimelineEntries(fixture.timeline)
    expect(selectedQueries.length).toBeGreaterThan(6)
    expect(selectedQueries.length).toBeLessThan(80)
    expect(selectedQueries.every(entry => entry.responseSamples.length === 0)).toBe(true)
  })

  test('v2.7.2 backfills a late real sample from CONFIRMED_MISSING to DATA without inventing a value', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:05:20.000+08:00', 11),
      },
    })
    await openStablePage(page)

    for (const delay of [5_000, 5_000, 10_000, 20_000, 5_000])
      await fixture.advanceTime(delay)
    await fixture.advanceTime(195_000)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'confirmed-missing')

    // A later heartbeat sees the delayed backend value and replaces the gap.
    await fixture.advanceTime(90_000)
    for (const metric of ['latency', 'loss'] as const)
      await expectNodeCardPingBucketState(page, metric, PING_INGESTION_BUCKET, 'data')
    await expectNodeCardPingTooltip(page, 'latency', '12:00–12:03\n延迟：11 ms\n丢包：0.0%\n最新样本：12:00:00')
    expect(fixture.timeline.some(entry => entry.responseSamples
      .some(sample => sample.sampleAt === Date.parse(PING_INGESTION_SAMPLE) && sample.latency === 11))).toBe(true)
  })

  test('keeps warm task-pair snapshots isolated from a clean browser context', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      preserveStorageOnReload: true,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:10:00.000+08:00', 99, 71),
      },
    })
    await openStablePage(page)
    await expectNodeCardPingTooltip(page, 'latency', '11:57–12:00\n延迟：71 ms\n丢包：0.0%\n最新样本：11:59:00')
    expect(await page.evaluate(prefix => Object.keys(localStorage)
      .some(key => key.startsWith(prefix) && !key.endsWith(':index')), MULTI_PING_CACHE_PREFIX)).toBe(true)

    const browser = page.context().browser()
    if (!browser)
      throw new Error('Playwright browser is required for cold-context Ping regression coverage')
    const baseURL = new URL(page.url()).origin
    const coldContext = await browser.newContext({
      baseURL,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    const coldPage = await coldContext.newPage()
    try {
      await coldPage.addInitScript(() => {
        Object.defineProperty(window, '__coldPingFixtureStorageKeyCount', {
          configurable: false,
          value: Object.keys(localStorage).length,
        })
      })
      await coldPage.setViewportSize({ width: 1280, height: 720 })
      await installKomariFixture(coldPage, {
        fakeTimers: true,
        clockNow: PING_INGESTION_CLOCK,
        nodeCardPingTaskBindings: primaryBinding(202),
        nodeCardPingFixture: {
          metric: 'valid',
          sampleSchedule: scheduledPingSamples('2026-07-25T12:10:00.000+08:00', 9),
        },
      })
      await openStablePage(coldPage)
      await expectNodeCardPingBucketState(coldPage, 'latency', PING_INGESTION_BUCKET, 'pending')
      await expectNodeCardPingTooltip(coldPage, 'latency', '11:57–12:00\n延迟：7 ms\n丢包：0.0%\n最新样本：11:59:00')
      expect(await coldPage.evaluate(() => {
        return (window as typeof window & { __coldPingFixtureStorageKeyCount?: number })
          .__coldPingFixtureStorageKeyCount
      })).toBe(0)
      expect(await coldPage.evaluate(prefix => Object.keys(localStorage)
        .some(key => key.startsWith(prefix) && !key.endsWith(':index')), MULTI_PING_CACHE_PREFIX)).toBe(true)
    }
    finally {
      await coldContext.close()
    }
  })

  test('only task-pair Ping localStorage or a fresh context makes a warmed snapshot cold', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    const warmSchedule = scheduledPingSamples('2026-07-25T12:10:00.000+08:00', 99, 71)
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      preserveStorageOnReload: true,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: warmSchedule,
      },
    })
    await openStablePage(page)
    await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')
    await expectNodeCardPingTooltip(page, 'latency', '11:57–12:00\n延迟：71 ms\n丢包：0.0%\n最新样本：11:59:00')
    expect(await page.evaluate(prefix => Object.keys(localStorage)
      .some(key => key.startsWith(prefix) && !key.endsWith(':index')), MULTI_PING_CACHE_PREFIX)).toBe(true)

    const reloadWithPausedPing = async () => {
      const resumePingResponses = fixture.pausePingResponses()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
      return resumePingResponses
    }
    const expectWarmSelectedSnapshot = async () => {
      await expectNodeCardPingBucketState(page, 'latency', PING_INGESTION_BUCKET, 'pending')
      await expectNodeCardPingTooltip(page, 'latency', '11:57–12:00\n延迟：71 ms\n丢包：0.0%\n最新样本：11:59:00')
    }

    await page.context().clearCookies()
    const resumeAfterCookieClear = await reloadWithPausedPing()
    await expectWarmSelectedSnapshot()
    resumeAfterCookieClear()

    await page.evaluate(() => sessionStorage.clear())
    const resumeAfterSessionStorageClear = await reloadWithPausedPing()
    await expectWarmSelectedSnapshot()
    resumeAfterSessionStorageClear()

    await page.evaluate(async () => {
      const factory = indexedDB as typeof indexedDB & {
        databases?: () => Promise<Array<{ name?: string }>>
      }
      const databases = await factory.databases?.() ?? []
      await Promise.all(databases.flatMap(({ name }) => {
        if (!name)
          return []
        return [new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name)
          request.addEventListener('success', () => resolve())
          request.addEventListener('error', () => resolve())
          request.addEventListener('blocked', () => resolve())
        })]
      }))
    })
    const resumeAfterIndexedDbClear = await reloadWithPausedPing()
    await expectWarmSelectedSnapshot()
    resumeAfterIndexedDbClear()

    await page.evaluate(async () => {
      if (!('caches' in window))
        return
      await Promise.all((await caches.keys()).map(cacheName => caches.delete(cacheName)))
    })
    const resumeAfterCacheStorageClear = await reloadWithPausedPing()
    await expectWarmSelectedSnapshot()
    resumeAfterCacheStorageClear()

    await page.evaluate((prefix) => {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index)
        if (key?.startsWith(prefix))
          localStorage.removeItem(key)
      }
    }, MULTI_PING_CACHE_PREFIX)
    const resumeColdPagePingResponses = await reloadWithPausedPing()
    for (const metric of ['latency', 'loss'] as const)
      await expectAllNodeCardPingBucketStates(page, metric, 'pending')
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('71 ms')
    expect(await page.evaluate(prefix => Object.keys(localStorage)
      .some(key => key.startsWith(prefix)), MULTI_PING_CACHE_PREFIX)).toBe(false)
    resumeColdPagePingResponses()

    const browser = page.context().browser()
    if (!browser)
      throw new Error('Playwright browser is required for fresh-context Ping cache coverage')
    // Playwright has no deterministic in-place HTTP-cache clearing API, so a
    // fresh context is the controlled HTTP-cache / Clear-Site-Data proxy here.
    const coldContext = await browser.newContext({
      baseURL: new URL(page.url()).origin,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    const coldPage = await coldContext.newPage()
    try {
      await coldPage.setViewportSize({ width: 1280, height: 720 })
      const coldFixture = await installKomariFixture(coldPage, {
        fakeTimers: true,
        clockNow: PING_INGESTION_CLOCK,
        preserveStorageOnReload: true,
        nodeCardPingTaskBindings: primaryBinding(202),
        nodeCardPingFixture: {
          metric: 'valid',
          sampleSchedule: warmSchedule,
        },
      })
      const resumeColdContextPingResponses = coldFixture.pausePingResponses()
      await coldPage.goto('/')
      await expect(coldPage.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
      for (const metric of ['latency', 'loss'] as const)
        await expectAllNodeCardPingBucketStates(coldPage, metric, 'pending')
      await expect(nodeCardPingPanel(coldPage, 'latency')).not.toContainText('71 ms')
      expect(await coldPage.evaluate(prefix => Object.keys(localStorage)
        .some(key => key.startsWith(prefix)), MULTI_PING_CACHE_PREFIX)).toBe(false)
      resumeColdContextPingResponses()
    }
    finally {
      await coldContext.close()
    }
  })

  test('v2 bounds pending retries, transfers one subscription to list view, and releases it on detail navigation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:10:00.000+08:00'),
      },
    })
    await openStablePage(page)

    await fixture.advanceTime(45_000)
    const pendingRetryCount = selectedPingMetricTimelineEntries(fixture.timeline).length
    // One initial fetch plus the bounded 5/10/20 retry cadence; this catches a
    // one-second or per-card polling regression without freezing the test.
    expect(pendingRetryCount).toBeGreaterThanOrEqual(4)
    expect(pendingRetryCount).toBeLessThanOrEqual(6)

    await page.getByLabel('列表视图').click()
    fixture.timeline.length = 0
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(() => selectedPingMetricTimelineEntries(fixture.timeline).length).toBeGreaterThan(0)
    const listRefreshes = selectedPingMetricTimelineEntries(fixture.timeline)
    expect(listRefreshes.length).toBeLessThanOrEqual(2)
    expect(new Set(listRefreshes.map(entry => entry.params.entity_id))).toEqual(new Set([PRIMARY_NODE_UUID]))

    await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
    await expect(page.getByText('硬件信息')).toBeVisible()
    fixture.timeline.length = 0
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await fixture.advanceTime(10_000)
    expect(selectedPingMetricTimelineEntries(fixture.timeline)).toHaveLength(0)
  })

  test('task-grouped coordination bounds page-level pending RPCs and preserves every node identity', async ({ page }) => {
    let catalogRequestCount = 0
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
        return
      const payload = request.postDataJSON() as { method?: string } | null
      if (payload?.method === 'public:getPublicPingTasks')
        catalogRequestCount += 1
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      fakeTimers: true,
      clockNow: PING_INGESTION_CLOCK,
      nodeCardPingTaskBindings: allNodeBindings(202),
      nodeCardPingFixture: {
        metric: 'valid',
        sampleSchedule: scheduledPingSamples('2026-07-25T12:10:00.000+08:00'),
      },
    })
    await openStablePage(page)

    const selectedRequests = () => selectedPingMetricTimelineEntries(fixture.timeline)
    await expect.poll(() => selectedRequests().length).toBeGreaterThan(0)
    const initialRequestCount = selectedRequests().length
    expect(initialRequestCount).toBeLessThan(12)
    const requestedNodeIds = () => new Set(selectedRequests().flatMap((entry) => {
      const ids = entry.params.entity_ids
      if (Array.isArray(ids))
        return ids.map(String)
      return typeof entry.params.entity_id === 'string' ? [entry.params.entity_id] : []
    }))
    await expect.poll(() => requestedNodeIds().size).toBe(12)
    expect(catalogRequestCount).toBe(1)

    await fixture.advanceTime(45_000)
    // All twelve consumers share one task group and the bounded 5/10/20 retry
    // cadence. Incremental mounting may schedule a few initial batches, but it
    // must remain far below the old per-card request fan-out.
    expect(selectedRequests().length).toBeGreaterThan(initialRequestCount)
    expect(selectedRequests().length).toBeLessThanOrEqual(initialRequestCount * 6)
    expect(requestedNodeIds().size).toBe(12)
  })

  test('keeps an accepted selected-task snapshot when its next refresh fails', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const selectedMetricQueryCount = () => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

    const initialSelectedMetricQueries = selectedMetricQueryCount()
    fixture.setNodeCardPingFixture({ metric: 'error', legacy: 'selected-empty' })
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(selectedMetricQueryCount).toBeGreaterThan(initialSelectedMetricQueries)

    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('加载中')
  })

  test('hydrates an exact selected-task snapshot before a reload network refresh completes', async ({ page }) => {
    const catalogResponses: number[] = []
    page.on('response', async (response) => {
      const request = response.request()
      if (!isRpc2Request(request.url()))
        return
      const payload = request.postDataJSON() as { method?: string } | null
      if (payload?.method === 'public:getPublicPingTasks')
        catalogResponses.push(response.status())
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    const fixture = await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid' },
      preserveStorageOnReload: true,
    })
    await openStablePage(page)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    expect(await page.evaluate(prefix => Object.keys(localStorage)
      .some(key => key.startsWith(prefix) && !key.endsWith(':index')), MULTI_PING_CACHE_PREFIX)).toBe(true)

    const resumePingResponses = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    await expect.poll(() => catalogResponses.length).toBeGreaterThanOrEqual(2)
    expect(catalogResponses.every(status => status === 200)).toBe(true)
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

    await page.evaluate((prefix) => {
      const key = Object.keys(localStorage)
        .find(value => value.startsWith(prefix) && !value.endsWith(':index'))
      if (!key)
        throw new Error('selected Ping snapshot was not persisted')
      const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
      localStorage.setItem(key, JSON.stringify({ ...value, version: 999 }))
    }, MULTI_PING_CACHE_PREFIX)

    const resumePingResponses = fixture.pausePingResponses()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
    const strip = primaryNodeCard(page).locator('[data-node-ping-task-id="202"]')
    await expect(strip).toContainText('等待采样')
    await expect(strip).not.toContainText('200 ms')
    await expect(strip.locator('[data-node-ping-bars="latency"] [data-node-ping-bar]').first()).toHaveAttribute('data-node-ping-state', 'pending')
    await expectNodeCardPingInfoStatus(page, '等待采样')
    resumePingResponses()
    await expectNodeCardPing(page, '200 ms', '25.0%')
  })

  test('keeps one selected-task list subscriber and releases it when all card consumers unmount', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    const selectedQueryCount = () => calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length
    await expect.poll(selectedQueryCount).toBe(1)

    await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
    await expect(page.getByText('硬件信息')).toBeVisible()
    calls.length = 0
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(300)
    expect(selectedQueryCount()).toBe(0)
  })

  test('visibility and online recovery trigger shared silent selected-task refreshes', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    const initialQueryCount = selectedQueryCount()
    expect(initialQueryCount).toBeGreaterThanOrEqual(1)
    expect(initialQueryCount).toBeLessThanOrEqual(2)

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(selectedQueryCount).toBeGreaterThan(initialQueryCount)
    const afterVisibilityCount = selectedQueryCount()
    expect(afterVisibilityCount).toBeLessThanOrEqual(initialQueryCount + 2)
    await expectNodeCardPing(page, '200 ms', '25.0%')
    await expect(nodeCardPingPanel(page, 'latency')).not.toContainText('加载中')

    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(selectedQueryCount).toBeGreaterThan(afterVisibilityCount)
    expect(selectedQueryCount()).toBeLessThanOrEqual(afterVisibilityCount + 2)
    await expectNodeCardPing(page, '200 ms', '25.0%')
  })

  test('a selected Metric failure uses only that node legacy data and leaves other nodes on Metric', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    await expectNodeCardPing(page, '200 ms', '0.0%')

    await expect.poll(() => calls.filter(isPingLegacyRequest).length).toBeGreaterThan(0)
    const legacyCalls = calls.filter(isPingLegacyRequest)
    expect(legacyCalls.length).toBeLessThanOrEqual(2)
    expect(new Set(legacyCalls.map(call => call.params.uuid))).toEqual(new Set([PRIMARY_NODE_UUID]))
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('selected Metric failure with a successful empty Legacy response keeps each valid binding empty without querying the aggregate', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

      const latencyBars = primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')
      const lossBars = primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [data-node-ping-bar]')
      await expect(latencyBars).toHaveCount(20)
      await expect(lossBars).toHaveCount(20)

      const latencyTimes = (await latencyBars.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))).map(text => text.trim().split(/\s+/)[0])
      const lossTimes = (await lossBars.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))).map(text => text.trim().split(/\s+/)[0])
      expect(latencyTimes).toEqual(lossTimes)
      const finalizedLatencyTimes = latencyTimes.filter(Boolean)
      expect(finalizedLatencyTimes).toEqual([...finalizedLatencyTimes].sort())

      if (sampleCount === 1) {
        const latencyStates = await primaryNodeCard(page)
          .locator('[data-node-ping-bars="latency"] > [data-node-ping-bar]')
          .evaluateAll(elements => elements.map(element => element.getAttribute('data-node-ping-state')))
        expect(latencyStates.filter(state => state === 'confirmed-missing')).toHaveLength(18)
        expect(latencyStates.filter(state => state === 'pending')).toHaveLength(1)
        expect(latencyStates.filter(state => state === 'data')).toHaveLength(1)
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

    const latencyBars = primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')
    const lossBars = primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [data-node-ping-bar]')
    await expect(latencyBars).toHaveCount(20)
    await expect(lossBars).toHaveCount(20)
    await expect(latencyBars.first()).toHaveAttribute('aria-label', /20:00–20:03[\s\S]*7 ms[\s\S]*最新样本：20:00:00/)
    await expect(lossBars.first()).toHaveAttribute('aria-label', /20:00–20:03[\s\S]*0\.0%[\s\S]*最新样本：20:00:00/)
  })

  test('uses selected Legacy history instead of a stats.latest-only synthetic Metric point', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    await expectNodeCardPing(page, '200 ms', '0.0%')
    await expect.poll(() => calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBeGreaterThan(0)
    expect(calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBeLessThanOrEqual(2)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.entity_id === PRIMARY_NODE_UUID && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && call.params.entity_id === PRIMARY_NODE_UUID && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('keeps a valid binding empty when stats lack selected history and Legacy also lacks data', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    await expect.poll(() => calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBeGreaterThan(0)
    expect(calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBeLessThanOrEqual(2)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.entity_id === PRIMARY_NODE_UUID && call.params.task_id === undefined)).toHaveLength(0)
    expect(calls.filter(call => call.method === 'public:queryMetrics' && call.params.entity_id === PRIMARY_NODE_UUID && isPingMetricQuery(call.params) && !(call.params.tags as Record<string, unknown> | undefined)?.task_id)).toHaveLength(0)
  })

  test('empty setting retains the all-task aggregate and does not request a task catalog', async ({ page }) => {
    let publicTaskCalls = 0
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
      if (!isRpc2Request(request.url()))
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

  test('a valid 100% loss Metric binding keeps summary latency empty, uses only its task, and recovers automatically', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

    await expectNodeCardPing(page, '-', '100%')
    await expect(primaryNodeCard(page).locator('[data-node-ping-bars="latency"] [data-node-ping-bar]')).toHaveCount(20)
    await expect(primaryNodeCard(page).locator('[data-node-ping-bars="loss"] [data-node-ping-bar]')).toHaveCount(20)
    const initialStatsCount = calls.filter(call => call.method === 'public:getPingMetricStats' && call.params.task_id === '202').length
    const initialQueryCount = calls.filter(call => call.method === 'public:queryMetrics'
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length
    expect(initialStatsCount).toBeGreaterThanOrEqual(1)
    expect(initialStatsCount).toBeLessThanOrEqual(2)
    expect(initialQueryCount).toBeGreaterThanOrEqual(1)
    expect(initialQueryCount).toBeLessThanOrEqual(2)
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
      && (call.params.tags as Record<string, unknown> | undefined)?.task_id === '202').length).toBeGreaterThan(initialQueryCount)
    expect(calls.filter(call => call.method === 'public:getPingMetricStats'
      && call.params.entity_id === PRIMARY_NODE_UUID
      && call.params.task_id === undefined)).toHaveLength(0)
  })

  test('selected Legacy full-loss records keep a valid binding task-scoped when Metric requests fail', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

    await expectNodeCardPing(page, '-', '100%')
    await expect.poll(() => calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBeGreaterThan(0)
    expect(calls.filter(call => isPingLegacyRequest(call) && call.params.uuid === PRIMARY_NODE_UUID).length).toBeLessThanOrEqual(2)
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

  test('missing or deleted task is marked invalid and never impersonated by aggregate history', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', task202Exists: false },
    })
    await openStablePage(page)

    const slot = primaryNodeCard(page).locator('[data-node-ping-invalid-slot="1"]')
    await expect(slot).toContainText('配置失效')
    await expect(slot).not.toContainText('91 ms')
    await expect(slot).not.toContainText('12.5%')
  })

  test('task not assigned to the node is marked invalid and never replaced with aggregate data', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installKomariFixture(page, {
      nodeCardPingTaskBindings: primaryBinding(202),
      nodeCardPingFixture: { metric: 'valid', task202Assigned: false },
    })
    await openStablePage(page)

    const slot = primaryNodeCard(page).locator('[data-node-ping-invalid-slot="1"]')
    await expect(slot).toContainText('任务失效')
    await expect(slot).not.toContainText('91 ms')
    await expect(slot).not.toContainText('12.5%')
  })

  test('task with no Metric or Legacy data remains empty when its binding is valid', async ({ page }) => {
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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

    await expectNodeCardPing(page, '200 ms', '0.0%')
    await expectNodeCardPingTooltip(page, 'latency', '200 ms')
    await expectNodeCardPingTooltip(page, 'loss', '丢包：100%')
  })

  test('keeps a valid binding empty after Metric failure and a successful empty Legacy response', async ({ page }) => {
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

  test('list uses the first effective task while detail Ping remains an unfiltered aggregate', async ({ page }) => {
    const detailPingCalls: Array<Record<string, unknown>> = []
    page.on('request', (request) => {
      if (!isRpc2Request(request.url()))
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
    await expect(listPingCell.locator('span[aria-label$=" ms"]').first()).toHaveAttribute('aria-label', /200 ms$/)
    await expect(listPingCell.locator('span[aria-label$="%"]').first()).toHaveAttribute('aria-label', /25\.0%$/)

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

  test('the Ping Center is node-centred, filters candidates by task clients, and saves a v3 custom override without rewriting v1 or v2', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      hidePingTaskBindingEntry: true,
      nodeCardPingFixture: { metric: 'valid' },
    })
    const originalSettings = fixture.getSavedThemeSettings()
    await openStablePage(page, '/?view=pingsettings')

    await expect(page.getByRole('heading', { name: '延迟监测中心', exact: true })).toHaveClass(/text-2xl/)
    await expect(page.getByTestId('ping-center')).not.toContainText('09 · 延迟任务绑定')

    const primaryRow = page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)
    await expect(primaryRow).toBeVisible()
    await expect(primaryRow).toContainText('候选 2')
    await page.getByTestId('ping-center-global-slot-1').selectOption('101')
    await primaryRow.getByRole('button', { name: '单节点配置' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('ping-center-node-mode-custom').click()
    const taskOptions = await dialog.getByTestId('ping-center-node-slot-1').locator('option').allTextContents()
    expect(taskOptions[0]).toBe('请选择探测任务')
    expect(taskOptions.some(text => text.includes('Fixture Tokyo'))).toBe(true)
    expect(taskOptions.some(text => text.includes('Fixture Hong Kong'))).toBe(true)
    expect(taskOptions.some(text => text.includes('Fixture Seoul (not assigned to primary)'))).toBe(false)
    await dialog.getByTestId('ping-center-node-slot-1').selectOption('202')
    await dialog.getByRole('button', { name: '完成' }).click()
    await page.getByTestId('ping-center-save-preview').click()
    await page.getByTestId('ping-center-save-confirm').click()

    await expect(primaryRow).toContainText('Fixture Hong Kong')
    await expect.poll(() => fixture.getThemeSaveCount()).toBe(1)
    const savedSettings = fixture.getSavedThemeSettings()
    expect(savedSettings.fixtureUnrelatedSetting).toBe('preserve-me')
    expect(savedSettings.hidePingTaskBindingEntry).toBe(true)
    expect(String(savedSettings.nodeCardPingTaskBindings)).toBe('{}')
    expect(savedSettings.nodeCardPingDisplayConfigV2).toBe(originalSettings.nodeCardPingDisplayConfigV2)
    expect(inspectNodeCardPingConfig(savedSettings.nodeCardPingDisplayConfigV3).config).toMatchObject({
      schemaVersion: 3,
      global: { threeNetworkEnabled: false, taskIds: [101, null, null] },
      nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [202, null, null] } },
    })
  })

  test('the Ping Center searches and filters nodes, then clears a migrated override while preserving the v1 key', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCardPingTaskBindings: primaryBinding(202),
    })
    await openStablePage(page, '/?view=pingsettings')

    const search = page.getByTestId('ping-center-settings-search')
    await search.fill(PRIMARY_NODE_UUID)
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
    await search.fill('no-such-node')
    await expect(page.getByText('没有匹配的节点。')).toBeVisible()
    await search.fill(PRIMARY_NODE_UUID)
    await page.getByTestId('ping-center-settings-filter').locator('[data-filter="custom"]').click()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
    await page.getByTestId('ping-center-settings-filter').locator('[data-filter="all"]').click()

    const primaryRow = page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)
    await primaryRow.getByRole('button', { name: '单节点配置' }).click()
    await page.getByTestId('ping-center-node-mode-inherit').click()
    await page.getByRole('dialog').getByRole('button', { name: '完成' }).click()
    await expect(primaryRow).toContainText('继承全局')
    await page.getByTestId('ping-center-global-slot-1').selectOption('101')
    await page.getByTestId('ping-center-save-preview').click()
    await page.getByTestId('ping-center-save-confirm').click()
    await expect.poll(() => fixture.getThemeSaveCount()).toBe(1)
    expect(String(fixture.getSavedThemeSettings().nodeCardPingTaskBindings)).toBe(primaryBinding(202))
    expect(inspectNodeCardPingConfig(fixture.getSavedThemeSettings().nodeCardPingDisplayConfigV3).config).toMatchObject({
      global: { threeNetworkEnabled: false, taskIds: [101, null, null] },
      nodes: {},
    })
  })

  test('recovery removes orphaned and invalid v2 overrides without mutating downgrade-safe v1 mappings', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCardPingTaskBindings: JSON.stringify({
        [PRIMARY_NODE_UUID]: 303,
        '00000000-0000-4000-8000-000000000999': 202,
      }),
    })
    await openStablePage(page, '/?view=pingsettings')

    const legacyValue = JSON.stringify({
      [PRIMARY_NODE_UUID]: 303,
      '00000000-0000-4000-8000-000000000999': 202,
    })
    await expect(page.getByTestId('ping-center-orphan-config')).toContainText('1 个节点覆盖已失效')
    await page.getByRole('button', { name: '移除失效覆盖' }).click()
    const primaryRow = page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)
    await expect(primaryRow).toContainText('失效')
    await primaryRow.getByRole('button', { name: '单节点配置' }).click()
    await page.getByTestId('ping-center-node-mode-inherit').click()
    await page.getByRole('dialog').getByRole('button', { name: '完成' }).click()
    await page.getByTestId('ping-center-global-slot-1').selectOption('101')
    await page.getByTestId('ping-center-save-preview').click()
    await page.getByTestId('ping-center-save-confirm').click()
    await expect.poll(() => fixture.getThemeSaveCount()).toBe(1)
    expect(String(fixture.getSavedThemeSettings().nodeCardPingTaskBindings)).toBe(legacyValue)
    expect(fixture.getSavedThemeSettings().nodeCardPingDisplayConfigV2).toBeUndefined()
    expect(inspectNodeCardPingConfig(fixture.getSavedThemeSettings().nodeCardPingDisplayConfigV3).config).toMatchObject({
      global: { threeNetworkEnabled: false, taskIds: [101, null, null] },
      nodes: {},
    })
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
    await expect(page.getByTestId('ping-center-settings-login-required')).toContainText('此配置仅允许已登录管理员读取和保存。')
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toHaveCount(0)
    await expect(page.getByTestId('ping-center-settings-search')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-save-preview')).toHaveCount(0)
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
    await expect(page.getByTestId('node-ping-binding-forbidden')).toContainText('当前账户没有管理员权限，无法读取或保存 Ping 配置。')
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toHaveCount(0)
    await expect(page.getByTestId('ping-center-save-preview')).toHaveCount(0)
    expect(adminRequests).toEqual(['GET /api/admin/ping'])
  })

  test('an administrator can open the known management URL while the toolbar entry is hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, {
      adminAccess: 'admin',
      hidePingTaskBindingEntry: true,
    })
    await openStablePage(page, '/?view=pingsettings')

    await expect(page.getByRole('heading', { name: '延迟监测中心', exact: true })).toBeVisible()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
    await expect(page.getByTestId('ping-center-entry')).toHaveCount(0)
  })

  test('the binding page title and return action remain separated on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installKomariFixture(page, { adminAccess: 'admin' })
    await openStablePage(page, '/?view=pingsettings')

    const heading = page.getByRole('heading', { name: '延迟监测中心', exact: true })
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

    await page.getByTestId('ping-center-entry').click()
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('pingsettings')
    expect(new URL(page.url()).searchParams.get('source')).toBe('toolbar')
    expect(new URL(page.url()).searchParams.get('pingtab')).toBe('overview')
    await expect(page.getByTestId('ping-center-overview')).toBeVisible()
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
