import type { MaybeRefOrGetter } from 'vue'
import type { PingRefreshOutcome, PingRefreshSubscription } from '@/services/ping-refresh-scheduler.service'
import type { PingHistoryBucketState } from '@/utils/pingHistoryState'
import type { PingTimeWindow } from '@/utils/pingTime'
import type { PingMetricTaskStats } from '@/utils/rpc'
import { useThrottleFn } from '@vueuse/core'
import { computed, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'
import { CACHE_CONFIG } from '@/constants/cache'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import { SharedCache } from '@/services/cache.service'
import { abortPingRecords, loadPingRecords } from '@/services/history.service'
import { abortPingMetricStats, abortQueryMetrics, getAssignedPublicPingTask, getCachedRawPingMetricSeries, loadPingMetricStats, loadPublicPingTaskCatalog, queryMetrics } from '@/services/metrics.service'
import { pingRefreshScheduler } from '@/services/ping-refresh-scheduler.service'
import { isPingMetric, normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { resolvePingHistoryBucketState } from '@/utils/pingHistoryState'
import { createNextAlignedPingTimeWindow, getPingTimeBucketIndex, isPingTimestampInWindow, parsePingTimestampMs } from '@/utils/pingTime'

export interface NodePingHistoryPoint {
  /** Stable three-minute bucket identity/start; never rewrite this to a sample timestamp. */
  time: string
  latency: number | null
  loss: number | null
  /** Latest real observation included in this bucket for the rendered metric. */
  latencySampleTime: string | null
  lossSampleTime: string | null
  latencyState: PingHistoryBucketState
  lossState: PingHistoryBucketState
}

export type { PingHistoryBucketState } from '@/utils/pingHistoryState'

export interface NodePingStatsState {
  avgLatency: number | null
  avgLoss: number | null
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
  latestSampleAt: number | null
  firstObservedAt: number
  taskIntervalMs: number
  canConfirmMissing: boolean
  metricQueryError?: string | null
  metricStats?: PingMetricTaskStats[]
  metricLossPoints?: MetricLossPoint[]
}

interface SharedPingRecordsEntry {
  data: ReturnType<typeof shallowRef<SharedPingRecordsState | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  promise: Promise<void> | null
  schedulerSubscription: PingRefreshSubscription | null
  subscribers: number
  requestWindow: PingTimeWindow | null
}

type SelectedPingTaskSource = 'metric' | 'legacy'

interface SelectedPingTaskSnapshot {
  stats: NodePingStatsState
  latestSampleAt: number | null
  windowStart: number
  windowEnd: number
  firstObservedAt: number
  fetchedAt: number
  source: SelectedPingTaskSource
  taskIntervalMs: number
  canConfirmMissing: boolean
  stale: boolean
}

interface SelectedPingTaskLoadResult {
  snapshot: SelectedPingTaskSnapshot | null
  taskIntervalMs: number
  bindingState: SelectedPingTaskBindingState
  error: string | null
}

type SelectedPingTaskBindingState = 'unknown' | 'valid' | 'invalid'

interface SelectedPingTaskStatsEntry {
  data: ReturnType<typeof shallowRef<SelectedPingTaskSnapshot | null>>
  loading: ReturnType<typeof ref<boolean>>
  error: ReturnType<typeof ref<string | null>>
  status: ReturnType<typeof ref<'idle' | 'loading' | 'ready' | 'empty' | 'fallback'>>
  bindingState: ReturnType<typeof ref<SelectedPingTaskBindingState>>
  promise: Promise<PingRefreshOutcome> | null
  subscribers: number
}

const HISTORY_BUCKET_COUNT = CACHE_CONFIG.nodePingSummary.historyBucketCount
const CACHE_VERSION = 12
const CACHE_KEY_PREFIX = 'komari-theme-emerald:node-ping-stats'
const SELECTED_CACHE_VERSION = 5
const SELECTED_CACHE_QUERY_VERSION = 'metric-window-v5'
const SELECTED_CACHE_KEY_PREFIX = 'komari-theme-emerald:selected-node-ping-stats'
const FULL_LOSS_EPSILON = 1e-6
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
    avgLatency: null,
    avgLoss: null,
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

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
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
  const latencySampleTime = point.latencySampleTime
  const lossSampleTime = point.lossSampleTime
  const latencyState = point.latencyState
  const lossState = point.lossState

  return typeof point.time === 'string'
    && (latency === null || typeof latency === 'number')
    && (loss === null || typeof loss === 'number')
    && isNullablePingSampleTime(latencySampleTime)
    && isNullablePingSampleTime(lossSampleTime)
    && isPingHistoryBucketState(latencyState)
    && isPingHistoryBucketState(lossState)
}

function isNullablePingSampleTime(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && parsePingTimestampMs(value) !== null)
}

