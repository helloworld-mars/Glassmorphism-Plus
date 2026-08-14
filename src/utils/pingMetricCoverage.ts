import type { MetricPoint, MetricQueryResponse, MetricSeries } from '@/utils/rpc'
import {
  metricSeriesKey,
  metricTags,
  metricTagsKey,
  normalizeMetricSeriesList,
  PING_LATENCY_METRIC,
  PING_LOSS_METRIC,
} from '@/utils/metricSeries'
import { parsePingTimestampMs } from '@/utils/pingTime'

interface CoveragePointCandidate {
  point: MetricPoint
  resolutionSeconds: number
  sourceIndex: number
}

interface CoverageSeriesAccumulator {
  series: MetricSeries
  resolutionSeconds: number
  sourceIndex: number
  points: Map<string, CoveragePointCandidate>
}

function cloneMetricPoint(point: MetricPoint): MetricPoint {
  return {
    ...point,
    tag: point.tag ? { ...point.tag } : undefined,
    tags: point.tags ? { ...point.tags } : undefined,
    labels: point.labels ? { ...point.labels } : undefined,
  }
}

function cloneMetricSeries(series: MetricSeries): MetricSeries {
  return {
    ...series,
    tag: series.tag ? { ...series.tag } : undefined,
    tags: series.tags ? { ...series.tags } : undefined,
    points: (series.points ?? []).map(cloneMetricPoint),
  }
}

function metricResolutionSeconds(series: MetricSeries): number {
  return typeof series.interval_seconds === 'number'
    && Number.isFinite(series.interval_seconds)
    && series.interval_seconds > 0
    ? series.interval_seconds
    : Number.POSITIVE_INFINITY
}

function isPingCoverageMetric(series: Pick<MetricSeries, 'metric_key'>): boolean {
  return series.metric_key === PING_LATENCY_METRIC || series.metric_key === PING_LOSS_METRIC
}

function coveragePointKey(point: MetricPoint): string {
  const timestamp = parsePingTimestampMs(point.time)
  return JSON.stringify([
    timestamp ?? point.time,
    metricTagsKey(metricTags(point)),
  ])
}

function shouldReplaceCoveragePoint(
  current: CoveragePointCandidate,
  candidate: CoveragePointCandidate,
): boolean {
  if (candidate.resolutionSeconds !== current.resolutionSeconds)
    return candidate.resolutionSeconds < current.resolutionSeconds
  return candidate.sourceIndex > current.sourceIndex
}

/** Return the coarsest positive Ping interval advertised by a response. */
export function getPingMetricResponseIntervalSeconds(response: MetricQueryResponse): number | null {
  const intervals = normalizeMetricSeriesList(response.series)
    .filter(isPingCoverageMetric)
    .map(metricResolutionSeconds)
    .filter(Number.isFinite)
  return intervals.length ? Math.max(...intervals) : null
}

export function hasObservedPingMetricData(response: MetricQueryResponse): boolean {
  return normalizeMetricSeriesList(response.series)
    .filter(isPingCoverageMetric)
    .some(series => series.points.some(point => (
      (typeof point.count === 'number' && Number.isFinite(point.count) && point.count > 0)
      || (typeof point.value === 'number' && Number.isFinite(point.value))
    )))
}

/**
 * Deterministically merge independently queried Ping rollup segments.
 *
 * A lower `interval_seconds` always wins at the same entity/task/timestamp,
 * including an explicit finer null. Equal-resolution later segments win so a
 * refreshed supplemental response replaces its older copy without averaging.
 */
export function mergePingMetricCoverageResponses(
  responses: readonly MetricQueryResponse[],
): MetricQueryResponse {
  const outer = responses[0]
  if (!outer)
    throw new Error('At least one Ping Metric response is required')

  const seriesByKey = new Map<string, CoverageSeriesAccumulator>()

  responses.forEach((response, sourceIndex) => {
    for (const normalized of normalizeMetricSeriesList(response.series)) {
      if (!isPingCoverageMetric(normalized))
        continue

      const candidateResolution = metricResolutionSeconds(normalized)
      const key = metricSeriesKey(normalized)
      const accumulator = seriesByKey.get(key) ?? {
        series: cloneMetricSeries(normalized),
        resolutionSeconds: candidateResolution,
        sourceIndex,
        points: new Map<string, CoveragePointCandidate>(),
      }

      if (
        candidateResolution < accumulator.resolutionSeconds
        || (candidateResolution === accumulator.resolutionSeconds && sourceIndex > accumulator.sourceIndex)
      ) {
        accumulator.series = cloneMetricSeries(normalized)
        accumulator.resolutionSeconds = candidateResolution
        accumulator.sourceIndex = sourceIndex
      }

      for (const point of normalized.points) {
        const pointKey = coveragePointKey(point)
        const candidate = {
          point: cloneMetricPoint(point),
          resolutionSeconds: candidateResolution,
          sourceIndex,
        }
        const current = accumulator.points.get(pointKey)
        if (!current || shouldReplaceCoveragePoint(current, candidate))
          accumulator.points.set(pointKey, candidate)
      }

      seriesByKey.set(key, accumulator)
    }
  })

  const series = [...seriesByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, accumulator]) => {
      const points = Array.from(accumulator.points.values(), candidate => candidate.point)
        .sort((left, right) => (
          (parsePingTimestampMs(left.time) ?? 0) - (parsePingTimestampMs(right.time) ?? 0)
        ))
      return {
        ...accumulator.series,
        interval_seconds: Number.isFinite(accumulator.resolutionSeconds)
          ? accumulator.resolutionSeconds
          : accumulator.series.interval_seconds,
        count: points.length,
        points,
      }
    })

  return {
    ...outer,
    series,
    count: series.reduce((total, item) => total + item.points.length, 0),
  }
}
