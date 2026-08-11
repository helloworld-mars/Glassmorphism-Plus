import type { MaybeRefOrGetter } from 'vue'
import { computed, toValue } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'

export type NodePingMetric = 'latency' | 'loss'

export interface NodePingBar {
  key: string
  time: string
  state: 'pending' | 'data' | 'confirmed-missing'
  className: string
  tooltip: string
}

interface UseNodePingDisplayOptions {
  enabled?: MaybeRefOrGetter<boolean>
  retainSnapshotWhenDisabled?: MaybeRefOrGetter<boolean>
  selectedTaskId?: MaybeRefOrGetter<string | number | undefined>
  loadingDisplayText?: string
  emptyDisplayText?: string
  loadingPanelTooltipText?: Partial<Record<NodePingMetric, string>>
  emptyPanelTooltipText?: Partial<Record<NodePingMetric, string>>
}

const EMPTY_PING_BAR_COUNT = 20

function getLatencyToneClass(latency: number): string {
  if (latency <= 60)
    return 'bg-signal-1'
  if (latency <= 100)
    return 'bg-signal-2'
  if (latency <= 160)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (latency <= 200)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}

function getLossToneClass(loss: number): string {
  if (loss <= 1)
    return 'bg-signal-1'
  if (loss <= 3)
    return 'bg-signal-2'
  if (loss <= 6)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (loss <= 9)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  options: UseNodePingDisplayOptions = {},
) {
  const appStore = useAppStore()

  const pingRecordAvailable = computed(() => {
    if (appStore.publicSettings?.record_enabled === false)
      return false
    return appStore.publicSettings?.ping_record_preserve_time !== 0
  })

  const pingStatsEnabled = computed(() => toValue(options.enabled) !== false && pingRecordAvailable.value)

  const retainSnapshotWhenDisabled = computed(() => {
    return toValue(options.retainSnapshotWhenDisabled) === true
      && toValue(options.enabled) === false
      && pingRecordAvailable.value
  })

  const pingStatsHours = computed(() => {
    const preserveTime = appStore.publicSettings?.ping_record_preserve_time
    if (typeof preserveTime === 'number' && preserveTime > 0)
      return Math.min(preserveTime, 1)
    return 1
  })

  const pingStats = useNodePingStats(uuid, {
    hours: pingStatsHours,
    enabled: pingStatsEnabled,
    retainSnapshotWhenDisabled,
    maxCount: PING_SUMMARY_MAX_COUNT,
    selectedTaskId: options.selectedTaskId,
  })

  function buildPingBars(metric: NodePingMetric): NodePingBar[] {
    const points = pingStats.history.value
    if (!points.length)
      return []

    return points.map((point, index) => {
      const value = point[metric]
      const state = metric === 'latency' ? point.latencyState : point.lossState
      const sampleTime = metric === 'latency' ? point.latencySampleTime : point.lossSampleTime
      const timestamp = formatDateTime(sampleTime ?? point.time, 'HH:mm:ss')

      return {
        key: `${point.time}-${index}`,
        time: point.time,
        state,
        // Reserve the fixed twenty-bar geometry but leave an open bucket
        // visually unfinished. It must not masquerade as a confirmed gap.
        className: state === 'pending'
          ? 'bg-transparent'
          : value === null
            ? 'bg-muted-foreground/15'
            : metric === 'latency'
              ? getLatencyToneClass(value)
              : getLossToneClass(value),
        tooltip: state === 'pending'
          // Keep a failed transport visibly diagnosable without turning it
          // into a false \"no sample\" claim. Normal pending buckets remain
          // quiet so their unfinished state does not look like telemetry.
          ? pingStats.error.value ? `${timestamp}\n加载失败，等待重试` : ''
          : value === null
            ? state === 'data' && metric === 'latency'
              ? `${timestamp}\n延迟不可用（100% 丢包）`
              : state === 'confirmed-missing'
                ? `${timestamp}\n无采样数据`
                : `${timestamp}\n暂无有效数据`
            : metric === 'latency'
              ? `${timestamp}\n${Math.round(value)} ms`
              : `${timestamp}\n${value.toFixed(1)}%`,
      }
    })
  }

  function buildEmptyPingBars(metric: NodePingMetric): NodePingBar[] {
    const tooltip = pingStats.loading.value
      ? '加载中'
      : pingStats.error.value
        ? '加载失败'
        : !pingStatsEnabled.value
            ? '未启用记录'
            : metric === 'latency'
              ? '无采样数据'
              : '无采样数据'

    // A failed transport is not evidence that a probe was missing. Keep the
    // empty strip in its pending state until a successful response can make a
    // real missing-data decision.
    const pending = pingStats.loading.value || !!pingStats.error.value
    return Array.from({ length: EMPTY_PING_BAR_COUNT }, (_, index) => ({
      key: `${metric}-empty-${index}`,
      time: '',
      state: pending ? 'pending' : 'confirmed-missing',
      className: pending ? 'bg-transparent' : 'bg-muted-foreground/10',
      tooltip: pending && !pingStats.error.value ? '' : tooltip,
    }))
  }

  const latencyBars = computed(() => buildPingBars('latency'))
  const lossBars = computed(() => buildPingBars('loss'))
  const latencyRenderBars = computed(() => latencyBars.value.length ? latencyBars.value : buildEmptyPingBars('latency'))
  const lossRenderBars = computed(() => lossBars.value.length ? lossBars.value : buildEmptyPingBars('loss'))

  const latencyDisplay = computed(() => {
    const avgLatency = pingStats.avgLatency.value
    if (typeof avgLatency === 'number' && Number.isFinite(avgLatency))
      return `${Math.round(avgLatency)} ms`
    if (pingStats.loading.value && !pingStats.hasData.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const lossDisplay = computed(() => {
    const avgLoss = pingStats.avgLoss.value
    if (typeof avgLoss === 'number' && Number.isFinite(avgLoss))
      return `${avgLoss.toFixed(1)}%`
    if (pingStats.loading.value && !pingStats.hasData.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const latencyPanelTooltip = computed(() => {
    const avgLatency = pingStats.avgLatency.value
    if (typeof avgLatency !== 'number' || !Number.isFinite(avgLatency)) {
      if (pingStats.loading.value && !pingStats.hasData.value)
        return options.loadingPanelTooltipText?.latency ?? ''
      return options.emptyPanelTooltipText?.latency ?? ''
    }
    return `平均延迟 ${Math.round(avgLatency)} ms`
  })

  const lossPanelTooltip = computed(() => {
    const avgLoss = pingStats.avgLoss.value
    if (typeof avgLoss !== 'number' || !Number.isFinite(avgLoss)) {
      if (pingStats.loading.value && !pingStats.hasData.value)
        return options.loadingPanelTooltipText?.loss ?? ''
      return options.emptyPanelTooltipText?.loss ?? ''
    }

    const volatility = pingStats.avgVolatility.value > 0
      ? `，平均波动 ${pingStats.avgVolatility.value.toFixed(2)}`
      : ''
    return `平均丢包 ${avgLoss.toFixed(1)}%${volatility}`
  })

  return {
    pingStats,
    pingStatsEnabled,
    pingStatsHours,
    latencyRenderBars,
    lossRenderBars,
    latencyDisplay,
    lossDisplay,
    latencyPanelTooltip,
    lossPanelTooltip,
  }
}
