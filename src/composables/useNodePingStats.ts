import type { MaybeRefOrGetter } from 'vue'
import type { PingRefreshOutcome } from '@/services/ping-refresh-scheduler.service'
import type { PingTimeWindow } from '@/utils/pingTime'
import type { PingMetricTaskStats } from '@/utils/rpc'
import { useThrottleFn } from '@vueuse/core'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { CACHE_CONFIG } from '@/constants/cache'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import { SharedCache } from '@/services/cache.service'
import { abortPingRecords, loadPingRecords } from '@/services/history.service'
import { abortPingMetricStats, abortQueryMetrics, getAssignedPublicPingTask, loadPingMetricStats, loadPublicPingTaskCatalog, queryMetrics } from '@/services/metrics.service'
import { pingRefreshScheduler } from '@/services/ping-refresh-scheduler.service'
import { isPingMetric, normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { createNextAlignedPingTimeWindow, getPingTimeBucketIndex, isPingTimestampInWindow, parsePingTimestampMs } from '@/utils/pingTime'

export interface NodePingHistoryPoint {
  time: string
  latency: number | null
  loss: number | null
}

export interface NodePingStatsState {
  avgLatency: number
  avgLoss: number
  avgVolatility: number
  history: NodePingHistoryPoint[]
  hasData: boolean
}

interface PingRecord {
  client: string
  task_id: number
  time: string
  value: number
}

interface MetricLossPoint {
  taskId: string
  time: string
  value: number
  count: number
}

function normalizeMaxCount(maxCount: number | null | undefined): number | undefined {
  if (typeof maxCount !== 'number' || !Number.isFinite(maxCount) || maxCount <= 0)
    return undefined
  return Math.floor(maxCount)
}

interface SharedPingRecordsState {
  recordsByClient: Map<string, PingRecord[]>
  source: 'metric' | 'legacy'
  window: PingTimeWindow
  metricStats?: PingMetricTaskStats[]
  metricLossPoints?: MetricLossPoint[]
}

interface SharedPingRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedPingRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  refreshTimer: ReturnType<typeof setInterval> | null
  subscribers: number
  lastFetchedAt: number
  requestWindow: PingTimeWindow | null
}

type SelectedPingTaskSource = 'metric' | 'legacy'

interface SelectedPingTaskSnapshot {
  stats: NodePingStatsState
  latestSampleAt: number
  fetchedAt: number
  source: SelectedPingTaskSource
  taskIntervalMs: number
  stale: boolean
}

interface SelectedPingTaskLoadResult {
  snapshot: SelectedPingTaskSnapshot | null
  taskIntervalMs: number
  bindingValid: boolean
}

interface SelectedPingTaskStatsEntry {
  data: ReturnType<typeof shallowRef<SelectedPingTaskSnapshot | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  status: ReturnType<typeof ref<'idle' | 'loading' | 'ready' | 'fallback'>>
  promise: Promise<PingRefreshOutcome> | null
  subscribers: number
}

const HISTORY_BUCKET_COUNT = CACHE_CONFIG.nodePingSummary.historyBucketCount
const CACHE_VERSION = 9
const CACHE_KEY_PREFIX = 'komari-theme-emerald:node-ping-stats'
const SELECTED_CACHE_VERSION = 1
const SELECTED_CACHE_QUERY_VERSION = 'metric-window-v1'
const SELECTED_CACHE_KEY_PREFIX = 'komari-theme-emerald:selected-node-ping-stats'
const FULL_LOSS_EPSILON = 1e-6
const PING_RECORD_REFRESH_INTERVAL_MS = CACHE_CONFIG.nodePingSummary.refreshInterval
const POSITIVE_INTEGER_TASK_ID_PATTERN = /^\d+$/
const sharedPingRecordsCache = new SharedCache<SharedPingRecordsEntry>({
  maxSize: CACHE_CONFIG.nodePingSummary.sharedRecords.maxSize,
  ttl: CACHE_CONFIG.nodePingSummary.sharedRecords.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
  canEvict: entry => entry.subscribers === 0 && !entry.promise,
})
const selectedPingTaskStatsCache = new SharedCache<SelectedPingTaskStatsEntry>({
  maxSize: CACHE_CONFIG.nodePingSummary.selectedStats.maxSize,
  ttl: CACHE_CONFIG.nodePingSummary.selectedStats.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
  canEvict: entry => entry.subscribers === 0 && !entry.promise,
})

interface TaskRecordSummary {
  total: number
  success: number
}

function createEmptyStats(): NodePingStatsState {
  return {
    avgLatency: 0,
    avgLoss: 0,
    avgVolatility: 0,
    history: [],
    hasData: false,
  }
}