function isPingHistoryBucketState(value: unknown): value is PingHistoryBucketState {
  return value === 'pending' || value === 'data' || value === 'confirmed-missing'
}

function isValidStatsState(value: unknown): value is NodePingStatsState {
  if (!value || typeof value !== 'object')
    return false

  const state = value as Record<string, unknown>
  return isNullableFiniteNumber(state.avgLatency)
    && isNullableFiniteNumber(state.avgLoss)
    && typeof state.avgVolatility === 'number'
    && typeof state.hasData === 'boolean'
    && Array.isArray(state.history)
    && state.history.every(isValidHistoryPoint)
}

function readStatsCache(uuid: string, hours: number, maxCount?: number): NodePingStatsState | null {
  if (typeof window === 'undefined')
    return null

  const activeWindow = getAlignedPingHistoryWindow(hours)
  const activeWindowStart = new Date(activeWindow.start).toISOString()
  try {
    const raw = window.localStorage.getItem(getCacheKey(uuid, hours, maxCount))
    if (!raw)
      return null

    const parsed = JSON.parse(raw) as {
      version?: number
      expiresAt?: number
      windowStart?: string
      stats?: unknown
    }
    if (parsed.version !== CACHE_VERSION
      || !isFiniteNumber(parsed.expiresAt)
      || parsed.expiresAt <= Date.now()
      || parsed.windowStart !== activeWindowStart
      || !isValidStatsState(parsed.stats)) {
      window.localStorage.removeItem(getCacheKey(uuid, hours, maxCount))
      return null
    }

    return parsed.stats
  }
  catch {
    return null
  }
}

