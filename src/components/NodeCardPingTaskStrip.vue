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
const currentUnreachable = computed(() => Boolean(latestSample.value?.observed
  && latestSample.value.latency === null
  && latestSample.value.loss === 1))
const latencyText = computed(() => latestSample.value?.latency === null
  || latestSample.value?.latency === undefined
  ? '-'
  : `${Math.round(latestSample.value.latency)}ms`)
const tooltipLatencyText = computed(() => currentUnreachable.value
  ? '不可达'
  : latestSample.value?.latency === null || latestSample.value?.latency === undefined
    ? '-'
    : `${Math.round(latestSample.value.latency)} ms`)
const lossText = computed(() => latestLossPercent.value === null
  ? '-'
  : `${latestLossPercent.value >= 100 ? '100' : latestLossPercent.value.toFixed(1)}%`)
const statusText = computed(() => {
  if (props.snapshot?.error)
    return '更新失败'
  return ({
    pending: '等待采样',
    data: '',
    confirmed_missing: '无采样',
    error: '更新失败',
    stale: '数据稍旧',
  } as const)[status.value]
})
const accessibleStatusText = computed(() => currentUnreachable.value ? '探测不可达' : statusText.value || '数据正常')
const statusClass = computed(() => {
  if (currentUnreachable.value)
    return 'node-card-ping-status-dot-outage'
  if (props.snapshot?.error)
    return 'bg-destructive'
  return ({
    pending: 'bg-muted-foreground/45',
    data: 'bg-emerald-500',
    confirmed_missing: 'bg-amber-500',
    error: 'bg-destructive',
    stale: 'bg-sky-500',
  } as const)[status.value]
})
const tooltipLossText = computed(() => latestLossPercent.value === null ? '-' : lossText.value)
const averageLatencyText = computed(() => props.snapshot?.avgLatency === null || props.snapshot?.avgLatency === undefined
  ? '-'
  : `${Math.round(props.snapshot.avgLatency)} ms`)
const averageLossText = computed(() => props.snapshot?.avgLoss === null || props.snapshot?.avgLoss === undefined
  ? '-'
  : `${props.snapshot.avgLoss.toFixed(1)}%`)
const latestSampleText = computed(() => props.snapshot?.latestSampleAt
  ? new Date(props.snapshot.latestSampleAt).toLocaleString()
  : '-')
const sourceText = computed(() => props.snapshot?.source
  ? props.snapshot.source === 'metric' ? '指标存储' : '同任务兼容接口'
  : '-')
function bucketTooltipDetails(point: NodeCardPingHistoryPoint): {
  interval: string
  sampleTimestamp: string
  status: string
  latency: string
  loss: string
  stale: boolean
} {
  const index = history.value.indexOf(point)
  const bucketEnd = bucketEndTime(index)
  const interval = point.time && bucketEnd
    ? `${formatDateTime(point.time, 'HH:mm')}–${formatDateTime(bucketEnd, 'HH:mm')}`
    : ''
  const sampleTime = [point.latencySampleTime, point.lossSampleTime]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
  const sampleTimestamp = sampleTime ? formatDateTime(sampleTime, 'HH:mm:ss') : ''
  if (isConfirmedNodeCardPingUnreachable(point))
    return { interval, sampleTimestamp, status: '', latency: '不可达', loss: '100%', stale: false }
  if (props.snapshot?.error) {
    if (point.latency !== null || point.loss !== null) {
      return {
        interval,
        sampleTimestamp,
        status: '',
        latency: point.latency === null ? '-' : `${Math.round(point.latency)} ms`,
        loss: point.loss === null ? '-' : `${point.loss.toFixed(1)}%`,
        stale: true,
      }
    }
    return { interval, sampleTimestamp, status: '更新失败', latency: '', loss: '', stale: false }
  }
  if (point.latency === null && point.loss === null) {
    const missing = point.latencyState === 'confirmed-missing' || point.lossState === 'confirmed-missing'
    return { interval, sampleTimestamp, status: missing ? '无采样' : '等待采样', latency: '', loss: '', stale: false }
  }
  return {
    interval,
    sampleTimestamp,
    status: '',
    latency: point.latency === null ? '-' : `${Math.round(point.latency)} ms`,
    loss: point.loss === null ? '-' : `${point.loss.toFixed(1)}%`,
    stale: false,
  }
}

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
  if (isConfirmedNodeCardPingUnreachable(point))
    return 'unreachable'
  if (point.loss !== null)
    return 'data'
  return props.snapshot?.error && point.lossState === 'pending' ? 'error' : point.lossState
}

