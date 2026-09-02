import type { PingRefreshOutcome, PingRefreshSubscription } from '@/services/ping-refresh-scheduler.service'
import type {
  EffectiveNodePingPair,
  NodeCardPingCoordinatorDebugSnapshot,
  NodeCardPingCoordinatorSubscription,
  NodeCardPingHistoryPoint,
  NodeCardPingPairSnapshot,
  NodeCardPingQueryWindow,
  NodeCardPingRequestCounters,
  NodeCardPingSample,
} from '@/types/node-card-ping'
import type { MetricQueryResponse, PingMetricStatsResponse, PingMetricTaskStats, PingRecord } from '@/utils/rpc'
import { CACHE_CONFIG } from '@/constants/cache'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { SharedCache } from '@/services/cache.service'
import { loadPingRecords } from '@/services/history.service'
import {
  getCachedRawPingMetricSeries,
  getPingMetricBatchCapabilitySnapshot,
  loadPingMetricStatsBatch,
  queryPingMetricSeriesBatch,
} from '@/services/metrics.service'
import { pingRefreshScheduler } from '@/services/ping-refresh-scheduler.service'
import { PING_LATENCY_METRIC, PING_LOSS_METRIC } from '@/utils/metricSeries'
import { resolvePingHistoryBucketState } from '@/utils/pingHistoryState'
import { normalizePingMetricSamples } from '@/utils/pingMetricSamples'
import { createNextAlignedPingTimeWindow, getPingTimeBucketIndex, isPingTimestampInWindow, parsePingTimestampMs } from '@/utils/pingTime'

interface NormalizedPingPair {
  nodeUuid: string
  taskId: string
  taskName: string
  taskIntervalMs: number
}

interface NormalizedQueryWindow {
  hours: number
  maxPoints: number
  bucketCount: number
  batchChunkSize: number
}

interface PairEntry {
  key: string
  groupKey: string
  pair: NormalizedPingPair
  window: NormalizedQueryWindow
  snapshot: NodeCardPingPairSnapshot
  subscribers: number
  refreshing: boolean
  listeners: Set<() => void>
}

interface GroupTarget {
  key: string
  taskId: string
  window: NormalizedQueryWindow
  pairEntries: Map<string, PairEntry>
  taskIntervalMs: number
  schedulerSubscription: PingRefreshSubscription | null
  inFlight: Promise<PingRefreshOutcome> | null
}

interface ChunkPayload {
  statsByEntityId: ReadonlyMap<string, PingMetricStatsResponse>
  statsErrorsByEntityId: ReadonlyMap<string, Error>
  seriesByEntityId: ReadonlyMap<string, MetricQueryResponse>
  seriesErrorsByEntityId: ReadonlyMap<string, Error>
}

interface PersistentEnvelope {
  version: number
  cacheKey: string
  expiresAt: number
  snapshot: NodeCardPingPairSnapshot
}

const PAIR_CACHE_VERSION = 1
const PAIR_CACHE_PREFIX = 'komari-theme-emerald:multi-node-ping-stats'
const PAIR_CACHE_INDEX_KEY = `${PAIR_CACHE_PREFIX}:index`
const PAIR_CACHE_MAX_SIZE = 512
const DEFAULT_BATCH_CHUNK_SIZE = 32
const POSITIVE_INTEGER_PATTERN = /^\d+$/

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value)
}

function normalizeNodeUuid(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizeTaskId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    return String(value)
  if (typeof value !== 'string')
    return null
  const normalized = value.trim()
  if (!POSITIVE_INTEGER_PATTERN.test(normalized) || Number(normalized) <= 0)
    return null
  return String(Number(normalized))
}

function normalizeTaskIntervalMs(value: unknown): number {
  return finiteNumber(value) && value > 0
    ? Math.max(CACHE_CONFIG.nodePingSummary.refresh.schedulerTick, Math.floor(value * 1000))
    : CACHE_CONFIG.nodePingSummary.refresh.heartbeat
}

function normalizePair(value: EffectiveNodePingPair): NormalizedPingPair | null {
  const nodeUuid = normalizeNodeUuid(value.nodeUuid)
  const taskId = normalizeTaskId(value.taskId)
  if (!nodeUuid || !taskId)
    return null
  return {
    nodeUuid,
    taskId,
    taskName: value.taskName?.trim() || `Ping ${taskId}`,
    taskIntervalMs: normalizeTaskIntervalMs(value.intervalSeconds),
  }
}

function normalizePositiveInteger(value: unknown, fallback: number, maximum: number): number {
  return finiteNumber(value) && value > 0
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback
}

function normalizeWindow(value: NodeCardPingQueryWindow): NormalizedQueryWindow {
  return {
    hours: normalizePositiveInteger(value.hours, 1, 24 * 365),
    maxPoints: normalizePositiveInteger(value.maxPoints, PING_SUMMARY_MAX_COUNT, 20_000),
    bucketCount: normalizePositiveInteger(
      value.bucketCount,
      CACHE_CONFIG.nodePingSummary.historyBucketCount,
      240,
    ),
    batchChunkSize: normalizePositiveInteger(value.batchChunkSize, DEFAULT_BATCH_CHUNK_SIZE, 100),
  }
}