function writeStatsCache(uuid: string, hours: number, maxCount: number | undefined, value: NodePingStatsState): void {
  if (typeof window === 'undefined')
    return

  const windowStart = value.history[0]?.time
  if (!windowStart)
    return

  try {
    window.localStorage.setItem(
      getCacheKey(uuid, hours, maxCount),
      JSON.stringify({
        version: CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        expiresAt: Date.now() + CACHE_CONFIG.nodePingSummary.historyBucketAlignment,
        windowStart,
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
    && (snapshot.latestSampleAt === null || isFiniteNumber(snapshot.latestSampleAt))
    && isFiniteNumber(snapshot.windowStart)
    && isFiniteNumber(snapshot.windowEnd)
    && snapshot.windowEnd > snapshot.windowStart
    && isFiniteNumber(snapshot.firstObservedAt)
    && isFiniteNumber(snapshot.fetchedAt)
    && (snapshot.source === 'metric' || snapshot.source === 'legacy')
    && isFiniteNumber(snapshot.taskIntervalMs)
    && snapshot.taskIntervalMs > 0
    && typeof snapshot.canConfirmMissing === 'boolean'
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
    schedulerSubscription: null,
    subscribers: 0,
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

function hasRawPingSamples(state: SharedPingRecordsState): boolean {
  return [...state.recordsByClient.values()].some(records => records.length > 0)
    || (state.metricLossPoints?.length ?? 0) > 0
}

function createLegacyPingRecordsState(
  records: PingRecord[],
  window: PingTimeWindow,
  firstObservedAt: number,
): SharedPingRecordsState {
  return {
    recordsByClient: buildRecordsByClient(records),
    source: 'legacy',
    window,
    latestSampleAt: latestPingTimestamp(records),
    firstObservedAt,
    taskIntervalMs: CACHE_CONFIG.nodePingSummary.refresh.heartbeat,
    canConfirmMissing: true,
  }
}

function createUnavailablePingRecordsState(
  window: PingTimeWindow,
  firstObservedAt: number,
): SharedPingRecordsState {
  return {
    recordsByClient: new Map(),
    source: 'metric',
    window,
    latestSampleAt: null,
    firstObservedAt,
    taskIntervalMs: CACHE_CONFIG.nodePingSummary.refresh.heartbeat,
    canConfirmMissing: false,
  }
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
  firstObservedAt = Date.now(),
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
  const cachedMetricSeries = getCachedRawPingMetricSeries(nodeUuid, start, end)
  const rawMetricSeries = cachedMetricSeries ?? (
    metricsResult.status === 'fulfilled' ? metricsResult.value.series : null
  )

  if (rawMetricSeries) {
    const seriesList = normalizeMetricSeriesList(rawMetricSeries)
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
      }
    }
  }

  const recordsByClient = buildRecordsByClient(metricRecords)
  // A latency sample is still real data when the independently-written loss
  // series arrives later. The Detail chart may have already returned those raw
  // samples for this exact window, so keep them on a transient NodeCard query
  // failure. A cached response is data only, never proof that an unseen bucket
  // is permanently missing.
  if (!rawMetricSeries)
    return null

  const taskIntervals = stats
    .map(stat => stat.interval)
    .filter((interval): interval is number => isFiniteNumber(interval) && interval > 0)
  const taskIntervalMs = taskIntervals.length
    ? Math.min(...taskIntervals) * 1000
    : CACHE_CONFIG.nodePingSummary.refresh.heartbeat

  return {
    recordsByClient,
    source: 'metric',
    window,
    latestSampleAt: latestPingTimestamp([...metricRecords, ...metricLossPoints]),
    firstObservedAt,
    taskIntervalMs,
    canConfirmMissing: metricsResult.status === 'fulfilled',
    metricQueryError: metricsResult.status === 'rejected'
      ? metricsResult.reason instanceof Error ? metricsResult.reason.message : '获取 Ping Metric 失败'
      : null,
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
    const previousState = entry.data.value
    const firstObservedAt = previousState?.window.start === window.start
      ? previousState.firstObservedAt
      : Date.now()
    let metricState: SharedPingRecordsState | null = null
    let metricError: Error | null = null
    let legacyState: SharedPingRecordsState | null = null
    let legacyError: Error | null = null

    try {
      if (nodeUuid) {
        try {
          metricState = await loadPingMetricRecords(nodeUuid, hours, maxCount, window, undefined, firstObservedAt)
        }
        catch (error) {
          metricError = error instanceof Error ? error : new Error('获取 Ping Metric 失败')
        }
      }

      if (entry.subscribers === 0)
        return

      if (metricState && hasRawPingSamples(metricState)) {
        entry.error.value = metricState.metricQueryError ?? null
        entry.data.value = metricState
        return
      }

      try {
        const records = await loadPingRecords(hours, maxCount, nodeUuid)
        legacyState = createLegacyPingRecordsState(records, window, firstObservedAt)
      }
      catch (error) {
        legacyError = error instanceof Error ? error : new Error('获取 Ping 历史失败')
      }

      if (entry.subscribers === 0)
        return

      // A successful empty Legacy response can make a real missing-data
      // decision when the Metric transport failed. Do not let a cache-backed
      // Metric placeholder discard that successful evidence.
      if (legacyState && (hasRawPingSamples(legacyState) || !metricState || !metricState.canConfirmMissing)) {
        entry.data.value = legacyState
        return
      }

      if (metricState) {
        entry.error.value = metricState.metricQueryError ?? legacyError?.message ?? null
        entry.data.value = metricState
        return
      }

      // Neither transport established an empty raw response. Retain a
      // same-window snapshot when possible and mark its unknown buckets as
      // pending; a network error is never proof of missing telemetry.
      entry.error.value = metricError?.message ?? legacyError?.message ?? '获取 Ping 历史失败'
      entry.data.value = previousState?.window.start === window.start
        ? { ...previousState, canConfirmMissing: false }
        : createUnavailablePingRecordsState(window, firstObservedAt)
    }
    finally {
      entry.loading.value = false
      entry.promise = null
      entry.requestWindow = null
    }
  })()

  return entry.promise
}

async function refreshSharedPingRecordsEntry(
  entry: SharedPingRecordsEntry,
  hours: number,
  maxCount?: number,
  uuid?: string,
): Promise<PingRefreshOutcome> {
  const previousLatestSampleAt = entry.data.value?.latestSampleAt ?? null
  await loadSharedPingRecords(entry, hours, maxCount, uuid)
  const nextState = entry.data.value
  const latestSampleAt = nextState?.latestSampleAt ?? previousLatestSampleAt
  return {
    advanced: latestSampleAt !== null && (previousLatestSampleAt === null || latestSampleAt > previousLatestSampleAt),
    latestSampleAt,
    taskIntervalMs: nextState?.taskIntervalMs ?? CACHE_CONFIG.nodePingSummary.refresh.heartbeat,
  }
}

function startSharedPingRecordsRefresh(entry: SharedPingRecordsEntry, hours: number, maxCount?: number, uuid?: string): void {
  if (entry.schedulerSubscription)
    return

  const key = `aggregate:${getSharedPingRecordsKey(hours, maxCount, uuid)}`
  entry.schedulerSubscription = pingRefreshScheduler.subscribe(
    key,
    () => refreshSharedPingRecordsEntry(entry, hours, maxCount, uuid),
    {
      latestSampleAt: entry.data.value?.latestSampleAt,
      taskIntervalMs: entry.data.value?.taskIntervalMs,
    },
  )
}

function stopSharedPingRecordsRefresh(entry: SharedPingRecordsEntry): void {
  entry.schedulerSubscription?.release()
  entry.schedulerSubscription = null
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
  latencySampleAt: number | null
  lossSampleAt: number | null
}

interface PingHistoryTiming {
  latestAcceptedSampleAt?: number | null
  firstObservedAt?: number
  taskIntervalMs?: number
  canConfirmMissing?: boolean
  now?: number
}

function hasHistoryData(history: NodePingHistoryPoint[]): boolean {
  return history.some(point => point.latencyState === 'data' || point.lossState === 'data')
}

function buildPingHistory(
  records: PingRecord[],
  metricLossPoints: MetricLossPoint[] | undefined,
  window: PingTimeWindow,
  timing: PingHistoryTiming = {},
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
      latencySampleAt: null,
      lossSampleAt: null,
    })
  }
  for (const record of records) {
    const timestamp = parsePingTimestampMs(record.time)
    if (timestamp === null || !isFiniteNumber(record.value))
      continue

    const bucketIndex = getPingTimeBucketIndex(timestamp, window)
    if (bucketIndex === null)
      continue

    const bucket = buckets[bucketIndex]
    if (!bucket)
      continue
    bucket.totalCount += 1
    bucket.latencySampleAt = Math.max(bucket.latencySampleAt ?? Number.NEGATIVE_INFINITY, timestamp)
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
    if (timestamp === null || !isFiniteNumber(point.value) || !isFiniteNumber(point.count) || point.count <= 0)
      continue

    const bucketIndex = getPingTimeBucketIndex(timestamp, window)
    if (bucketIndex === null)
      continue

    const bucket = buckets[bucketIndex]
    if (!bucket)
      continue
    bucket.metricLossSum += point.value * point.count
    bucket.metricLossCount += point.count
    bucket.lossSampleAt = Math.max(bucket.lossSampleAt ?? Number.NEGATIVE_INFINITY, timestamp)
  }

  const latestAcceptedSampleAt = timing.latestAcceptedSampleAt
    ?? latestPingTimestamp([...records, ...(metricLossPoints ?? [])])
  const taskIntervalMs = timing.taskIntervalMs ?? CACHE_CONFIG.nodePingSummary.refresh.heartbeat
  const now = timing.now ?? Date.now()
  const firstObservedAt = timing.firstObservedAt ?? now
  const canConfirmMissing = timing.canConfirmMissing ?? true

  return buckets.map((bucket, index) => {
    const bucketStart = window.start + window.bucketWidth * index
    const bucketEnd = bucketStart + window.bucketWidth
    const latency = bucket.latencyCount ? bucket.latencySum / bucket.latencyCount : null
    const loss = metricLossPoints
      ? (bucket.metricLossCount ? bucket.metricLossSum / bucket.metricLossCount * 100 : null)
      : (bucket.totalCount ? bucket.lostCount / bucket.totalCount * 100 : null)
    // A failed probe is still an observed sample. Do not turn 100% packet loss
    // into a false “no sample” latency bucket merely because latency is null.
    const hasLatencyObservation = bucket.latencyCount > 0
      || bucket.totalCount > 0
      || bucket.metricLossCount > 0
    const latencyState = resolvePingHistoryBucketState(hasLatencyObservation, {
      bucketStart,
      bucketEnd,
      now,
      latestAcceptedSampleAt,
      firstObservedAt,
      taskIntervalMs,
      canConfirmMissing,
    })
    const lossState = resolvePingHistoryBucketState(loss !== null, {
      bucketStart,
      bucketEnd,
      now,
      latestAcceptedSampleAt,
      firstObservedAt,
      taskIntervalMs,
      canConfirmMissing,
    })
    // A full-loss raw Metric observation has no latency value, yet it still
    // proves that a probe happened. Reuse that *real* loss timestamp only for
    // this explicit latency-unavailable case; never manufacture a bucket time.
    const latencySampleAt = bucket.latencySampleAt ?? bucket.lossSampleAt
    const lossSampleAt = metricLossPoints ? bucket.lossSampleAt : bucket.latencySampleAt

    return {
      time: new Date(bucketStart).toISOString(),
      latency,
      loss,
      latencySampleTime: latencyState === 'data' && latencySampleAt !== null
        ? new Date(latencySampleAt).toISOString()
        : null,
      lossSampleTime: lossState === 'data' && lossSampleAt !== null
        ? new Date(lossSampleAt).toISOString()
        : null,
      latencyState,
      lossState,
    }
  })
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
  timing: PingHistoryTiming = {},
): NodePingStatsState {
  const statsWithSamples = (metricStats ?? []).filter(stat => stat.total > 0)
  if (statsWithSamples.length) {
    const history = buildPingHistory(records.filter(record => record.value >= 0), metricLossPoints, window, timing)
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

    const avgLatency = latencyValues.length
      ? weightedAverage(latencyValues)
      : latestLatencyValues.length ? average(latestLatencyValues) : null
    const avgLoss = lossValues.length ? weightedAverage(lossValues) : null

    return {
      avgLatency,
      avgLoss,
      avgVolatility: weightedAverage(volatilityValues),
      history,
      hasData: hasHistoryData(history) || avgLatency !== null || avgLoss !== null,
    }
  }

  const includedTaskIds = getIncludedTaskIds(records)

  if (!includedTaskIds.size) {
    const history = buildPingHistory([], metricLossPoints, window, timing)
    return {
      avgLatency: null,
      avgLoss: null,
      avgVolatility: 0,
      history,
      hasData: hasHistoryData(history),
    }
  }

  const filteredRecords = records.filter(record => includedTaskIds.has(record.task_id))
  // When Metric task summaries are temporarily unavailable, the timestamped
  // raw loss series is still authoritative telemetry. Keeping it here avoids
  // deriving a false 0% loss value from latency-only records during a failed
  // refresh (for example after the selected-task snapshot has been accepted).
  const history = buildPingHistory(filteredRecords, metricLossPoints, window, timing)
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

  const avgLatency = latencyValues.length
    ? average(latencyValues)
    : historyLatencyValues.length ? average(historyLatencyValues) : null
  const avgLoss = metricLossPoints
    ? metricLossPoints.length
      ? weightedAverage(metricLossPoints.map(point => ({
          value: point.value * 100,
          weight: point.count,
        })))
      : null
    : taskLossValues.length
      ? average(taskLossValues)
      : historyLossValues.length ? average(historyLossValues) : null
  const avgVolatility = average(volatilityValues)
  const hasData = hasHistoryData(history) || avgLatency !== null || avgLoss !== null

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
  latestSampleAt: number | null
  hasRawSample: boolean
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
  taskIntervalMs: number,
): BuiltSelectedPingStats | null {
  if (!state || state.source !== 'metric')
    return null

  const metricStats = (state.metricStats ?? []).filter((stat) => {
    return stat.entity_id === nodeUuid
      && normalizeSelectedPingTaskId(stat.task_id) === selectedTaskId
  })
  const metricLossPoints = (state.metricLossPoints ?? []).filter(point => point.taskId === selectedTaskId)
  const records = (state.recordsByClient.get(nodeUuid) ?? []).filter((record) => {
    const timestamp = parsePingTimestampMs(record.time)
    return normalizeSelectedPingTaskId(record.task_id) === selectedTaskId
      && timestamp !== null
      && isPingTimestampInWindow(timestamp, state.window)
      && record.value >= 0
  })
  const latestSampleAt = latestPingTimestamp([...records, ...metricLossPoints])
  const selectedStats = buildStats(records, metricStats, metricLossPoints, state.window, {
    latestAcceptedSampleAt: latestSampleAt,
    firstObservedAt: state.firstObservedAt,
    taskIntervalMs,
    canConfirmMissing: state.canConfirmMissing,
  })
  return {
    stats: selectedStats,
    latestSampleAt,
    hasRawSample: records.length > 0 || metricLossPoints.length > 0,
  }
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
  taskIntervalMs: number,
  firstObservedAt: number,
  canConfirmMissing = true,
): BuiltSelectedPingStats | null {
  if (!Array.isArray(records))
    return null

  const selectedRecords = records.filter(record => isSelectedLegacyPingRecord(record, nodeUuid, selectedTaskId))
  const recordsInWindow = selectedRecords.filter((record) => {
    const timestamp = parsePingTimestampMs(record.time)
    return timestamp !== null && isPingTimestampInWindow(timestamp, window)
  })
  const latestSampleAt = latestPingTimestamp(recordsInWindow)
  return {
    stats: buildStats(recordsInWindow, undefined, undefined, window, {
      latestAcceptedSampleAt: latestSampleAt,
      firstObservedAt,
      taskIntervalMs,
      canConfirmMissing,
    }),
    latestSampleAt,
    hasRawSample: recordsInWindow.length > 0,
  }
}

