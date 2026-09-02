import type { Page, Route } from '@playwright/test'

const FIXED_NOW = '2026-07-25T12:00:00.000Z'
const GIB = 1024 ** 3
const TIB = 1024 ** 4

const REGION_FIXTURES = [
  { code: 'US', name: '主控-洛杉矶', cpu: 'Intel Xeon Gold 6152 CPU @ 2.10GHz' },
  { code: 'HK', name: '香港边缘节点-超长名称布局测试', cpu: 'AMD EPYC 7551 32-Core Processor' },
  { code: 'JP', name: '东京-高负载', cpu: 'AMD EPYC 7B13 64-Core Processor' },
  { code: 'SG', name: '新加坡-A100', cpu: 'AMD EPYC 9654 96-Core Processor' },
  { code: 'DE', name: '法兰克福-2680', cpu: 'Intel Xeon CPU E5-2680 v4 @ 2.40GHz' },
  { code: 'GB', name: '伦敦-离线归档', cpu: 'Intel N100' },
  { code: 'TW', name: '台北-流量预警', cpu: 'Ampere Altra Max M128-30' },
  { code: 'AU', name: '悉尼-IPv6', cpu: 'AMD Ryzen 9 9950X 16-Core Processor' },
] as const

export interface VisualFixtureOptions {
  dark?: boolean
  earthRenderer?: 'cobe' | 'realistic' | 'tiled'
  colorVisionFriendly?: boolean
  viewMode?: 'card' | 'list'
  nodeCardSize?: 'mini' | 'compact' | 'comfortable' | 'large'
  freePriceNode?: boolean
  hideEarth?: boolean
  expiryThresholds?: boolean
  invalidExpiry?: boolean
  missingCpuMetricHistory?: boolean
  nodeCardPingTaskBindings?: string
  nodeCardPingDisplayConfigV2?: string
  nodeCardPingFixture?: NodeCardPingFixture
  nodeCount?: number
  clockNow?: string
  fakeTimers?: boolean
  preserveStorageOnReload?: boolean
  adminAccess?: 'admin' | 'guest' | 'forbidden'
  hidePingTaskBindingEntry?: boolean
  siteName?: string
  disablePageAnimation?: boolean
  pingRecordPreserveTime?: number
  generalCardPreset?: string
  generalCardKeys?: string[]
  loadMetricFixture?: LoadMetricFixture
}

export interface LoadMetricFixture {
  rejectPerMetricAggregation?: boolean
  delayMsByHours?: Record<string, number>
  cpuValueByHours?: Record<string, number>
}

export interface NodeCardPingFixture {
  metric?: 'valid' | 'error' | 'malformed' | 'selected-empty'
  legacy?: 'valid' | 'error' | 'selected-empty'
  metricErrorUuids?: string[]
  /** Fail only NodeCard-style tagged raw Metric queries; Detail remains untagged. */
  metricErrorWhenTaggedTaskIds?: number[]
  legacyErrorUuids?: string[]
  legacyEmptyUuids?: string[]
  sampleCount?: number
  sampleTimes?: Array<string | number>
  /**
   * Deterministic ingestion timeline for the v1.3.3 NodeCard regression.
   * `sampleAt` is the real probe timestamp; the sample only becomes visible
   * to an RPC response at `apiVisibleAt`. It intentionally does not model a
   * browser cache or a persisted storage state.
   */
  sampleSchedule?: NodeCardPingScheduledSample[]
  /** Exact paired Metric rollups for long-range chart/domain regressions. */
  metricSamples?: PingMetricFixtureSample[]
  /** Range-dependent rollup responses used to emulate Komari's selected tier. */
  metricRangeSamples?: PingMetricRangeFixture[]
  /** Optional real-time delay by rounded requested hours for stale-response tests. */
  metricQueryDelayMsByHours?: Record<string, number>
  metricQueryOmitTaskIds?: number[]
  task202Exists?: boolean
  task202Assigned?: boolean
  task202Latency?: number | null
  task202Loss?: number
  /** Make task 303 available to every fixture node for v2 three-task layouts. */
  thirdSharedTask?: boolean
  /** Sanitized shape observed in Komari 1.4.1 HAR responses. */
  komari141HarShape?: boolean
}

export interface PingMetricFixtureSample {
  time: string | number
  latency: number | null
  /** Metric loss ratio (0..1), not a percentage. */
  loss: number | null
  latencyCount?: number
  lossCount?: number
  taskId?: number
  client?: string
}

export interface PingMetricRangeFixture {
  minHours?: number
  maxHours?: number
  intervalSeconds: number
  samples: PingMetricFixtureSample[]
}

export interface NodeCardPingScheduledSample {
  sampleAt: string | number
  apiVisibleAt: string | number
  latency: number | null
  loss: number
  taskId?: number
  client?: string
}

export interface PingRpcTimelineSample {
  sampleAt: number
  apiVisibleAt: number
  latency: number | null
  loss: number
  taskId: number
  client: string
}

export interface PingRpcTimelineEntry {
  method: string
  requestAt: number
  responseAt: number
  params: Record<string, unknown>
  /** The real scheduled samples contained in this RPC response. */
  responseSamples: PingRpcTimelineSample[]
}

export interface KomariFixtureController {
  setSiteName: (value: string) => void
  setNodeCardPingTaskBindings: (value: string) => void
  setNodeCardPingDisplayConfigV2: (value: string) => void
  setThemeSetting: (key: string, value: unknown) => void
  setAdminAccess: (value: 'admin' | 'guest' | 'forbidden') => void
  setNodeCardPingFixture: (value: Partial<NodeCardPingFixture>) => void
  getSavedThemeSettings: () => Record<string, unknown>
  getThemeSaveCount: () => number
  pausePingResponses: () => () => void
  pauseAdminResponses: () => () => void
  advanceTime: (milliseconds: number) => Promise<void>
  /** In-memory only; no HAR, storage state, or browser profile is produced. */
  timeline: PingRpcTimelineEntry[]
  now: () => number
}

interface FixturePingTask {
  id: number
  name: string
  interval: number
  loss: number
  weight: number
  clients: string[]
  type: string
  target: string
}

interface PingResponseGate {
  pause: () => () => void
  wait: () => Promise<void>
}

interface ResolvedScheduledPingSample extends PingRpcTimelineSample {
  time: string
}

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

