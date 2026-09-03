import type { Locator, Page } from '@playwright/test'
import type { NodeCardPingHistoryPoint } from '../../src/types/node-card-ping'
import type { NodeCardMultiPingConfig } from '../../src/utils/nodeCardMultiPingConfig'
import type { NodeCardPingConfig } from '../../src/utils/nodeCardPingConfig'
import { expect, test } from '@playwright/test'
import { serializeNodeCardMultiPingConfig } from '../../src/utils/nodeCardMultiPingConfig'
import {
  createDefaultNodeCardPingConfig,
  inspectNodeCardPingConfig,
  migrateNodeCardMultiPingConfigToV3,
  previewStrictNodeCardPingBulkAssignment,
  resolveNodeCardPingDisplay,
  resolveNodeCardPingRuntimeConfig,
  serializeNodeCardPingConfig,
} from '../../src/utils/nodeCardPingConfig'
import {
  classifyNodeCardLatency,
  classifyNodeCardLoss,
  isConfirmedNodeCardPingUnreachable,
  latencyBucketSeverity,
  lossBucketSeverity,
} from '../../src/utils/nodeCardPingPresentation'
import { installKomariFixture, PRIMARY_NODE_UUID } from './fixtures/komari'

const NODE_2 = '00000000-0000-4000-8000-000000000002'
const NODE_3 = '00000000-0000-4000-8000-000000000003'
const NODE_4 = '00000000-0000-4000-8000-000000000004'

function v2Config(displayCount: 1 | 2 | 3, taskIds: number[]): NodeCardMultiPingConfig {
  return {
    schemaVersion: 2,
    global: { displayCount, taskIds },
    nodes: {
      [PRIMARY_NODE_UUID]: { mode: 'custom', displayCount, taskIds: [...taskIds] },
    },
  }
}

function v3Config(value: Partial<NodeCardPingConfig> = {}): NodeCardPingConfig {
  return {
    schemaVersion: 3,
    global: { threeNetworkEnabled: true, taskIds: [101, 202, 303] },
    nodes: {},
    ...value,
  }
}

async function readTaskStripGeometry(strip: Locator) {
  return strip.evaluate((element) => {
    const readRail = (metric: 'latency' | 'loss') => {
      const rail = element.querySelector<HTMLElement>(`[data-node-ping-bars="${metric}"]`)
      if (!rail)
        throw new Error(`missing ${metric} rail`)
      const railRect = rail.getBoundingClientRect()
      const wrappers = Array.from(rail.querySelectorAll<HTMLElement>(':scope > [data-node-ping-bar]'))
      return {
        rect: { top: railRect.top, bottom: railRect.bottom, width: railRect.width, height: railRect.height },
        gap: Number.parseFloat(getComputedStyle(rail).columnGap) || 0,
        buckets: wrappers.map((wrapper) => {
          const fill = wrapper.querySelector<HTMLElement>('[data-node-ping-bucket-fill]')
          if (!fill)
            throw new Error('missing bucket fill')
          const wrapperRect = wrapper.getBoundingClientRect()
          const fillRect = fill.getBoundingClientRect()
          const style = getComputedStyle(fill)
          return {
            wrapper: { left: wrapperRect.left, right: wrapperRect.right, width: wrapperRect.width, height: wrapperRect.height },
            fill: { left: fillRect.left, right: fillRect.right, width: fillRect.width, height: fillRect.height },
            transform: style.transform,
            margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
          }
        }),
      }
    }
    const latency = readRail('latency')
    const loss = readRail('loss')
    return {
      latency,
      loss,
      rowGap: loss.rect.top - latency.rect.bottom,
      cssRowGap: Number.parseFloat(getComputedStyle(element).getPropertyValue('--ping-row-gap')),
      cssThickness: Number.parseFloat(getComputedStyle(element).getPropertyValue('--ping-bucket-height')),
      trendRowHeight: Number.parseFloat(getComputedStyle(element).getPropertyValue('--ping-trend-row-height')),
    }
  })
}

