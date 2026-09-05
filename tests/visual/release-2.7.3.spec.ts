import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { installKomariFixture, PRIMARY_NODE_UUID } from './fixtures/komari'

const config = JSON.stringify({ schemaVersion: 3, global: { threeNetworkEnabled: true, taskIds: [101, 202, 303] }, nodes: {} })
const cellSelector = 'button[aria-label="打开延迟和丢包监测"]'

async function contrast(tooltip: Locator) {
  return tooltip.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d')!
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data)
    }
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map((value) => {
      const s = value / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
    const bg = rgba(getComputedStyle(element).backgroundColor)
    const bgL = luminance(bg)
    const items = Array.from(element.querySelectorAll<HTMLElement>(':scope > div.grid > span'))
    const bounds = element.getBoundingClientRect()
    return {
      alpha: bg[3],
      opacity: getComputedStyle(element).opacity,
      left: bounds.left,
      right: bounds.right,
      viewport: innerWidth,
      items: items.map((item) => {
        const fgL = luminance(rgba(getComputedStyle(item).color))
        return { text: item.textContent, ratio: (Math.max(bgL, fgL) + 0.05) / (Math.min(bgL, fgL) + 0.05), overflow: item.scrollWidth > item.clientWidth }
      }),
    }
  })
}

test('statistics Tooltip has paired contrast in both themes, including live theme changes and deselected tasks', async ({ page, isMobile }, testInfo) => {
  await installKomariFixture(page, { hideEarth: true, nodeCardPingFixture: { metric: 'valid' } })
  await page.route('**/rpc2', async (route) => {
    const payload = route.request().postDataJSON() as { id: string, method: string, params: { start: string, end: string } }
    if (payload.method !== 'public:getPingMetricStats')
      return route.fallback()
    // Complete optional statistics for the existing constant 200 ms / 25% fixture.
    await route.fulfill({ json: { jsonrpc: '2.0', id: payload.id, result: {
      start: payload.params.start,
      end: payload.params.end,
      interval_seconds: 60,
      count: 1,
      stats: [{ entity_id: PRIMARY_NODE_UUID, task_id: '202', tags: { task_id: '202' }, name: 'Fixture Hong Kong', type: 'tcp', interval: 60, min: 200, max: 200, avg: 200, latest: 200, p50: 200, p99: 200, p99_p50_ratio: 0, stddev: 0, total: 4, valid: 3, loss: 25, loss_approximate: false }],
    } } })
  })
  await page.goto(`/instance/${PRIMARY_NODE_UUID}`)
  const task = page.locator('[data-ping-chart-task-id="202"]')
  const trigger = task.locator('button')
  await expect(task).toBeVisible()
  await task.click()
  await expect(task).toHaveClass(/opacity-30/)
  if (isMobile)
    await trigger.tap()
  else
    await trigger.hover()
  const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: '标准差' })
  await expect(tooltip).toBeVisible()
  const statistics = tooltip.locator(':scope > div.grid')
  const values = await statistics.textContent()
  const measurements = []
  for (const mode of ['dark', 'light']) {
    // Dispatch the existing theme button without moving focus away from the open Portal.
    await page.getByRole('button', { name: mode === 'dark' ? '深色模式' : '浅色模式', exact: true }).dispatchEvent('click')
    await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /dark/ : /^(?!.*\bdark\b)/)
    await expect(tooltip).toBeVisible()
    await expect(statistics).toHaveText(values!)
    await expect(tooltip).toHaveCSS('opacity', '1')
    const result = await contrast(tooltip)
    measurements.push({ mode, ...result })
    expect(result.items).toHaveLength(24)
    expect(result.alpha).toBe(255)
    expect(result.opacity).toBe('1')
    expect(result.left).toBeGreaterThanOrEqual(0)
    expect.soft(result.right).toBeLessThanOrEqual(result.viewport + 1)
    for (const item of result.items) {
      expect.soft(item.ratio, `${mode}: ${item.text}`).toBeGreaterThanOrEqual(4.5)
      expect(item.overflow, item.text ?? '').toBe(false)
    }
    await expect(task).toHaveClass(/opacity-30/)
    await tooltip.screenshot({ path: testInfo.outputPath(`statistics-${mode}.png`) })
  }
  await testInfo.attach('contrast', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  if (!isMobile) {
    await page.keyboard.press('Escape')
    await page.mouse.move(0, 0)
    await trigger.focus()
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
  }
})

