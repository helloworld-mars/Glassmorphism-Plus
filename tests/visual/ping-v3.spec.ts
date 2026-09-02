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

  test('three-network switch hides and restores task 2/3 without a two-task control', async ({ page }) => {
    await installKomariFixture(page, {
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

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-global-slot-3')).toHaveCount(0)
    await toggle.click()
    await expect(page.getByTestId('ping-center-global-slot-2')).toHaveValue('202')
    await expect(page.getByTestId('ping-center-global-slot-3')).toHaveValue('303')

    await page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`).getByRole('button', { name: '单节点配置' }).click()
    await expect(page.getByTestId('ping-center-node-count')).toHaveCount(0)
    await expect(page.getByTestId('ping-center-node-mode-inherit')).toContainText('继承全局')
    await expect(page.getByTestId('ping-center-node-mode-custom')).toContainText('单独配置')
    await expect(page.getByTestId('ping-center-node-clear')).toContainText('恢复继承')
    await page.getByTestId('ping-center-node-mode-custom').click()
    await expect(page.getByTestId('ping-center-node-slot-1')).toBeVisible()
    await expect(page.getByTestId('ping-center-node-slot-2')).toBeVisible()
    await expect(page.getByTestId('ping-center-node-slot-3')).toBeVisible()
  })

  test('100 percent loss shows no latency value or green latency rail', async ({ page }) => {
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCount: 3,
      nodeCardPingDisplayConfigV3: serializeNodeCardPingConfig(v3Config({
        global: { threeNetworkEnabled: false, taskIds: [202, null, null] },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', task202Latency: 200, task202Loss: 100 },
    })
    await page.goto('/')
    const strip = page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"] [data-node-ping-task-id="202"]`)
    await expect(strip).toHaveAttribute('data-node-ping-status', 'data')
    await expect(strip).toContainText('100% 丢包')
    await expect(strip).toContainText('-')
    const latencyBars = strip.locator('[data-node-ping-trend="latency"] > span:last-child > span')
    await expect(latencyBars).toHaveCount(20)
    expect(await latencyBars.evaluateAll(elements => elements.some(element => element.className.includes('emerald')))).toBe(false)
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
