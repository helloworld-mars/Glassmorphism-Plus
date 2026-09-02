import type { MetricDefinition, MetricPoint, MetricQueryParams, MetricQueryResponse, MetricSeries, PingMetricStatsParams, PingMetricStatsResponse, PingTaskInfo } from '@/utils/rpc'
import { CACHE_CONFIG } from '@/constants/cache'
import { SharedCache } from '@/services/cache.service'
import { requestManager } from '@/services/request.service'
import { metricSeriesDataKey, metricSeriesKey, normalizeMetricSeriesList, PING_LATENCY_METRIC, PING_LOSS_METRIC, pingTaskId } from '@/utils/metricSeries'
import { getSharedRpc, RpcError } from '@/utils/rpc'

export interface PublicPingTaskCatalog {
  tasks: readonly PingTaskInfo[]
  taskById: ReadonlyMap<string, PingTaskInfo>
  taskIdsByNodeUuid: ReadonlyMap<string, ReadonlySet<string>>
}

export type PingMetricBatchTransport = 'batch' | 'pair'

export interface PingMetricEntityBatchResult<T> {
  valuesByEntityId: ReadonlyMap<string, T>
  errorsByEntityId: ReadonlyMap<string, Error>
  transport: PingMetricBatchTransport
  requestCount: number
}

export interface PingMetricSeriesBatchParams {
  entityIds: readonly string[]
  taskId: string | number
  query: Omit<MetricQueryParams, 'entity_id' | 'entity_ids'>
}

export interface PingMetricStatsBatchParams {
  entityIds: readonly string[]
  taskId: string | number
  query: Omit<PingMetricStatsParams, 'uuid' | 'entity_id' | 'entity_ids' | 'task_id' | 'task_ids'>
}

type BatchCapability = 'unknown' | 'supported' | 'unsupported'

let pingMetricSeriesBatchCapability: BatchCapability = 'unknown'
let pingMetricStatsBatchCapability: BatchCapability = 'unknown'

class InvalidPingMetricBatchPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPingMetricBatchPayloadError'
  }
}

const POSITIVE_BATCH_TASK_ID_PATTERN = /^\d+$/
const UNSUPPORTED_BATCH_ERROR_PATTERN = /invalid\s+params|entity_ids|unknown\s+field|unsupported/i

interface RawPingMetricWindowCacheEntry {
  series: MetricSeries[]
}

function normalizeHours(hours: number | null | undefined): number | undefined {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0)
    return undefined
  return Math.max(1, Math.floor(hours))
}

function normalizeMaxPoints(maxPoints: number | null | undefined): number | undefined {
  if (typeof maxPoints !== 'number' || !Number.isFinite(maxPoints) || maxPoints <= 0)
    return undefined
  return Math.floor(maxPoints)
}

function cachePart(value: unknown): string {
  if (value === undefined || value === null)
    return 'all'
  if (Array.isArray(value))
    return value.map(item => String(item)).sort().join(',') || 'empty'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort())
    }
    catch {
      return String(value)
    }
  }
  return String(value)
}

function shouldRetryMetricRequest(error: unknown): boolean {
  if (error instanceof RpcError)
    return error.code !== 401 && error.code !== 403 && error.code !== -32601 && error.code !== -32602
  return true
}

