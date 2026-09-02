<script setup lang="ts">
import type { NodeCardPingHistoryPoint, NodeCardPingPairSnapshot, NodeCardPingSample } from '@/types/node-card-ping'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'

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
const latencyText = computed(() => latestSample.value?.latency === null || latestSample.value?.latency === undefined
  ? '-'
  : `${Math.round(latestSample.value.latency)}ms`)
const latestLossPercent = computed(() => latestSample.value?.loss === null || latestSample.value?.loss === undefined
  ? null
  : latestSample.value.loss * 100)
const lossText = computed(() => latestLossPercent.value === null
  ? '-'
  : `${latestLossPercent.value >= 10 ? latestLossPercent.value.toFixed(0) : latestLossPercent.value.toFixed(1)}%`)
const statusText = computed(() => ({
  pending: '等待',
  data: '有数据',
  confirmed_missing: '无数据',
  error: '错误',
  stale: '缓存',
}[status.value]))
const statusClass = computed(() => ({
  pending: 'bg-muted-foreground/45',
  data: 'bg-emerald-500',
  confirmed_missing: 'bg-amber-500',
  error: 'bg-destructive',
  stale: 'bg-sky-500',
}[status.value]))
const stripClass = computed(() => ({
  mini: 'min-h-9 gap-1 px-1.5 py-1',
  compact: 'min-h-12 gap-1.5 px-2 py-1.5',
  comfortable: 'min-h-14 gap-2 px-2.5 py-2',
  large: 'min-h-14 gap-2 px-2.5 py-2',
}[props.size]))
const tooltip = computed(() => {
  const lines = [
    `${props.taskName}（ID ${props.taskId}）`,
    `当前延迟：${latencyText.value} · 当前丢包：${lossText.value} · 状态：${statusText.value}`,
  ]
  if (props.snapshot?.avgLatency !== null && props.snapshot?.avgLatency !== undefined)
    lines.push(`窗口平均延迟：${Math.round(props.snapshot.avgLatency)}ms`)
  if (props.snapshot?.avgLoss !== null && props.snapshot?.avgLoss !== undefined)
    lines.push(`窗口平均丢包：${props.snapshot.avgLoss.toFixed(1)}%`)
  if (props.snapshot?.latestSampleAt)
    lines.push(`最新真实样本：${new Date(props.snapshot.latestSampleAt).toLocaleString()}`)
  if (props.snapshot?.source)
    lines.push(`数据源：${props.snapshot.source === 'metric' ? 'Metric' : '同任务 Legacy'}`)
  if (props.snapshot?.error)
    lines.push(`刷新信息：${props.snapshot.error}`)
  return lines.join('\n')
})

function latencyBarStyle(point: NodeCardPingHistoryPoint): Record<string, string> {
  if (point.latencyState !== 'data' || point.latency === null)
    return { height: '22%' }
  return { height: `${Math.max(18, Math.min(100, point.latency / latencyCeiling.value * 100))}%` }
}

function lossBarStyle(point: NodeCardPingHistoryPoint): Record<string, string> {
  if (point.lossState !== 'data' || point.loss === null)
    return { height: '22%' }
  return { height: `${Math.max(18, Math.min(100, point.loss))}%` }
}

function barClass(state: NodeCardPingHistoryPoint['latencyState'], danger: boolean): string {
  if (state === 'pending')
    return 'bg-muted-foreground/20'
  if (state === 'confirmed-missing')
    return 'bg-amber-500/70'
  return danger ? 'bg-rose-500/80' : 'bg-emerald-500/75'
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
        :aria-label="`${taskName} 当前延迟 ${latencyText} 当前丢包 ${lossText} 状态 ${statusText}`"
        @click.stop="emit('click')"
        @keydown.stop
      >
        {{ taskName }}
      </button>
      <span class="shrink-0 text-[9px] text-muted-foreground">{{ statusText }}</span>
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
    <div class="grid h-2 min-w-0 grid-cols-20 items-end gap-px" data-node-ping-trend="latency">
      <span
        v-for="(point, index) in history"
        :key="`latency-${index}`"
        class="block min-w-0 rounded-[1px]"
        :class="barClass(point.latencyState, false)"
        :style="latencyBarStyle(point)"
      />
    </div>
    <div v-if="size !== 'mini'" class="grid h-1.5 min-w-0 grid-cols-20 items-end gap-px" data-node-ping-trend="loss">
      <span
        v-for="(point, index) in history"
        :key="`loss-${index}`"
        class="block min-w-0 rounded-[1px]"
        :class="barClass(point.lossState, (point.loss ?? 0) > 0)"
        :style="lossBarStyle(point)"
      />
    </div>
  </div>
</template>

<style scoped>
.grid-cols-20 {
  grid-template-columns: repeat(20, minmax(0, 1fr));
}
</style>