async function watchLeavingList(page: Page) {
  await page.evaluate((selector) => {
    const cells = Array.from(document.querySelectorAll<HTMLElement>(selector))
    const read = (cell: HTMLElement) => Array.from(cell.querySelectorAll('.grid > span')).map(bar => [bar.getAttribute('title'), bar.firstElementChild?.className])
    const before = cells.map(read)
    const report = { frames: 0, mutations: 0, disabledWhileConnected: false, changed: [] as number[], detached: false }
    Object.assign(window, { listLeaveReport: report })
    const observe = () => {
      if (location.pathname === '/')
        return
      cells.forEach((cell, index) => {
        if (cell.isConnected && cell.dataset.pingListEnabled === 'false')
          report.disabledWhileConnected = true
        if (cell.isConnected && JSON.stringify(read(cell)) !== JSON.stringify(before[index]) && !report.changed.includes(index))
          report.changed.push(index)
      })
    }
    const observer = new MutationObserver(() => {
      report.mutations++
      observe()
    })
    observer.observe(document.body, { subtree: true, attributes: true, childList: true })
    const frame = () => {
      if (!cells.some(cell => cell.isConnected)) {
        report.detached = true
        observer.disconnect()
        return
      }
      if (location.pathname !== '/')
        report.frames++
      observe()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, cellSelector)
}

for (const strategy of ['multi', 'legacy'] as const) {
  test(`list navigation preserves actual ${strategy} bars during leave and resumes on return`, async ({ page }) => {
    const fixture = await installKomariFixture(page, {
      viewMode: 'list',
      hideEarth: true,
      disablePageAnimation: false,
      nodeCount: 3,
      ...(strategy === 'multi' ? { nodeCardPingDisplayConfigV3: config } : { nodeCardPingTaskBindings: JSON.stringify({ [PRIMARY_NODE_UUID]: 202 }) }),
      nodeCardPingFixture: { metric: 'valid', thirdSharedTask: true },
    })
    await page.goto('/')
    const row = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情', exact: true })
    const cell = row.locator(cellSelector)
    await expect(cell.locator('.grid > span')).toHaveCount(40)
    await expect.poll(() => cell.locator('.grid > span > span[class*="emerald"]').count()).toBeGreaterThan(0)
    await watchLeavingList(page)
    const beforeRequests = fixture.timeline.length
    await row.dispatchEvent('click')
    await expect(page).toHaveURL(`/instance/${PRIMARY_NODE_UUID}`)
    await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
    const report = await page.evaluate(() => (window as unknown as { listLeaveReport: { changed: number[], frames: number, detached: boolean, disabledWhileConnected: boolean } }).listLeaveReport)
    expect(report.detached).toBe(true)
    expect(report.disabledWhileConnected).toBe(true)
    expect(report.frames).toBeGreaterThan(0)
    expect(report.changed).toEqual([])
    // A detail query is untagged and for this node; the stopped list must not
    // add tagged/batch home refreshes, including on a network-resume signal.
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForTimeout(350)
    const requests = fixture.timeline.slice(beforeRequests).filter(entry => entry.method === 'public:queryMetrics')
    expect(requests.every(entry => !entry.params.tags && !entry.params.entity_ids)).toBe(true)
    await page.goBack()
    await expect(row).toBeVisible()
    await expect.poll(() => cell.locator('.grid > span > span[class*="emerald"]').count()).toBeGreaterThan(0)
  })
}

test('cold list has no invented history and active/returned lists accept updated real samples', async ({ page }) => {
  const fixture = await installKomariFixture(page, {
    viewMode: 'list',
    hideEarth: true,
    nodeCount: 1,
    fakeTimers: true,
    nodeCardPingDisplayConfigV3: JSON.stringify({ schemaVersion: 3, global: { threeNetworkEnabled: false, taskIds: [202, null, null] }, nodes: {} }),
    nodeCardPingFixture: { metric: 'valid', task202Latency: 200, task202Loss: 25 },
  })
  const resume = fixture.pausePingResponses()
  await page.goto('/')
  const cell = page.locator(cellSelector).first()
  await expect(cell.locator('.grid > span')).toHaveCount(40)
  await expect(cell.locator('.grid > span > span[class*="emerald"]')).toHaveCount(0)
  await expect(cell).toContainText('延迟 -')
  resume()
  await expect(cell).toContainText('延迟 200 ms')
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情', exact: true }).dispatchEvent('click')
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
  await page.goBack()
  await expect(cell).toContainText('延迟 200 ms')
  fixture.setNodeCardPingFixture({ task202Latency: null, task202Loss: 100 })
  await fixture.advanceTime(75_000)
  await expect(cell).toContainText('丢包 100.0%')
  await expect(cell).toContainText('延迟 -')
})

test('card navigation returns to the existing real snapshot without changing the card path', async ({ page }) => {
  await installKomariFixture(page, { hideEarth: true, nodeCount: 1, nodeCardPingTaskBindings: JSON.stringify({ [PRIMARY_NODE_UUID]: 202 }), nodeCardPingFixture: { metric: 'valid' } })
  await page.goto('/')
  const card = page.locator('.node-card').first()
  await expect(card.locator('[data-node-ping-bar]')).toHaveCount(40)
  await expect(card).toContainText('200')
  await card.click()
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
  await page.goBack()
  await expect(card).toBeVisible()
  await expect(card).toContainText('200')
  await expect(card.locator('[data-node-ping-bar]')).toHaveCount(40)
})