function windowKey(window: NormalizedQueryWindow): string {
  return JSON.stringify([window.hours, window.maxPoints, window.bucketCount, window.batchChunkSize])
}

function pairKey(pair: NormalizedPingPair, window: NormalizedQueryWindow): string {
  return JSON.stringify([
    'multi-ping-pair',
    PAIR_CACHE_VERSION,
    'selected-node-task',
    'metric-series+stats|same-task-legacy',
    pair.nodeUuid,
    pair.taskId,
    windowKey(window),
  ])
}

function groupKey(taskId: string, window: NormalizedQueryWindow): string {
  return JSON.stringify([
    'multi-ping-task',
    PAIR_CACHE_VERSION,
    'metric-series+stats|same-task-legacy',
    taskId,
    windowKey(window),
  ])
}

function currentWindow(window: NormalizedQueryWindow, now = Date.now()) {
  return createNextAlignedPingTimeWindow(now, window.hours, window.bucketCount)
    ?? {
      start: now - window.hours * 60 * 60 * 1000,
      end: now,
      bucketCount: window.bucketCount,
      bucketWidth: window.hours * 60 * 60 * 1000 / window.bucketCount,
    }
}

function createPendingSnapshot(
  pair: NormalizedPingPair,
  window: NormalizedQueryWindow,
  now = Date.now(),
): NodeCardPingPairSnapshot {
  const range = currentWindow(window, now)
  return {
    nodeUuid: pair.nodeUuid,
    taskId: pair.taskId,
    taskName: pair.taskName,
    status: 'pending',
    source: 'metric',
    samples: [],
    history: [],
    avgLatency: null,
    avgLoss: null,
    avgVolatility: 0,
    latestSampleAt: null,
    windowStart: range.start,
    windowEnd: range.end,
    firstObservedAt: now,
    fetchedAt: 0,
    taskIntervalMs: pair.taskIntervalMs,
    canConfirmMissing: false,
    stale: false,
    refreshing: false,
    error: null,
  }
}

function persistentStorageKey(key: string): string {
  return `${PAIR_CACHE_PREFIX}:${encodeURIComponent(key)}`
}

function isPairStatus(value: unknown): value is NodeCardPingPairSnapshot['status'] {
  return value === 'pending'
    || value === 'data'
    || value === 'confirmed_missing'
    || value === 'error'
    || value === 'stale'
}

function isPairSource(value: unknown): value is NodeCardPingPairSnapshot['source'] {
  return value === 'metric' || value === 'legacy'
}

function isHistoryState(value: unknown): value is NodeCardPingHistoryPoint['latencyState'] {
  return value === 'pending' || value === 'data' || value === 'confirmed-missing'
}

function validSample(value: unknown, pair: NormalizedPingPair): value is NodeCardPingSample {
  if (!value || typeof value !== 'object')
    return false
  const sample = value as Partial<NodeCardPingSample>
  const timestamp = parsePingTimestampMs(sample.time)
  return normalizeNodeUuid(sample.entityId) === pair.nodeUuid
    && normalizeTaskId(sample.taskId) === pair.taskId
    && timestamp !== null
    && sample.timestamp === timestamp
    && nullableFiniteNumber(sample.latency)
    && (sample.latency === null || sample.latency >= 0)
    && nullableFiniteNumber(sample.loss)
    && (sample.loss === null || (sample.loss >= 0 && sample.loss <= 1))
    && finiteNumber(sample.totalCount)
    && sample.totalCount >= 0
    && typeof sample.observed === 'boolean'
}

function validHistoryPoint(value: unknown): value is NodeCardPingHistoryPoint {
  if (!value || typeof value !== 'object')
    return false
  const point = value as Partial<NodeCardPingHistoryPoint>
  return parsePingTimestampMs(point.time) !== null
    && nullableFiniteNumber(point.latency)
    && nullableFiniteNumber(point.loss)
    && (point.loss === null || (point.loss >= 0 && point.loss <= 100))
    && (point.latencySampleTime === null || parsePingTimestampMs(point.latencySampleTime) !== null)
    && (point.lossSampleTime === null || parsePingTimestampMs(point.lossSampleTime) !== null)
    && isHistoryState(point.latencyState)
    && isHistoryState(point.lossState)
}