export const PRIMARY_NODE_UUID = uuidFor(0)

function createPingResponseGate(): PingResponseGate {
  let pending: Promise<void> | null = null
  let release: (() => void) | null = null

  return {
    pause: () => {
      if (!pending) {
        pending = new Promise<void>((resolve) => {
          release = resolve
        })
      }

      return () => {
        release?.()
        pending = null
        release = null
      }
    },
    wait: async () => {
      await pending
    },
  }
}

/**
 * `page.clock.fastForward()` runs browser timers synchronously, while routed
 * RPC responses complete over the Playwright protocol afterwards. Yield both
 * event loops between deterministic clock ticks so a request scheduled at one
 * retry boundary can settle before the next boundary is evaluated.
 */
async function settleFakeClockWork(page: Page): Promise<void> {
  await Promise.resolve()
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await page.evaluate(async () => {
    await Promise.resolve()
  })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function parseFixtureTimestamp(value: string | number, label: string): number {
  const raw = typeof value === 'number'
    ? (Math.abs(value) < 10_000_000_000 ? value * 1000 : value)
    : Date.parse(value)
  if (!Number.isFinite(raw))
    throw new Error(`Invalid Ping fixture ${label}: ${String(value)}`)
  return raw
}

function resolveScheduledPingSamples(
  fixture: NodeCardPingFixture,
  uuid: string,
  now: number,
): ResolvedScheduledPingSample[] | null {
  if (!fixture.sampleSchedule?.length)
    return null

  return fixture.sampleSchedule
    .map((sample) => {
      const sampleAt = parseFixtureTimestamp(sample.sampleAt, 'sampleAt')
      const apiVisibleAt = parseFixtureTimestamp(sample.apiVisibleAt, 'apiVisibleAt')
      return {
        sampleAt,
        apiVisibleAt,
        latency: sample.latency,
        loss: sample.loss,
        taskId: sample.taskId ?? 202,
        client: sample.client ?? uuid,
        time: new Date(sampleAt).toISOString(),
      }
    })
    .filter(sample => sample.client === uuid && sample.apiVisibleAt <= now)
    .sort((left, right) => left.sampleAt - right.sampleAt)
}

function allFixtureNodeUuids(count = 12): string[] {
  return Array.from({ length: count }, (_, index) => uuidFor(index))
}

function buildNodeCardPingTasks(
  fixture: NodeCardPingFixture,
  assignedNodeUuids = allFixtureNodeUuids(),
): FixturePingTask[] {
  const task202Assigned = fixture.task202Assigned ?? true
  const task202Exists = fixture.task202Exists ?? true
  const tasks: FixturePingTask[] = [
    {
      id: 101,
      name: 'Fixture Tokyo',
      interval: 60,
      loss: 0,
      weight: 1,
      clients: assignedNodeUuids,
      type: 'tcp',
      target: 'tokyo.fixture.example:443',
    },
  ]

  if (task202Exists) {
    tasks.push({
      id: 202,
      name: 'Fixture Hong Kong',
      interval: 60,
      loss: fixture.task202Loss ?? 25,
      weight: 2,
      clients: task202Assigned ? assignedNodeUuids : [uuidFor(1)],
      type: 'icmp',
      target: 'hong-kong.fixture.example',
    })
  }

  tasks.push({
    id: 303,
    name: 'Fixture Seoul (not assigned to primary)',
    interval: 120,
    loss: 0,
    weight: 3,
    clients: fixture.thirdSharedTask ? assignedNodeUuids : [uuidFor(1)],
    type: 'http',
    target: 'https://seoul.fixture.example/health',
  })

  return tasks
}

function getFixturePingTaskIds(
  payload: Record<string, unknown>,
  fixture: NodeCardPingFixture,
  omittedTaskIds: number[] = [],
): number[] {
  const taskId = typeof payload.task_id === 'string' || typeof payload.task_id === 'number'
    ? Number(payload.task_id)
    : Number((payload.tags as Record<string, unknown> | undefined)?.task_id)
  const availableTaskIds = fixture.metric === 'selected-empty'
    ? [101]
    : fixture.thirdSharedTask ? [101, 202, 303] : [101, 202]
  if (Number.isSafeInteger(taskId) && taskId > 0)
    return availableTaskIds.filter(id => id === taskId && !omittedTaskIds.includes(id))
  return availableTaskIds.filter(id => !omittedTaskIds.includes(id))
}

function getFixtureEntityIds(payload: Record<string, unknown>): string[] {
  const batchIds = Array.isArray(payload.entity_ids)
    ? payload.entity_ids.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
  if (batchIds.length)
    return [...new Set(batchIds)]
  if (typeof payload.entity_id === 'string' && payload.entity_id)
    return [payload.entity_id]
  if (typeof payload.uuid === 'string' && payload.uuid)
    return [payload.uuid]
  return [uuidFor(0)]
}

function buildNodeCardPingSamplePoints(fixture: NodeCardPingFixture): Array<{ time: string | number, index: number }> {
  const sampleCount = Math.max(1, Math.floor(fixture.sampleCount ?? (fixture.komari141HarShape ? 58 : 4)))
  if (fixture.sampleTimes?.length) {
    return fixture.sampleTimes.map((time, index) => ({ time, index }))
  }

  return Array.from({ length: sampleCount }, (_, index) => {
    const timestamp = new Date(
      Date.parse(FIXED_NOW) - (sampleCount - 1 - index) * (fixture.komari141HarShape ? 60_000 : 75_000),
    ).toISOString()
    return {
      time: fixture.komari141HarShape ? timestamp.replace('.000Z', 'Z') : timestamp,
      index,
    }
  })
}

function buildNodeCardPingRecords(
  uuid: string,
  fixture: NodeCardPingFixture,
  now: number,
): Array<{ task_id: number, client: string, time: string | number, value: number }> {
  const scheduledSamples = resolveScheduledPingSamples(fixture, uuid, now)
  if (scheduledSamples) {
    return scheduledSamples.map(sample => ({
      task_id: sample.taskId,
      client: sample.client,
      time: sample.time,
      value: sample.latency ?? -1,
    }))
  }

  const points = buildNodeCardPingSamplePoints(fixture)
  const records = points.map(point => ({ task_id: 101, client: uuid, time: point.time, value: 10 }))
  if (fixture.legacy === 'selected-empty' || fixture.legacyEmptyUuids?.includes(uuid))
    return records

  const latency = fixture.task202Latency === undefined ? 200 : fixture.task202Latency
  const loss = fixture.task202Loss ?? 25
  const lostCount = loss > 0 ? Math.min(points.length, Math.max(0, Math.round(loss / 25))) : 0
  return [
    ...records,
    ...points.map(point => ({
      task_id: 202,
      client: uuid,
      time: point.time,
      value: point.index < lostCount || latency === null ? -1 : latency,
    })),
  ]
}

function buildNodeCardPingMetricResponse(
  payload: Record<string, unknown>,
  fixture: NodeCardPingFixture,
  now: number,
) {
  const requested = Array.isArray(payload.metric_keys) ? payload.metric_keys.map(String) : ['ping.latency_ms', 'ping.loss']
  const entityIds = getFixtureEntityIds(payload)
  const taskIds = getFixturePingTaskIds(payload, fixture, fixture.metricQueryOmitTaskIds)
  const requestedStart = typeof payload.start === 'string' ? Date.parse(payload.start) : Number.NEGATIVE_INFINITY
  const requestedEnd = typeof payload.end === 'string' ? Date.parse(payload.end) : Number.POSITIVE_INFINITY
  const requestedHours = Number.isFinite(requestedStart) && Number.isFinite(requestedEnd)
    ? (requestedEnd - requestedStart) / 3_600_000
    : 0
  const selectedRange = fixture.metricRangeSamples?.find(range => (
    (range.minHours === undefined || requestedHours >= range.minHours)
    && (range.maxHours === undefined || requestedHours <= range.maxHours)
  ))
  const configuredSamples = selectedRange?.samples ?? fixture.metricSamples
  if (configuredSamples) {
    const series = entityIds.flatMap((uuid) => {
      const samples = configuredSamples
        .map(sample => ({
          ...sample,
          timestamp: parseFixtureTimestamp(sample.time, 'configuredSamples.time'),
          taskId: sample.taskId ?? 202,
          client: sample.client ?? uuid,
        }))
        .filter(sample => sample.client === uuid
          && taskIds.includes(sample.taskId)
          && sample.timestamp >= requestedStart
          && sample.timestamp < requestedEnd)
        .sort((left, right) => left.timestamp - right.timestamp)
      return requested.flatMap((metricKey) => {
        if (metricKey !== 'ping.latency_ms' && metricKey !== 'ping.loss')
          return []
        return taskIds.flatMap((taskId) => {
          const taskSamples = samples.filter(sample => sample.taskId === taskId)
          if (!taskSamples.length)
            return []
          return [{
            metric_key: metricKey,
            entity_id: uuid,
            type: 'gauge',
            tags: { task_id: String(taskId), task_name: taskId === 202 ? 'Fixture Hong Kong' : 'Fixture Tokyo' },
            downsampled: true,
            fill_empty: true,
            interval_seconds: selectedRange?.intervalSeconds ?? 60,
            count: taskSamples.length,
            points: taskSamples.map(sample => ({
              time: new Date(sample.timestamp).toISOString(),
              value: metricKey === 'ping.loss' ? sample.loss : sample.latency,
              count: metricKey === 'ping.loss' ? sample.lossCount : sample.latencyCount,
            })),
          }]
        })
      })
    })
    return {
      start: typeof payload.start === 'string' ? payload.start : FIXED_NOW,
      end: typeof payload.end === 'string' ? payload.end : FIXED_NOW,
      series,
      count: series.length,
    }
  }
  const points = buildNodeCardPingSamplePoints(fixture)
  const scheduledByEntity = new Map(entityIds.map(uuid => [uuid, resolveScheduledPingSamples(fixture, uuid, now)]))
  const series = entityIds
    .filter(uuid => !fixture.metricErrorUuids?.includes(uuid))
    .flatMap(uuid => requested.flatMap((metricKey) => {
      if (metricKey !== 'ping.latency_ms' && metricKey !== 'ping.loss')
        return []

      return taskIds.map((taskId) => {
        const scheduledSamples = scheduledByEntity.get(uuid)
        if (scheduledSamples) {
          const taskSamples = scheduledSamples.filter(sample => sample.taskId === taskId)
          return {
            metric_key: metricKey,
            entity_id: uuid,
            type: 'gauge',
            tags: fixture.komari141HarShape
              ? { task_id: String(taskId) }
              : { task_id: String(taskId), task_name: taskId === 202 ? 'Fixture Hong Kong' : 'Fixture Tokyo' },
            downsampled: false,
            interval_seconds: 60,
            count: taskSamples.length,
            points: taskSamples.map(sample => ({
              time: sample.time,
              value: metricKey === 'ping.loss' ? sample.loss / 100 : sample.latency,
              count: 1,
              ...(fixture.komari141HarShape ? { tags: { task_id: String(taskId) } } : {}),
            })),
          }
        }

        const latency = taskId === 202
          ? fixture.task202Latency === undefined ? 200 : fixture.task202Latency
          : taskId === 303 ? 30 : 10
        const loss = taskId === 202 ? (fixture.task202Loss ?? 25) / 100 : 0
        return {
          metric_key: metricKey,
          entity_id: uuid,
          type: 'gauge',
          tags: fixture.komari141HarShape
            ? { task_id: String(taskId) }
            : { task_id: String(taskId), task_name: taskId === 202 ? 'Fixture Hong Kong' : taskId === 303 ? 'Fixture Seoul' : 'Fixture Tokyo' },
          downsampled: false,
          interval_seconds: 60,
          count: points.length,
          points: points.map(point => ({
            time: point.time,
            value: metricKey === 'ping.loss' ? loss : latency,
            count: 1,
            ...(fixture.komari141HarShape ? { tags: { task_id: String(taskId) } } : {}),
          })),
        }
      })
    }))
  const scheduledSamples = [...scheduledByEntity.values()].flatMap(samples => samples ?? [])
  const scheduledStart = scheduledSamples[0]?.time
  const scheduledEnd = scheduledSamples.at(-1)?.time
  return {
    start: String(scheduledStart ?? points[0]?.time ?? FIXED_NOW),
    end: String(scheduledEnd ?? points.at(-1)?.time ?? FIXED_NOW),
    series,
    count: series.length,
  }
}

function buildNodeCardPingMetricStats(
  payload: Record<string, unknown>,
  fixture: NodeCardPingFixture,
  now: number,
) {
  const entityIds = getFixtureEntityIds(payload)
  const taskIds = getFixturePingTaskIds(payload, fixture)
  const scheduledByEntity = new Map(entityIds.map(uuid => [uuid, resolveScheduledPingSamples(fixture, uuid, now)]))
  const scheduledSamples = [...scheduledByEntity.values()].flatMap(samples => samples ?? [])
  if (scheduledByEntity.size && [...scheduledByEntity.values()].some(samples => samples !== null)) {
    const stats = entityIds
      .filter(uuid => !fixture.metricErrorUuids?.includes(uuid))
      .flatMap(uuid => taskIds.flatMap((taskId) => {
        const taskSamples = (scheduledByEntity.get(uuid) ?? []).filter(sample => sample.taskId === taskId)
        if (!taskSamples.length)
          return []

        const latencySamples = taskSamples.filter((sample): sample is ResolvedScheduledPingSample & { latency: number } => sample.latency !== null)
        const avg = latencySamples.length
          ? latencySamples.reduce((total, sample) => total + sample.latency, 0) / latencySamples.length
          : undefined
        const latest = latencySamples.at(-1)?.latency
        const loss = taskSamples.reduce((total, sample) => total + sample.loss, 0) / taskSamples.length
        return [{
          entity_id: uuid,
          task_id: String(taskId),
          name: taskId === 202 ? 'Fixture Hong Kong' : taskId === 303 ? 'Fixture Seoul' : 'Fixture Tokyo',
          tags: { task_id: String(taskId) },
          interval: 60,
          total: taskSamples.length,
          valid: latencySamples.length,
          avg,
          latest,
          loss,
          ...(fixture.komari141HarShape ? {} : { loss_approximate: false }),
        }]
      }))
    const start = scheduledSamples[0]?.time ?? FIXED_NOW
    const end = scheduledSamples.at(-1)?.time ?? FIXED_NOW
    return { start, end, interval_seconds: 60, stats, count: stats.length }
  }

  const sampleCount = fixture.sampleTimes?.length ?? Math.max(1, Math.floor(fixture.sampleCount ?? 4))
  const stats = entityIds
    .filter(uuid => !fixture.metricErrorUuids?.includes(uuid))
    .flatMap(uuid => taskIds.map((taskId) => {
      const latency = taskId === 202
        ? fixture.task202Latency === undefined ? 200 : fixture.task202Latency
        : taskId === 303 ? 30 : 10
      const loss = taskId === 202 ? fixture.task202Loss ?? 25 : 0
      return {
        entity_id: uuid,
        task_id: String(taskId),
        name: taskId === 202 ? 'Fixture Hong Kong' : taskId === 303 ? 'Fixture Seoul' : 'Fixture Tokyo',
        tags: { task_id: String(taskId) },
        total: Math.max(1, sampleCount),
        valid: loss >= 100 ? 0 : Math.max(1, sampleCount - Math.round(loss / 25)),
        avg: latency,
        latest: latency,
        loss,
        ...(fixture.komari141HarShape ? {} : { loss_approximate: false }),
      }
    }))
  return { start: FIXED_NOW, end: FIXED_NOW, interval_seconds: 60, stats, count: stats.length }
}

function buildClients(freePriceNode = false, expiryThresholds = false, invalidExpiry = false, count = 12) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const fixture = REGION_FIXTURES[index % REGION_FIXTURES.length]
    const uuid = uuidFor(index)
    return [uuid, {
      uuid,
      name: index < REGION_FIXTURES.length ? fixture.name : `${fixture.name}-${index + 1}`,
      cpu_name: fixture.cpu,
      virtualization: index % 3 === 0 ? 'docker' : 'kvm',
      arch: index % 4 === 0 ? 'aarch64' : 'x86_64',
      cpu_cores: index % 4 + 1,
      cpu_physical_cores: Math.max(1, index % 3 + 1),
      os: index % 2 === 0 ? 'Ubuntu 24.04.4 LTS' : 'Debian GNU/Linux 12',
      kernel_version: '6.8.0-visual-test',
      gpu_name: index === 3 ? 'NVIDIA A100 80GB PCIe' : '',
      ipv4: `192.0.2.${index + 10}`,
      ipv6: `2001:db8:abcd:${index + 1}::${index + 10}`,
      region: fixture.code,
      public_remark: index === 1 ? '长备注用于验证文本换行与裁切' : '',
      mem_total: (index % 4 + 1) * GIB,
      swap_total: index % 3 === 0 ? 2 * GIB : 0,
      disk_total: (index % 3 + 1) * 40 * GIB,
      version: '1.2.6-visual',
      weight: index,
      price: freePriceNode && index === 0 ? -1 : index === 5 ? 0 : 9.9 + index,
      billing_cycle: 365,
      auto_renewal: index % 2 === 0,
      currency: 'USD',
      expired_at: invalidExpiry && index === 0
        ? 'not-a-valid-date'
        : expiryThresholds && index === 0
          ? '2026-07-30T12:00:00.000Z'
          : expiryThresholds && index === 1
            ? '2026-08-04T12:00:00.000Z'
            : index === 6 ? '2026-08-02T00:00:00.000Z' : '2027-07-25T00:00:00.000Z',
      group: index < 6 ? '生产' : '测试,边缘',
      tags: index % 2 === 0 ? 'core<jade>,visual<blue>' : 'edge<orange>',
      hidden: false,
      traffic_limit: index === 6 ? 2 * TIB : 20 * TIB,
      traffic_limit_type: 'sum',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: FIXED_NOW,
    }]
  }))
}