function average(values: number[]): number {
  if (!values.length)
    return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function weightedAverage(values: Array<{ value: number, weight: number }>): number {
  const weightedValues = values.filter(item => item.weight > 0)
  const totalWeight = weightedValues.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight)
    return 0

  return weightedValues.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeSelectedPingTaskId(value: unknown): string | null {
  const rawValue = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : ''
  if (!POSITIVE_INTEGER_TASK_ID_PATTERN.test(rawValue))
    return null

  const numericTaskId = Number(rawValue)
  if (!Number.isSafeInteger(numericTaskId) || numericTaskId <= 0)
    return null

  return String(numericTaskId)
}

function summarizeTaskRecords(records: PingRecord[]): Map<number, TaskRecordSummary> {
  const summaries = new Map<number, TaskRecordSummary>()

  for (const record of records) {
    const summary = summaries.get(record.task_id) ?? { total: 0, success: 0 }
    summary.total += 1
    if (record.value >= 0) {
      summary.success += 1
    }
    summaries.set(record.task_id, summary)
  }

  return summaries
}

function getIncludedTaskIds(records: PingRecord[]): Set<number> {
  const recordSummaries = summarizeTaskRecords(records)

  return new Set(
    [...recordSummaries.entries()]
      .filter(([, summary]) => summary.total > 0)
      .map(([taskId]) => taskId),
  )
}

function getCacheKey(uuid: string, hours: number, maxCount?: number): string {
  return `${CACHE_KEY_PREFIX}:${uuid}:${hours}:${maxCount ?? 'all'}`
}

function getSharedPingRecordsKey(hours: number, maxCount?: number, uuid?: string): string {
  return `${uuid?.trim() || 'all'}:${hours}:${maxCount ?? 'all'}`
}

function getSelectedPingTaskStatsKey(uuid: string, hours: number, maxCount: number | undefined, taskId: string): string {
  return [
    SELECTED_CACHE_QUERY_VERSION,
    uuid.trim().toLowerCase(),
    taskId,
    hours,
    maxCount ?? 'all',
    HISTORY_BUCKET_COUNT,
  ].join(':')
}

function getSelectedPersistentCacheKey(
  uuid: string,
  hours: number,
  maxCount: number | undefined,
  taskId: string,
): string {
  return `${SELECTED_CACHE_KEY_PREFIX}:${getSelectedPingTaskStatsKey(uuid, hours, maxCount, taskId)}`
}

function getAlignedPingHistoryWindow(hours: number): PingTimeWindow {
  const window = createNextAlignedPingTimeWindow(Date.now(), hours, HISTORY_BUCKET_COUNT)
  if (!window)
    throw new Error('Invalid Ping history window')
  return window
}

function isValidHistoryPoint(value: unknown): value is NodePingHistoryPoint {
  if (!value || typeof value !== 'object')
    return false

  const point = value as Record<string, unknown>
  const latency = point.latency
  const loss = point.loss

  return typeof point.time === 'string'
    && (latency === null || typeof latency === 'number')
    && (loss === null || typeof loss === 'number')
}

function isValidStatsState(value: unknown): value is NodePingStatsState {
  if (!value || typeof value !== 'object')
    return false

  const state = value as Record<string, unknown>
  return typeof state.avgLatency === 'number'
    && typeof state.avgLoss === 'number'
    && typeof state.avgVolatility === 'number'
    && typeof state.hasData === 'boolean'
    && Array.isArray(state.history)
    && state.history.every(isValidHistoryPoint)
}

function readStatsCache(uuid: string, hours: number, maxCount?: number): NodePingStatsState | null {
  if (typeof window === 'undefined')
    return null

  try {
    const raw = window.localStorage.getItem(getCacheKey(uuid, hours, maxCount))
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as { version?: number, stats?: unknown }
    if (parsed.version !== CACHE_VERSION || !isValidStatsState(parsed.stats))
      return null

    return parsed.stats
  }
  catch {
    return null
  }
}

function writeStatsCache(uuid: string, hours: number, maxCount: number | undefined, value: NodePingStatsState): void {
  if (typeof window === 'undefined')
    return

  try {
    window.localStorage.setItem(
      getCacheKey(uuid, hours, maxCount),
      JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        stats: value,
      }),
    )
  }
  catch {
  }
}

function isValidSelectedPingTaskSnapshot(value: unknown): value is SelectedPingTaskSnapshot {
  if (!value || typeof value !== 'object')
    return false

  const snapshot = value as Partial<SelectedPingTaskSnapshot>
  return isValidStatsState(snapshot.stats)
    && snapshot.stats.history.length === HISTORY_BUCKET_COUNT
    && isFiniteNumber(snapshot.latestSampleAt)
    && isFiniteNumber(snapshot.fetchedAt)
    && (snapshot.source === 'metric' || snapshot.source === 'legacy')
    && isFiniteNumber(snapshot.taskIntervalMs)
    && snapshot.taskIntervalMs > 0
    && typeof snapshot.stale === 'boolean'
}

function readSelectedStatsCache(
  uuid: string,
  hours: number,
  maxCount: number | undefined,
  taskId: string,
): SelectedPingTaskSnapshot | null {
  if (typeof window === 'undefined')
    return null

  const key = getSelectedPersistentCacheKey(uuid, hours, maxCount, taskId)
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as { version?: number, expiresAt?: number, snapshot?: unknown }
    if (parsed.version !== SELECTED_CACHE_VERSION
      || !isFiniteNumber(parsed.expiresAt)
      || parsed.expiresAt <= Date.now()
      || !isValidSelectedPingTaskSnapshot(parsed.snapshot)) {
      window.localStorage.removeItem(key)
      return null
    }

    return parsed.snapshot
  }
  catch {
    try {
      window.localStorage.removeItem(key)
    }
    catch {
    }
    return null
  }
}

function removeSelectedStatsCache(
  uuid: string,
  hours: number,
  maxCount: number | undefined,
  taskId: string,
): void {
  if (typeof window === 'undefined')
    return
  try {
    window.localStorage.removeItem(getSelectedPersistentCacheKey(uuid, hours, maxCount, taskId))
  }
  catch {
  }
}

