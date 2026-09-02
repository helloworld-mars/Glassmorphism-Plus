import type { MetricSeries } from '@/utils/rpc'
import {
  normalizeMetricSeriesList,
  PING_LATENCY_METRIC,
  PING_LOSS_METRIC,
  pingTaskId,
} from '@/utils/metricSeries'
import { parsePingTimestampMs } from '@/utils/pingTime'

const POSITIVE_TASK_ID_PATTERN = /^\d+$/u

interface PairedMetricPoint {
  value: number | null
  count: number
  downsampled: boolean
}

interface PairedMetricSampleAccumulator {
  entityId: string
  taskId: string
  timestamp: number
  latency?: PairedMetricPoint
  loss?: PairedMetricPoint
}

export interface PingMetricSample {
  entityId: string
  taskId: string
  time: string
  timestamp: number
  /** Mean latency of successful probes only. Null means an observed gap/loss. */
  latency: number | null
  /** Packet-loss ratio in the inclusive range 0..1 when supplied by Komari. */
  loss: number | null
  totalCount: number
  /** False only for a backend fill-empty marker without a real observation. */
  observed: boolean
}

export interface PingMetricSampleOptions {
  entityId?: string
  taskId?: string
  start?: number
  end?: number
}

function pointCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0
}

function finiteValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeEntityId(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function normalizeTaskId(value: unknown): string | null {
  if (typeof value !== 'string' || !POSITIVE_TASK_ID_PATTERN.test(value.trim()))
    return null
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : null
}

function isInRequestedWindow(timestamp: number, options: PingMetricSampleOptions): boolean {
  if (typeof options.start === 'number' && timestamp < options.start)
    return false
  if (typeof options.end === 'number' && timestamp >= options.end)
    return false
  return true
}

/**
 * Pair Komari Ping latency/loss series by entity, task ID and exact timestamp.
 *
 * Komari records a failed probe as latency=-1 and loss=1. Rollup `avg` includes
 * that -1 value, so a partially-lost bucket must be converted back to the mean
 * of successful probes: `(aggregateLatency + lossRatio) / (1 - lossRatio)`.
 * A fully-lost observed bucket remains an explicit null; a fill-empty marker is
 * retained as `observed=false` so charts can preserve its gap without treating
 * it as telemetry or skipping the Legacy fallback.
 */
export function normalizePingMetricSamples(
  seriesList: readonly MetricSeries[] | undefined,
  options: PingMetricSampleOptions = {},
): PingMetricSample[] {
  const samplesByKey = new Map<string, PairedMetricSampleAccumulator>()
  const requestedEntityId = options.entityId ? normalizeEntityId(options.entityId) : null
  const requestedTaskId = options.taskId ? normalizeTaskId(options.taskId) : null

  for (const series of normalizeMetricSeriesList(seriesList ? [...seriesList] : [])) {
    if (series.metric_key !== PING_LATENCY_METRIC && series.metric_key !== PING_LOSS_METRIC)
      continue
    const entityId = normalizeEntityId(series.entity_id)
    if (!entityId || (requestedEntityId && entityId !== requestedEntityId))
      continue

    const taskId = normalizeTaskId(pingTaskId(series))
    if (!taskId || (requestedTaskId && taskId !== requestedTaskId))
      continue

    for (const point of series.points) {
      const timestamp = parsePingTimestampMs(point.time)
      if (timestamp === null || !isInRequestedWindow(timestamp, options))
        continue

      const key = JSON.stringify([entityId, taskId, timestamp])
      const sample = samplesByKey.get(key) ?? {
        entityId,
        taskId,
        timestamp,
      }
      const pairedPoint: PairedMetricPoint = {
        value: finiteValue(point.value),
        count: pointCount(point.count),
        downsampled: series.downsampled === true,
      }
      if (series.metric_key === PING_LATENCY_METRIC)
        sample.latency = pairedPoint
      else
        sample.loss = pairedPoint
      samplesByKey.set(key, sample)
    }
  }

  return [...samplesByKey.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((sample) => {
      const rawLatency = finiteValue(sample.latency?.value)
      const rawLoss = finiteValue(sample.loss?.value)
      const loss = rawLoss !== null && rawLoss >= 0 && rawLoss <= 1 ? rawLoss : null
      const totalCount = Math.max(sample.latency?.count ?? 0, sample.loss?.count ?? 0)
      const observed = rawLatency !== null || loss !== null || totalCount > 0

      let latency = rawLatency !== null && rawLatency >= 0 ? rawLatency : null
      if (loss !== null && loss >= 1) {
        latency = null
      }
      else if (
        latency !== null
        && loss !== null
        && loss > 0
        && (sample.latency?.downsampled || sample.loss?.downsampled || totalCount > 1)
      ) {
        // Algebraically equivalent to `(avg * total + lost) / valid`, without
        // rounding a fractional loss ratio back to an integer lost count.
        latency = (latency + loss) / (1 - loss)
      }

      return {
        entityId: sample.entityId,
        taskId: sample.taskId,
        time: new Date(sample.timestamp).toISOString(),
        timestamp: sample.timestamp,
        latency,
        loss,
        totalCount: totalCount || (observed ? 1 : 0),
        observed,
      }
    })
}