function buildStatuses(count = 12) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const uuid = uuidFor(index)
    const offline = index === 5
    const highLoad = index === 2
    const trafficWarning = index === 6
    const memTotal = (index % 4 + 1) * GIB
    const diskTotal = (index % 3 + 1) * 40 * GIB
    return [uuid, {
      client: uuid,
      time: FIXED_NOW,
      cpu: offline ? 0 : highLoad ? 96.4 : 8 + index * 2.7,
      gpu: index === 3 ? 72.5 : 0,
      gpu_count: index === 3 ? 1 : 0,
      gpu_average_usage: index === 3 ? 72.5 : 0,
      gpu_detailed_info: index === 3 ? [{ name: 'NVIDIA A100', utilization: 72.5, memory_total: 80 * GIB, memory_used: 52 * GIB, temperature: 61 }] : [],
      ram: offline ? 0 : Math.round(memTotal * (0.28 + index * 0.025)),
      ram_total: memTotal,
      swap: index % 3 === 0 ? (index + 1) * 64 * 1024 ** 2 : 0,
      swap_total: index % 3 === 0 ? 2 * GIB : 0,
      load: offline ? 0 : 0.18 + index * 0.11,
      load5: offline ? 0 : 0.14 + index * 0.09,
      load15: offline ? 0 : 0.1 + index * 0.07,
      temp: offline ? 0 : 36 + index,
      disk: Math.round(diskTotal * (0.18 + index * 0.035)),
      disk_total: diskTotal,
      net_in: offline ? 0 : 32_000 + index * 91_000,
      net_out: offline ? 0 : 18_000 + index * 63_000,
      net_total_up: (index + 1) * 45 * GIB,
      net_total_down: trafficWarning ? 1.78 * TIB : (index + 1) * 62 * GIB,
      traffic_up: (index + 1) * 3 * GIB,
      traffic_down: (index + 1) * 5 * GIB,
      process: offline ? 0 : 72 + index * 4,
      connections: offline ? 0 : 140 + index * 17,
      connections_udp: offline ? 0 : 8 + index,
      online: !offline,
      uptime: offline ? 0 : (index + 3) * 86_400,
      message: '',
      updated_at: FIXED_NOW,
      ping: {
        1: { name: 'Tokyo', latest: offline ? -1 : 42 + index * 13, avg: 50 + index * 11, tail: 88 + index * 14, loss: offline ? 100 : index * 2.3, min: 32, max: 260 },
      },
    }]
  }))
}

