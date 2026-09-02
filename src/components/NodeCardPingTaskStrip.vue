<script setup lang="ts">
import type { NodeCardPingHistoryPoint, NodeCardPingPairSnapshot, NodeCardPingSample } from '@/types/node-card-ping'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { formatDateTime } from '@/utils/helper'
import {
  isConfirmedNodeCardPingUnreachable,
  latencyBucketSeverity,
  lossBucketSeverity,
} from '@/utils/nodeCardPingPresentation'

const props = defineProps<{
  taskId: number
  taskName: string
  snapshot?: NodeCardPingPairSnapshot
  size: 'mini' | 'compact' | 'comfortable' | 'large'
  online: boolean
}>()

const emit = defineEmits<{
  click: []
}>()

const placeholderPoint = {
  time: '',
  latency: null,
  loss: null,
  latencySampleTime: null,
  lossSampleTime: null,
  latencyState: 'pending',
  lossState: 'pending',
} satisfies NodeCardPingHistoryPoint
const placeholderHistory = Array.from({ length: 20 }).fill(placeholderPoint) as NodeCardPingHistoryPoint[]

const status = computed(() => props.snapshot?.status ?? 'pending')
const history = computed(() => props.snapshot?.history.length === 20
  ? props.snapshot.history
  : placeholderHistory)
const latestSample = computed(() => props.snapshot?.samples.reduce<NodeCardPingSample | undefined>((latest, sample) => (
  sample.observed && (!latest || sample.timestamp > latest.timestamp) ? sample : latest
), undefined))
const latestLossPercent = computed(() => latestSample.value?.loss === null || latestSample.value?.loss === undefined
  ? null
  : latestSample.value.loss * 100)
const latencyText = computed(() => latestLossPercent.value === 100
  || latestSample.value?.latency === null
  || latestSample.value?.latency === undefined
  ? '-'
  : `${Math.round(latestSample.value.latency)}ms`)
const lossText = computed(() => latestLossPercent.value === null
  ? '-'
  : `${latestLossPercent.value >= 10 ? latestLossPercent.value.toFixed(0) : latestLossPercent.value.toFixed(1)}%`)
const statusText = computed(() => {
  if (props.snapshot?.error)
    return '更新失败'
  return ({
    pending: '等待采样',
    data: '',
    confirmed_missing: '暂无采样',
    error: '更新失败',
    stale: '数据稍旧',
  } as const)[status.value]
})
const accessibleStatusText = computed(() => latestLossPercent.value === 100 ? '延迟不可达' : statusText.value || '数据正常')
const statusClass = computed(() => {
  if (props.snapshot?.error || latestLossPercent.value === 100)
    return 'bg-destructive'
  return ({
    pending: 'bg-muted-foreground/45',
    data: 'bg-emerald-500',
    confirmed_missing: 'bg-amber-500',
    error: 'bg-destructive',
    stale: 'bg-sky-500',
  } as const)[status.value]
})
const tooltip = computed(() => {
  const lines = [
    `${props.taskName}（ID ${props.taskId}）`,
    `当前延迟：${latencyText.value} · 当前丢包：${lossText.value} · 状态：${accessibleStatusText.value}`,
  ]
  if (props.snapshot?.avgLatency !== null && props.snapshot?.avgLatency !== undefined)
    lines.push(`窗口平均延迟：${Math.round(props.snapshot.avgLatency)}ms`)
  if (props.snapshot?.avgLoss !== null && props.snapshot?.avgLoss !== undefined)
    lines.push(`窗口平均丢包：${props.snapshot.avgLoss.toFixed(1)}%`)
  if (props.snapshot?.latestSampleAt)
    lines.push(`最新真实样本：${new Date(props.snapshot.latestSampleAt).toLocaleString()}`)
  if (props.snapshot?.source)
    lines.push(`数据来源：${props.snapshot.source === 'metric' ? '指标存储' : '同任务兼容接口'}`)
  if (props.snapshot?.error)
    lines.push(`刷新信息：${props.snapshot.error}`)
  return lines.join('\n')
})

function latencyBucketState(point: NodeCardPingHistoryPoint): string {
  if (isConfirmedNodeCardPingUnreachable(point))
    return 'unreachable'
  if (point.latency !== null)
    return 'data'
  if (props.snapshot?.error && point.latencyState === 'pending')
    return 'error'
  return point.latencyState
}

function lossBucketState(point: NodeCardPingHistoryPoint): string {
  if (point.loss !== null)
    return 'data'
  return props.snapshot?.error && point.lossState === 'pending' ? 'error' : point.lossState
}