function normalizeBatchEntityId(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizeBatchEntityIds(values: readonly string[]): string[] {
  return [...new Set(values
    .map(normalizeBatchEntityId)
    .filter((value): value is string => value !== null))]
    .sort((left, right) => left.localeCompare(right))
}

function normalizeBatchTaskId(value: unknown): string | null {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && POSITIVE_BATCH_TASK_ID_PATTERN.test(value.trim()) && Number(value) > 0
      ? String(Number(value))
      : null
  return normalized
}

function errorValue(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}

function isUnsupportedBatchError(error: unknown): boolean {
  if (error instanceof InvalidPingMetricBatchPayloadError)
    return true
  if (error instanceof RpcError) {
    if (error.code === -32601 || error.code === -32602)
      return true
    return [400, 404, 422].includes(error.code)
      && UNSUPPORTED_BATCH_ERROR_PATTERN.test(error.message)
  }
  return error instanceof Error
    && UNSUPPORTED_BATCH_ERROR_PATTERN.test(error.message)
}

function assertRequestedBatchIdentities(
  identities: readonly { entityId: string | null, taskId: string | null }[],
  requestedEntityIds: ReadonlySet<string>,
  requestedTaskId: string,
): void {
  const invalid = identities.find(identity => !identity.entityId
    || !requestedEntityIds.has(identity.entityId)
    || identity.taskId !== requestedTaskId)
  if (invalid) {
    throw new InvalidPingMetricBatchPayloadError(
      'Ping Metric batch response contained an entity/task identity outside the request',
    )
  }
}

function normalizeMetricKeys(params: MetricQueryParams): string[] {
  const keys = [
    ...(params.metric_keys ?? []),
    ...(params.metrics ?? []),
    ...(params.metric_key ? [params.metric_key] : []),
  ]
  return [...new Set(keys.filter(Boolean))].sort()
}

const metricDefinitionsCache = new SharedCache<MetricDefinition[]>({
  maxSize: 1,
  ttl: CACHE_CONFIG.request.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
})

const publicPingTaskCatalogCache = new SharedCache<PublicPingTaskCatalog>({
  maxSize: CACHE_CONFIG.nodePingSummary.taskCatalog.maxSize,
  ttl: CACHE_CONFIG.nodePingSummary.taskCatalog.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
})

// Raw Ping samples are shared between the Detail chart and NodeCard only for
// the exact backend query window. This is deliberately an in-memory cache:
// it never persists telemetry, nor does it turn a failed request into proof
// that a bucket is missing.
const rawPingMetricWindowCache = new SharedCache<RawPingMetricWindowCacheEntry>({
  maxSize: CACHE_CONFIG.nodePingSummary.sharedRecords.maxSize,
  ttl: CACHE_CONFIG.nodePingSummary.sharedRecords.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
})

function normalizeRawPingMetricEntityId(value: unknown): string | null {
  if (typeof value !== 'string')
    return null

  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizeRawPingMetricWindowPart(value: unknown): string | null {
  if (typeof value === 'string')
    return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value))
    return String(value)
  return null
}

function getRawPingMetricWindowKey(entityId: string, start: string, end: string): string {
  return JSON.stringify(['metrics:raw-ping', entityId, start, end])
}

function getRawPingMetricWindow(params: MetricQueryParams): { start: string, end: string } | null {
  const start = normalizeRawPingMetricWindowPart(params.start ?? params.start_time)
  const end = normalizeRawPingMetricWindowPart(params.end ?? params.end_time)
  return start && end ? { start, end } : null
}

function isPingMetricKey(value: unknown): value is typeof PING_LATENCY_METRIC | typeof PING_LOSS_METRIC {
  return value === PING_LATENCY_METRIC || value === PING_LOSS_METRIC
}

function cloneMetricTags(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value ? { ...value } : undefined
}

function cloneMetricPoint(point: MetricPoint): MetricPoint {
  return {
    ...point,
    tag: cloneMetricTags(point.tag),
    tags: cloneMetricTags(point.tags),
    labels: cloneMetricTags(point.labels),
  }
}

function cloneMetricSeries(series: MetricSeries): MetricSeries {
  return {
    ...series,
    tag: cloneMetricTags(series.tag),
    tags: cloneMetricTags(series.tags),
    points: (series.points ?? []).map(cloneMetricPoint),
  }
}

function mergeRawPingMetricPoint(current: MetricPoint, candidate: MetricPoint): MetricPoint {
  // A synthetic `fill_empty` null (no observed count) must never erase a real
  // sample. An observed null with count > 0 is different: Komari uses it for a
  // fully-lost Ping rollup, so it must be allowed to replace stale finite data.
  const candidateHasObservedCount = typeof candidate.count === 'number'
    && Number.isFinite(candidate.count)
    && candidate.count > 0
  if (current.value !== null && candidate.value === null && !candidateHasObservedCount)
    return cloneMetricPoint(current)
  return cloneMetricPoint(candidate)
}

