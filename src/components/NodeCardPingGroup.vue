<script setup lang="ts">
import { computed } from 'vue'
import NodeCardPingTaskStrip from '@/components/NodeCardPingTaskStrip.vue'
import { useNodeCardPingTaskCatalog } from '@/composables/useNodeCardPingTaskCatalog'
import { useNodeMultiPingStats } from '@/composables/useNodeMultiPingStats'
import { useAppStore } from '@/stores/app'
import { resolveNodeCardPingDisplay } from '@/utils/nodeCardPingConfig'

const props = defineProps<{
  nodeUuid: string
  nodeName: string
  size: 'mini' | 'compact' | 'comfortable' | 'large'
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
  props.nodeUuid,
  catalog.tasks.value,
))
const configuredCount = computed(() => resolution.value.displayCount)
const effectiveTasks = computed(() => resolution.value.tasks.map(task => ({
  taskId: task.id,
  taskName: task.name,
  intervalSeconds: task.interval,
})))
const { snapshotsByTaskId } = useNodeMultiPingStats(
  () => props.nodeUuid,
  effectiveTasks,
  {
    enabled: () => props.enabled && catalog.loaded.value,
    retainSnapshotWhenDisabled: true,
  },
)

const resolvedTaskById = computed(() => new Map(resolution.value.tasks.map(task => [task.id, task])))
const displaySlots = computed(() => Array.from({ length: configuredCount.value }, (_, slotIndex) => {
  const taskId = resolution.value.configuredTaskSlots[slotIndex] ?? null
  const task = taskId === null ? undefined : resolvedTaskById.value.get(taskId)
  const reason = catalog.error.value
    ? '更新失败'
    : (taskId === null
        ? '未配置'
        : resolution.value.deletedTaskIds.includes(taskId)
          ? '配置失效'
          : resolution.value.unassignedTaskIds.includes(taskId)
            ? '任务失效'
            : '暂无采样')
  return { slotIndex, taskId, task, reason }
}))
const placeholderCount = computed(() => catalog.loaded.value || catalog.error.value
  ? 0
  : Math.max(1, configuredCount.value))
const placeholderBars = Array.from({ length: 20 }, (_, index) => index)

function handleUnavailableSlotClick(): void {
  if (catalog.error.value) {
    void catalog.retry()
    return
  }
  emit('click')
}
</script>

<template>
  <div
    class="node-card-ping-group min-w-0"
    :data-node-ping-task-count="effectiveTasks.length"
    :data-node-ping-display-count="configuredCount"
    :data-node-ping-coverage="resolution.coverage"
  >
    <div v-if="placeholderCount" class="grid gap-1.5" aria-label="正在加载探测任务">
      <div
        v-for="slot in placeholderCount"
        :key="slot"
        class="node-card-ping-task-strip min-w-0 rounded-lg bg-slate-500/8 text-[10px] text-muted-foreground motion-reduce:animate-none sm:text-[11px]"
        :class="!appStore.disablePageAnimation && 'animate-pulse'"
        :data-node-ping-size="size"
        data-node-ping-placeholder
        data-node-ping-task-placeholder
      >
        <span class="node-card-ping-task-header truncate">探测任务 {{ slot }} · 等待采样</span>
        <span class="node-card-ping-trend-row" data-node-ping-panel="latency">
          <span class="node-card-ping-trend-label" data-node-ping-header="latency">延迟</span>
          <span class="node-card-ping-bucket-grid" data-node-ping-bars="latency">
            <span v-for="bar in placeholderBars" :key="`pending-latency-${bar}`" class="node-card-ping-bucket-hitbox" data-node-ping-bar data-node-ping-state="pending"><i class="node-card-ping-bucket-fill bg-transparent" data-node-ping-bucket-fill /></span>
          </span>
        </span>
        <span class="node-card-ping-trend-row" data-node-ping-panel="loss">
          <span class="node-card-ping-trend-label" data-node-ping-header="loss">丢包</span>
          <span class="node-card-ping-bucket-grid" data-node-ping-bars="loss">
            <span v-for="bar in placeholderBars" :key="`pending-loss-${bar}`" class="node-card-ping-bucket-hitbox" data-node-ping-bar data-node-ping-state="pending"><i class="node-card-ping-bucket-fill bg-transparent" data-node-ping-bucket-fill /></span>
          </span>
        </span>
      </div>
    </div>
    <div v-else class="grid gap-1.5">
      <template v-for="slot in displaySlots" :key="`${slot.slotIndex}-${slot.taskId ?? 'empty'}`">
        <NodeCardPingTaskStrip
          v-if="slot.task"
          :task-id="Number(slot.task.id)"
          :task-name="slot.task.name || `Ping ${slot.task.id}`"
          :snapshot="snapshotsByTaskId.get(String(slot.task.id))"
          :size="size"
          :online="online"
          @click="emit('click')"
        />
        <button
          v-else
          type="button"
          class="node-card-ping-task-strip min-w-0 rounded-lg bg-slate-500/5 text-left text-[10px] text-muted-foreground sm:text-[11px]"
          :data-node-ping-size="size"
          :title="`${nodeName}：${slot.reason}`"
          :data-node-ping-invalid-slot="slot.slotIndex + 1"
          @click.stop="handleUnavailableSlotClick"
        >
          <span class="node-card-ping-task-header flex min-w-0 items-center gap-1.5"><span class="size-1.5 shrink-0 rounded-full" :class="catalog.error.value ? 'bg-destructive' : 'bg-amber-500'" /><span class="min-w-0 flex-1 truncate">探测任务 {{ slot.slotIndex + 1 }}</span><span class="shrink-0">{{ slot.reason }}</span></span>
          <span class="node-card-ping-trend-row" data-node-ping-panel="latency"><span class="node-card-ping-trend-label" data-node-ping-header="latency">延迟</span><span class="node-card-ping-bucket-grid" data-node-ping-bars="latency"><span v-for="bar in placeholderBars" :key="`latency-${bar}`" class="node-card-ping-bucket-hitbox" data-node-ping-bar :data-node-ping-state="catalog.error.value ? 'error' : 'invalid'"><i class="node-card-ping-bucket-fill" :class="catalog.error.value ? 'bg-transparent' : 'bg-muted-foreground/15'" data-node-ping-bucket-fill /></span></span></span>
          <span class="node-card-ping-trend-row" data-node-ping-panel="loss"><span class="node-card-ping-trend-label" data-node-ping-header="loss">丢包</span><span class="node-card-ping-bucket-grid" data-node-ping-bars="loss"><span v-for="bar in placeholderBars" :key="`loss-${bar}`" class="node-card-ping-bucket-hitbox" data-node-ping-bar :data-node-ping-state="catalog.error.value ? 'error' : 'invalid'"><i class="node-card-ping-bucket-fill" :class="catalog.error.value ? 'bg-transparent' : 'bg-muted-foreground/15'" data-node-ping-bucket-fill /></span></span></span>
        </button>
      </template>
    </div>
  </div>
</template>