function pruneSelectedStatsCache(): void {
  if (typeof window === 'undefined')
    return

  const entries: Array<{ key: string, fetchedAt: number }> = []
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index--) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(`${SELECTED_CACHE_KEY_PREFIX}:`))
        continue

      try {
        const raw = window.localStorage.getItem(key)
        const parsed = raw
          ? JSON.parse(raw) as { version?: number, expiresAt?: number, snapshot?: unknown }
          : null
        if (!parsed
          || parsed.version !== SELECTED_CACHE_VERSION
          || !isFiniteNumber(parsed.expiresAt)
          || parsed.expiresAt <= Date.now()
          || !isValidSelectedPingTaskSnapshot(parsed.snapshot)) {
          window.localStorage.removeItem(key)
          continue
        }
        entries.push({ key, fetchedAt: parsed.snapshot.fetchedAt })
      }
      catch {
        window.localStorage.removeItem(key)
      }
    }

    entries
      .sort((left, right) => right.fetchedAt - left.fetchedAt)
      .slice(CACHE_CONFIG.nodePingSummary.persistedSelectedStats.maxSize)
      .forEach(entry => window.localStorage.removeItem(entry.key))
  }
  catch {
  }
}

function writeSelectedStatsCache(
  uuid: string,
  hours: number,
  maxCount: number | undefined,
  taskId: string,
  snapshot: SelectedPingTaskSnapshot,
): void {
  if (typeof window === 'undefined')
    return

  try {
    window.localStorage.setItem(
      getSelectedPersistentCacheKey(uuid, hours, maxCount, taskId),
      JSON.stringify({
        version: SELECTED_CACHE_VERSION,
        expiresAt: Date.now() + CACHE_CONFIG.nodePingSummary.persistedSelectedStats.ttl,
        snapshot,
      }),
    )
    pruneSelectedStatsCache()
  }
  catch {
  }
}

function createSharedPingRecordsEntry(): SharedPingRecordsEntry {
  return {
    data: shallowRef<SharedPingRecordsState | null>(null),
    loading: ref(false),
    error: ref<string | null>(null),
    promise: null,
    refreshTimer: null,
    subscribers: 0,
    lastFetchedAt: 0,
    requestWindow: null,
  }
}

function getSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): SharedPingRecordsEntry {
  const key = getSharedPingRecordsKey(hours, maxCount, uuid)
  const cachedEntry = sharedPingRecordsCache.get(key)
  if (cachedEntry)
    return cachedEntry

  const nextEntry = createSharedPingRecordsEntry()
  sharedPingRecordsCache.set(key, nextEntry)
  return nextEntry
}

function buildRecordsByClient(records: PingRecord[]): Map<string, PingRecord[]> {
  const grouped = new Map<string, PingRecord[]>()

  for (const record of records) {
    if (!record.client || parsePingTimestampMs(record.time) === null)
      continue

    const clientRecords = grouped.get(record.client) ?? []
    clientRecords.push(record)
    grouped.set(record.client, clientRecords)
  }

  for (const clientRecords of grouped.values()) {
    clientRecords.sort(
      (left, right) => (parsePingTimestampMs(left.time) ?? 0) - (parsePingTimestampMs(right.time) ?? 0),
    )
  }

  return grouped
}

function normalizeTaskId(taskId: string): number {
  if (!taskId.trim())
    return Number.NaN

  const numericTaskId = Number(taskId)
  if (Number.isFinite(numericTaskId))
    return numericTaskId

  let hash = 0
  for (let index = 0; index < taskId.length; index++)
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0
  return Math.abs(hash)
}

async function loadPingMetricRecords(
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  window: PingTimeWindow,
  selectedTaskId?: string,
): Promise<SharedPingRecordsState | null> {
  const start = new Date(window.start).toISOString()
  const end = new Date(window.end).toISOString()
  const [statsResult, metricsResult] = await Promise.allSettled([
    loadPingMetricStats({
      entity_id: nodeUuid,
      ...(selectedTaskId ? { task_id: selectedTaskId } : {}),
      hours,
      start,
      end,
      max_points: maxCount,
    }),
    queryMetrics({
      metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
      entity_id: nodeUuid,
      ...(selectedTaskId ? { tags: { task_id: selectedTaskId } } : {}),
      hours,
      start,
      end,
      downsample: true,
      fill_empty: true,
      max_points: maxCount,
      aggregation: 'avg',
    }),
  ])

  const rawStats = statsResult.status === 'fulfilled'
    ? (statsResult.value.stats ?? []).filter(stat => stat.entity_id === nodeUuid)
    : []
  const stats = selectedTaskId
    ? rawStats.filter(stat => normalizeSelectedPingTaskId(stat.task_id) === selectedTaskId)
    : rawStats
  const metricRecords: PingRecord[] = []
  const metricLossPoints: MetricLossPoint[] = []
  const metricLossTaskIds = new Set<number>()
  const metricLatencyTaskIds = new Set<number>()

  if (metricsResult.status === 'fulfilled') {
    const seriesList = normalizeMetricSeriesList(metricsResult.value.series)
    for (const series of seriesList) {
      if (series.entity_id !== nodeUuid)
        continue

      const rawTaskId = pingTaskId(series)
      const canonicalTaskId = normalizeSelectedPingTaskId(rawTaskId)
      if (selectedTaskId && canonicalTaskId !== selectedTaskId)
        continue

      const taskId = normalizeTaskId(rawTaskId)
      if (!Number.isFinite(taskId))
        continue

      if (series.metric_key === PING_LOSS_METRIC) {
        for (const point of series.points) {
          const timestamp = parsePingTimestampMs(point.time)
          if (!isFiniteNumber(point.value) || timestamp === null || !isPingTimestampInWindow(timestamp, window))
            continue

          metricLossPoints.push({
            taskId: canonicalTaskId ?? rawTaskId,
            time: point.time,
            value: point.value,
            count: isFiniteNumber(point.count) && point.count > 0 ? point.count : 1,
          })
          metricLossTaskIds.add(taskId)
        }
        continue
      }

      if (!isPingMetric(series))
        continue

      for (const point of series.points) {
        const timestamp = parsePingTimestampMs(point.time)
        if (point.value === null || timestamp === null || !isPingTimestampInWindow(timestamp, window))
          continue

        metricRecords.push({
          client: series.entity_id,
          task_id: taskId,
          time: point.time,
          value: point.value,
        })
        metricLatencyTaskIds.add(taskId)
      }
    }
  }

  const recordsByClient = buildRecordsByClient(metricRecords)
  const exactLatencyTaskIds = new Set(
    stats
      .filter(stat => stat.total > 0 && stat.valid > 0 && (isFiniteNumber(stat.avg) || isFiniteNumber(stat.latest)))
      .map(stat => normalizeTaskId(stat.task_id)),
  )
  const exactLossTaskIds = new Set(
    stats
      .filter(stat => stat.total > 0 && !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => normalizeTaskId(stat.task_id)),
  )
  const hasCompleteLossSeries = exactLossTaskIds.size > 0
    && [...exactLossTaskIds].every(taskId => metricLossTaskIds.has(taskId))
  const hasCompleteLatencySeries = exactLatencyTaskIds.size > 0
    && [...exactLatencyTaskIds].every(taskId => metricLatencyTaskIds.has(taskId))
  if (!hasCompleteLatencySeries || !hasCompleteLossSeries)
    return null

  return {
    recordsByClient,
    source: 'metric',
    window,
    metricStats: stats,
    metricLossPoints,
  }
}