function parsePersistentSnapshot(
  raw: string,
  cacheKey: string,
  pair: NormalizedPingPair,
  window: NormalizedQueryWindow,
): NodeCardPingPairSnapshot | null {
  let envelope: Partial<PersistentEnvelope>
  try {
    envelope = JSON.parse(raw) as Partial<PersistentEnvelope>
  }
  catch {
    return null
  }
  if (envelope.version !== PAIR_CACHE_VERSION
    || envelope.cacheKey !== cacheKey
    || !finiteNumber(envelope.expiresAt)
    || envelope.expiresAt <= Date.now()
    || !envelope.snapshot
    || typeof envelope.snapshot !== 'object') {
    return null
  }

  const snapshot = envelope.snapshot as Partial<NodeCardPingPairSnapshot>
  if (normalizeNodeUuid(snapshot.nodeUuid) !== pair.nodeUuid
    || normalizeTaskId(snapshot.taskId) !== pair.taskId
    || !isPairStatus(snapshot.status)
    || !isPairSource(snapshot.source)
    || !Array.isArray(snapshot.samples)
    || !snapshot.samples.every(sample => validSample(sample, pair))
    || !Array.isArray(snapshot.history)
    || snapshot.history.length !== window.bucketCount
    || !snapshot.history.every(validHistoryPoint)
    || !nullableFiniteNumber(snapshot.avgLatency)
    || !nullableFiniteNumber(snapshot.avgLoss)
    || !finiteNumber(snapshot.avgVolatility)
    || !nullableFiniteNumber(snapshot.latestSampleAt)
    || !finiteNumber(snapshot.windowStart)
    || !finiteNumber(snapshot.windowEnd)
    || !finiteNumber(snapshot.firstObservedAt)
    || !finiteNumber(snapshot.fetchedAt)
    || !finiteNumber(snapshot.taskIntervalMs)
    || typeof snapshot.canConfirmMissing !== 'boolean'
    || typeof snapshot.stale !== 'boolean') {
    return null
  }

  const samples = snapshot.samples as NodeCardPingSample[]
  const observedSamples = samples.filter(sample => sample.observed)
  const resolvedLatestSampleAt = latestSampleAt(samples)
  const windowStart = snapshot.windowStart as number
  const windowEnd = snapshot.windowEnd as number
  const firstObservedAt = snapshot.firstObservedAt as number
  const taskIntervalMs = snapshot.taskIntervalMs as number
  if (windowEnd <= windowStart
    || firstObservedAt < windowStart
    || taskIntervalMs <= 0
    || (snapshot.avgLatency !== null && snapshot.avgLatency < 0)
    || (snapshot.avgLoss !== null && (snapshot.avgLoss < 0 || snapshot.avgLoss > 100))
    || samples.some(sample => sample.timestamp < windowStart || sample.timestamp >= windowEnd)
    || snapshot.latestSampleAt !== resolvedLatestSampleAt
    || ((snapshot.status === 'data' || snapshot.status === 'stale') && !observedSamples.length)) {
    return null
  }

  const stale = resolvedLatestSampleAt !== null
    && Date.now() - resolvedLatestSampleAt
    >= taskIntervalMs * CACHE_CONFIG.nodePingSummary.refresh.staleAfterIntervals
  return {
    ...(snapshot as NodeCardPingPairSnapshot),
    taskName: pair.taskName,
    status: stale ? 'stale' : snapshot.status === 'stale' ? 'data' : snapshot.status,
    stale,
    refreshing: false,
    error: null,
  }
}

function average(values: number[]): number | null {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null
}

function weightedAverage(values: Array<{ value: number, weight: number }>): number | null {
  const valid = values.filter(item => finiteNumber(item.value) && finiteNumber(item.weight) && item.weight > 0)
  const totalWeight = valid.reduce((total, item) => total + item.weight, 0)
  return totalWeight > 0
    ? valid.reduce((total, item) => total + item.value * item.weight, 0) / totalWeight
    : null
}

function latestSampleAt(samples: readonly NodeCardPingSample[]): number | null {
  const timestamps = samples.filter(sample => sample.observed).map(sample => sample.timestamp)
  return timestamps.length ? Math.max(...timestamps) : null
}

