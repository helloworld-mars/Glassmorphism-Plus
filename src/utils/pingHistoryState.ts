import { CACHE_CONFIG } from '@/constants/cache'

/**
 * A rendered Ping bucket must distinguish an actual observed sample from an
 * unfinished sample period. `null` is a value shape, not a data-state.
 */
export type PingHistoryBucketState = 'pending' | 'data' | 'confirmed-missing'

export interface PingHistoryBucketTiming {
  bucketStart: number
  bucketEnd: number
  now: number
  latestAcceptedSampleAt: number | null
  /** A stable request-time anchor for a cold bucket with no accepted samples. */
  firstObservedAt: number
  taskIntervalMs: number
  /** Only a successful empty raw response may become confirmed-missing. */
  canConfirmMissing: boolean
}

/**
 * A closed bucket remains provisional for the coordinator's existing write
 * grace and bounded retry budget. The helper creates no timers or requests.
 */
export function getPingBucketDecisionDeadline({
  bucketEnd,
}: Pick<PingHistoryBucketTiming, 'bucketEnd'>): number {
  const refresh = CACHE_CONFIG.nodePingSummary.refresh
  const retryBudget = refresh.retryDelays.reduce((total, delay) => total + delay, 0)
  return bucketEnd + refresh.sampleWriteGrace + retryBudget
}

/**
 * Buckets can move from confirmed-missing back to data when a late real sample
 * appears. No branch manufactures a latency or loss value.
 */
export function resolvePingHistoryBucketState(
  hasRawSample: boolean,
  timing: PingHistoryBucketTiming,
): PingHistoryBucketState {
  if (hasRawSample)
    return 'data'

  // A transport failure, cancelled request, or unavailable backend has not
  // established that this bucket is absent. Keep it explicitly pending rather
  // than turning an operational failure into a data-quality claim.
  if (!timing.canConfirmMissing)
    return 'pending'

  // An open (or future) bucket has not finished collecting samples. Keep it
  // pending regardless of the retry deadline so an empty in-progress interval
  // is never presented as a final data-quality result.
  if (timing.now < timing.bucketEnd)
    return 'pending'

  // The newest closed bucket absorbs normal write lag and the coordinator's
  // bounded retries. Older successfully queried buckets settle independently.
  if (timing.now < getPingBucketDecisionDeadline(timing))
    return 'pending'

  return 'confirmed-missing'
}
