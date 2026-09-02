import type { PingHistoryBucketState } from '@/utils/pingHistoryState'

export interface EffectiveNodePingPair {
  nodeUuid: string
  taskId: string | number
  taskName?: string
  /** Komari task interval in seconds. */
  intervalSeconds?: number
}

export interface NodeCardPingQueryWindow {
  hours: number
  maxPoints?: number
  bucketCount?: number
  batchChunkSize?: number
}

export type NodeCardPingPairStatus = 'pending' | 'data' | 'confirmed_missing' | 'error' | 'stale'
export type NodeCardPingPairSource = 'metric' | 'legacy'

export interface NodeCardPingSample {
  entityId: string
  taskId: string
  /** Exact backend observation timestamp; never replaced with a bucket time. */
  time: string
  timestamp: number
  latency: number | null
  /** Packet-loss ratio in the inclusive range 0..1. */
  loss: number | null
  totalCount: number
  observed: boolean
}

export interface NodeCardPingHistoryPoint {
  /** Stable bucket start, distinct from the real observation timestamps below. */
  time: string
  latency: number | null
  loss: number | null
  latencySampleTime: string | null
  lossSampleTime: string | null
  latencyState: PingHistoryBucketState
  lossState: PingHistoryBucketState
}

export interface NodeCardPingPairSnapshot {
  nodeUuid: string
  taskId: string
  taskName: string
  status: NodeCardPingPairStatus
  source: NodeCardPingPairSource
  samples: readonly NodeCardPingSample[]
  history: readonly NodeCardPingHistoryPoint[]
  avgLatency: number | null
  /** Percent in the inclusive range 0..100. */
  avgLoss: number | null
  avgVolatility: number
  latestSampleAt: number | null
  windowStart: number
  windowEnd: number
  firstObservedAt: number
  fetchedAt: number
  taskIntervalMs: number
  canConfirmMissing: boolean
  stale: boolean
  refreshing: boolean
  error: string | null
}

export interface NodeCardPingRequestCounters {
  metricStatsBatch: number
  metricStatsPair: number
  metricSeriesBatch: number
  metricSeriesPair: number
  legacyPair: number
  aggregate: number
  dedupedRefresh: number
}

export interface NodeCardPingCoordinatorDebugSnapshot {
  targets: number
  pairEntries: number
  subscribers: number
  schedulerSubscribers: number
  timerCount: number
  listenerCount: number
  cacheHits: number
  cacheMisses: number
  persistentCacheHits: number
  persistentCacheMisses: number
  inflight: number
  requestCounters: Readonly<NodeCardPingRequestCounters>
}

export interface NodeCardPingCoordinatorSubscription {
  getSnapshots: () => readonly NodeCardPingPairSnapshot[]
  refreshNow: () => void
  release: () => void
}