function mergeSamples(
  current: readonly NodeCardPingSample[],
  candidate: readonly NodeCardPingSample[],
  windowStart: number,
  windowEnd: number,
): NodeCardPingSample[] {
  const byTimestamp = new Map<number, NodeCardPingSample>()
  for (const sample of current) {
    if (sample.timestamp >= windowStart && sample.timestamp < windowEnd)
      byTimestamp.set(sample.timestamp, sample)
  }
  for (const sample of candidate) {
    if (sample.timestamp >= windowStart && sample.timestamp < windowEnd)
      byTimestamp.set(sample.timestamp, sample)
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
}

function buildHistory(
  samples: readonly NodeCardPingSample[],
  range: ReturnType<typeof currentWindow>,
  timing: {
    now: number
    latestSampleAt: number | null
    firstObservedAt: number
    taskIntervalMs: number
    canConfirmMissing: boolean
  },
): NodeCardPingHistoryPoint[] {
  const buckets = Array.from({ length: range.bucketCount }, (_, bucketIndex) => ({
    bucketIndex,
    latency: [] as Array<{ value: number, weight: number }>,
    loss: [] as Array<{ value: number, weight: number }>,
    observed: false,
    latencySampleAt: null as number | null,
    lossSampleAt: null as number | null,
  }))

  for (const sample of samples) {
    if (!sample.observed)
      continue
    const index = getPingTimeBucketIndex(sample.timestamp, range)
    const bucket = index === null ? undefined : buckets[index]
    if (!bucket)
      continue
    bucket.observed = true
    const totalWeight = sample.totalCount > 0 ? sample.totalCount : 1
    if (sample.loss !== null) {
      bucket.loss.push({ value: sample.loss * 100, weight: totalWeight })
      bucket.lossSampleAt = Math.max(bucket.lossSampleAt ?? Number.NEGATIVE_INFINITY, sample.timestamp)
    }
    if (sample.latency !== null) {
      const successfulWeight = sample.loss === null
        ? totalWeight
        : Math.max(0, totalWeight * (1 - sample.loss))
      bucket.latency.push({ value: sample.latency, weight: successfulWeight || 1 })
      bucket.latencySampleAt = Math.max(bucket.latencySampleAt ?? Number.NEGATIVE_INFINITY, sample.timestamp)
    }
  }

  return buckets.map((bucket, index) => {
    const bucketStart = range.start + range.bucketWidth * index
    const bucketEnd = bucketStart + range.bucketWidth
    const latency = weightedAverage(bucket.latency)
    const loss = weightedAverage(bucket.loss)
    const latencyState = resolvePingHistoryBucketState(bucket.observed, {
      bucketStart,
      bucketEnd,
      ...timing,
      latestAcceptedSampleAt: timing.latestSampleAt,
    })
    const lossState = resolvePingHistoryBucketState(loss !== null, {
      bucketStart,
      bucketEnd,
      ...timing,
      latestAcceptedSampleAt: timing.latestSampleAt,
    })
    const latencySampleAt = bucket.latencySampleAt ?? bucket.lossSampleAt
    return {
      time: new Date(bucketStart).toISOString(),
      latency,
      loss,
      latencySampleTime: latencyState === 'data' && latencySampleAt !== null
        ? new Date(latencySampleAt).toISOString()
        : null,
      lossSampleTime: lossState === 'data' && bucket.lossSampleAt !== null
        ? new Date(bucket.lossSampleAt).toISOString()
        : null,
      latencyState,
      lossState,
    }
  })
}

function buildAverages(
  samples: readonly NodeCardPingSample[],
  stats: readonly PingMetricTaskStats[],
): { avgLatency: number | null, avgLoss: number | null, avgVolatility: number } {
  const acceptedStats = stats.filter(stat => finiteNumber(stat.total) && stat.total > 0)
  const latency = weightedAverage(acceptedStats.flatMap(stat => finiteNumber(stat.avg) && stat.valid > 0
    ? [{ value: stat.avg, weight: stat.valid }]
    : []))
  const loss = weightedAverage(acceptedStats.flatMap(stat => !stat.loss_approximate && finiteNumber(stat.loss)
    ? [{ value: stat.loss, weight: stat.total }]
    : []))
  const volatility = weightedAverage(acceptedStats.flatMap(stat => finiteNumber(stat.p99_p50_ratio) && stat.valid > 0
    ? [{ value: stat.p99_p50_ratio, weight: stat.valid }]
    : []))
  const observed = samples.filter(sample => sample.observed)
  return {
    avgLatency: latency ?? average(observed.flatMap(sample => sample.latency === null ? [] : [sample.latency])),
    avgLoss: loss ?? weightedAverage(observed.flatMap(sample => sample.loss === null
      ? []
      : [{ value: sample.loss * 100, weight: sample.totalCount || 1 }])),
    avgVolatility: volatility ?? 0,
  }
}

function errorMessage(errors: readonly unknown[]): string | null {
  const messages = [...new Set(errors.flatMap((error) => {
    if (!error)
      return []
    return [error instanceof Error ? error.message : String(error)]
  }).filter(Boolean))]
  return messages.length ? messages.join('；') : null
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size)
    chunks.push(values.slice(index, index + size))
  return chunks
}

function createRequestCounters(): NodeCardPingRequestCounters {
  return {
    metricStatsBatch: 0,
    metricStatsPair: 0,
    metricSeriesBatch: 0,
    metricSeriesPair: 0,
    legacyPair: 0,
    aggregate: 0,
    dedupedRefresh: 0,
  }
}

export class NodeCardPingCoordinator {
  private readonly groups = new Map<string, GroupTarget>()
  private readonly pairCache = new SharedCache<PairEntry>({
    maxSize: PAIR_CACHE_MAX_SIZE,
    ttl: CACHE_CONFIG.nodePingSummary.selectedStats.ttl,
    canEvict: entry => entry.subscribers === 0 && !entry.refreshing,
  })

  private readonly legacyInFlight = new Map<string, Promise<PingRecord[]>>()
  private requestCounters = createRequestCounters()
  private cacheHits = 0
  private cacheMisses = 0
  private persistentCacheHits = 0
  private persistentCacheMisses = 0
  private activeInflight = 0