function mergeRawPingMetricSeries(current: MetricSeries, candidate: MetricSeries): MetricSeries {
  const pointsByKey = new Map<string, MetricPoint>()
  for (const point of current.points ?? [])
    pointsByKey.set(metricSeriesDataKey(current, point), cloneMetricPoint(point))
  for (const point of candidate.points ?? []) {
    const key = metricSeriesDataKey(candidate, point)
    const existing = pointsByKey.get(key)
    pointsByKey.set(key, existing ? mergeRawPingMetricPoint(existing, point) : cloneMetricPoint(point))
  }

  return {
    ...cloneMetricSeries(current),
    ...cloneMetricSeries(candidate),
    points: [...pointsByKey.values()],
  }
}

function mergeRawPingMetricSeriesList(
  current: readonly MetricSeries[],
  candidate: readonly MetricSeries[],
): MetricSeries[] {
  const seriesByKey = new Map<string, MetricSeries>()
  for (const series of current) {
    if (isPingMetricKey(series.metric_key))
      seriesByKey.set(metricSeriesKey(series), cloneMetricSeries(series))
  }
  for (const series of candidate) {
    if (!isPingMetricKey(series.metric_key))
      continue
    const key = metricSeriesKey(series)
    const existing = seriesByKey.get(key)
    seriesByKey.set(key, existing ? mergeRawPingMetricSeries(existing, series) : cloneMetricSeries(series))
  }
  return [...seriesByKey.values()]
}

function cacheRawPingMetricQuery(params: MetricQueryParams, response: MetricQueryResponse): void {
  const window = getRawPingMetricWindow(params)
  if (!window)
    return

  const pingSeries = (response.series ?? []).filter(series => isPingMetricKey(series.metric_key))
  const requestedPingMetrics = normalizeMetricKeys(params).some(isPingMetricKey)
  if (!requestedPingMetrics && !pingSeries.length)
    return

  const entityIds = new Set<string>()
  for (const entityId of [params.entity_id, ...(params.entity_ids ?? [])]) {
    const normalized = normalizeRawPingMetricEntityId(entityId)
    if (normalized)
      entityIds.add(normalized)
  }
  for (const series of pingSeries) {
    const normalized = normalizeRawPingMetricEntityId(series.entity_id)
    if (normalized)
      entityIds.add(normalized)
  }

  for (const entityId of entityIds) {
    const key = getRawPingMetricWindowKey(entityId, window.start, window.end)
    const current = rawPingMetricWindowCache.get(key)
    const incoming = pingSeries.filter(series => normalizeRawPingMetricEntityId(series.entity_id) === entityId)
    rawPingMetricWindowCache.set(key, {
      series: mergeRawPingMetricSeriesList(current?.series ?? [], incoming),
    })
  }
}

/**
 * Read only raw Ping samples collected by a successful query for the same
 * entity and exact time window. `null` is a cache miss; an empty array means a
 * prior successful Ping query was empty, but callers must not use that as a
 * missing-data decision for a new failed request.
 */
export function getCachedRawPingMetricSeries(
  entityId: string,
  start: string | number,
  end: string | number,
): MetricSeries[] | null {
  const normalizedEntityId = normalizeRawPingMetricEntityId(entityId)
  const normalizedStart = normalizeRawPingMetricWindowPart(start)
  const normalizedEnd = normalizeRawPingMetricWindowPart(end)
  if (!normalizedEntityId || !normalizedStart || !normalizedEnd)
    return null

  const cached = rawPingMetricWindowCache.get(
    getRawPingMetricWindowKey(normalizedEntityId, normalizedStart, normalizedEnd),
  )
  return cached ? mergeRawPingMetricSeriesList([], cached.series) : null
}

export function getMetricDefinitionsRequestKey(): string {
  return 'metrics:definitions'
}

export function getQueryMetricsRequestKey(params: MetricQueryParams): string {
  return [
    'metrics:query',
    cachePart(normalizeMetricKeys(params)),
    cachePart(params.entity_id),
    cachePart(params.entity_ids),
    cachePart(params.hours),
    cachePart(params.start ?? params.start_time),
    cachePart(params.end ?? params.end_time),
    cachePart(params.max_points ?? params.downsample_points),
    cachePart(params.aggregation ?? params.downsample_algorithm ?? params.algorithm),
    cachePart(params.aggregation_by_metric),
    cachePart(params.downsample_algorithm_by_metric),
    cachePart(params.algorithm_by_metric),
    cachePart(params.tags),
    cachePart(params.downsample ?? params.server_downsample),
    cachePart(params.fill_empty),
  ].join(':')
}

