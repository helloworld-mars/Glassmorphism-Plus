<script setup lang="ts">
import type { NodeCardPingHistoryPoint, NodeCardPingPairSnapshot, NodeCardPingSample } from '@/types/node-card-ping'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { formatDateTime } from '@/utils/helper'

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
const observedLatencies = computed(() => history.value.flatMap(point => point.latency === null ? [] : [point.latency]))
const latencyCeiling = computed(() => Math.max(1, ...observedLatencies.value))
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
  if (latestLossPercent.value === 100)
    return '100% 丢包'
  return ({
    pending: '等待采样',
    data: '',
    confirmed_missing: '暂无采样',
    error: '更新失败',
    stale: '数据稍旧',
  } as const)[status.value]
})
const accessibleStatusText = computed(() => statusText.value || '数据正常')
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
const stripClass = computed(() => ({
  mini: 'h-9 gap-1 px-1.5 py-1',
  compact: 'h-12 gap-1.5 px-2 py-1.5',
  comfortable: 'h-14 gap-2 px-2.5 py-2',
  large: 'h-14 gap-2 px-2.5 py-2',
}[props.size]))
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

function latencyBarStyle(point: NodeCardPingHistoryPoint): Record<string, string> {
  if (point.latencyState !== 'data' || point.latency === null || point.loss === 100)
    return { height: '22%' }
  return { height: `${Math.max(18, Math.min(100, point.latency / latencyCeiling.value * 100))}%` }
}

function lossBarStyle(point: NodeCardPingHistoryPoint): Record<string, string> {
  if (point.lossState !== 'data' || point.loss === null)
    return { height: '22%' }
  return { height: `${Math.max(18, Math.min(100, point.loss))}%` }
}

function latencyBarClass(point: NodeCardPingHistoryPoint): string {
  if (point.latencyState === 'pending')
    return 'bg-transparent'
  if (point.latencyState === 'confirmed-missing' || point.latency === null || point.loss === 100)
    return 'bg-muted-foreground/15'
  return 'bg-emerald-500/75'
}

function lossBarClass(point: NodeCardPingHistoryPoint): string {
  const state = point.lossState
  if (state === 'pending')
    return 'bg-transparent'
  if (state === 'confirmed-missing' || point.loss === null)
    return 'bg-muted-foreground/15'
  return point.loss > 0 ? 'bg-rose-500/80' : 'bg-emerald-500/75'
}

function barTooltip(point: NodeCardPingHistoryPoint, metric: 'latency' | 'loss'): string {
  const state = metric === 'latency' ? point.latencyState : point.lossState
  const sampleTime = metric === 'latency' ? point.latencySampleTime : point.lossSampleTime
  const value = metric === 'latency' ? point.latency : point.loss
  const timestamp = sampleTime || point.time ? formatDateTime(sampleTime ?? point.time, 'HH:mm:ss') : ''
  const prefix = timestamp ? `${timestamp}\n` : ''

  if (state === 'pending')
    return props.snapshot?.error ? `${prefix}加载失败，等待重试` : ''
  if (value === null) {
    if (state === 'data' && metric === 'latency' && point.loss === 100)
      return `${prefix}延迟不可用（100% 丢包）`
    return `${prefix}${state === 'confirmed-missing' ? '无采样数据' : '暂无有效数据'}`
  }
  return metric === 'latency'
    ? `${prefix}${Math.round(value)} ms`
    : `${prefix}${value.toFixed(1)}%`
}
</script>

<template>
  <div
    class="node-card-ping-task-strip min-w-0 rounded-lg bg-slate-500/5 text-left"
    :class="[stripClass, !online && 'opacity-50']"
    :title="tooltip"
    :data-node-ping-task-id="taskId"
    :data-node-ping-status="status"
    @click.stop="emit('click')"
  >
    <div class="flex min-w-0 items-center gap-1 text-[10px] leading-none sm:text-[11px]">
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
      <span class="shrink-0 tabular-nums text-muted-foreground">{{ latencyText }}</span>
      <span class="shrink-0 tabular-nums" :class="latestLossPercent === 100 ? 'text-destructive' : 'text-muted-foreground'">{{ lossText }}</span>
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
    <div class="grid min-w-0 grid-cols-[22px_1fr] items-end gap-1" data-node-ping-panel="latency" data-node-ping-trend="latency">
      <span class="text-[8px] leading-none text-muted-foreground" data-node-ping-header="latency">延迟</span>
      <span class="grid h-[4px] min-w-0 grid-cols-20 items-end gap-px" data-node-ping-bars="latency">
        <DataTooltip
          v-for="(point, index) in history"
          :key="`latency-${index}`"
          as="span"
          data-node-ping-bar
          :data-node-ping-bucket-time="point.time || undefined"
          :data-node-ping-state="point.latencyState"
          placement="top"
          :content="barTooltip(point, 'latency')"
          content-class="whitespace-pre-line"
          class="flex h-full min-w-0 w-full items-end"
        >
          <span class="block min-w-0 w-full rounded-[1px]" :class="latencyBarClass(point)" :style="latencyBarStyle(point)" />
        </DataTooltip>
      </span>
    </div>
    <div class="grid min-w-0 grid-cols-[22px_1fr] items-end gap-1" data-node-ping-panel="loss" data-node-ping-trend="loss">
      <span class="text-[8px] leading-none text-muted-foreground" data-node-ping-header="loss">丢包</span>
      <span class="grid h-[4px] min-w-0 grid-cols-20 items-end gap-px" data-node-ping-bars="loss">
        <DataTooltip
          v-for="(point, index) in history"
          :key="`loss-${index}`"
          as="span"
          data-node-ping-bar
          :data-node-ping-bucket-time="point.time || undefined"
          :data-node-ping-state="point.lossState"
          placement="top"
          :content="barTooltip(point, 'loss')"
          content-class="whitespace-pre-line"
          class="flex h-full min-w-0 w-full items-end"
        >
          <span class="block min-w-0 w-full rounded-[1px]" :class="lossBarClass(point)" :style="lossBarStyle(point)" />
        </DataTooltip>
      </span>
    </div>
  </div>
</template>

<style scoped>
.grid-cols-20 {
  grid-template-columns: repeat(20, minmax(0, 1fr));
}
</style>