  subscribe(
    pairs: readonly EffectiveNodePingPair[],
    requestedWindow: NodeCardPingQueryWindow,
    onChange?: () => void,
  ): NodeCardPingCoordinatorSubscription {
    const window = normalizeWindow(requestedWindow)
    const normalizedPairs = [...new Map(pairs
      .map(normalizePair)
      .filter((pair): pair is NormalizedPingPair => pair !== null)
      .map(pair => [`${pair.nodeUuid}:${pair.taskId}`, pair])).values()]
    const entries = normalizedPairs.map(pair => this.retainPair(pair, window, onChange))

    onChange?.()
    let released = false
    return {
      getSnapshots: () => entries.map(entry => entry.snapshot),
      refreshNow: () => {
        if (released)
          return
        for (const key of new Set(entries.map(entry => entry.groupKey)))
          this.groups.get(key)?.schedulerSubscription?.refreshNow()
      },
      release: () => {
        if (released)
          return
        released = true
        for (const entry of entries)
          this.releasePair(entry, onChange)
      },
    }
  }

  getDebugSnapshot(): NodeCardPingCoordinatorDebugSnapshot {
    const subscribers = [...this.groups.values()]
      .flatMap(group => [...group.pairEntries.values()])
      .reduce((total, entry) => total + entry.subscribers, 0)
    const targets = this.groups.size
    return Object.freeze({
      targets,
      pairEntries: this.pairCache.size,
      subscribers,
      schedulerSubscribers: targets,
      timerCount: targets > 0 ? 1 : 0,
      listenerCount: targets > 0 && typeof window !== 'undefined' ? 2 : 0,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      persistentCacheHits: this.persistentCacheHits,
      persistentCacheMisses: this.persistentCacheMisses,
      inflight: this.activeInflight,
      requestCounters: Object.freeze({ ...this.requestCounters }),
    })
  }

  resetDebugCounters(): void {
    this.requestCounters = createRequestCounters()
    this.cacheHits = 0
    this.cacheMisses = 0
    this.persistentCacheHits = 0
    this.persistentCacheMisses = 0
  }

  private retainPair(
    pair: NormalizedPingPair,
    window: NormalizedQueryWindow,
    onChange?: () => void,
  ): PairEntry {
    const key = pairKey(pair, window)
    let entry = this.pairCache.get(key)
    if (entry) {
      this.cacheHits += 1
      entry.pair = pair
      entry.snapshot = { ...entry.snapshot, taskName: pair.taskName, taskIntervalMs: pair.taskIntervalMs }
    }
    else {
      this.cacheMisses += 1
      const snapshot = this.readPersistent(key, pair, window) ?? createPendingSnapshot(pair, window)
      entry = {
        key,
        groupKey: groupKey(pair.taskId, window),
        pair,
        window,
        snapshot,
        subscribers: 0,
        refreshing: false,
        listeners: new Set(),
      }
      this.pairCache.set(key, entry)
    }

    entry.subscribers += 1
    if (onChange)
      entry.listeners.add(onChange)
    const group = this.retainGroup(entry)
    group.pairEntries.set(entry.key, entry)
    if (entry.snapshot.status === 'pending' || entry.snapshot.status === 'stale' || entry.snapshot.status === 'error')
      group.schedulerSubscription?.refreshNow()
    return entry
  }

  private retainGroup(entry: PairEntry): GroupTarget {
    const existing = this.groups.get(entry.groupKey)
    if (existing) {
      existing.taskIntervalMs = Math.min(existing.taskIntervalMs, entry.pair.taskIntervalMs)
      return existing
    }

    const group: GroupTarget = {
      key: entry.groupKey,
      taskId: entry.pair.taskId,
      window: entry.window,
      pairEntries: new Map(),
      taskIntervalMs: entry.pair.taskIntervalMs,
      schedulerSubscription: null,
      inFlight: null,
    }
    this.groups.set(group.key, group)
    group.schedulerSubscription = pingRefreshScheduler.subscribe(
      `node-card-multi:${group.key}`,
      () => this.refreshGroup(group),
      {
        latestSampleAt: entry.snapshot.latestSampleAt,
        taskIntervalMs: entry.snapshot.taskIntervalMs,
      },
    )
    return group
  }

  private releasePair(entry: PairEntry, onChange?: () => void): void {
    if (onChange)
      entry.listeners.delete(onChange)
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers > 0)
      return