async function loadSharedPingRecords(
  entry: SharedPingRecordsEntry,
  hours: number,
  maxCount?: number,
  nodeUuid?: string,
  window = getAlignedPingHistoryWindow(hours),
): Promise<void> {
  if (entry.promise)
    return entry.promise

  entry.loading.value = true
  entry.error.value = null
  entry.requestWindow = window

  entry.promise = (async () => {
    try {
      const metricState = nodeUuid ? await loadPingMetricRecords(nodeUuid, hours, maxCount, window).catch(() => null) : null
      if (entry.subscribers === 0)
        return

      if (metricState) {
        entry.data.value = metricState
      }
      else {
        const records = await loadPingRecords(hours, maxCount, nodeUuid)
        entry.data.value = {
          recordsByClient: buildRecordsByClient(records),
          source: 'legacy',
          window,
        }
      }
      entry.lastFetchedAt = Date.now()
    }
    catch (err) {
      entry.error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      throw err
    }
    finally {
      entry.loading.value = false
      entry.promise = null
      entry.requestWindow = null
    }
  })()

  return entry.promise
}

function startSharedPingRecordsRefresh(entry: SharedPingRecordsEntry, hours: number, maxCount?: number, uuid?: string): void {
  if (entry.refreshTimer)
    return

  entry.refreshTimer = setInterval(() => {
    void loadSharedPingRecords(entry, hours, maxCount, uuid).catch(() => {})
  }, PING_RECORD_REFRESH_INTERVAL_MS)
}

function stopSharedPingRecordsRefresh(entry: SharedPingRecordsEntry): void {
  if (!entry.refreshTimer)
    return

  clearInterval(entry.refreshTimer)
  entry.refreshTimer = null
}

function abortSharedPingRecordsRequests(
  hours: number,
  maxCount: number | undefined,
  uuid: string | undefined,
  window: PingTimeWindow | null,
): void {
  abortPingRecords(hours, maxCount, uuid)
  if (!uuid)
    return

  const range = window
    ? { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() }
    : {}

  abortPingMetricStats({ entity_id: uuid, hours, max_points: maxCount, ...range })
  abortQueryMetrics({
    metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
    entity_id: uuid,
    hours,
    ...range,
    downsample: true,
    fill_empty: true,
    max_points: maxCount,
    aggregation: 'avg',
  })
}

function retainSharedPingRecordsEntry(hours: number, maxCount?: number, uuid?: string): () => void {
  const entry = getSharedPingRecordsEntry(hours, maxCount, uuid)
  entry.subscribers += 1
  startSharedPingRecordsRefresh(entry, hours, maxCount, uuid)

  let released = false
  return () => {
    if (released)
      return

    released = true
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0) {
      stopSharedPingRecordsRefresh(entry)
      abortSharedPingRecordsRequests(hours, maxCount, uuid, entry.requestWindow)
    }
  }
}

interface PingHistoryBucket {
  latencySum: number
  latencyCount: number
  totalCount: number
  lostCount: number
  metricLossSum: number
  metricLossCount: number
}

function buildPingHistory(
  records: PingRecord[],
  metricLossPoints: MetricLossPoint[] | undefined,
  window: PingTimeWindow,
): NodePingHistoryPoint[] {
  const buckets: PingHistoryBucket[] = []
  for (let index = 0; index < HISTORY_BUCKET_COUNT; index++) {
    buckets.push({
      latencySum: 0,
      latencyCount: 0,
      totalCount: 0,
      lostCount: 0,
      metricLossSum: 0,
      metricLossCount: 0,
    })
  }
  let hasRecords = false
  let hasMetricLossPoints = false

  for (const record of records) {
    const timestamp = parsePingTimestampMs(record.time)
    const bucketIndex = timestamp === null ? null : getPingTimeBucketIndex(timestamp, window)
    if (bucketIndex === null || !isFiniteNumber(record.value))
      continue

    const bucket = buckets[bucketIndex]
    if (!bucket)
      continue
    hasRecords = true
    bucket.totalCount += 1
    if (record.value >= 0) {
      bucket.latencySum += record.value
      bucket.latencyCount += 1
    }
    else {
      bucket.lostCount += 1
    }
  }

  for (const point of metricLossPoints ?? []) {
    const timestamp = parsePingTimestampMs(point.time)
    const bucketIndex = timestamp === null ? null : getPingTimeBucketIndex(timestamp, window)
    if (bucketIndex === null || !isFiniteNumber(point.value) || !isFiniteNumber(point.count) || point.count <= 0)
      continue

    const bucket = buckets[bucketIndex]
    if (!bucket)
      continue
    hasMetricLossPoints = true
    bucket.metricLossSum += point.value * point.count
    bucket.metricLossCount += point.count
  }

  if (!hasRecords && !hasMetricLossPoints)
    return []

  return buckets.map((bucket, index) => ({
    time: new Date(window.start + window.bucketWidth * index).toISOString(),
    latency: bucket.latencyCount ? bucket.latencySum / bucket.latencyCount : null,
    loss: metricLossPoints
      ? (bucket.metricLossCount ? bucket.metricLossSum / bucket.metricLossCount * 100 : null)
      : (bucket.totalCount ? bucket.lostCount / bucket.totalCount * 100 : null),
  }))
}