function expectFixedRailGeometry(
  geometry: Awaited<ReturnType<typeof readTaskStripGeometry>>,
  expectedThickness: number,
  expectedRowGap: number,
  expectedBucketGap: number,
): void {
  expect(geometry.latency.buckets).toHaveLength(20)
  expect(geometry.loss.buckets).toHaveLength(20)
  expect(geometry.cssThickness).toBe(expectedThickness)
  expect(geometry.latency.rect.height).toBeCloseTo(expectedThickness, 1)
  expect(geometry.loss.rect.height).toBeCloseTo(expectedThickness, 1)
  expect(geometry.latency.rect.width).toBeCloseTo(geometry.loss.rect.width, 1)
  expect(geometry.rowGap).toBeCloseTo(expectedRowGap, 1)
  expect(geometry.rowGap).toBeCloseTo(geometry.trendRowHeight + geometry.cssRowGap - expectedThickness, 1)
  for (const rail of [geometry.latency, geometry.loss]) {
    expect(rail.gap).toBeCloseTo(expectedBucketGap, 1)
    const widths = rail.buckets.map(bucket => bucket.wrapper.width)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1.01)
    for (const [index, bucket] of rail.buckets.entries()) {
      expect(bucket.wrapper.height).toBeCloseTo(expectedThickness, 1)
      expect(bucket.fill.width).toBeCloseTo(bucket.wrapper.width, 1)
      expect(bucket.fill.height).toBeCloseTo(bucket.wrapper.height, 1)
      expect(bucket.transform).toBe('none')
      expect(bucket.margin).toEqual(['0px', '0px', '0px', '0px'])
      expect(bucket.padding).toEqual(['0px', '0px', '0px', '0px'])
      expect(bucket.border).toEqual(['0px', '0px', '0px', '0px'])
      if (index > 0)
        expect(bucket.wrapper.left - rail.buckets[index - 1]!.wrapper.right).toBeCloseTo(rail.gap, 1)
    }
  }
}

const NODE_CARD_PING_GEOMETRY = [
  { size: 'mini', viewportWidth: 390, thickness: 3, rowGap: 8, bucketGap: 1 },
  { size: 'compact', viewportWidth: 768, thickness: 4, rowGap: 9, bucketGap: 2 },
  { size: 'comfortable', viewportWidth: 1024, thickness: 5, rowGap: 10, bucketGap: 2 },
  { size: 'large', viewportWidth: 1440, thickness: 5, rowGap: 10, bucketGap: 2 },
] as const

function historyPoint(value: Partial<NodeCardPingHistoryPoint> = {}): NodeCardPingHistoryPoint {
  return {
    time: '2026-09-02T16:19:00.000Z',
    latency: null,
    loss: null,
    latencySampleTime: null,
    lossSampleTime: null,
    latencyState: 'pending',
    lossState: 'pending',
    ...value,
  }
}

function activeDataTooltip(page: Page): Locator {
  return page.locator('[data-slot="data-tooltip-content"]').last()
}

test.describe('node-card Ping v2.3 presentation semantics', () => {
  test('uses the Lumina latency thresholds without treating 158-180 ms as critical', () => {
    expect([
      [0, 'excellent'],
      [60, 'excellent'],
      [61, 'good'],
      [100, 'good'],
      [101, 'moderate'],
      [158, 'moderate'],
      [160, 'moderate'],
      [161, 'elevated'],
      [170, 'elevated'],
      [180, 'elevated'],
      [200, 'elevated'],
      [201, 'critical'],
      [null, 'neutral'],
    ].map(([value]) => classifyNodeCardLatency(value as number | null))).toEqual([
      'excellent',
      'excellent',
      'good',
      'good',
      'moderate',
      'moderate',
      'moderate',
      'elevated',
      'elevated',
      'elevated',
      'elevated',
      'critical',
      'neutral',
    ])
  })

  test('keeps loss severity independent and requires paired real evidence for unreachable', () => {
    expect([0, 0.5, 2, 4, 25, 100, null].map(classifyNodeCardLoss)).toEqual([
      'excellent',
      'good',
      'moderate',
      'elevated',
      'critical',
      'critical',
      'neutral',
    ])

    const unreachable = historyPoint({
      latency: null,
      loss: 100,
      latencySampleTime: '2026-09-02T16:19:00.000Z',
      lossSampleTime: '2026-09-02T16:19:00.000Z',
      latencyState: 'data',
      lossState: 'data',
    })
    expect(isConfirmedNodeCardPingUnreachable(unreachable)).toBe(true)
    expect(latencyBucketSeverity(unreachable)).toBe('unreachable')
    expect(lossBucketSeverity(unreachable)).toBe('unreachable')
    expect(isConfirmedNodeCardPingUnreachable(historyPoint({ loss: 100, lossState: 'data' }))).toBe(false)
    expect(isConfirmedNodeCardPingUnreachable(historyPoint({ latencyState: 'confirmed-missing', loss: 100, lossState: 'data' }))).toBe(false)
    expect(isConfirmedNodeCardPingUnreachable({ ...unreachable, lossSampleTime: '2026-09-02T16:18:00.000Z' })).toBe(false)
    expect(latencyBucketSeverity(historyPoint(), true)).toBe('error')
    expect(lossBucketSeverity(historyPoint(), true)).toBe('error')
  })
})

