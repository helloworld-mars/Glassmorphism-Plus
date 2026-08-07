import { TIME_MS } from './time'

export const CACHE_CONFIG = {
  providerMetadata: {
    maxSize: 1000,
    ttl: TIME_MS.day,
  },
  request: {
    ttl: 5 * TIME_MS.minute,
  },
  promise: {
    ttl: 30 * TIME_MS.second,
  },
  nodePingSummary: {
    refreshInterval: TIME_MS.minute,
    historyBucketCount: 20,
    historyBucketAlignment: 3 * TIME_MS.minute,
    taskCatalog: {
      maxSize: 1,
      ttl: TIME_MS.minute,
    },
    sharedRecords: {
      maxSize: 160,
      ttl: TIME_MS.minute,
    },
    selectedStats: {
      maxSize: 160,
      ttl: 30 * TIME_MS.minute,
    },
    persistedSelectedStats: {
      maxSize: 160,
      ttl: 30 * TIME_MS.minute,
    },
    refresh: {
      schedulerTick: TIME_MS.second,
      // Komari may persist a scheduled Ping sample a few seconds after its nominal timestamp.
      sampleWriteGrace: 5 * TIME_MS.second,
      retryDelays: [5 * TIME_MS.second, 10 * TIME_MS.second, 20 * TIME_MS.second],
      heartbeat: TIME_MS.minute,
      staleAfterIntervals: 4,
    },
  },
  cleanup: {
    interval: 5 * TIME_MS.minute,
  },
} as const