export function getPingMetricStatsRequestKey(params: PingMetricStatsParams): string {
  return [
    'metrics:ping-stats',
    cachePart(params.uuid ?? params.entity_id),
    cachePart(params.entity_ids),
    cachePart(params.task_id),
    cachePart(params.task_ids),
    cachePart(params.hours),
    cachePart(params.start ?? params.start_time),
    cachePart(params.end ?? params.end_time),
    cachePart(params.max_points ?? params.downsample_points),
  ].join(':')
}

export function getPublicPingTasksRequestKey(): string {
  return 'metrics:public-ping-tasks'
}

function normalizePublicPingTaskId(value: unknown): string | null {
  const id = typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : Number.NaN
  return Number.isFinite(id) ? String(id) : null
}

function buildPublicPingTaskCatalog(tasks: PingTaskInfo[]): PublicPingTaskCatalog {
  const taskById = new Map<string, PingTaskInfo>()
  const taskIdsByNodeUuid = new Map<string, Set<string>>()

  for (const task of tasks) {
    if (!task || typeof task !== 'object')
      continue
    const taskId = normalizePublicPingTaskId(task?.id)
    if (!taskId)
      continue

    taskById.set(taskId, task)
    for (const clientUuid of task.clients ?? []) {
      if (typeof clientUuid !== 'string')
        continue
      const normalizedUuid = clientUuid.trim().toLowerCase()
      if (!normalizedUuid)
        continue
      const taskIds = taskIdsByNodeUuid.get(normalizedUuid) ?? new Set<string>()
      taskIds.add(taskId)
      taskIdsByNodeUuid.set(normalizedUuid, taskIds)
    }
  }

  return {
    tasks,
    taskById,
    taskIdsByNodeUuid,
  }
}

export function abortQueryMetrics(params: MetricQueryParams): void {
  requestManager.abort(getQueryMetricsRequestKey(params))
}

export function abortPingMetricStats(params: PingMetricStatsParams): void {
  requestManager.abort(getPingMetricStatsRequestKey(params))
}

export async function loadMetricDefinitions(): Promise<MetricDefinition[]> {
  const key = getMetricDefinitionsRequestKey()
  const cached = metricDefinitionsCache.get(key)
  if (cached)
    return cached

  const definitions = await requestManager.run(
    key,
    async () => getSharedRpc().listPublicMetricDefinitions(),
    { shouldRetry: shouldRetryMetricRequest },
  )
  return metricDefinitionsCache.set(key, definitions)
}

export async function queryMetrics(params: MetricQueryParams): Promise<MetricQueryResponse> {
  const normalizedParams: MetricQueryParams = {
    ...params,
    hours: normalizeHours(params.hours),
    max_points: normalizeMaxPoints(params.max_points ?? params.downsample_points),
  }

  const response = await requestManager.run(
    getQueryMetricsRequestKey(normalizedParams),
    async signal => getSharedRpc().queryPublicMetrics(normalizedParams, signal),
    { shouldRetry: shouldRetryMetricRequest },
  )
  cacheRawPingMetricQuery(normalizedParams, response)
  return response
}

export async function loadPingMetricStats(params: PingMetricStatsParams): Promise<PingMetricStatsResponse> {
  const normalizedParams: PingMetricStatsParams = {
    ...params,
    hours: normalizeHours(params.hours),
    max_points: normalizeMaxPoints(params.max_points ?? params.downsample_points),
  }

  return requestManager.run(
    getPingMetricStatsRequestKey(normalizedParams),
    async signal => getSharedRpc().getPublicPingMetricStats(normalizedParams, signal),
    { shouldRetry: shouldRetryMetricRequest },
  )
}

function splitPingMetricSeriesBatchResponse(
  response: MetricQueryResponse,
  entityIds: readonly string[],
  taskId: string,
): ReadonlyMap<string, MetricQueryResponse> {
  const requestedEntityIds = new Set(entityIds)
  const normalizedSeries = normalizeMetricSeriesList(response.series)
    .filter(series => isPingMetricKey(series.metric_key))
  assertRequestedBatchIdentities(
    normalizedSeries.map(series => ({
      entityId: normalizeBatchEntityId(series.entity_id),
      taskId: normalizeBatchTaskId(pingTaskId(series)),
    })),
    requestedEntityIds,
    taskId,
  )

  return new Map(entityIds.map((entityId) => {
    const series = normalizedSeries.filter(item => normalizeBatchEntityId(item.entity_id) === entityId)
    return [entityId, {
      ...response,
      series,
      count: series.reduce((total, item) => total + (Number.isFinite(item.count) ? item.count : 0), 0),
    }]
  }))
}