test.describe('node-card Ping v3 configuration invariants', () => {
  test('strictly parses opaque v3 data, canonicalizes node order, and serializes idempotently', () => {
    for (const value of [undefined, null, ''])
      expect(inspectNodeCardPingConfig(value)).toMatchObject({ status: 'absent', config: null })

    for (const value of [
      '{broken',
      'v3:not+base64',
      { schemaVersion: 3, global: { threeNetworkEnabled: true, taskIds: [101, 101, null] }, nodes: {} },
      { schemaVersion: 3, global: { threeNetworkEnabled: true, taskIds: [101, 202] }, nodes: {} },
      { schemaVersion: 2, global: { displayCount: 1, taskIds: [101] }, nodes: {} },
    ]) {
      expect(inspectNodeCardPingConfig(value)).toMatchObject({ status: 'damaged', config: null })
    }

    const raw = v3Config({
      nodes: {
        [NODE_2.toUpperCase()]: { mode: 'inherit' },
        [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [303, 202, 101] },
      },
    })
    const encoded = serializeNodeCardPingConfig(raw)
    expect(encoded).toMatch(/^v3:/)
    expect(serializeNodeCardPingConfig(encoded)).toBe(encoded)
    expect(inspectNodeCardPingConfig(encoded).config).toEqual({
      ...raw,
      nodes: {
        [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [303, 202, 101] },
        [NODE_2]: { mode: 'inherit' },
      },
    })
  })

  test('migrates v2 count 1, 2, and 3 without inventing or deleting task slots', () => {
    const single = migrateNodeCardMultiPingConfigToV3(v2Config(1, [101]))
    expect(single).toMatchObject({
      global: { threeNetworkEnabled: false, taskIds: [101, null, null] },
      nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [101, null, null] } },
    })

    const formerTwo = migrateNodeCardMultiPingConfigToV3(v2Config(2, [101, 202]))
    expect(formerTwo).toMatchObject({
      global: { threeNetworkEnabled: true, taskIds: [101, 202, null] },
      nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [101, 202, null] } },
    })
    const tasks = [
      { id: 101, clients: [PRIMARY_NODE_UUID] },
      { id: 202, clients: [PRIMARY_NODE_UUID] },
    ]
    expect(resolveNodeCardPingDisplay({
      config: formerTwo,
      source: 'v2-migration',
      persistedStatus: 'absent',
      damaged: false,
      migrationNeeded: true,
    }, PRIMARY_NODE_UUID, tasks)).toMatchObject({
      displayCount: 3,
      configuredTaskSlots: [101, 202, null],
      coverage: 'partial',
    })

    const triple = migrateNodeCardMultiPingConfigToV3(v2Config(3, [101, 202, 303]))
    expect(triple.global).toEqual({ threeNetworkEnabled: true, taskIds: [101, 202, 303] })
  })

  test('prefers valid v3, falls back through v2 and v1, and never changes old serialized values', () => {
    const legacy = { [PRIMARY_NODE_UUID]: 404 }
    const oldV2 = serializeNodeCardMultiPingConfig(v2Config(2, [101, 202]))
    const v3 = serializeNodeCardPingConfig(v3Config())

    expect(resolveNodeCardPingRuntimeConfig(v3, oldV2, legacy)).toMatchObject({
      source: 'v3',
      migrationNeeded: false,
      config: v3Config(),
    })
    expect(resolveNodeCardPingRuntimeConfig(undefined, oldV2, legacy)).toMatchObject({
      source: 'v2-migration',
      migrationNeeded: true,
      config: { global: { threeNetworkEnabled: true, taskIds: [101, 202, null] } },
    })
    expect(resolveNodeCardPingRuntimeConfig('{bad', undefined, legacy)).toMatchObject({
      source: 'legacy-migration',
      damaged: true,
      config: { nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [404, null, null] } } },
    })
    expect(resolveNodeCardPingRuntimeConfig(undefined, undefined, {})).toMatchObject({ source: 'legacy-aggregate' })
    expect(oldV2).toBe(serializeNodeCardMultiPingConfig(v2Config(2, [101, 202])))
  })

  test('three-network switch derives only one or three active rows and preserves hidden task IDs', () => {
    const config = v3Config()
    config.global.threeNetworkEnabled = false
    const serializedOff = serializeNodeCardPingConfig(config)
    expect(inspectNodeCardPingConfig(serializedOff).config?.global.taskIds).toEqual([101, 202, 303])

    const runtime = resolveNodeCardPingRuntimeConfig(serializedOff, undefined, {})
    const tasks = [101, 202, 303].map(id => ({ id, clients: [PRIMARY_NODE_UUID] }))
    expect(resolveNodeCardPingDisplay(runtime, PRIMARY_NODE_UUID, tasks)).toMatchObject({
      displayCount: 1,
      configuredTaskSlots: [101, 202, 303],
      resolvedTaskIds: [101],
      coverage: 'full',
    })

    config.global.threeNetworkEnabled = true
    expect(resolveNodeCardPingDisplay(resolveNodeCardPingRuntimeConfig(config, undefined, {}), PRIMARY_NODE_UUID, tasks)).toMatchObject({
      displayCount: 3,
      resolvedTaskIds: [101, 202, 303],
      coverage: 'full',
    })
  })

  test('keeps node overrides count-free and rejects partial strict bulk assignment', () => {
    const config = v3Config()
    const tasks = [
      { id: 101, clients: [PRIMARY_NODE_UUID, NODE_2] },
      { id: 202, clients: [PRIMARY_NODE_UUID, NODE_2] },
      { id: 303, clients: [PRIMARY_NODE_UUID] },
    ]
    const rejected = previewStrictNodeCardPingBulkAssignment(
      config,
      [PRIMARY_NODE_UUID, NODE_2],
      [101, 202, 303],
      tasks,
    )
    expect(rejected).toMatchObject({
      displayCount: 3,
      canApply: false,
      invalidTaskIds: [303],
      excludedNodeUuids: [NODE_2],
    })

    config.global.threeNetworkEnabled = false
    const applicable = previewStrictNodeCardPingBulkAssignment(
      config,
      [PRIMARY_NODE_UUID, NODE_2],
      [101, null, null],
      tasks,
    )
    expect(applicable).toMatchObject({ displayCount: 1, canApply: true, invalidTaskIds: [] })
  })

  test('default v3 remains explicit, safe, and does not silently enable a second task', () => {
    expect(createDefaultNodeCardPingConfig()).toEqual({
      schemaVersion: 3,
      global: { threeNetworkEnabled: false, taskIds: [null, null, null] },
      nodes: {},
    })
  })
})