async function loadSelectedPingTaskStats(
  nodeUuid: string,
  hours: number,
  maxCount: number | undefined,
  selectedTaskId: string,
  window: PingTimeWindow,
  firstObservedAt: number,
): Promise<SelectedPingTaskLoadResult> {
  let catalogError: Error | null = null
  let task: ReturnType<typeof getAssignedPublicPingTask> | undefined
  try {
    const catalog = await loadPublicPingTaskCatalog()
    task = getAssignedPublicPingTask(catalog, selectedTaskId, nodeUuid)
  }
  catch (error) {
    catalogError = error instanceof Error ? error : new Error('获取 Ping 任务目录失败')
  }

  const taskIntervalMs = normalizeTaskIntervalMs(task?.interval)
  if (!catalogError && !task)
    return { snapshot: null, taskIntervalMs, bindingState: 'invalid', error: null }

  let metricState: SharedPingRecordsState | null = null
  let metricError: Error | null = null
  try {
    metricState = await loadPingMetricRecords(
      nodeUuid,
      hours,
      maxCount,
      window,
      selectedTaskId,
      firstObservedAt,
    )
  }
  catch (error) {
    metricError = error instanceof Error ? error : new Error('获取 Ping Metric 失败')
  }

  const metricStats = buildSelectedMetricStats(metricState, nodeUuid, selectedTaskId, taskIntervalMs)
  if (metricStats?.hasRawSample) {
    return {
      snapshot: {
        stats: metricStats.stats,
        latestSampleAt: metricStats.latestSampleAt,
        windowStart: window.start,
        windowEnd: window.end,
        firstObservedAt,
        fetchedAt: Date.now(),
        source: 'metric',
        taskIntervalMs,
        canConfirmMissing: metricState?.canConfirmMissing ?? false,
        stale: false,
      },
      taskIntervalMs,
      bindingState: 'valid',
      error: metricState?.metricQueryError ?? null,
    }
  }

  let legacyRecords: unknown = null
  let legacySucceeded = false
  let legacyError: Error | null = null
  try {
    legacyRecords = await loadPingRecords(hours, maxCount, nodeUuid)
    legacySucceeded = true
  }
  catch (error) {
    legacyError = error instanceof Error ? error : new Error('获取 Ping 历史失败')
  }

  // A cache may contain another task's real points while this selected task's
  // fresh Metric request failed. Only a *successful current* Metric query (or
  // a successful Legacy query) can establish that this task's empty bucket is
  // genuinely missing.
  const canConfirmMissing = metricState?.canConfirmMissing === true || legacySucceeded
  const legacyStats = buildSelectedLegacyStats(
    legacyRecords,
    nodeUuid,
    selectedTaskId,
    window,
    taskIntervalMs,
    firstObservedAt,
    canConfirmMissing,
  )
  // Metric summary fields (notably `latest`) have no timestamped history.
  // They must never turn an otherwise empty selected binding into a synthetic
  // value. `metricStats` is therefore only used by the early raw-sample path
  // above; below it, a selected Legacy sample may provide the fallback, or
  // the valid binding stays empty until a real raw observation arrives.
  const fallbackStats = legacyStats?.hasRawSample
    ? legacyStats
    : legacyStats ?? {
      stats: buildStats([], undefined, undefined, window, {
        latestAcceptedSampleAt: null,
        firstObservedAt,
        taskIntervalMs,
        canConfirmMissing,
      }),
      latestSampleAt: null,
      hasRawSample: false,
    }
  return {
    snapshot: {
      stats: fallbackStats.stats,
      latestSampleAt: fallbackStats.latestSampleAt,
      windowStart: window.start,
      windowEnd: window.end,
      firstObservedAt,
      fetchedAt: Date.now(),
      source: legacyStats && !metricState ? 'legacy' : 'metric',
      taskIntervalMs,
      canConfirmMissing,
      stale: false,
    },
    taskIntervalMs,
    bindingState: catalogError ? 'unknown' : 'valid',
    error: canConfirmMissing
      ? null
      : catalogError?.message ?? metricError?.message ?? legacyError?.message ?? '获取 Ping 数据失败',
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
        stale: persistedSnapshot.latestSampleAt !== null
          && Date.now() - persistedSnapshot.latestSampleAt
          >= persistedSnapshot.taskIntervalMs * CACHE_CONFIG.nodePingSummary.refresh.staleAfterIntervals,
      }
    : null
  return {
    data: shallowRef(snapshot),
    loading: ref(false),
    error: ref<string | null>(null),
    status: ref(snapshot ? 'ready' : 'idle'),
    bindingState: ref(snapshot ? 'valid' : 'unknown'),
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

function mergePingMetric(
  currentValue: number | null,
  currentState: PingHistoryBucketState,
  currentSampleTime: string | null,
  candidateValue: number | null,
  candidateState: PingHistoryBucketState,
  candidateSampleTime: string | null,
): { value: number | null, state: PingHistoryBucketState, sampleTime: string | null } {
  if (candidateState === 'data')
    return { value: candidateValue, state: candidateState, sampleTime: candidateSampleTime }
  if (currentState === 'data')
    return { value: currentValue, state: currentState, sampleTime: currentSampleTime }
  if (currentState === 'confirmed-missing' && candidateState === 'pending')
    return { value: currentValue, state: currentState, sampleTime: null }
  return { value: candidateValue, state: candidateState, sampleTime: null }
}

function mergePingHistory(
  current: NodePingHistoryPoint[],
  candidate: NodePingHistoryPoint[],
): NodePingHistoryPoint[] {
  const currentByTime = new Map(current.map(point => [point.time, point]))
  return candidate.map((candidatePoint) => {
    const currentPoint = currentByTime.get(candidatePoint.time)
    if (!currentPoint)
      return candidatePoint

    const latency = mergePingMetric(
      currentPoint.latency,
      currentPoint.latencyState,
      currentPoint.latencySampleTime,
      candidatePoint.latency,
      candidatePoint.latencyState,
      candidatePoint.latencySampleTime,
    )
    const loss = mergePingMetric(
      currentPoint.loss,
      currentPoint.lossState,
      currentPoint.lossSampleTime,
      candidatePoint.loss,
      candidatePoint.lossState,
      candidatePoint.lossSampleTime,
    )
    return {
      time: candidatePoint.time,
      latency: latency.value,
      latencySampleTime: latency.sampleTime,
      latencyState: latency.state,
      loss: loss.value,
      lossSampleTime: loss.sampleTime,
      lossState: loss.state,
    }
  })
}

function mergeSelectedPingTaskSnapshot(
  current: SelectedPingTaskSnapshot,
  candidate: SelectedPingTaskSnapshot,
): SelectedPingTaskSnapshot {
  const history = mergePingHistory(current.stats.history, candidate.stats.history)
  const statsSource = candidate.stats.hasData ? candidate.stats : current.stats
  const isSameWindow = current.windowStart === candidate.windowStart
    && current.windowEnd === candidate.windowEnd
  const latestSampleAt = Math.max(current.latestSampleAt ?? Number.NEGATIVE_INFINITY, candidate.latestSampleAt ?? Number.NEGATIVE_INFINITY)
  const resolvedLatestSampleAt = Number.isFinite(latestSampleAt) ? latestSampleAt : null
  return {
    ...candidate,
    latestSampleAt: resolvedLatestSampleAt,
    firstObservedAt: isSameWindow
      ? Math.min(current.firstObservedAt, candidate.firstObservedAt)
      : candidate.firstObservedAt,
    stats: {
      ...statsSource,
      history,
      hasData: statsSource.hasData || hasHistoryData(history),
    },
    stale: resolvedLatestSampleAt !== null
      && Date.now() - resolvedLatestSampleAt
      >= candidate.taskIntervalMs * CACHE_CONFIG.nodePingSummary.refresh.staleAfterIntervals,
  }
}

function hasMeaningfulSnapshotChange(
  current: SelectedPingTaskSnapshot | null,
  candidate: SelectedPingTaskSnapshot,
): boolean {
  if (!current)
    return true

  const comparable = (snapshot: SelectedPingTaskSnapshot) => ({
    latestSampleAt: snapshot.latestSampleAt,
    windowStart: snapshot.windowStart,
    windowEnd: snapshot.windowEnd,
    firstObservedAt: snapshot.firstObservedAt,
    source: snapshot.source,
    taskIntervalMs: snapshot.taskIntervalMs,
    canConfirmMissing: snapshot.canConfirmMissing,
    stale: snapshot.stale,
    stats: snapshot.stats,
  })
  return JSON.stringify(comparable(current)) !== JSON.stringify(comparable(candidate))
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

  const refreshWindow = getAlignedPingHistoryWindow(hours)
  const existingSnapshot = entry.data.value
  const firstObservedAt = existingSnapshot
    && existingSnapshot.windowStart === refreshWindow.start
    && existingSnapshot.windowEnd === refreshWindow.end
    ? existingSnapshot.firstObservedAt
    : Date.now()

  entry.promise = loadSelectedPingTaskStats(
    nodeUuid,
    hours,
    maxCount,
    selectedTaskId,
    refreshWindow,
    firstObservedAt,
  )
    .then((result) => {
      entry.bindingState.value = result.bindingState
      entry.error.value = result.error
      if (result.bindingState === 'invalid') {
        entry.data.value = null
        entry.status.value = 'fallback'
        removeSelectedStatsCache(nodeUuid, hours, maxCount, selectedTaskId)
        return {
          advanced: false,
          latestSampleAt: null,
          taskIntervalMs: result.taskIntervalMs,
        }
      }

      const current = entry.data.value ?? null
      const candidate = result.snapshot
      const advanced = candidate !== null
        && candidate.latestSampleAt !== null
        && (current === null || current.latestSampleAt === null || candidate.latestSampleAt > current.latestSampleAt)
      const nextSnapshot = candidate
        ? current
          ? mergeSelectedPingTaskSnapshot(current, candidate)
          : candidate
        : current

      if (nextSnapshot && hasMeaningfulSnapshotChange(current, nextSnapshot)) {
        entry.data.value = nextSnapshot
        entry.status.value = 'ready'
        if (nextSnapshot.stats.hasData)
          writeSelectedStatsCache(nodeUuid, hours, maxCount, selectedTaskId, nextSnapshot)
      }
      else if (!nextSnapshot) {
        entry.status.value = 'empty'
      }
      else {
        entry.status.value = 'ready'
      }

      return {
        advanced,
        latestSampleAt: nextSnapshot?.latestSampleAt ?? null,
        taskIntervalMs: result.taskIntervalMs,
      }
    })
    .catch((err): PingRefreshOutcome => {
      entry.error.value = err instanceof Error ? err.message : 'èŽ·å– Ping åŽ†å²å¤±è´¥'
      entry.status.value = entry.data.value ? 'ready' : 'empty'
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
    retainSnapshotWhenDisabled?: MaybeRefOrGetter<boolean>
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
      retainSnapshotWhenDisabled: toValue(options?.retainSnapshotWhenDisabled) ?? false,
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

  // Aggregate stats share the page-wide sample-aware scheduler. A newly
  // visible sample therefore does not wait for a card-local one-minute tick.
  async function refreshAggregateStats(
    nodeUuid: string,
    hours: number,
    maxCount: number | undefined,
  ): Promise<void> {
    syncSharedRecordsSubscription(hours, maxCount, nodeUuid)
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    if (entry.data.value) {
      loading.value = false
      error.value = null
      return
    }

    loading.value = !entry.data.value
    error.value = null
    try {
      await (entry.promise ?? refreshSharedPingRecordsEntry(entry, hours, maxCount, nodeUuid))
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
      ? buildStats(records, state.metricStats, state.metricLossPoints, state.window, {
          latestAcceptedSampleAt: state.latestSampleAt,
          firstObservedAt: state.firstObservedAt,
          taskIntervalMs: state.taskIntervalMs,
          canConfirmMissing: state.canConfirmMissing,
        })
      : buildStats([], undefined, undefined, state.window, {
          latestAcceptedSampleAt: state.latestSampleAt,
          firstObservedAt: state.firstObservedAt,
          taskIntervalMs: state.taskIntervalMs,
          canConfirmMissing: state.canConfirmMissing,
        })
  }

  function readRetainedSelectedTaskStats(
    nodeUuid: string,
    hours: number,
    maxCount: number | undefined,
    selectedTaskId: string,
  ): NodePingStatsState {
    const selectedTaskKey = getSelectedPingTaskStatsKey(nodeUuid, hours, maxCount, selectedTaskId)
    const entry = selectedTaskEntryKey.value === selectedTaskKey
      ? selectedTaskEntry.value
      : getSelectedPingTaskStatsEntry(nodeUuid, hours, maxCount, selectedTaskId)

    return entry?.data.value?.stats ?? createEmptyStats()
  }

  const stats = computed<NodePingStatsState>(() => {
    const {
      uuid: nodeUuid,
      hours,
      maxCount,
      enabled,
      retainSnapshotWhenDisabled,
      configuredTaskId,
      selectedTaskId,
    } = resolved.value
    if (!nodeUuid.trim())
      return createEmptyStats()

    if (!enabled) {
      if (!retainSnapshotWhenDisabled)
        return createEmptyStats()

      if (!configuredTaskId) {
        const aggregateStats = buildAggregateStats(nodeUuid, hours, maxCount)
        return aggregateStats.history.length
          ? aggregateStats
          : readStatsCache(nodeUuid, hours, maxCount) ?? createEmptyStats()
      }

      return selectedTaskId
        ? readRetainedSelectedTaskStats(nodeUuid, hours, maxCount, selectedTaskId)
        : buildAggregateStats(nodeUuid, hours, maxCount)
    }

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    if (!configuredTaskId) {
      const aggregateStats = buildAggregateStats(nodeUuid, hours, maxCount)
      return aggregateStats.history.length
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

    return entry.bindingState.value === 'invalid'
      ? buildAggregateStats(nodeUuid, hours, maxCount)
      : createEmptyStats()
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
        [retained.entry.status, retained.entry.data, retained.entry.bindingState],
        async ([status, snapshot, bindingState]) => {
          if (cancelled)
            return
          if (snapshot) {
            syncSharedRecordsSubscription(null)
            return
          }
          if (status !== 'fallback' || bindingState !== 'invalid')
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