const clients = buildClients()
const statuses = buildStatuses()

function buildRecords(uuid = uuidFor(0)) {
  const status = statuses[uuid] ?? statuses[uuidFor(0)]
  return Array.from({ length: 48 }, (_, index) => ({
    ...status,
    client: uuid,
    time: new Date(Date.parse(FIXED_NOW) - (47 - index) * 75_000).toISOString(),
    cpu: Math.max(1, Number(status.cpu) + Math.sin(index / 5) * 8),
    ram: Math.max(0, Number(status.ram) + index * 2 * 1024 ** 2),
    disk: Math.max(0, Number(status.disk) + index * 4 * 1024 ** 2),
    net_in: 80_000 + index * 12_000,
    net_out: 50_000 + index * 9_000,
  }))
}

const METRIC_KEYS = [
  'cpu.usage',
  'load.average',
  'memory.used',
  'memory.total',
  'swap.used',
  'swap.total',
  'temperature',
  'disk.used',
  'disk.total',
  'net.in.rate',
  'net.out.rate',
  'net.total.down',
  'net.total.up',
  'traffic.down',
  'traffic.up',
  'process.count',
  'connections.tcp',
  'connections.udp',
  'gpu.usage',
  'gpu.device.usage',
  'gpu.memory.used',
  'gpu.memory.total',
  'gpu.temperature',
  'ping.latency_ms',
  'ping.loss',
] as const

