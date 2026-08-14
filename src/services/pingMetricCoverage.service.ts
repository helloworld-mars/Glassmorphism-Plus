import type { MetricQueryParams, MetricQueryResponse } from '@/utils/rpc'
import { CACHE_CONFIG } from '@/constants/cache'
import { TIME_MS } from '@/constants/time'
import { SharedCache } from '@/services/cache.service'
import { queryMetrics } from '@/services/metrics.service'
import {
  getPingMetricResponseIntervalSeconds,
  mergePingMetricCoverageResponses,
} from '@/utils/pingMetricCoverage'
import { parsePingTimestampMs } from '@/utils/pingTime'

const coverageConfig = CACHE_CONFIG.nodePingSummary.metricCoverage

interface PingMetricCoverageCapability {
  windowHours: number
  intervalSeconds: number
}

export interface PingMetricCoverageRequest {
  kind: 'full' | 'supplemental'
  start: string
  end: string
  hours: number
  intervalSeconds: number | null
}

export interface PingMetricCoverageResult {
  response: MetricQueryResponse
  requests: PingMetricCoverageRequest[]
}

export type PingMetricCoverageQuery = (params: MetricQueryParams) => Promise<MetricQueryResponse>

const capabilityCache = new SharedCache<PingMetricCoverageCapability>({
  maxSize: coverageConfig.capability.maxSize,
  ttl: coverageConfig.capability.ttl,
  cleanupInterval: CACHE_CONFIG.cleanup.interval,
})

function metricQueryWindow(params: MetricQueryParams): { start: number, end: number, hours: number } | null {
  const start = parsePingTimestampMs(params.start ?? params.start_time)
  const end = parsePingTimestampMs(params.end ?? params.end_time)
  if (start === null || end === null || end <= start)
    return null
  return { start, end, hours: (end - start) / TIME_MS.hour }
}

function capabilityKey(outerHours: number, fullIntervalSeconds: number | null): string {
  return JSON.stringify([
    coverageConfig.schemaVersion,
    Math.round(outerHours * 1000) / 1000,
    fullIntervalSeconds ?? 'unknown',
  ])
}

function initialProbeHours(outerHours: number): number {
  if (outerHours > coverageConfig.defaultFineWindowHintHours)
    return coverageConfig.defaultFineWindowHintHours
  return Math.floor(outerHours * 0.75)
}

function nextProbeHours(currentHours: number): number {
  return Math.floor(currentHours / 2)
}

function supplementalParams(
  params: MetricQueryParams,
  end: number,
  windowHours: number,
): MetricQueryParams {
  const {
    start: _start,
    start_time: _startTime,
    end: _end,
    end_time: _endTime,
    hours: _hours,
    ...rest
  } = params
  return {
    ...rest,
    start: new Date(end - windowHours * TIME_MS.hour).toISOString(),
    end: new Date(end).toISOString(),
  }
}

function describeRequest(
  kind: PingMetricCoverageRequest['kind'],
  params: MetricQueryParams,
  hours: number,
  response: MetricQueryResponse,
): PingMetricCoverageRequest {
  return {
    kind,
    start: String(params.start ?? params.start_time ?? ''),
    end: String(params.end ?? params.end_time ?? ''),
    hours,
    intervalSeconds: getPingMetricResponseIntervalSeconds(response),
  }
}

/**
 * Load one full Ping range and, only when Komari selects a coarse tier for a
 * long window, one bounded recent finer segment. Komari 1.4.x does not expose
 * configured rollup retention publicly, so a short-lived capability hint is
 * learned from `interval_seconds`; at most three supplemental probes are made.
 */
export async function loadPingMetricCoverage(
  params: MetricQueryParams,
  query: PingMetricCoverageQuery = queryMetrics,
): Promise<PingMetricCoverageResult> {
  const window = metricQueryWindow(params)
  const fullResponse = await query(params)
  const fullInterval = getPingMetricResponseIntervalSeconds(fullResponse)
  const requests = [describeRequest('full', params, window?.hours ?? 0, fullResponse)]

  if (
    !window
    || window.hours <= coverageConfig.longRangeThresholdHours
    || (fullInterval !== null && fullInterval <= coverageConfig.maximumFineIntervalSeconds)
  ) {
    return { response: fullResponse, requests }
  }

  const profileKey = capabilityKey(window.hours, fullInterval)
  const cachedCapability = capabilityCache.get(profileKey)
  let probeHours = cachedCapability?.windowHours ?? initialProbeHours(window.hours)
  const responses = [fullResponse]

  for (let attempt = 0; attempt < coverageConfig.maxSupplementalProbes; attempt++) {
    if (
      probeHours < coverageConfig.minimumProbeWindowHours
      || probeHours >= window.hours
    ) {
      break
    }

    const probeParams = supplementalParams(params, window.end, probeHours)
    let probeResponse: MetricQueryResponse
    try {
      probeResponse = await query(probeParams)
    }
    catch {
      break
    }

    const probeInterval = getPingMetricResponseIntervalSeconds(probeResponse)
    requests.push(describeRequest('supplemental', probeParams, probeHours, probeResponse))

    const isFiner = probeInterval !== null
      && (fullInterval === null || probeInterval < fullInterval)
    if (isFiner) {
      capabilityCache.set(profileKey, {
        windowHours: probeHours,
        intervalSeconds: probeInterval,
      })
      responses.push(probeResponse)
      break
    }

    probeHours = nextProbeHours(probeHours)
  }

  return {
    response: responses.length > 1
      ? mergePingMetricCoverageResponses(responses)
      : fullResponse,
    requests,
  }
}