test.describe('Ping v3 Chinese configuration and task-strip behavior', () => {
  test('uses four Chinese main filters, composes search, preserves selection, and exposes exact coverage badges', async ({ page }) => {
    await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCount: 4,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config({
        nodes: {
          [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [101, 202, 303] },
          [NODE_3]: { mode: 'custom', taskIds: [101, 202, 999] },
          [NODE_4]: { mode: 'custom', taskIds: [101, 202, null] },
        },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', thirdSharedTask: true },
    })
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('ping-center-global-config')).toBeVisible()

    const filter = page.getByTestId('ping-center-settings-filter')
    await expect(filter.locator('button')).toHaveCount(4)
    await expect(filter).toContainText('全部')
    await expect(filter).toContainText('继承全局')
    await expect(filter).toContainText('单独配置')
    await expect(filter).toContainText('需要处理')
    await expect(page.getByTestId('ping-center-settings')).not.toContainText(/\b(?:inherit|custom|full|partial|none|invalid|Slot)\b/u)

    await filter.locator('[data-filter="custom"]').click()
    await expect(page.locator('[data-testid^="node-binding-row-"]')).toHaveCount(3)
    await page.getByTestId('ping-center-settings-search').fill('主控')
    await expect(page.locator('[data-testid^="node-binding-row-"]')).toHaveCount(1)
    await page.getByTestId('ping-center-filter-select-all').click()
    await expect(page.getByTestId('ping-center-settings')).toContainText('已选 1 台')

    await page.getByTestId('ping-center-settings-search').fill('')
    await filter.locator('[data-filter="all"]').click()
    await expect(page.locator('[data-testid^="node-binding-row-"]')).toHaveCount(4)
    await expect(page.getByTestId('ping-center-settings')).toContainText('已选 1 台')

    await page.getByTestId('ping-center-coverage-invalid').click()
    await expect(page.locator('[data-testid^="node-binding-row-"]')).toHaveCount(1)
    await expect(page.getByTestId(`node-binding-row-${NODE_3}`)).toBeVisible()
    await expect(page.getByTestId('ping-center-settings')).toContainText('精确状态：配置失效')

    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  })

  test('standard three-network switch updates one draft state, preserves slots, and persists only on save', async ({ page }) => {
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCount: 3,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config()),
      nodeCardPingFixture: { metric: 'valid', thirdSharedTask: true },
    })
    await page.goto('/?view=pingsettings&pingtab=config')
    const toggle = page.getByTestId('ping-center-three-network-switch')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveValue('202')
    await expect(page.getByTestId('ping-center-global-slot-3')).toHaveValue('303')
    await expect(page.getByTestId('ping-center-global-count')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-three-network-state')).toHaveText('已开启')
    expect(fixture.getThemeSaveCount()).toBe(0)

    await page.getByTestId('ping-center-three-network-label').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('ping-center-three-network-state')).toHaveText('已关闭')
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-global-slot-3')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-current-state')).toContainText('有未保存修改')
    expect(fixture.getThemeSaveCount()).toBe(0)

    await page.getByTestId('ping-center-three-network-label').click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveValue('202')
    await expect(page.getByTestId('ping-center-global-slot-3')).toHaveValue('303')

    await toggle.focus()
    await toggle.press('Space')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.press('Enter')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(fixture.getThemeSaveCount()).toBe(0)

    await page.getByTestId('ping-center-save-preview').click()
    await page.getByTestId('ping-center-save-confirm').click()
    await expect.poll(() => fixture.getThemeSaveCount()).toBe(1)
    expect(inspectNodeCardPingConfig(fixture.getSavedThemeSettings().nodeCardPingDisplayConfigV3).config?.global).toEqual({
      threeNetworkEnabled: false,
      taskIds: [101, 202, 303],
    })

    await page.reload()
    await expect(page.getByTestId('ping-center-three-network-switch')).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveCount(0)
    await page.getByTestId('ping-center-three-network-switch').click()
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveValue('202')
    await expect(page.getByTestId('ping-center-global-slot-3')).toHaveValue('303')

    await page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`).getByRole('button', { name: '单节点配置' }).click()
    await expect(page.getByTestId('ping-center-node-count')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-node-mode-inherit')).toContainText('继承全局')
    await expect(page.getByTestId('ping-center-node-mode-custom')).toContainText('单独配置')
    await expect(page.getByTestId('ping-center-node-editor')).not.toContainText('恢复继承')
    await expect(page.getByTestId('ping-center-node-clear')).toHaveCount(0)
    await page.getByTestId('ping-center-node-mode-custom').click()
    await expect(page.getByTestId('ping-center-node-slot-1')).toBeVisible()
    await expect(page.getByTestId('ping-center-node-slot-2')).toBeVisible()
    await expect(page.getByTestId('ping-center-node-slot-3')).toBeVisible()
  })

  for (const geometryCase of NODE_CARD_PING_GEOMETRY) {
    test(`${geometryCase.size} cards keep 20 fixed buckets across low and high values, hover, focus, and tooltip`, async ({ page, isMobile }) => {
      await page.setViewportSize({ width: geometryCase.viewportWidth, height: 900 })
      const fixture = await installKomariFixture(page, {
        hideEarth: true,
        nodeCount: 3,
        nodeCardSize: geometryCase.size,
        nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config()),
        nodeCardPingFixture: {
          metric: 'valid',
          legacy: 'valid',
          sampleCount: 20,
          thirdSharedTask: true,
          task202Name: 'Fixture Hong Kong latency route with an intentionally long readable name',
          task202Latency: 159,
          task202Loss: 25,
        },
      })
      await page.goto('/')
      const card = page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"]`)
      const strips = card.locator('[data-node-ping-task-id]')
      await expect(strips).toHaveCount(3)
      expect(await strips.evaluateAll((elements, size) => elements.every(element => element.getAttribute('data-node-ping-size') === size), geometryCase.size)).toBe(true)

      const lowValueStrip = card.locator('[data-node-ping-task-id="101"]')
      const highValueStrip = card.locator('[data-node-ping-task-id="202"]')
      await expect(highValueStrip).toHaveAttribute('data-node-ping-status', 'data')
      const lowValueGeometry = await readTaskStripGeometry(lowValueStrip)
      const highValueGeometry = await readTaskStripGeometry(highValueStrip)
      expectFixedRailGeometry(lowValueGeometry, geometryCase.thickness, geometryCase.rowGap, geometryCase.bucketGap)
      expectFixedRailGeometry(highValueGeometry, geometryCase.thickness, geometryCase.rowGap, geometryCase.bucketGap)
      expect(highValueGeometry.latency.buckets[0]!.wrapper.width).toBeCloseTo(lowValueGeometry.latency.buckets[0]!.wrapper.width, 1)
      const highValueDataBuckets = highValueStrip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-state="data"]')
      await expect(highValueDataBuckets).not.toHaveCount(0)
      expect(await highValueDataBuckets.evaluateAll(elements => elements.every(element => element.getAttribute('data-node-ping-severity') === 'moderate'))).toBe(true)
      await expect(highValueStrip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-severity="critical"]')).toHaveCount(0)

      const bucket = highValueDataBuckets.first()
      const beforeInteraction = await readTaskStripGeometry(highValueStrip)
      if (!isMobile) {
        await bucket.hover()
        await expect(activeDataTooltip(page)).toBeVisible()
        expectFixedRailGeometry(await readTaskStripGeometry(highValueStrip), geometryCase.thickness, geometryCase.rowGap, geometryCase.bucketGap)
      }
      await bucket.focus()
      await expect(activeDataTooltip(page)).toBeVisible()
      await expect(activeDataTooltip(page)).toContainText('延迟159 ms')
      await expect(activeDataTooltip(page)).toContainText('丢包25.0%')
      expectFixedRailGeometry(await readTaskStripGeometry(highValueStrip), geometryCase.thickness, geometryCase.rowGap, geometryCase.bucketGap)
      expect(await readTaskStripGeometry(highValueStrip)).toEqual(beforeInteraction)
      await page.evaluate(() => document.documentElement.classList.add('dark'))
      expectFixedRailGeometry(await readTaskStripGeometry(highValueStrip), geometryCase.thickness, geometryCase.rowGap, geometryCase.bucketGap)
      await page.evaluate(() => document.documentElement.classList.remove('dark'))

      fixture.setNodeCardPingDisplayConfigV3(serializeNodeCardPingConfig(v3Config({
        global: { threeNetworkEnabled: false, taskIds: [202, null, null] },
      })))
      await page.reload()
      const singleTaskStrip = page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"] [data-node-ping-task-id="202"]`)
      await expect(page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"] [data-node-ping-task-id]`)).toHaveCount(1)
      expectFixedRailGeometry(await readTaskStripGeometry(singleTaskStrip), geometryCase.thickness, geometryCase.rowGap, geometryCase.bucketGap)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    })
  }

  test('pending, missing, error, and invalid rails reuse the same fixed bucket DOM and geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const fixture = await installKomariFixture(page, {
      hideEarth: true,
      fakeTimers: true,
      nodeCount: 3,
      nodeCardSize: 'compact',
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config({
        nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [202, 999, 303] } },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', sampleCount: 20, thirdSharedTask: true },
    })
    const releasePending = fixture.pausePingResponses()
    await page.goto('/')
    const card = page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"]`)
    const pendingStrip = card.locator('[data-node-ping-task-id="202"]')
    await expect(pendingStrip).toHaveAttribute('data-node-ping-status', 'pending')
    const pendingBucket = pendingStrip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar]').first()
    await pendingBucket.focus()
    await expect(activeDataTooltip(page)).toContainText('等待采样')
    expectFixedRailGeometry(await readTaskStripGeometry(pendingStrip), 4, 9, 2)
    const invalidStrip = card.locator('[data-node-ping-invalid-slot="2"]')
    await expect(invalidStrip.locator('[data-node-ping-state="invalid"]')).toHaveCount(40)
    expectFixedRailGeometry(await readTaskStripGeometry(invalidStrip), 4, 9, 2)

    releasePending()
    await expect(pendingStrip).toHaveAttribute('data-node-ping-status', 'data')
    fixture.setNodeCardPingFixture({ metric: 'selected-empty', legacy: 'selected-empty' })
    await page.reload()
    await expect(pendingStrip.locator('[data-node-ping-state="confirmed-missing"]')).not.toHaveCount(0)
    const missingBucket = pendingStrip.locator('[data-node-ping-state="confirmed-missing"]').first()
    await missingBucket.focus()
    await expect(activeDataTooltip(page)).toContainText('暂无采样')
    expectFixedRailGeometry(await readTaskStripGeometry(pendingStrip), 4, 9, 2)

    fixture.setNodeCardPingFixture({ metric: 'error', legacy: 'error' })
    await page.reload()
    await expect(pendingStrip.locator('[data-node-ping-state="error"]')).toHaveCount(40)
    const errorBucket = pendingStrip.locator('[data-node-ping-state="error"]').first()
    await errorBucket.focus()
    await expect(activeDataTooltip(page)).toContainText('更新失败')
    expectFixedRailGeometry(await readTaskStripGeometry(pendingStrip), 4, 9, 2)
  })

  test('renders 158, 170, and 180 ms as moderate or elevated while reserving critical for over 200 ms', async ({ page }) => {
    const latencies = [158, 170, 180, 201]
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCount: 3,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config({
        global: { threeNetworkEnabled: false, taskIds: [202, null, null] },
      })),
      nodeCardPingFixture: {
        metric: 'valid',
        legacy: 'valid',
        task202Latency: 201,
        task202Loss: 0,
        metricSamples: Array.from({ length: 20 }, (_, index) => ({
          time: Date.parse('2026-07-25T11:04:30.000Z') + index * 180_000,
          latency: latencies[index % latencies.length]!,
          loss: 0,
          latencyCount: 1,
          lossCount: 1,
          taskId: 202,
        })),
      },
    })
    await page.goto('/')
    const strip = page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"] [data-node-ping-task-id="202"]`)
    const dataBuckets = strip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-state="data"]')
    await expect(dataBuckets).not.toHaveCount(0)
    await expect(dataBuckets.filter({ has: page.locator('[data-node-ping-bucket-fill]') })).not.toHaveCount(0)
    await expect(strip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-severity="moderate"]')).not.toHaveCount(0)
    await expect(strip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-severity="elevated"]')).not.toHaveCount(0)
    await expect(strip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-severity="critical"]')).not.toHaveCount(0)
    const elevatedBucket = strip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar][data-node-ping-severity="elevated"]').first()
    await elevatedBucket.focus()
    await expect(activeDataTooltip(page)).toContainText(/延迟(170|180) ms/u)
    await expect(activeDataTooltip(page)).toContainText('丢包0.0%')
  })

  test('tooltip, focus, responsive resize, and theme styling do not trigger extra Ping RPCs', async ({ page, isMobile }) => {
    const pingRequests: string[] = []
    page.on('request', (request) => {
      const body = request.postData() ?? ''
      const rpcPath = new URL(request.url()).pathname.replace(/\/+$/u, '')
      if (rpcPath.endsWith('/rpc2') && (/ping\.|PingMetric|PingRecords/u).test(body))
        pingRequests.push(body)
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCount: 12,
      nodeCardSize: 'compact',
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config()),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', sampleCount: 20, thirdSharedTask: true },
    })
    await page.goto('/')
    const strips = page.locator('[data-node-ping-task-id]')
    await expect(strips).toHaveCount(36)
    await expect(page.locator('[data-node-ping-status="data"]')).toHaveCount(36)
    expect(pingRequests.length).toBeGreaterThan(0)
    const requestBaseline = pingRequests.length

    const bucket = strips.first().locator('[data-node-ping-bars="latency"] > [data-node-ping-bar]').nth(4)
    if (!isMobile) {
      await bucket.hover()
      await expect(activeDataTooltip(page)).toBeVisible()
    }
    await bucket.focus()
    await expect(activeDataTooltip(page)).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => document.documentElement.classList.toggle('dark'))
    await page.waitForTimeout(250)
    expect(pingRequests).toHaveLength(requestBaseline)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  })

  test('inherit mode is cancel-safe, deletes the override only on completion, survives reload, and rejects failed saves', async ({ page }) => {
    const initialConfig = v3Config({
      nodes: {
        [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [101, 202, 303] },
        [NODE_2]: { mode: 'custom', taskIds: [101, 202, 303] },
      },
    })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCount: 3,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(initialConfig),
      nodeCardPingFixture: { metric: 'valid', thirdSharedTask: true },
    })
    await page.goto('/?view=pingsettings&pingtab=config')
    const primaryRow = page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)
    await primaryRow.getByRole('button', { name: '单节点配置' }).click()
    await page.getByTestId('ping-center-node-mode-inherit').click()
    await page.getByTestId('ping-center-node-editor').getByRole('button', { name: '取消', exact: true }).click()
    await expect(primaryRow).toContainText('单独配置')
    expect(fixture.getThemeSaveCount()).toBe(0)

    await primaryRow.getByRole('button', { name: '单节点配置' }).click()
    await page.getByTestId('ping-center-node-mode-inherit').click()
    await expect(page.getByTestId('ping-center-node-slot-1')).toHaveCount(0)
    await page.getByTestId('ping-center-node-complete').click()
    await expect(primaryRow).toContainText('继承全局')
    expect(fixture.getThemeSaveCount()).toBe(0)
    await page.getByTestId('ping-center-save-preview').click()
    await page.getByTestId('ping-center-save-confirm').click()
    await expect.poll(() => fixture.getThemeSaveCount()).toBe(1)
    expect(inspectNodeCardPingConfig(fixture.getSavedThemeSettings().nodeCardPingDisplayConfigV3).config?.nodes[PRIMARY_NODE_UUID]).toBeUndefined()
    await page.reload()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toContainText('继承全局')

    const secondRow = page.getByTestId(`node-binding-row-${NODE_2}`)
    await secondRow.getByRole('button', { name: '单节点配置' }).click()
    await page.getByTestId('ping-center-node-mode-inherit').click()
    await page.getByTestId('ping-center-node-complete').click()
    await page.getByTestId('ping-center-save-preview').click()
    fixture.setAdminAccess('forbidden')
    await page.getByTestId('ping-center-save-confirm').click()
    await expect(page.getByTestId('node-ping-binding-forbidden')).toBeVisible()
    expect(fixture.getThemeSaveCount()).toBe(1)
    expect(inspectNodeCardPingConfig(fixture.getSavedThemeSettings().nodeCardPingDisplayConfigV3).config?.nodes[NODE_2]?.mode).toBe('custom')
  })

  test('100 percent loss shows one explicit loss value with unreachable latency and fixed rails', async ({ page }) => {
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCount: 3,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config({
        global: { threeNetworkEnabled: false, taskIds: [202, null, null] },
      })),
      nodeCardPingFixture: {
        metric: 'valid',
        legacy: 'valid',
        task202Latency: null,
        task202Loss: 100,
        metricSamples: Array.from({ length: 20 }, (_, index) => ({
          time: Date.parse('2026-07-25T11:04:30.000Z') + index * 180_000,
          latency: null,
          loss: 1,
          latencyCount: 0,
          lossCount: 1,
          taskId: 202,
        })),
      },
    })
    await page.goto('/')
    const strip = page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"] [data-node-ping-task-id="202"]`)
    await expect(strip).toHaveAttribute('data-node-ping-status', 'data')
    await expect(strip.locator('[data-node-ping-summary="latency"]')).toHaveText('延迟-')
    await expect(strip.locator('[data-node-ping-summary="loss"]')).toHaveText('丢包100%')
    await expect(strip.getByText('100% 丢包', { exact: true })).toHaveCount(0)
    await expect(strip).toHaveAttribute('data-node-ping-outage', 'true')
    const latencyBars = strip.locator('[data-node-ping-bars="latency"] > [data-node-ping-bar]')
    const lossBars = strip.locator('[data-node-ping-bars="loss"] > [data-node-ping-bar]')
    await expect(latencyBars).toHaveCount(20)
    await expect(lossBars).toHaveCount(20)
    expect(await latencyBars.evaluateAll(elements => elements.every(element => element.getAttribute('data-node-ping-state') === 'unreachable'))).toBe(true)
    expect(await latencyBars.evaluateAll(elements => elements.every(element => element.getAttribute('data-node-ping-severity') === 'unreachable'))).toBe(true)
    expect(await lossBars.evaluateAll(elements => elements.every(element => element.getAttribute('data-node-ping-state') === 'data'))).toBe(true)
    expect(await lossBars.evaluateAll(elements => elements.every(element => element.getAttribute('data-node-ping-severity') === 'unreachable'))).toBe(true)
    const unreachableBucket = latencyBars.first()
    await unreachableBucket.focus()
    await expect(activeDataTooltip(page)).toContainText('延迟不可达')
    await expect(activeDataTooltip(page)).toContainText('丢包100%')
    const geometry = await readTaskStripGeometry(strip)
    expectFixedRailGeometry(geometry, 4, 9, 2)
  })

  test('keeps mixed full, partial, and invalid triple-mode cards equal height', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCount: 4,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config({
        nodes: {
          [PRIMARY_NODE_UUID]: { mode: 'custom', taskIds: [101, 202, 303] },
          [NODE_2]: { mode: 'custom', taskIds: [101, 202, null] },
          [NODE_3]: { mode: 'custom', taskIds: [101, 999, 303] },
        },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', thirdSharedTask: true },
    })
    await page.goto('/')

    const cards = await Promise.all([PRIMARY_NODE_UUID, NODE_2, NODE_3].map(async uuid => page.locator(`[data-node-card-uuid="${uuid}"]`).evaluate((element) => {
      const card = element.getBoundingClientRect()
      const group = element.querySelector<HTMLElement>('[data-node-ping-display-count]')?.getBoundingClientRect()
      return { cardHeight: card.height, groupHeight: group?.height ?? 0 }
    })))
    expect(new Set(cards.map(item => Math.round(item.cardHeight))).size).toBe(1)
    expect(new Set(cards.map(item => Math.round(item.groupHeight))).size).toBe(1)
    await expect(page.locator(`[data-node-card-uuid="${NODE_2}"] [data-node-ping-display-count]`)).toContainText('未配置')
    await expect(page.locator(`[data-node-card-uuid="${NODE_3}"] [data-node-ping-display-count]`)).toContainText('配置失效')
  })

  test('warns before leaving dirty configuration and supports continuing or discarding', async ({ page }) => {
    await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCount: 3,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config()),
      nodeCardPingFixture: { metric: 'valid', thirdSharedTask: true },
    })
    await page.goto('/?view=pingsettings&pingtab=config')
    await page.getByTestId('ping-center-three-network-switch').click()
    await page.getByTestId('ping-center-close').click()
    await expect(page.getByTestId('ping-center-leave-confirm')).toBeVisible()

    await page.getByRole('button', { name: '继续编辑' }).click()
    await expect(page).toHaveURL(/view=pingsettings/)
    await expect(page.getByTestId('ping-center-leave-confirm')).toHaveCount(0)

    await page.getByTestId('ping-center-close').click()
    await page.getByTestId('ping-center-leave-discard').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('ping-center-settings')).toHaveCount(0)
  })
})