function metricValue(key: string, index: number): number {
  const values: Record<string, number> = {
    'cpu.usage': 22 + Math.sin(index / 4) * 12,
    'load.average': 0.45 + Math.sin(index / 6) * 0.2,
    'memory.used': 1.2 * GIB + index * 3 * 1024 ** 2,
    'memory.total': 4 * GIB,
    'swap.used': 260 * 1024 ** 2 + index * 1024 ** 2,
    'swap.total': 2 * GIB,
    'temperature': 44 + Math.sin(index / 5) * 5,
    'disk.used': 18 * GIB + index * 4 * 1024 ** 2,
    'disk.total': 80 * GIB,
    'net.in.rate': 420_000 + index * 13_000,
    'net.out.rate': 280_000 + index * 9_000,
    'net.total.down': 860 * GIB + index * 11 * GIB,
    'net.total.up': 540 * GIB + index * 8 * GIB,
    'traffic.down': 8 * GIB + index * 2 * GIB,
    'traffic.up': 5 * GIB + index * GIB,
    'process.count': 86 + index % 9,
    'connections.tcp': 220 + index * 2,
    'connections.udp': 12 + index % 4,
    'gpu.usage': 0,
    'gpu.device.usage': 0,
    'gpu.memory.used': 0,
    'gpu.memory.total': 0,
    'gpu.temperature': 0,
    'ping.latency_ms': 88 + Math.sin(index / 3) * 15,
    'ping.loss': index % 13 === 0 ? 8 : 1.5,
  }
  return values[key] ?? 0
}

function metricRequestHours(payload: Record<string, unknown>): number {
  if (typeof payload.hours === 'number' && Number.isFinite(payload.hours))
    return Math.round(payload.hours)
  const start = typeof payload.start === 'string' ? Date.parse(payload.start) : Number.NaN
  const end = typeof payload.end === 'string' ? Date.parse(payload.end) : Number.NaN
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 3_600_000) : 0
}