    const group = this.groups.get(entry.groupKey)
    group?.pairEntries.delete(entry.key)
    if (group?.pairEntries.size === 0) {
      group.schedulerSubscription?.release()
      group.schedulerSubscription = null
      this.groups.delete(group.key)
    }
    this.pairCache.set(entry.key, entry)
  }

  private refreshGroup(group: GroupTarget): Promise<PingRefreshOutcome> {
    if (group.inFlight) {
      this.requestCounters.dedupedRefresh += 1
      return group.inFlight
    }

    this.activeInflight += 1
    group.inFlight = Promise.resolve()
      .then(() => this.performGroupRefresh(group))
      .finally(() => {
        group.inFlight = null
        this.activeInflight = Math.max(0, this.activeInflight - 1)
      })
    return group.inFlight
  }

  private async performGroupRefresh(group: GroupTarget): Promise<PingRefreshOutcome> {
    // Let all synchronously-mounted cards join the same task group before the
    // first entity chunk is captured.
    await Promise.resolve()
    const entries = [...group.pairEntries.values()]
      .filter(entry => entry.subscribers > 0)
      .sort((left, right) => left.pair.nodeUuid.localeCompare(right.pair.nodeUuid))
    if (!entries.length) {
      return {
        advanced: false,
        latestSampleAt: null,
        taskIntervalMs: group.taskIntervalMs,
      }
    }

    const now = Date.now()
    const range = currentWindow(group.window, now)
    const previousLatest = new Map(entries.map(entry => [entry.key, entry.snapshot.latestSampleAt]))
    for (const entry of entries)
      this.setRefreshing(entry, true)

    const payloads = await Promise.all(chunked(entries, group.window.batchChunkSize)
      .map(chunk => this.loadChunk(group, chunk.map(entry => entry.pair.nodeUuid), range)))

    const payloadByEntityId = new Map<string, ChunkPayload>()
    for (const payload of payloads) {
      const entityIds = new Set([
        ...payload.statsByEntityId.keys(),
        ...payload.statsErrorsByEntityId.keys(),
        ...payload.seriesByEntityId.keys(),
        ...payload.seriesErrorsByEntityId.keys(),
      ])
      for (const entityId of entityIds)
        payloadByEntityId.set(entityId, payload)
    }

    const pairResults = await Promise.allSettled(entries.map(async (entry) => {
      const payload = payloadByEntityId.get(entry.pair.nodeUuid)
      await this.applyPairPayload(entry, payload, range, now)
    }))
    pairResults.forEach((result, index) => {
      if (result.status === 'fulfilled')
        return
      const entry = entries[index]
      if (entry)
        this.markPairError(entry, result.reason)
    })

    const activeSnapshots = entries
      .filter(entry => entry.subscribers > 0)
      .map(entry => entry.snapshot)
    const hasPending = activeSnapshots.some(snapshot => snapshot.status === 'pending' || snapshot.status === 'error')
    const latestValues = activeSnapshots
      .map(snapshot => snapshot.latestSampleAt)
      .filter((value): value is number => value !== null)
    const advanced = !hasPending && entries.some((entry) => {
      const before = previousLatest.get(entry.key)
      return entry.snapshot.latestSampleAt !== null
        && (before === null || before === undefined || entry.snapshot.latestSampleAt > before)
    })
    return {
      advanced,
      latestSampleAt: hasPending || !latestValues.length ? null : Math.min(...latestValues),
      taskIntervalMs: group.taskIntervalMs,
    }
  }

  private async loadChunk(
    group: GroupTarget,
    entityIds: readonly string[],
    range: ReturnType<typeof currentWindow>,
  ): Promise<ChunkPayload> {
    const start = new Date(range.start).toISOString()
    const end = new Date(range.end).toISOString()
    const capability = getPingMetricBatchCapabilitySnapshot()
    const statsPromise = loadPingMetricStatsBatch({
      entityIds,
      taskId: group.taskId,
      query: {
        hours: group.window.hours,
        start,
        end,
        max_points: group.window.maxPoints,
      },
    })
    const seriesPromise = queryPingMetricSeriesBatch({
      entityIds,
      taskId: group.taskId,
      query: {
        metric_keys: [PING_LATENCY_METRIC, PING_LOSS_METRIC],
        hours: group.window.hours,
        start,
        end,
        downsample: true,
        fill_empty: true,
        max_points: group.window.maxPoints,
        aggregation: 'avg',
      },
    })
    const [statsResult, seriesResult] = await Promise.allSettled([statsPromise, seriesPromise])

    const statsByEntityId = statsResult.status === 'fulfilled'
      ? statsResult.value.valuesByEntityId
      : new Map<string, PingMetricStatsResponse>()
    const statsErrorsByEntityId = statsResult.status === 'fulfilled'
      ? statsResult.value.errorsByEntityId
      : new Map(entityIds.map(entityId => [entityId, statsResult.reason instanceof Error
          ? statsResult.reason
          : new Error('获取 Ping Metric 统计失败')]))
    const seriesByEntityId = seriesResult.status === 'fulfilled'
      ? seriesResult.value.valuesByEntityId
      : new Map<string, MetricQueryResponse>()
    const seriesErrorsByEntityId = seriesResult.status === 'fulfilled'
      ? seriesResult.value.errorsByEntityId
      : new Map(entityIds.map(entityId => [entityId, seriesResult.reason instanceof Error
          ? seriesResult.reason
          : new Error('获取 Ping Metric 序列失败')]))

    this.recordMetricRequests('stats', entityIds.length, capability.stats, statsResult)
    this.recordMetricRequests('series', entityIds.length, capability.series, seriesResult)
    return { statsByEntityId, statsErrorsByEntityId, seriesByEntityId, seriesErrorsByEntityId }
  }

  private recordMetricRequests<T extends { transport: 'batch' | 'pair', requestCount: number }>(
    kind: 'stats' | 'series',
    entityCount: number,
    capabilityBefore: 'unknown' | 'supported' | 'unsupported',
    result: PromiseSettledResult<T>,
  ): void {
    const batchKey = kind === 'stats' ? 'metricStatsBatch' : 'metricSeriesBatch'
    const pairKey = kind === 'stats' ? 'metricStatsPair' : 'metricSeriesPair'
    if (result.status === 'rejected') {
      if (entityCount > 1 && capabilityBefore !== 'unsupported')
        this.requestCounters[batchKey] += 1
      else
        this.requestCounters[pairKey] += entityCount
      return
    }

    if (result.value.transport === 'batch') {
      this.requestCounters[batchKey] += result.value.requestCount
      return
    }
    this.requestCounters[pairKey] += entityCount
    this.requestCounters[batchKey] += Math.max(0, result.value.requestCount - entityCount)
  }

  private async applyPairPayload(
    entry: PairEntry,
    payload: ChunkPayload | undefined,
    range: ReturnType<typeof currentWindow>,
    now: number,
  ): Promise<void> {
    const pair = entry.pair
    if (entry.subscribers === 0 || this.groups.get(entry.groupKey)?.pairEntries.get(entry.key) !== entry) {
      this.stopRefreshing(entry)
      return
    }
    const seriesResponse = payload?.seriesByEntityId.get(pair.nodeUuid)
    const statsResponse = payload?.statsByEntityId.get(pair.nodeUuid)
    const metricErrors = [
      payload?.seriesErrorsByEntityId.get(pair.nodeUuid),
      payload?.statsErrorsByEntityId.get(pair.nodeUuid),
    ]
    const start = new Date(range.start).toISOString()
    const end = new Date(range.end).toISOString()
    const cachedSeries = getCachedRawPingMetricSeries(pair.nodeUuid, start, end)
    const rawSeries = cachedSeries ?? seriesResponse?.series ?? null
    const metricSamples: NodeCardPingSample[] = rawSeries
      ? normalizePingMetricSamples(rawSeries, {
          entityId: pair.nodeUuid,
          taskId: pair.taskId,
          start: range.start,
          end: range.end,
        }).map(sample => ({ ...sample }))
      : []
    const hasMetricObservation = metricSamples.some(sample => sample.observed)

    let legacySamples: NodeCardPingSample[] = []
    let legacySucceeded = false
    let legacyError: Error | null = null
    if (!hasMetricObservation) {
      try {
        const records = await this.loadLegacyRecords(entry, range)
        legacySucceeded = true
        legacySamples = records
          .filter(record => normalizeNodeUuid(record.client) === pair.nodeUuid
            && normalizeTaskId(record.task_id) === pair.taskId)
          .flatMap((record) => {
            const timestamp = parsePingTimestampMs(record.time)
            if (timestamp === null || !isPingTimestampInWindow(timestamp, range) || !finiteNumber(record.value))
              return []
            return [{
              entityId: pair.nodeUuid,
              taskId: pair.taskId,
              time: new Date(timestamp).toISOString(),
              timestamp,
              latency: record.value >= 0 ? record.value : null,
              loss: record.value >= 0 ? 0 : 1,
              totalCount: 1,
              observed: true,
            }]
          })
      }
      catch (error) {
        legacyError = error instanceof Error ? error : new Error('获取同任务 Ping 历史失败')
      }
    }

    const freshSamples = hasMetricObservation ? metricSamples : legacySamples
    const samples = mergeSamples(entry.snapshot.samples, freshSamples, range.start, range.end)
    const observedSamples = samples.filter(sample => sample.observed)
    const latest = latestSampleAt(samples)
    const stats = statsResponse?.stats.filter(stat => normalizeNodeUuid(stat.entity_id) === pair.nodeUuid
      && normalizeTaskId(stat.task_id) === pair.taskId) ?? []
    const statsIntervals = stats.flatMap(stat => finiteNumber(stat.interval) && stat.interval > 0
      ? [normalizeTaskIntervalMs(stat.interval)]
      : [])
    const taskIntervalMs = statsIntervals.length ? Math.min(...statsIntervals) : pair.taskIntervalMs
    const firstObservedAt = entry.snapshot.windowStart === range.start
      && entry.snapshot.windowEnd === range.end
      ? entry.snapshot.firstObservedAt
      : now
    const canConfirmMissing = Boolean(seriesResponse) || legacySucceeded
    const history = buildHistory(samples, range, {
      now,
      latestSampleAt: latest,
      firstObservedAt,
      taskIntervalMs,
      canConfirmMissing,
    })
    const averages = buildAverages(samples, observedSamples.length ? stats : [])
    const freshObservation = (Boolean(seriesResponse) && hasMetricObservation)
      || legacySamples.some(sample => sample.observed)
    const transportUnavailable = !seriesResponse && !legacySucceeded
    const stale = latest !== null
      && (transportUnavailable
        || now - latest >= taskIntervalMs * CACHE_CONFIG.nodePingSummary.refresh.staleAfterIntervals)
    const requestError = freshObservation || canConfirmMissing
      ? null
      : errorMessage([...metricErrors, legacyError])
    let status: NodeCardPingPairSnapshot['status']
    if (observedSamples.length) {
      status = stale ? 'stale' : 'data'
    }
    else if (canConfirmMissing) {
      status = history.some(point => point.latencyState === 'pending' || point.lossState === 'pending')
        ? 'pending'
        : 'confirmed_missing'
    }
    else {
      status = 'error'
    }

    if (entry.subscribers === 0 || this.groups.get(entry.groupKey)?.pairEntries.get(entry.key) !== entry)
      return

    entry.snapshot = {
      nodeUuid: pair.nodeUuid,
      taskId: pair.taskId,
      taskName: pair.taskName,
      status,
      source: hasMetricObservation
        ? 'metric'
        : legacySamples.length ? 'legacy' : entry.snapshot.source,
      samples,
      history,
      ...averages,
      latestSampleAt: latest,
      windowStart: range.start,
      windowEnd: range.end,
      firstObservedAt,
      fetchedAt: now,
      taskIntervalMs,
      canConfirmMissing,
      stale,
      refreshing: false,
      error: requestError,
    }
    entry.refreshing = false
    this.pairCache.set(entry.key, entry)
    if (observedSamples.length)
      this.writePersistent(entry)
    this.notify(entry)
  }

  private loadLegacyRecords(
    entry: PairEntry,
    range: ReturnType<typeof currentWindow>,
  ): Promise<PingRecord[]> {
    const key = JSON.stringify([
      'multi-ping-legacy',
      entry.pair.nodeUuid,
      entry.window.hours,
      entry.window.maxPoints,
      range.start,
      range.end,
    ])
    const existing = this.legacyInFlight.get(key)
    if (existing) {
      this.requestCounters.dedupedRefresh += 1
      return existing
    }
    this.requestCounters.legacyPair += 1
    const promise = loadPingRecords(entry.window.hours, entry.window.maxPoints, entry.pair.nodeUuid)
      .finally(() => this.legacyInFlight.delete(key))
    this.legacyInFlight.set(key, promise)
    return promise
  }

  private setRefreshing(entry: PairEntry, refreshing: boolean): void {
    entry.refreshing = refreshing
    entry.snapshot = { ...entry.snapshot, refreshing }
    this.notify(entry)
  }

  private stopRefreshing(entry: PairEntry): void {
    entry.refreshing = false
    entry.snapshot = { ...entry.snapshot, refreshing: false }
    this.pairCache.set(entry.key, entry)
  }

  private markPairError(entry: PairEntry, error: unknown): void {
    if (entry.subscribers === 0) {
      this.stopRefreshing(entry)
      return
    }
    const hasData = entry.snapshot.samples.some(sample => sample.observed)
    entry.refreshing = false
    entry.snapshot = {
      ...entry.snapshot,
      status: hasData ? 'stale' : 'error',
      stale: hasData,
      refreshing: false,
      error: error instanceof Error ? error.message : '处理 Ping 数据失败',
    }
    this.pairCache.set(entry.key, entry)
    this.notify(entry)
  }

  private notify(entry: PairEntry): void {
    for (const listener of entry.listeners)
      listener()
  }

  private readPersistent(
    key: string,
    pair: NormalizedPingPair,
    window: NormalizedQueryWindow,
  ): NodeCardPingPairSnapshot | null {
    if (typeof localStorage === 'undefined') {
      this.persistentCacheMisses += 1
      return null
    }
    try {
      const raw = localStorage.getItem(persistentStorageKey(key))
      if (!raw) {
        this.persistentCacheMisses += 1
        return null
      }
      const snapshot = parsePersistentSnapshot(raw, key, pair, window)
      if (!snapshot) {
        localStorage.removeItem(persistentStorageKey(key))
        this.persistentCacheMisses += 1
        return null
      }
      this.persistentCacheHits += 1
      return snapshot
    }
    catch {
      this.persistentCacheMisses += 1
      return null
    }
  }

  private writePersistent(entry: PairEntry): void {
    if (typeof localStorage === 'undefined')
      return
    try {
      const storageKey = persistentStorageKey(entry.key)
      const envelope: PersistentEnvelope = {
        version: PAIR_CACHE_VERSION,
        cacheKey: entry.key,
        expiresAt: Date.now() + CACHE_CONFIG.nodePingSummary.persistedSelectedStats.ttl,
        snapshot: { ...entry.snapshot, refreshing: false, error: null },
      }
      localStorage.setItem(storageKey, JSON.stringify(envelope))
      const index = JSON.parse(localStorage.getItem(PAIR_CACHE_INDEX_KEY) ?? '[]') as unknown
      const keys = Array.isArray(index)
        ? index.filter((value): value is string => typeof value === 'string' && value !== storageKey)
        : []
      keys.push(storageKey)
      while (keys.length > PAIR_CACHE_MAX_SIZE) {
        const removed = keys.shift()
        if (removed)
          localStorage.removeItem(removed)
      }
      localStorage.setItem(PAIR_CACHE_INDEX_KEY, JSON.stringify(keys))
    }
    catch {
      // Storage quota/privacy mode must not affect the in-memory data path.
    }
  }
}

export const nodeCardPingCoordinator = new NodeCardPingCoordinator()
