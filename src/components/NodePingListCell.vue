<script setup lang="ts">
import { computed } from 'vue'
import { useNodeCardPingTaskCatalog } from '@/composables/useNodeCardPingTaskCatalog'
import { useNodeMultiPingStats } from '@/composables/useNodeMultiPingStats'
import { useNodePingDisplay } from '@/composables/useNodePingDisplay'
import { useAppStore } from '@/stores/app'
import { getNodeCardPingTaskId } from '@/utils/nodeCardPingBindings'
import { resolveNodeCardPingDisplay } from '@/utils/nodeCardPingConfig'

const props = defineProps<{
  uuid: string
  online: boolean
  enabled: boolean
}>()

const emit = defineEmits<{
  click: []
}>()

const appStore = useAppStore()
const catalog = useNodeCardPingTaskCatalog()
const resolution = computed(() => resolveNodeCardPingDisplay(
  appStore.nodeCardMultiPingRuntimeConfig,
  props.uuid,
  catalog.tasks.value,
))
const usesLegacy = computed(() => {
  const runtime = appStore.nodeCardMultiPingRuntimeConfig
  const nodeConfig = runtime.config.nodes[props.uuid.trim().toLowerCase()]
  return nodeConfig?.mode !== 'custom'
    && !runtime.config.global.threeNetworkEnabled
    && runtime.config.global.taskIds[0] === null
})
const firstTask = computed(() => resolution.value.tasks.slice(0, 1).map(task => ({
  taskId: task.id,
  taskName: task.name,
  intervalSeconds: task.interval,
})))
const { snapshots } = useNodeMultiPingStats(
  () => props.uuid,
  firstTask,
  { enabled: () => props.enabled && !usesLegacy.value && catalog.loaded.value },
)

const legacySelectedTaskId = computed(() => getNodeCardPingTaskId(appStore.nodeCardPingTaskBindings, props.uuid))
const legacyDisplay = useNodePingDisplay(() => props.uuid, {
  enabled: () => props.enabled && usesLegacy.value,
  selectedTaskId: legacySelectedTaskId,
})

const emptyBars = Array.from({ length: 20 }, (_, index) => ({
  key: `empty-${index}`,
  className: 'bg-muted-foreground/15',
  tooltip: '等待 Ping 数据',
}))
const multiLatencyBars = computed(() => {
  const history = snapshots.value[0]?.history
  if (!history?.length)
    return emptyBars
  return history.map((point, index) => ({
    key: `${point.time}-${index}`,
    tooltip: point.time || '等待 Ping 数据',
    className: point.latencyState === 'pending'
      ? 'bg-transparent'
      : point.latencyState === 'confirmed-missing' || point.latency === null
        ? 'bg-muted-foreground/15'
        : 'bg-emerald-500/80',
  }))
})
const multiLossBars = computed(() => {
  const history = snapshots.value[0]?.history
  if (!history?.length)
    return emptyBars
  return history.map((point, index) => ({
    key: `${point.time}-${index}`,
    tooltip: point.time || '等待 Ping 数据',
    className: point.lossState === 'pending'
      ? 'bg-transparent'
      : point.lossState === 'confirmed-missing'
        ? 'bg-muted-foreground/15'
        : (point.loss ?? 0) > 0 ? 'bg-rose-500/80' : 'bg-emerald-500/80',
  }))
})
const displayLatencyBars = computed(() => usesLegacy.value ? legacyDisplay.latencyRenderBars.value : multiLatencyBars.value)
const displayLossBars = computed(() => usesLegacy.value ? legacyDisplay.lossRenderBars.value : multiLossBars.value)
const firstSnapshot = computed(() => snapshots.value[0])
const latencyDisplay = computed(() => {
  if (usesLegacy.value)
    return legacyDisplay.latencyDisplay.value
  const snapshot = firstSnapshot.value
  if (snapshot?.avgLoss === 100 || snapshot?.avgLatency === null || snapshot?.avgLatency === undefined)
    return '-'
  return `${Math.round(snapshot.avgLatency)} ms`
})
const lossDisplay = computed(() => {
  if (usesLegacy.value)
    return legacyDisplay.lossDisplay.value
  const loss = firstSnapshot.value?.avgLoss
  return loss === null || loss === undefined ? '-' : `${loss.toFixed(1)}%`
})
</script>

<template>
  <button
    type="button"
    class="group flex w-full flex-col gap-[1px] pr-4 text-left"
    aria-label="打开延迟和丢包监测"
    @click.stop="emit('click')"
  >
    <span class="sr-only" :aria-label="`延迟 ${latencyDisplay}`">延迟 {{ latencyDisplay }}</span>
    <span class="sr-only" :aria-label="`丢包 ${lossDisplay}`">丢包 {{ lossDisplay }}</span>
    <div class="group/panel relative items-center gap-1 opacity-80 hover:opacity-100">
      <div
        class="grid h-1 cursor-auto items-end gap-[1px] transition-all hover:h-2.5"
        :style="{ gridTemplateColumns: `repeat(${displayLatencyBars.length}, minmax(0, 1fr))` }"
      >
        <span
          v-for="bar in displayLatencyBars"
          :key="bar.key"
          :title="bar.tooltip"
          :aria-label="bar.tooltip"
          class="h-full w-full"
        >
          <span class="block h-full w-full rounded-[1px] transition-all group-hover:opacity-50 hover:scale-y-160 hover:opacity-100" :class="bar.className" />
        </span>
      </div>
    </div>
    <div class="group/panel relative items-center gap-1 opacity-80 hover:opacity-100">
      <div
        class="grid h-1 cursor-auto items-end gap-[1px] transition-all hover:h-2.5"
        :style="{ gridTemplateColumns: `repeat(${displayLossBars.length}, minmax(0, 1fr))` }"
      >
        <span
          v-for="bar in displayLossBars"
          :key="bar.key"
          :title="bar.tooltip"
          :aria-label="bar.tooltip"
          class="h-full w-full"
        >
          <span class="block h-full w-full rounded-[1px] transition-all group-hover:opacity-50 hover:scale-y-160 hover:opacity-100" :class="bar.className" />
        </span>
      </div>
    </div>
  </button>
</template>