function getPercentile(values: number[], percentile: number): number | null {
  if (!values.length)
    return null

  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * percentile))
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = sorted[lowerIndex]
  const upperValue = sorted[upperIndex]

  if (lowerValue === undefined || upperValue === undefined)
    return null
  if (lowerIndex === upperIndex)
    return lowerValue

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex)
}

function buildStats(
  records: PingRecord[],
  metricStats: PingMetricTaskStats[] | undefined,
  metricLossPoints: MetricLossPoint[] | undefined,
  window: PingTimeWindow,
): NodePingStatsState {
  const statsWithSamples = (metricStats ?? []).filter(stat => stat.total > 0)
  if (statsWithSamples.length) {
    const history = buildPingHistory(records.filter(record => record.value >= 0), metricLossPoints, window)
    const latencyValues = statsWithSamples
      .flatMap(stat => stat.valid > 0 && isFiniteNumber(stat.avg)
        ? [{ value: stat.avg, weight: stat.valid }]
        : [])
    const latestLatencyValues = statsWithSamples
      .map(stat => stat.latest)
      .filter(isFiniteNumber)
    const lossValues = statsWithSamples
      .filter(stat => !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => ({ value: stat.loss, weight: stat.total }))
    const volatilityValues = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99_p50_ratio))
      .map(stat => ({ value: stat.p99_p50_ratio!, weight: stat.valid }))

    const avgLoss = weightedAverage(lossValues)

    return {
      avgLatency: latencyValues.length ? weightedAverage(latencyValues) : average(latestLatencyValues),
      avgLoss,
      avgVolatility: weightedAverage(volatilityValues),
      history,
      hasData: true,
    }
  }

  const includedTaskIds = getIncludedTaskIds(records)

  if (!includedTaskIds.size)
    return createEmptyStats()

  const filteredRecords = records.filter(record => includedTaskIds.has(record.task_id))
  const history = buildPingHistory(filteredRecords, undefined, window)
  const taskRecords = new Map<number, PingRecord[]>()

  for (const record of filteredRecords) {
    const currentRecords = taskRecords.get(record.task_id) ?? []
    currentRecords.push(record)
    taskRecords.set(record.task_id, currentRecords)
  }

  const latencyValues: number[] = []
  const taskLossValues: number[] = []
  const volatilityValues: number[] = []

  for (const recordsByTask of taskRecords.values()) {
    const validValues = recordsByTask
      .map(record => record.value)
      .filter(value => value >= 0)

    taskLossValues.push((recordsByTask.length - validValues.length) / recordsByTask.length * 100)

    if (!validValues.length)
      continue

    latencyValues.push(average(validValues))

    if (validValues.length > 1) {
      const p50 = getPercentile(validValues, 0.5)
      const p99 = getPercentile(validValues, 0.99)
      if (isFiniteNumber(p50) && isFiniteNumber(p99) && p50 > FULL_LOSS_EPSILON) {
        volatilityValues.push(p99 / p50)
      }
    }
  }

  const historyLatencyValues = history
    .map(point => point.latency)
    .filter(isFiniteNumber)
  const historyLossValues = history
    .map(point => point.loss)
    .filter(isFiniteNumber)

  const avgLatency = latencyValues.length ? average(latencyValues) : average(historyLatencyValues)
  const avgLoss = taskLossValues.length ? average(taskLossValues) : average(historyLossValues)
  const avgVolatility = average(volatilityValues)
  const hasData = history.length > 0 || latencyValues.length > 0 || taskLossValues.length > 0

  return {
    avgLatency,
    avgLoss,
    avgVolatility,
    history,
    hasData,
  }
}

interface BuiltSelectedPingStats {
  stats: NodePingStatsState
  latestSampleAt: number
}

function latestPingTimestamp(values: Array<{ time: string }>): number | null {
  let latest: number | null = null
  for (const value of values) {
    const timestamp = parsePingTimestampMs(value.time)
    if (timestamp !== null && (latest === null || timestamp > latest))
      latest = timestamp
  }
  return latest
}

function normalizeTaskIntervalMs(value: unknown): number {
  return isFiniteNumber(value) && value > 0
    ? Math.max(CACHE_CONFIG.nodePingSummary.refresh.schedulerTick, Math.floor(value * 1000))
    : CACHE_CONFIG.nodePingSummary.refresh.heartbeat
}

