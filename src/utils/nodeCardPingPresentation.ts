import type { NodeCardPingHistoryPoint } from '@/types/node-card-ping'

export type NodeCardPingSeverity
  = | 'neutral'
    | 'waiting'
    | 'no-sample'
    | 'excellent'
    | 'good'
    | 'moderate'
    | 'elevated'
    | 'critical'
    | 'unreachable'
    | 'error'

export function classifyNodeCardLatency(latency: number | null): NodeCardPingSeverity {
  if (latency === null || !Number.isFinite(latency) || latency < 0)
    return 'neutral'
  if (latency <= 60)
    return 'excellent'
  if (latency <= 100)
    return 'good'
  if (latency <= 160)
    return 'moderate'
  if (latency <= 200)
    return 'elevated'
  return 'critical'
}

export function classifyNodeCardLoss(loss: number | null): NodeCardPingSeverity {
  if (loss === null || !Number.isFinite(loss) || loss < 0)
    return 'neutral'
  if (loss === 0)
    return 'excellent'
  if (loss <= 1)
    return 'good'
  if (loss <= 3)
    return 'moderate'
  if (loss <= 5)
    return 'elevated'
  return 'critical'
}

/**
 * An unreachable bucket needs a real observation from both Metric series.
 * A null latency by itself remains neutral because it may be pending or absent.
 */
export function isConfirmedNodeCardPingUnreachable(point: NodeCardPingHistoryPoint): boolean {
  return point.latencyState === 'data'
    && point.lossState === 'data'
    && point.latency === null
    && point.loss === 100
    && point.latencySampleTime !== null
    && point.latencySampleTime === point.lossSampleTime
}

export function latencyBucketSeverity(
  point: NodeCardPingHistoryPoint,
  requestFailed = false,
): NodeCardPingSeverity {
  if (isConfirmedNodeCardPingUnreachable(point))
    return 'unreachable'
  if (point.latency !== null)
    return classifyNodeCardLatency(point.latency)
  if (point.latencyState === 'confirmed-missing')
    return 'no-sample'
  if (requestFailed && point.latencyState === 'pending')
    return 'error'
  if (point.latencyState === 'pending')
    return 'waiting'
  return 'neutral'
}

export function lossBucketSeverity(
  point: NodeCardPingHistoryPoint,
  requestFailed = false,
): NodeCardPingSeverity {
  if (isConfirmedNodeCardPingUnreachable(point))
    return 'unreachable'
  if (point.loss !== null)
    return classifyNodeCardLoss(point.loss)
  if (point.lossState === 'confirmed-missing')
    return 'no-sample'
  if (requestFailed && point.lossState === 'pending')
    return 'error'
  if (point.lossState === 'pending')
    return 'waiting'
  return 'neutral'
}