function bucketEndTime(index: number): string {
  return history.value[index + 1]?.time
    || (props.snapshot?.windowEnd ? new Date(props.snapshot.windowEnd).toISOString() : '')
}

function bucketSampleTime(point: NodeCardPingHistoryPoint): string {
  return [point.latencySampleTime, point.lossSampleTime]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? ''
}

function barTooltip(point: NodeCardPingHistoryPoint): string {
  const details = bucketTooltipDetails(point)
  const lines = details.interval ? [details.interval] : []
  if (details.status)
    lines.push(details.status)
  else
    lines.push(`延迟：${details.latency}`, `丢包：${details.loss}`)
  if (details.sampleTimestamp)
    lines.push(`最新样本：${details.sampleTimestamp}`)
  if (details.stale)
    lines.push('状态：更新失败（显示上次数据）')
  return lines.join('\n')
}
</script>

<template>
  <div
    class="node-card-ping-task-strip min-w-0 rounded-lg bg-slate-500/5 text-left"
    :class="!online && 'opacity-50'"
    :data-node-ping-fetched-at="snapshot?.fetchedAt ? new Date(snapshot.fetchedAt).toISOString() : undefined"
    :data-node-ping-node-uuid="snapshot?.nodeUuid || undefined"
    :data-node-ping-outage="currentUnreachable || undefined"
    :data-node-ping-size="size"
    :data-node-ping-task-id="taskId"
    :data-node-ping-status="status"
    :data-node-ping-window-end="snapshot?.windowEnd ? new Date(snapshot.windowEnd).toISOString() : undefined"
    :data-node-ping-window-start="snapshot?.windowStart ? new Date(snapshot.windowStart).toISOString() : undefined"
    @click.stop="emit('click')"
  >
    <div class="node-card-ping-task-header min-w-0 text-[10px] leading-none sm:text-[11px]">
      <span class="node-card-ping-status-dot size-1.5 rounded-full" :class="statusClass" />
      <span class="node-card-ping-task-identity min-w-0">
        <button
          type="button"
          class="node-card-ping-task-name min-w-0 truncate rounded-sm text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          :aria-label="`${taskName} 当前延迟 ${latencyText} 当前丢包 ${lossText} 状态 ${accessibleStatusText}`"
          @click.stop="emit('click')"
          @keydown.stop
        >
          {{ taskName }}
        </button>
        <span v-if="statusText" class="node-card-ping-status-text text-[9px]" :class="status === 'error' ? 'text-destructive' : 'text-muted-foreground'">{{ statusText }}</span>
      </span>
      <span class="node-card-ping-summary tabular-nums text-muted-foreground" :class="currentUnreachable && 'node-card-ping-summary-outage'" data-node-ping-summary="latency"><span>延迟</span><strong>{{ latencyText }}</strong></span>
      <span class="node-card-ping-summary tabular-nums text-muted-foreground" :class="currentUnreachable && 'node-card-ping-summary-outage'" data-node-ping-summary="loss"><span>丢包</span><strong>{{ lossText }}</strong></span>
      <DataTooltip as="span" placement="top" open-on-click content-class="node-card-ping-task-tooltip" class="node-card-ping-info-tooltip">
        <button
          type="button"
          class="node-card-ping-info-trigger inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          aria-label="查看该 Ping 任务详情"
          @click.stop
        >
          <Icon icon="tabler:info-circle" width="12" height="12" />
        </button>
        <template #content>
          <div class="node-card-ping-task-tooltip-name">
            {{ taskName }}
          </div>
          <dl class="node-card-ping-task-tooltip-grid">
            <dt>任务 ID</dt><dd>{{ taskId }}</dd>
            <dt>当前延迟</dt><dd>{{ tooltipLatencyText }}</dd>
            <dt>当前丢包</dt><dd>{{ tooltipLossText }}</dd>
            <dt>当前状态</dt><dd>{{ accessibleStatusText }}</dd>
            <dt>窗口平均延迟</dt><dd>{{ averageLatencyText }}</dd>
            <dt>窗口平均丢包</dt><dd>{{ averageLossText }}</dd>
            <dt>最新真实样本</dt><dd>{{ latestSampleText }}</dd>
            <dt>数据来源</dt><dd>{{ sourceText }}</dd>
            <template v-if="snapshot?.error">
              <dt>刷新信息</dt><dd class="node-card-ping-tooltip-wrap">
                {{ snapshot.error }}
              </dd>
            </template>
          </dl>
        </template>
      </DataTooltip>
    </div>
    <div class="node-card-ping-trend-row" data-node-ping-panel="latency" data-node-ping-trend="latency">
      <span class="node-card-ping-trend-label" data-node-ping-header="latency">延迟</span>
      <span class="node-card-ping-bucket-grid" data-node-ping-bars="latency">
        <template v-for="(point, index) in history" :key="`latency-${index}`">
          <DataTooltip
            as="span"
            data-node-ping-bar
            :data-node-ping-bucket-time="point.time || undefined"
            :data-node-ping-bucket-start="point.time || undefined"
            :data-node-ping-bucket-end="bucketEndTime(index) || undefined"
            :data-node-ping-sample-time="bucketSampleTime(point) || undefined"
            :data-node-ping-state="latencyBucketState(point)"
            :data-node-ping-severity="latencyBucketSeverity(point, Boolean(snapshot?.error))"
            placement="top"
            :content="barTooltip(point)"
            open-on-click
            content-class="node-card-ping-bucket-tooltip"
            class="node-card-ping-bucket-hitbox"
            tabindex="-1"
            :aria-label="barTooltip(point)"
            @click.stop
          >
            <span class="node-card-ping-bucket-fill" data-node-ping-bucket-fill />
            <template #content>
              <div v-if="bucketTooltipDetails(point).interval" class="node-card-ping-tooltip-time">{{ bucketTooltipDetails(point).interval }}</div>
              <div v-if="bucketTooltipDetails(point).status" class="node-card-ping-tooltip-status">{{ bucketTooltipDetails(point).status }}</div>
              <dl v-else class="node-card-ping-bucket-tooltip-grid">
                <dt>延迟</dt><dd>{{ bucketTooltipDetails(point).latency }}</dd>
                <dt>丢包</dt><dd>{{ bucketTooltipDetails(point).loss }}</dd>
                <dt v-if="bucketTooltipDetails(point).sampleTimestamp">最新样本</dt><dd v-if="bucketTooltipDetails(point).sampleTimestamp">{{ bucketTooltipDetails(point).sampleTimestamp }}</dd>
                <template v-if="bucketTooltipDetails(point).stale">
                  <dt>状态</dt><dd class="node-card-ping-tooltip-wrap">更新失败（显示上次数据）</dd>
                </template>
              </dl>
            </template>
          </DataTooltip>
        </template>
      </span>
    </div>
    <div class="node-card-ping-trend-row" data-node-ping-panel="loss" data-node-ping-trend="loss">
      <span class="node-card-ping-trend-label" data-node-ping-header="loss">丢包</span>
      <span class="node-card-ping-bucket-grid" data-node-ping-bars="loss">
        <template v-for="(point, index) in history" :key="`loss-${index}`">
          <DataTooltip
            as="span"
            data-node-ping-bar
            :data-node-ping-bucket-time="point.time || undefined"
            :data-node-ping-bucket-start="point.time || undefined"
            :data-node-ping-bucket-end="bucketEndTime(index) || undefined"
            :data-node-ping-sample-time="bucketSampleTime(point) || undefined"
            :data-node-ping-state="lossBucketState(point)"
            :data-node-ping-severity="lossBucketSeverity(point, Boolean(snapshot?.error))"
            placement="top"
            :content="barTooltip(point)"
            open-on-click
            content-class="node-card-ping-bucket-tooltip"
            class="node-card-ping-bucket-hitbox"
            tabindex="-1"
            :aria-label="barTooltip(point)"
            @click.stop
          >
            <span class="node-card-ping-bucket-fill" data-node-ping-bucket-fill />
            <template #content>
              <div v-if="bucketTooltipDetails(point).interval" class="node-card-ping-tooltip-time">{{ bucketTooltipDetails(point).interval }}</div>
              <div v-if="bucketTooltipDetails(point).status" class="node-card-ping-tooltip-status">{{ bucketTooltipDetails(point).status }}</div>
              <dl v-else class="node-card-ping-bucket-tooltip-grid">
                <dt>延迟</dt><dd>{{ bucketTooltipDetails(point).latency }}</dd>
                <dt>丢包</dt><dd>{{ bucketTooltipDetails(point).loss }}</dd>
                <dt v-if="bucketTooltipDetails(point).sampleTimestamp">最新样本</dt><dd v-if="bucketTooltipDetails(point).sampleTimestamp">{{ bucketTooltipDetails(point).sampleTimestamp }}</dd>
                <template v-if="bucketTooltipDetails(point).stale">
                  <dt>状态</dt><dd class="node-card-ping-tooltip-wrap">更新失败（显示上次数据）</dd>
                </template>
              </dl>
            </template>
          </DataTooltip>
        </template>
      </span>
    </div>
  </div>
</template>
