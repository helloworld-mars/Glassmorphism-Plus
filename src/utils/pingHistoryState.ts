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

function normalizeInterval(value: number): number {
  const refresh = CACHE_CONFIG.nodePingSummary.refresh
  return Number.isFinite(value) && value > 0
    ? Math.max(refresh.schedulerTick, Math.floor(value))
    : refresh.heartbeat
}

/**
 * The deadline is derived from a real sample cadence and the scheduler's
 * bounded retry budget. A newly opened bucket is never missing merely because
 * its first query raced normal metric ingestion.
 */
export function getPingBucketDecisionDeadline({
  bucketStart,
  latestAcceptedSampleAt,
  firstObservedAt,
  taskIntervalMs,
}: Pick<PingHistoryBucketTiming, 'bucketStart' | 'latestAcceptedSampleAt' | 'firstObservedAt' | 'taskIntervalMs'>): number {
  const refresh = CACHE_CONFIG.nodePingSummary.refresh
  const expectedSampleAt = latestAcceptedSampleAt === null
    ? Math.max(bucketStart, firstObservedAt)
    : Math.max(bucketStart, latestAcceptedSampleAt + normalizeInterval(taskIntervalMs))
  const retryBudget = refresh.retryDelays.reduce((total, delay) => total + delay, 0)
  return expectedSampleAt + refresh.sampleWriteGrace + retryBudget
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

  const isOpenBucket = timing.now >= timing.bucketStart && timing.now < timing.bucketEnd
  if (!isOpenBucket)
    return 'confirmed-missing'

  return timing.now < getPingBucketDecisionDeadline(timing)
    ? 'pending'
    : 'confirmed-missing'
}