function buildSelectedMetricStats(
  state: SharedPingRecordsState | null,
  nodeUuid: string,
  selectedTaskId: string,
): BuiltSelectedPingStats | null {
  if (!state || state.source !== 'metric')
    return null

  const metricStats = (state.metricStats ?? []).filter((stat) => {
    return stat.entity_id === nodeUuid
      && normalizeSelectedPingTaskId(stat.task_id) === selectedTaskId
  })
  const hasLatency = metricStats.some((stat) => {
    return stat.total > 0
      && stat.valid > 0
      && (isFiniteNumber(stat.avg) || isFiniteNumber(stat.latest))
  })
  const hasExactLoss = metricStats.some((stat) => {
    return stat.total > 0
      && !stat.loss_approximate
      && isFiniteNumber(stat.loss)
  })
  const metricLossPoints = (state.metricLossPoints ?? []).filter(point => point.taskId === selectedTaskId)
  const records = (state.recordsByClient.get(nodeUuid) ?? []).filter((record) => {
    const timestamp = parsePingTimestampMs(record.time)
    return normalizeSelectedPingTaskId(record.task_id) === selectedTaskId
      && timestamp !== null
      && isPingTimestampInWindow(timestamp, state.window)
      && record.value >= 0
  })
  const hasRawLatency = records.length > 0
  const hasRawLoss = metricLossPoints.some((point) => {
    const timestamp = parsePingTimestampMs(point.time)
    return timestamp !== null && isPingTimestampInWindow(timestamp, state.window)
  })
  if (!hasLatency || !hasExactLoss || !hasRawLatency || !hasRawLoss)
    return null

  const selectedStats = buildStats(records, metricStats, metricLossPoints, state.window)
  const latestSampleAt = latestPingTimestamp([...records, ...metricLossPoints])
  return selectedStats.hasData
    && Number.isFinite(selectedStats.avgLatency)
    && Number.isFinite(selectedStats.avgLoss)
    && latestSampleAt !== null
    ? { stats: selectedStats, latestSampleAt }
    : null
}

function isSelectedLegacyPingRecord(value: unknown, nodeUuid: string, selectedTaskId: string): value is PingRecord {
  if (!value || typeof value !== 'object')
    return false

  const record = value as Partial<PingRecord>
  return record.client === nodeUuid
    && normalizeSelectedPingTaskId(record.task_id) === selectedTaskId
    && typeof record.time === 'string'
    && parsePingTimestampMs(record.time) !== null
    && isFiniteNumber(record.value)
}

function buildSelectedLegacyStats(
  records: unknown,
  nodeUuid: string,
  selectedTaskId: string,
  window: PingTimeWindow,
): BuiltSelectedPingStats | null {
  if (!Array.isArray(records))
    return null

  const selectedRecords = records.filter(record => isSelectedLegacyPingRecord(record, nodeUuid, selectedTaskId))
  const recordsInWindow = selectedRecords.filter((record) => {
    const timestamp = parsePingTimestampMs(record.time)
    return timestamp !== null && isPingTimestampInWindow(timestamp, window)
  })
  if (!recordsInWindow.some(record => record.value >= 0))
    return null

  const selectedStats = buildStats(recordsInWindow, undefined, undefined, window)
  const latestSampleAt = latestPingTimestamp(recordsInWindow)
  return selectedStats.hasData
    && Number.isFinite(selectedStats.avgLatency)
    && Number.isFinite(selectedStats.avgLoss)
    && latestSampleAt !== null
    ? { stats: selectedStats, latestSampleAt }
    : null
}

async function loadSelectedPingTaskStats(
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  selectedTaskId: string,
  window: PingTimeWindow,
): Promise<SelectedPingTaskLoadResult> {
  const catalog = await loadPublicPingTaskCatalog()
  const task = getAssignedPublicPingTask(catalog, selectedTaskId, nodeUuid)
  const taskIntervalMs = normalizeTaskIntervalMs(task?.interval)
  if (!task)
    return { snapshot: null, taskIntervalMs, bindingValid: false }

  const metricState = await loadPingMetricRecords(nodeUuid, hours, maxCount, window, selectedTaskId).catch(() => null)
  const metricStats = buildSelectedMetricStats(metricState, nodeUuid, selectedTaskId)
  if (metricStats) {
    return {
      snapshot: {
        ...metricStats,
        fetchedAt: Date.now(),
        source: 'metric',
        taskIntervalMs,
        stale: false,
      },
      taskIntervalMs,
      bindingValid: true,
    }
  }

  const legacyRecords = await loadPingRecords(hours, maxCount, nodeUuid).catch(() => null)
  const legacyStats = buildSelectedLegacyStats(legacyRecords, nodeUuid, selectedTaskId, window)
  return {
    snapshot: legacyStats
      ? {
          ...legacyStats,
          fetchedAt: Date.now(),
          source: 'legacy',
          taskIntervalMs,
          stale: false,
        }
      : null,
    taskIntervalMs,
    bindingValid: true,
  }
}

function createSelectedPingTaskStatsEntry(
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  selectedTaskId: string,
): SelectedPingTaskStatsEntry {
  const persistedSnapshot = readSelectedStatsCache(nodeUuid, hours, maxCount, selectedTaskId)
  const snapshot = persistedSnapshot
    ? {
        ...persistedSnapshot,
        stale: Date.now() - persistedSnapshot.latestSampleAt
          >= persistedSnapshot.taskIntervalMs * CACHE_CONFIG.nodePingSummary.refresh.staleAfterIntervals,
      }
    : null
  return {
    data: shallowRef(snapshot),
    loading: ref(false),
    error: ref<string | null>(null),
    status: ref(snapshot ? 'ready' : 'idle'),
    promise: null,
    subscribers: 0,
  }
}

function getSelectedPingTaskStatsEntry(
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  selectedTaskId: string,
): SelectedPingTaskStatsEntry {
  const key = getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
  const cachedEntry = selectedPingTaskStatsCache.get(key)
  if (cachedEntry)
    return cachedEntry

  const entry = createSelectedPingTaskStatsEntry(nodeUuid, hours, maxCount, selectedTaskId)
  selectedPingTaskStatsCache.set(key, entry)
  return entry
}