function barTooltip(point: NodeCardPingHistoryPoint): string {
  const sampleTime = point.latencySampleTime ?? point.lossSampleTime ?? point.time
  const timestamp = sampleTime ? formatDateTime(sampleTime, 'HH:mm:ss') : ''
  const prefix = timestamp ? `${timestamp}\n` : ''

  if (isConfirmedNodeCardPingUnreachable(point))
    return `${prefix}延迟：不可达\n丢包：100%`
  if (props.snapshot?.error) {
    if (point.latency !== null || point.loss !== null)
      return `${prefix}延迟：${point.latency === null ? '-' : `${Math.round(point.latency)} ms`}\n丢包：${point.loss === null ? '-' : `${point.loss.toFixed(1)}%`}\n状态：更新失败（显示上次数据）`
    return `${prefix}更新失败`
  }
  if (point.latency === null && point.loss === null) {
    if (point.latencyState === 'confirmed-missing' || point.lossState === 'confirmed-missing')
      return `${prefix}暂无采样`
    return `${prefix}等待采样`
  }
  return `${prefix}延迟：${point.latency === null ? '-' : `${Math.round(point.latency)} ms`}\n丢包：${point.loss === null ? '-' : `${point.loss.toFixed(1)}%`}`
}
</script>

<template>
  <div
    class="node-card-ping-task-strip min-w-0 rounded-lg bg-slate-500/5 text-left"
    :class="!online && 'opacity-50'"
    :title="tooltip"
    :data-node-ping-size="size"
    :data-node-ping-task-id="taskId"
    :data-node-ping-status="status"
    @click.stop="emit('click')"
  >
    <div class="node-card-ping-task-header flex min-w-0 items-center gap-1 text-[10px] leading-none sm:text-[11px]">
      <span class="size-1.5 shrink-0 rounded-full" :class="statusClass" />
      <button
        type="button"
        class="min-w-0 flex-1 truncate rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
        :aria-label="`${taskName} 当前延迟 ${latencyText} 当前丢包 ${lossText} 状态 ${accessibleStatusText}`"
        @click.stop="emit('click')"
        @keydown.stop
      >
        {{ taskName }}
      </button>
      <span v-if="statusText" class="shrink-0 text-[9px]" :class="latestLossPercent === 100 || status === 'error' ? 'text-destructive' : 'text-muted-foreground'">{{ statusText }}</span>
      <span class="node-card-ping-summary shrink-0 tabular-nums text-muted-foreground" data-node-ping-summary="latency"><span>延迟</span> {{ latencyText }}</span>
      <span class="node-card-ping-summary shrink-0 tabular-nums" :class="latestLossPercent === 100 ? 'text-destructive' : 'text-muted-foreground'" data-node-ping-summary="loss"><span>丢包</span> {{ lossText }}</span>
      <DataTooltip :content="tooltip" as="span" placement="top" width="220" content-class="whitespace-pre-line leading-4" class="shrink-0">
        <button
          type="button"
          class="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          :aria-label="`${taskName} 详细状态`"
          @click.stop
          @keydown.stop
        >
          <Icon icon="tabler:info-circle" width="12" height="12" />
        </button>
      </DataTooltip>
    </div>
    <div class="node-card-ping-trend-row" data-node-ping-panel="latency" data-node-ping-trend="latency">
      <span class="node-card-ping-trend-label" data-node-ping-header="latency">延迟</span>
      <span class="node-card-ping-bucket-grid" data-node-ping-bars="latency">
        <DataTooltip
          v-for="(point, index) in history"
          :key="`latency-${index}`"
          as="span"
          data-node-ping-bar
          :data-node-ping-bucket-time="point.time || undefined"
          :data-node-ping-state="latencyBucketState(point)"
          :data-node-ping-severity="latencyBucketSeverity(point, Boolean(snapshot?.error))"
          placement="top"
          :content="barTooltip(point)"
          content-class="whitespace-pre-line"
          class="node-card-ping-bucket-hitbox"
          tabindex="-1"
          :aria-label="barTooltip(point)"
        >
          <span class="node-card-ping-bucket-fill" data-node-ping-bucket-fill />
        </DataTooltip>
      </span>
    </div>
    <div class="node-card-ping-trend-row" data-node-ping-panel="loss" data-node-ping-trend="loss">
      <span class="node-card-ping-trend-label" data-node-ping-header="loss">丢包</span>
      <span class="node-card-ping-bucket-grid" data-node-ping-bars="loss">
        <DataTooltip
          v-for="(point, index) in history"
          :key="`loss-${index}`"
          as="span"
          data-node-ping-bar
          :data-node-ping-bucket-time="point.time || undefined"
          :data-node-ping-state="lossBucketState(point)"
          :data-node-ping-severity="lossBucketSeverity(point, Boolean(snapshot?.error))"
          placement="top"
          :content="barTooltip(point)"
          content-class="whitespace-pre-line"
          class="node-card-ping-bucket-hitbox"
          tabindex="-1"
          :aria-label="barTooltip(point)"
        >
          <span class="node-card-ping-bucket-fill" data-node-ping-bucket-fill />
        </DataTooltip>
      </span>
    </div>
  </div>
</template>