function buildMetricResponse(
  payload: Record<string, unknown>,
  missingCpuMetricHistory = false,
  loadMetricFixture?: LoadMetricFixture,
) {
  const requested = Array.isArray(payload.metric_keys) ? payload.metric_keys.map(String) : METRIC_KEYS
  const uuid = typeof payload.entity_id === 'string' ? payload.entity_id : uuidFor(0)
  const requestedHours = metricRequestHours(payload)
  const fixedCpuValue = loadMetricFixture?.cpuValueByHours?.[String(requestedHours)]
  const points = Array.from({ length: 48 }, (_, index) => ({
    time: new Date(Date.parse(FIXED_NOW) - (47 - index) * 75_000).toISOString(),
    index,
  }))
  const series = requested.filter(key => !missingCpuMetricHistory || key !== 'cpu.usage').map(key => ({
    metric_key: key,
    entity_id: uuid,
    type: 'gauge',
    tags: key.startsWith('ping.') ? { task_id: '1', task_name: 'Tokyo' } : {},
    points: points.map(point => ({
      time: point.time,
      value: key === 'cpu.usage' && fixedCpuValue !== undefined ? fixedCpuValue : metricValue(key, point.index),
    })),
  }))
  return { start: points[0].time, end: points.at(-1)?.time, series, count: series.length }
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function isPingMetricRequest(method: string, params: Record<string, unknown> | undefined): boolean {
  if (method === 'public:getPingMetricStats')
    return true
  const metricKeys = Array.isArray(params?.metric_keys) ? params.metric_keys.map(String) : []
  return metricKeys.includes('ping.latency_ms') || metricKeys.includes('ping.loss')
}

function pingRequestUuid(params: Record<string, unknown> | undefined): string {
  return getFixtureEntityIds(params)[0] ?? uuidFor(0)
}

function shouldFailPingMetric(params: Record<string, unknown> | undefined, fixture: NodeCardPingFixture): boolean {
  if (fixture.metric === 'error')
    return true
  const entityIds = getFixtureEntityIds(params)
  return entityIds.length === 1 && fixture.metricErrorUuids?.includes(entityIds[0]) === true
}

function shouldFailTaggedPingMetricQuery(params: Record<string, unknown> | undefined, fixture: NodeCardPingFixture): boolean {
  const taskId = Number((params?.tags as Record<string, unknown> | undefined)?.task_id)
  return Number.isSafeInteger(taskId) && fixture.metricErrorWhenTaggedTaskIds?.includes(taskId) === true
}

function shouldFailPingLegacy(params: Record<string, unknown> | undefined, fixture: NodeCardPingFixture): boolean {
  return fixture.legacy === 'error' || fixture.legacyErrorUuids?.includes(pingRequestUuid(params)) === true
}

function getPingResponseSamples(
  payload: { method: string, params?: Record<string, unknown> },
  fixture: NodeCardPingFixture | undefined,
  now: number,
): PingRpcTimelineSample[] {
  if (!fixture || payload.method === 'public:getPublicPingTasks')
    return []

  const scheduledSamples = resolveScheduledPingSamples(fixture, pingRequestUuid(payload.params), now)
  if (!scheduledSamples)
    return []

  const requestedTaskIds = isPingMetricRequest(payload.method, payload.params)
    ? getFixturePingTaskIds(payload.params ?? {}, fixture, payload.method === 'public:queryMetrics' ? fixture.metricQueryOmitTaskIds : [])
    : null
  return scheduledSamples
    .filter(sample => requestedTaskIds === null || requestedTaskIds.includes(sample.taskId))
    .map(({ time: _time, ...sample }) => sample)
}

async function handleRpc(
  route: Route,
  clientFixtures = clients,
  statusFixtures = statuses,
  nodeCardPingFixture?: NodeCardPingFixture,
  pingResponseGate?: PingResponseGate,
  missingCpuMetricHistory = false,
  loadMetricFixture?: LoadMetricFixture,
  getNow: () => Promise<number> = async () => Date.now(),
  pingTimeline: PingRpcTimelineEntry[] = [],
): Promise<void> {
  const payload = route.request().postDataJSON() as { id: unknown, method: string, params?: Record<string, unknown> }
  const uuid = typeof payload.params?.uuid === 'string' ? payload.params.uuid : uuidFor(0)
  const isPingRequest = payload.method === 'public:getPublicPingTasks'
    || (payload.method === 'common:getRecords' && payload.params?.type === 'ping')
    || payload.method === 'public:getPingRecords'
    || isPingMetricRequest(payload.method, payload.params)
  const requestAt = isPingRequest ? await getNow() : 0
  if (isPingRequest)
    await pingResponseGate?.wait()

  if (payload.method === 'public:queryMetrics' && nodeCardPingFixture?.metricQueryDelayMsByHours) {
    const start = typeof payload.params?.start === 'string' ? Date.parse(payload.params.start) : Number.NaN
    const end = typeof payload.params?.end === 'string' ? Date.parse(payload.params.end) : Number.NaN
    const hours = Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 3_600_000) : 0
    const delay = nodeCardPingFixture.metricQueryDelayMsByHours[String(hours)] ?? 0
    if (delay > 0)
      await new Promise(resolve => setTimeout(resolve, delay))
  }

  if (payload.method === 'public:queryMetrics' && loadMetricFixture?.delayMsByHours) {
    const hours = metricRequestHours(payload.params ?? {})
    const delay = loadMetricFixture.delayMsByHours[String(hours)] ?? 0
    if (delay > 0)
      await new Promise(resolve => setTimeout(resolve, delay))
  }

  const responseAt = isPingRequest ? await getNow() : requestAt
  const pingRecords = nodeCardPingFixture
    ? buildNodeCardPingRecords(uuid, nodeCardPingFixture, responseAt)
    : Array.from({ length: 48 }, (_, index) => ({ task_id: 1, client: uuid, time: new Date(Date.parse(FIXED_NOW) - (47 - index) * 75_000).toISOString(), value: index % 17 === 0 ? -1 : 76 + index }))
  const pingTasks = nodeCardPingFixture
    ? buildNodeCardPingTasks(nodeCardPingFixture, Object.keys(clientFixtures))
    : [{ id: 1, name: 'Tokyo', interval: 60, loss: 3.2, weight: 1 }]

  let result: unknown
  let error: { code: number, message: string } | null = null

  switch (payload.method) {
    case 'rpc.ping':
      result = 'pong'
      break
    case 'common:getNodes':
      result = clientFixtures
      break
    case 'common:getNodesLatestStatus':
      result = statusFixtures
      break
    case 'common:getNodeRecentStatus':
      result = { count: 48, records: buildRecords(uuid) }
      break
    case 'common:getRecords':
      if (payload.params?.type === 'ping' && nodeCardPingFixture && shouldFailPingLegacy(payload.params, nodeCardPingFixture)) {
        error = { code: -32601, message: 'Fixture ping legacy records unavailable' }
      }
      else {
        result = payload.params?.type === 'ping'
          ? { count: 48, records: pingRecords, tasks: pingTasks }
          : { count: 48, records: buildRecords(uuid) }
      }
      break
    case 'public:getClientRecentRecords':
      result = buildRecords(uuid)
      break
    case 'public:getRecordsByUUID':
      result = { count: 48, records: buildRecords(uuid), load_type: 'all', has_gpu_data: false }
      break
    case 'public:getPingRecords':
      if (nodeCardPingFixture && shouldFailPingLegacy(payload.params, nodeCardPingFixture))
        error = { code: -32601, message: 'Fixture public ping legacy records unavailable' }
      else
        result = { count: 48, records: pingRecords, tasks: pingTasks }
      break
    case 'public:getPublicPingTasks':
      result = pingTasks
      break
    case 'public:listMetricDefinitions':
      result = METRIC_KEYS.map(name => ({ name, description: name, type: 'gauge', retention_days: 30 }))
      break
    case 'public:queryMetrics':
      if (nodeCardPingFixture && isPingMetricRequest(payload.method, payload.params)) {
        if (shouldFailPingMetric(payload.params, nodeCardPingFixture)
          || shouldFailTaggedPingMetricQuery(payload.params, nodeCardPingFixture)) {
          error = { code: -32601, message: 'Fixture ping metrics unavailable' }
        }
        else if (nodeCardPingFixture.metric === 'malformed') {
          result = {
            start: FIXED_NOW,
            end: FIXED_NOW,
            count: 1,
            series: [{ metric_key: 'ping.latency_ms', entity_id: uuid, tags: {}, points: [{ time: FIXED_NOW, value: 200 }] }],
          }
        }
        else {
          result = buildNodeCardPingMetricResponse(payload.params ?? {}, nodeCardPingFixture, responseAt)
        }
      }
      else if (loadMetricFixture?.rejectPerMetricAggregation && payload.params?.aggregation_by_metric) {
        error = { code: -32602, message: 'Fixture per-metric aggregation unsupported' }
      }
      else {
        result = buildMetricResponse(payload.params ?? {}, missingCpuMetricHistory, loadMetricFixture)
      }
      break
    case 'public:getPingMetricStats':
      if (nodeCardPingFixture && shouldFailPingMetric(payload.params, nodeCardPingFixture)) {
        error = { code: -32601, message: 'Fixture ping metric stats unavailable' }
      }
      else if (nodeCardPingFixture && nodeCardPingFixture.metric === 'malformed') {
        result = {
          start: FIXED_NOW,
          end: FIXED_NOW,
          interval_seconds: 60,
          count: 1,
          stats: [{ entity_id: uuid, task_id: 'invalid', total: 4, valid: 4, avg: 200, latest: 200, loss: 0, loss_approximate: false }],
        }
      }
      else {
        result = nodeCardPingFixture
          ? buildNodeCardPingMetricStats(payload.params ?? {}, nodeCardPingFixture, responseAt)
          : { start: FIXED_NOW, end: FIXED_NOW, interval_seconds: 60, stats: [], count: 0 }
      }
      break
    case 'public:getNodesInformation':
      result = Object.values(clientFixtures)
      break
    case 'public:getMe':
      result = { logged_in: false }
      break
    case 'public:getVersion':
    case 'common:getBackendVersion':
    case 'rpc.getVersion':
      result = { version: '1.2.6-visual', hash: 'visual' }
      break
    default:
      result = null
  }

  const responseSamples = isPingRequest && !error
    ? getPingResponseSamples(payload, nodeCardPingFixture, responseAt)
    : []

  if (isPingRequest) {
    pingTimeline.push({
      method: payload.method,
      requestAt,
      responseAt,
      params: { ...(payload.params ?? {}) },
      responseSamples,
    })
  }

  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(error ? jsonRpcError(payload.id, error.code, error.message) : jsonRpcResult(payload.id, result)),
  })
}

