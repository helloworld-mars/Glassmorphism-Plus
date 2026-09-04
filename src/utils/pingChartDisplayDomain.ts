import { parsePingTimestampMs } from '@/utils/pingTime'

export interface PingChartDisplaySample {
  taskId: number
  time: unknown
  finalized: boolean
}

export interface PingChartDisplayDomain {
  min: number
  max: number
  latestFinalizedTimestamp: number | null
}

export interface ResolvePingChartDisplayDomainOptions {
  requestedStart: number
  requestedEnd: number
  selectedTaskIds: readonly number[]
  samples: readonly PingChartDisplaySample[]
  preserveRequestedEnd: boolean
}

/**
 * Resolves the chart-only time domain without changing the requested range or
 * manufacturing an endpoint. Relative ranges can trim only the common tail
 * after the latest finalized sample among currently visible tasks; custom
 * ranges always preserve the user's explicit end.
 */
export function resolvePingChartDisplayDomain(
  options: ResolvePingChartDisplayDomainOptions,
): PingChartDisplayDomain {
  const selectedTaskIds = new Set(options.selectedTaskIds)
  let latestFinalizedTimestamp: number | null = null

  for (const sample of options.samples) {
    if (!sample.finalized || !selectedTaskIds.has(sample.taskId))
      continue

    const timestamp = parsePingTimestampMs(sample.time)
    if (
      timestamp === null
      || timestamp < options.requestedStart
      || timestamp >= options.requestedEnd
    ) {
      continue
    }

    latestFinalizedTimestamp = latestFinalizedTimestamp === null
      ? timestamp
      : Math.max(latestFinalizedTimestamp, timestamp)
  }

  const canTrimRelativeTail = !options.preserveRequestedEnd
    && latestFinalizedTimestamp !== null
    && latestFinalizedTimestamp > options.requestedStart

  return {
    min: options.requestedStart,
    max: canTrimRelativeTail && latestFinalizedTimestamp !== null
      ? latestFinalizedTimestamp
      : options.requestedEnd,
    latestFinalizedTimestamp,
  }
}