function splitPingMetricStatsBatchResponse(
  response: PingMetricStatsResponse,
  entityIds: readonly string[],
  taskId: string,
): ReadonlyMap<string, PingMetricStatsResponse> {
  const requestedEntityIds = new Set(entityIds)
  assertRequestedBatchIdentities(
    response.stats.map(stat => ({
      entityId: normalizeBatchEntityId(stat.entity_id),
      taskId: normalizeBatchTaskId(stat.task_id),
    })),
    requestedEntityIds,
    taskId,
  )

  return new Map(entityIds.map((entityId) => {
    const stats = response.stats.filter(stat => normalizeBatchEntityId(stat.entity_id) === entityId)
    return [entityId, {
      ...response,
      stats,
      count: stats.length,
    }]
  }))
}

async function queryPingMetricSeriesPairs(
  entityIds: readonly string[],
  taskId: string,
  query: Omit<MetricQueryParams, 'entity_id' | 'entity_ids'>,
  priorRequestCount = 0,
): Promise<PingMetricEntityBatchResult<MetricQueryResponse>> {
  const valuesByEntityId = new Map<string, MetricQueryResponse>()
  const errorsByEntityId = new Map<string, Error>()
  await Promise.all(entityIds.map(async (entityId) => {
    try {
      const response = await queryMetrics({
        ...query,
        entity_id: entityId,
        entity_ids: undefined,
        tags: { ...(query.tags ?? {}), task_id: taskId },
      })
      const normalizedSeries = normalizeMetricSeriesList(response.series)
        .filter(series => isPingMetricKey(series.metric_key)
          && normalizeBatchEntityId(series.entity_id) === entityId
          && normalizeBatchTaskId(pingTaskId(series)) === taskId)
      valuesByEntityId.set(entityId, {
        ...response,
        series: normalizedSeries,
        count: normalizedSeries.reduce((total, item) => total + (Number.isFinite(item.count) ? item.count : 0), 0),
      })
    }
    catch (error) {
      errorsByEntityId.set(entityId, errorValue(error, '获取 Ping Metric 序列失败'))
    }
  }))
  return {
    valuesByEntityId,
    errorsByEntityId,
    transport: 'pair',
    requestCount: priorRequestCount + entityIds.length,
  }
}

async function loadPingMetricStatsPairs(
  entityIds: readonly string[],
  taskId: string,
  query: Omit<PingMetricStatsParams, 'uuid' | 'entity_id' | 'entity_ids' | 'task_id' | 'task_ids'>,
  priorRequestCount = 0,
): Promise<PingMetricEntityBatchResult<PingMetricStatsResponse>> {
  const valuesByEntityId = new Map<string, PingMetricStatsResponse>()
  const errorsByEntityId = new Map<string, Error>()
  await Promise.all(entityIds.map(async (entityId) => {
    try {
      const response = await loadPingMetricStats({
        ...query,
        uuid: undefined,
        entity_id: entityId,
        entity_ids: undefined,
        task_id: taskId,
        task_ids: undefined,
      })
      const stats = response.stats.filter(stat => normalizeBatchEntityId(stat.entity_id) === entityId
        && normalizeBatchTaskId(stat.task_id) === taskId)
      valuesByEntityId.set(entityId, { ...response, stats, count: stats.length })
    }
    catch (error) {
      errorsByEntityId.set(entityId, errorValue(error, '获取 Ping Metric 统计失败'))
    }
  }))
  return {
    valuesByEntityId,
    errorsByEntityId,
    transport: 'pair',
    requestCount: priorRequestCount + entityIds.length,
  }
}

/**
 * Query one task for a stable entity set. Komari versions that reject
 * `entity_ids` are downgraded once to exact entity/task pair requests. A
 * transport failure is not treated as a capability failure.
 */