export async function installKomariFixture(page: Page, options: VisualFixtureOptions = {}): Promise<KomariFixtureController> {
  const nodeCount = Math.max(1, Math.floor(options.nodeCount ?? 12))
  const clientFixtures = buildClients(
    options.freePriceNode,
    options.expiryThresholds,
    options.invalidExpiry,
    nodeCount,
  )
  const statusFixtures = buildStatuses(nodeCount)
  const pingResponseGate = createPingResponseGate()
  const adminResponseGate = createPingResponseGate()
  const pingTimeline: PingRpcTimelineEntry[] = []
  let currentNow = parseFixtureTimestamp(options.clockNow ?? FIXED_NOW, 'clockNow')
  const readBrowserNow = async (): Promise<number> => {
    try {
      const browserNow = await page.evaluate(() => Date.now())
      if (Number.isFinite(browserNow))
        currentNow = browserNow
    }
    catch {
      // A route can outlive page teardown; retain the last deterministic clock.
    }
    return currentNow
  }
  let nodeCardPingFixture = options.nodeCardPingFixture
  let adminAccess = options.adminAccess ?? 'guest'
  let siteName = options.siteName ?? 'Komari Visual Lab'
  let themeSaveCount = 0
  let settings: Record<string, unknown> = {
    themeMode: options.dark ? 'dark' : 'light',
    dataUpdateInterval: 60,
    rpcTransportMode: 'http',
    defaultViewMode: options.viewMode ?? 'card',
    nodeCardSize: options.nodeCardSize ?? 'compact',
    earthRenderer: options.earthRenderer ?? 'realistic',
    hideEarth: options.hideEarth ?? false,
    stopEarth: true,
    visitorInfoEnabled: true,
    colorVisionMode: options.colorVisionFriendly ? '色觉友好' : '标准',
    hideAdminEntryWhenLoggedOut: false,
    hidePriceWhenLoggedOut: false,
    disablePageAnimation: options.disablePageAnimation ?? true,
    homeQuickControlsEnabled: true,
    homeQuickControlPreset: '完整',
    homeToolsEnabled: true,
    generalCardPreset: options.generalCardPreset ?? '自定义',
    generalCardKeys: (options.generalCardKeys ?? (
      options.earthRenderer === 'tiled'
        ? ['onlineNodes', 'remainingValue', 'monthlyCost', 'totalTraffic', 'uploadSpeed', 'downloadSpeed']
        : ['memory', 'disk', 'remainingValue', 'totalTraffic', 'uploadSpeed', 'downloadSpeed']
    )).join('\n'),
    hidePingTaskBindingEntry: options.hidePingTaskBindingEntry ?? false,
    nodeCardPingTaskBindings: options.nodeCardPingTaskBindings ?? '{}',
    ...(options.nodeCardPingDisplayConfigV2 === undefined
      ? {}
      : { nodeCardPingDisplayConfigV2: options.nodeCardPingDisplayConfigV2 }),
    fixtureUnrelatedSetting: 'preserve-me',
  }

  if (options.fakeTimers)
    await page.clock.install({ time: new Date(options.clockNow ?? FIXED_NOW) })

  await page.addInitScript(({ fixedNow, preserveStorageOnReload, useFakeTimers }) => {
    if (!preserveStorageOnReload) {
      localStorage.clear()
      sessionStorage.clear()
    }
    if (useFakeTimers)
      return

    const NativeDate = Date
    let currentTime = new NativeDate(fixedNow).getTime()
    class FixedDate extends NativeDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(currentTime)
        }
        else if (args.length === 1) {
          super(args[0] as string | number)
        }
        else {
          super(
            Number(args[0]),
            Number(args[1]),
            args[2] === undefined ? 1 : Number(args[2]),
            args[3] === undefined ? 0 : Number(args[3]),
            args[4] === undefined ? 0 : Number(args[4]),
            args[5] === undefined ? 0 : Number(args[5]),
            args[6] === undefined ? 0 : Number(args[6]),
          )
        }
      }

      static now() {
        return currentTime
      }
    }
    window.Date = FixedDate as DateConstructor
    Object.defineProperty(window, '__advanceKomariFixtureTime', {
      configurable: false,
      value: (milliseconds: number) => {
        currentTime += milliseconds
      },
    })
  }, {
    fixedNow: options.clockNow ?? FIXED_NOW,
    preserveStorageOnReload: options.preserveStorageOnReload ?? false,
    useFakeTimers: options.fakeTimers ?? false,
  })

  await page.route('**/api/public', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      message: 'ok',
      data: {
        allow_cors: true,
        custom_body: '',
        custom_head: '',
        description: '固定虚构节点视觉回归环境',
        disable_password_login: false,
        oauth_enable: false,
        oauth_provider: null,
        private_site: false,
        record_enabled: true,
        record_preserve_time: 720,
        ping_record_preserve_time: options.pingRecordPreserveTime ?? 720,
        sitename: siteName,
        theme: 'Glassmorphism',
        theme_settings: settings,
        visitor_audit_enabled: false,
      },
    }),
  }))
  await page.route('**/api/me', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ logged_in: adminAccess === 'admin' || adminAccess === 'forbidden', username: adminAccess === 'admin' ? 'visual-admin' : 'visual-guest' }),
  }))
  await page.route('**/api/version', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', message: 'ok', data: { version: '1.2.6-visual', hash: 'visual' } }),
  }))
  await page.route('**/rpc2', route => handleRpc(
    route,
    clientFixtures,
    statusFixtures,
    nodeCardPingFixture,
    pingResponseGate,
    options.missingCpuMetricHistory ?? false,
    options.loadMetricFixture,
    readBrowserNow,
    pingTimeline,
  ))
  await page.route('**/api/admin/ping', async (route) => {
    await adminResponseGate.wait()
    if (adminAccess !== 'admin') {
      await route.fulfill({
        status: adminAccess === 'forbidden' ? 403 : 401,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: adminAccess === 'forbidden' ? 'forbidden' : 'unauthenticated' }),
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', message: 'ok', data: buildNodeCardPingTasks(nodeCardPingFixture ?? {}, Object.keys(clientFixtures)) }),
    })
  })
  await page.route('**/api/admin/client/list', async (route) => {
    await adminResponseGate.wait()
    if (adminAccess !== 'admin') {
      await route.fulfill({
        status: adminAccess === 'forbidden' ? 403 : 401,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: adminAccess === 'forbidden' ? 'forbidden' : 'unauthenticated' }),
      })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(Object.values(clientFixtures)) })
  })
  await page.route('**/api/admin/theme/settings?*', async (route) => {
    await adminResponseGate.wait()
    if (adminAccess !== 'admin') {
      await route.fulfill({
        status: adminAccess === 'forbidden' ? 403 : 401,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: adminAccess === 'forbidden' ? 'forbidden' : 'unauthenticated' }),
      })
      return
    }
    const payload = route.request().postDataJSON() as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'invalid payload' }) })
      return
    }
    settings = { ...(payload as Record<string, unknown>) }
    themeSaveCount += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'success', message: 'ok' }) })
  })
  await page.route('https://ipwho.is/', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ success: true, ip: '2001:db8::25', city: 'Tokyo', region: 'Tokyo', country: 'Japan', connection: { org: 'Example Networks' } }),
  }))

  return {
    setSiteName: (value) => {
      siteName = value
    },
    setNodeCardPingTaskBindings: (value) => {
      settings.nodeCardPingTaskBindings = value
    },
    setNodeCardPingDisplayConfigV2: (value) => {
      settings.nodeCardPingDisplayConfigV2 = value
    },
    setThemeSetting: (key, value) => {
      settings[key] = value
    },
    setAdminAccess: (value) => {
      adminAccess = value
    },
    setNodeCardPingFixture: (value) => {
      nodeCardPingFixture = { ...(nodeCardPingFixture ?? {}), ...value }
    },
    getSavedThemeSettings: () => ({ ...settings }),
    getThemeSaveCount: () => themeSaveCount,
    pausePingResponses: () => pingResponseGate.pause(),
    pauseAdminResponses: () => adminResponseGate.pause(),
    advanceTime: async (milliseconds) => {
      if (options.fakeTimers) {
        // Step fake time at the scheduler's one-second cadence. A single large
        // jump otherwise makes a 5/10/20s retry chain appear as one request,
        // because each async routed RPC only resumes after the whole jump.
        let remaining = milliseconds
        while (remaining > 0) {
          const step = Math.min(1_000, remaining)
          await page.clock.fastForward(step)
          currentNow += step
          await settleFakeClockWork(page)
          remaining -= step
        }
      }
      else {
        await page.evaluate((delta) => {
          const advance = (window as typeof window & { __advanceKomariFixtureTime?: (value: number) => void })
            .__advanceKomariFixtureTime
          advance?.(delta)
        }, milliseconds)
        currentNow += milliseconds
      }
      await readBrowserNow()
    },
    timeline: pingTimeline,
    now: () => currentNow,
  }
}