async function refreshSelectedPingTaskStatsEntry(
  entry: SelectedPingTaskStatsEntry,
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  selectedTaskId: string,
): Promise<PingRefreshOutcome> {
  const key = getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
  if (entry.promise)
    return entry.promise

  entry.loading.value = true
  entry.error.value = null
  if (!entry.data.value)
    entry.status.value = 'loading'

  entry.promise = loadSelectedPingTaskStats(
    nodeUuid,
    hours,
    maxCount,
    selectedTaskId,
    getAlignedPingHistoryWindow(hours),
  )
    .then((result) => {
      if (!result.bindingValid) {
        entry.data.value = null
        entry.status.value = 'fallback'
        removeSelectedStatsCache(nodeUuid, hours, maxCount, selectedTaskId)
        return {
          advanced: false,
          latestSampleAt: null,
          taskIntervalMs: result.taskIntervalMs,
        }
      }

      const current = entry.data.value
      const candidate = result.snapshot
      const advanced = candidate !== null
        && (current == null || candidate.latestSampleAt > current.latestSampleAt)

      if (advanced && candidate) {
        entry.data.value = candidate
        entry.status.value = 'ready'
        writeSelectedStatsCache(nodeUuid, hours, maxCount, selectedTaskId, candidate)
      }
      else if (current) {
        const taskIntervalMs = result.taskIntervalMs || current.taskIntervalMs
        const stale = Date.now() - current.latestSampleAt
          >= taskIntervalMs * CACHE_CONFIG.nodePingSummary.refresh.staleAfterIntervals
        if (current.stale !== stale) {
          entry.data.value = {
            ...current,
            taskIntervalMs,
            stale,
          }
        }
        entry.status.value = 'ready'
      }
      else {
        entry.status.value = 'fallback'
      }

      return {
        advanced,
        latestSampleAt: entry.data.value?.latestSampleAt ?? null,
        taskIntervalMs: result.taskIntervalMs,
      }
    })
    .catch((err): PingRefreshOutcome => {
      entry.error.value = err instanceof Error ? err.message : 'èŽ·å– Ping åŽ†å²å¤±è´¥'
      entry.status.value = entry.data.value ? 'ready' : 'fallback'
      return {
        advanced: false,
        latestSampleAt: entry.data.value?.latestSampleAt ?? null,
        taskIntervalMs: entry.data.value?.taskIntervalMs
          ?? CACHE_CONFIG.nodePingSummary.refresh.heartbeat,
      }
    })
    .finally(() => {
      entry.loading.value = false
      entry.promise = null
      selectedPingTaskStatsCache.set(key, entry)
    })

  return entry.promise
}