export async function queryPingMetricSeriesBatch(
  params: PingMetricSeriesBatchParams,
): Promise<PingMetricEntityBatchResult<MetricQueryResponse>> {
  const entityIds = normalizeBatchEntityIds(params.entityIds)
  const taskId = normalizeBatchTaskId(params.taskId)
  if (!entityIds.length || !taskId) {
    return {
      valuesByEntityId: new Map(),
      errorsByEntityId: new Map(),
      transport: 'pair',
      requestCount: 0,
    }
  }

  if (entityIds.length === 1 || pingMetricSeriesBatchCapability === 'unsupported')
    return queryPingMetricSeriesPairs(entityIds, taskId, params.query)

  try {
    const response = await queryMetrics({
      ...params.query,
      entity_id: undefined,
      entity_ids: entityIds,
      tags: { ...(params.query.tags ?? {}), task_id: taskId },
    })
    const valuesByEntityId = splitPingMetricSeriesBatchResponse(response, entityIds, taskId)
    pingMetricSeriesBatchCapability = 'supported'
    return {
      valuesByEntityId,
      errorsByEntityId: new Map(),
      transport: 'batch',
      requestCount: 1,
    }
  }
  catch (error) {
    if (!isUnsupportedBatchError(error))
      throw error
    pingMetricSeriesBatchCapability = 'unsupported'
    return queryPingMetricSeriesPairs(entityIds, taskId, params.query, 1)
  }
}

/** Same capability-safe batching contract as queryPingMetricSeriesBatch. */
export async function loadPingMetricStatsBatch(
  params: PingMetricStatsBatchParams,
): Promise<PingMetricEntityBatchResult<PingMetricStatsResponse>> {
  const entityIds = normalizeBatchEntityIds(params.entityIds)
  const taskId = normalizeBatchTaskId(params.taskId)
  if (!entityIds.length || !taskId) {
    return {
      valuesByEntityId: new Map(),
      errorsByEntityId: new Map(),
      transport: 'pair',
      requestCount: 0,
    }
  }

  if (entityIds.length === 1 || pingMetricStatsBatchCapability === 'unsupported')
    return loadPingMetricStatsPairs(entityIds, taskId, params.query)

  try {
    const response = await loadPingMetricStats({
      ...params.query,
      uuid: undefined,
      entity_id: undefined,
      entity_ids: entityIds,
      task_id: taskId,
      task_ids: undefined,
    })
    const valuesByEntityId = splitPingMetricStatsBatchResponse(response, entityIds, taskId)
    pingMetricStatsBatchCapability = 'supported'
    return {
      valuesByEntityId,
      errorsByEntityId: new Map(),
      transport: 'batch',
      requestCount: 1,
    }
  }
  catch (error) {
    if (!isUnsupportedBatchError(error))
      throw error
    pingMetricStatsBatchCapability = 'unsupported'
    return loadPingMetricStatsPairs(entityIds, taskId, params.query, 1)
  }
}

export function getPingMetricBatchCapabilitySnapshot(): Readonly<{
  series: BatchCapability
  stats: BatchCapability
}> {
  return Object.freeze({
    series: pingMetricSeriesBatchCapability,
    stats: pingMetricStatsBatchCapability,
  })
}

export async function loadPublicPingTasks(): Promise<PingTaskInfo[]> {
  return [...(await loadPublicPingTaskCatalog()).tasks]
}

export async function loadPublicPingTaskCatalog(): Promise<PublicPingTaskCatalog> {
  const key = getPublicPingTasksRequestKey()
  const cached = publicPingTaskCatalogCache.get(key)
  if (cached)
    return cached

  const catalog = await requestManager.run(
    key,
    async () => buildPublicPingTaskCatalog(await getSharedRpc().getPublicPingTasks()),
    { shouldRetry: shouldRetryMetricRequest },
  )
  return publicPingTaskCatalogCache.set(key, catalog)
}

export function getAssignedPublicPingTask(
  catalog: PublicPingTaskCatalog,
  taskId: string,
  nodeUuid: string,
): PingTaskInfo | null {
  const task = catalog.taskById.get(taskId)
  if (!task)
    return null

  return catalog.taskIdsByNodeUuid.get(nodeUuid.trim().toLowerCase())?.has(taskId)
    ? task
    : null
}