function retainSelectedPingTaskStatsEntry(
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  selectedTaskId: string,
): { entry: SelectedPingTaskStatsEntry, release: () => void } {
  const key = getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
  const entry = getSelectedPingTaskStatsEntry(nodeUuid, hours, maxCount, selectedTaskId)
  entry.subscribers += 1
  const subscription = pingRefreshScheduler.subscribe(
    key,
    () => refreshSelectedPingTaskStatsEntry(entry, nodeUuid, hours, maxCount, selectedTaskId),
    {
      latestSampleAt: entry.data.value?.latestSampleAt,
      taskIntervalMs: entry.data.value?.taskIntervalMs,
    },
  )

  let released = false
  return {
    entry,
    release: () => {
      if (released)
        return
      released = true
      subscription.release()
      entry.subscribers = Math.max(0, entry.subscribers - 1)
    },
  }
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    maxCount?: MaybeRefOrGetter<number | undefined>
    selectedTaskId?: MaybeRefOrGetter<string | number | undefined>
  },
) {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const selectedTaskEntry = shallowRef<SelectedPingTaskStatsEntry | null>(null)
  const selectedTaskEntryKey = ref<string | null>(null)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? PING_RECORD_MAX_COUNT)
    const rawSelectedTaskId = toValue(options?.selectedTaskId)
    const configuredTaskId = typeof rawSelectedTaskId === 'string'
      ? rawSelectedTaskId.trim()
      : typeof rawSelectedTaskId === 'number' && Number.isFinite(rawSelectedTaskId)
        ? String(rawSelectedTaskId)
        : ''
    return {
      uuid: toValue(uuid),
      hours,
      maxCount,
      cacheKey: getSharedPingRecordsKey(hours, maxCount, toValue(uuid)),
      enabled: toValue(options?.enabled) ?? true,
      configuredTaskId,
      selectedTaskId: normalizeSelectedPingTaskId(configuredTaskId),
    }
  })

  let activeCacheKey: string | null = null
  let releaseSharedRecords: (() => void) | null = null
  let releaseSelectedTaskStats: (() => void) | null = null

  function syncSharedRecordsSubscription(hours: number | null, maxCount?: number, uuid?: string): void {
    const cacheKey = hours === null ? null : getSharedPingRecordsKey(hours, maxCount, uuid)
    if (activeCacheKey === cacheKey)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeCacheKey = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedPingRecordsEntry(hours, maxCount, uuid)
    activeCacheKey = cacheKey
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
    releaseSelectedTaskStats?.()
    releaseSelectedTaskStats = null
  })

  // stats 由共享 getRecords 结果派生；共享记录每分钟刷新一次后会自动重算。
  async function refreshAggregateStats(
    nodeUuid: string,
    hours: number,
    maxCount: number | undefined,
  ): Promise<void> {
    syncSharedRecordsSubscription(hours, maxCount, nodeUuid)
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const shouldLoadRecords = !entry.data.value
      || Date.now() - entry.lastFetchedAt >= PING_RECORD_REFRESH_INTERVAL_MS

    if (!shouldLoadRecords) {
      loading.value = false
      error.value = null
      return
    }

    loading.value = !entry.data.value
    error.value = null
    try {
      await loadSharedPingRecords(entry, hours, maxCount, nodeUuid)
    }
    finally {
      loading.value = false
    }
  }

  function buildAggregateStats(
    nodeUuid: string,
    hours: number,
    maxCount: number | undefined,
  ): NodePingStatsState {
    const state = getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value
    if (!state)
      return createEmptyStats()

    const records = state.recordsByClient.get(nodeUuid) ?? []
    return records.length || state.metricStats?.length
      ? buildStats(records, state.metricStats, state.metricLossPoints, state.window)
      : createEmptyStats()
  }

  const stats = computed<NodePingStatsState>(() => {
    const { uuid: nodeUuid, hours, maxCount, enabled, configuredTaskId, selectedTaskId } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return createEmptyStats()

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    if (!configuredTaskId) {
      const aggregateStats = buildAggregateStats(nodeUuid, hours, maxCount)
      return aggregateStats.hasData
        ? aggregateStats
        : readStatsCache(nodeUuid, hours, maxCount) ?? createEmptyStats()
    }

    if (!selectedTaskId) {
      return buildAggregateStats(nodeUuid, hours, maxCount)
    }

    const selectedTaskKey = getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
    const entry = selectedTaskEntryKey.value === selectedTaskKey
      ? selectedTaskEntry.value
      : null
    if (entry?.data.value)
      return entry.data.value.stats

    if (!entry || entry.status.value === 'loading' || entry.status.value === 'idle')
      return createEmptyStats()

    return buildAggregateStats(nodeUuid, hours, maxCount)
  })

  // 副作用：按需触发首次共享加载并维护 loading/error，不再命令式写入 stats。
  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, maxCount, enabled, configuredTaskId, selectedTaskId } = next
      if (!enabled || !nodeUuid.trim()) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      if (configuredTaskId && selectedTaskId) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        error.value = null
        return
      }

      try {
        await refreshAggregateStats(nodeUuid, hours, maxCount)
      }
      catch (err) {
        if (!cancelled)
          error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
      }
    },
    { immediate: true },
  )

  watch(
    () => {
      const { uuid: nodeUuid, hours, maxCount, enabled, configuredTaskId, selectedTaskId } = resolved.value
      return [nodeUuid, hours, maxCount, enabled, configuredTaskId, selectedTaskId] as const
    },
    ([nodeUuid, hours, maxCount, enabled, configuredTaskId, selectedTaskId], _previous, onCleanup) => {
      releaseSelectedTaskStats?.()
      releaseSelectedTaskStats = null
      selectedTaskEntry.value = null
      selectedTaskEntryKey.value = null

      if (!enabled || !nodeUuid.trim() || !configuredTaskId)
        return

      if (!selectedTaskId)
        return

      const selectedTaskKey = getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
      const retained = retainSelectedPingTaskStatsEntry(nodeUuid, hours, maxCount, selectedTaskId)
      selectedTaskEntry.value = retained.entry
      selectedTaskEntryKey.value = selectedTaskKey
      releaseSelectedTaskStats = retained.release
      let cancelled = false
      const stopFallbackWatch = watch(
        [retained.entry.status, retained.entry.data],
        async ([status, snapshot]) => {
          if (cancelled)
            return
          if (snapshot) {
            syncSharedRecordsSubscription(null)
            return
          }
          if (status !== 'fallback')
            return

          try {
            await refreshAggregateStats(nodeUuid, hours, maxCount)
          }
          catch (err) {
            if (!cancelled)
              error.value = err instanceof Error ? err.message : '获取 Ping 历史失败'
          }
        },
        { immediate: true },
      )

      onCleanup(() => {
        cancelled = true
        stopFallbackWatch()
        if (releaseSelectedTaskStats === retained.release) {
          releaseSelectedTaskStats()
          releaseSelectedTaskStats = null
        }
      })
    },
    { immediate: true },
  )

  // 共享记录会定时刷新，节流回写 localStorage，避免多节点同时重算时密集写盘。
  const persistStats = useThrottleFn(
    (nodeUuid: string, hours: number, maxCount: number | undefined, value: NodePingStatsState) => {
      writeStatsCache(nodeUuid, hours, maxCount, value)
    },
    30_000,
    true,
    true,
  )

  watch(stats, (value) => {
    if (!value.hasData)
      return
    const { uuid: nodeUuid, hours, maxCount, enabled, configuredTaskId } = resolved.value
    if (enabled && nodeUuid.trim() && !configuredTaskId)
      persistStats(nodeUuid, hours, maxCount, value)
  })

  const isLoading = computed(() => {
    const { uuid: nodeUuid, hours, maxCount, selectedTaskId } = resolved.value
    const selectedTaskKey = selectedTaskId
      ? getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
      : null
    const entry = selectedTaskEntryKey.value === selectedTaskKey
      ? selectedTaskEntry.value
      : null
    return loading.value || !!(entry && !entry.data.value && entry.loading.value)
  })

  const effectiveError = computed(() => selectedTaskEntry.value?.error.value ?? error.value)

  return {
    stats,
    loading: isLoading,
    error: effectiveError,
    stale: computed(() => selectedTaskEntry.value?.data.value?.stale ?? false),
    history: computed(() => stats.value.history),
    avgLatency: computed(() => stats.value.avgLatency),
    avgLoss: computed(() => stats.value.avgLoss),
    avgVolatility: computed(() => stats.value.avgVolatility),
    hasData: computed(() => stats.value.hasData),
  }
}
