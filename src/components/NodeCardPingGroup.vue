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

const slotClass = computed(() => ({
  mini: 'h-9 gap-1 px-1.5 py-1',
  compact: 'h-12 gap-1.5 px-2 py-1.5',
  comfortable: 'h-14 gap-2 px-2.5 py-2',
  large: 'h-14 gap-2 px-2.5 py-2',
}[props.size]))
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
        class="grid min-w-0 grid-rows-[auto_1fr_1fr] rounded-lg bg-slate-500/8 text-[10px] text-muted-foreground motion-reduce:animate-none sm:text-[11px]"
        :class="[slotClass, !appStore.disablePageAnimation && 'animate-pulse']"
        data-node-ping-placeholder
        data-node-ping-task-placeholder
      >
        <span class="truncate">探测任务 {{ slot }} · 等待采样</span>
        <span class="grid min-w-0 grid-cols-[22px_1fr] items-end gap-1" data-node-ping-panel="latency">
          <span class="text-[8px] leading-none" data-node-ping-header="latency">延迟</span>
          <span class="grid h-[4px] min-w-0 grid-cols-20 items-end gap-px" data-node-ping-bars="latency">
            <i v-for="bar in placeholderBars" :key="`pending-latency-${bar}`" class="h-[22%] rounded-[1px] bg-transparent" data-node-ping-bar data-node-ping-state="pending" />
          </span>
        </span>
        <span class="grid min-w-0 grid-cols-[22px_1fr] items-end gap-1" data-node-ping-panel="loss">
          <span class="text-[8px] leading-none" data-node-ping-header="loss">丢包</span>
          <span class="grid h-[4px] min-w-0 grid-cols-20 items-end gap-px" data-node-ping-bars="loss">
            <i v-for="bar in placeholderBars" :key="`pending-loss-${bar}`" class="h-[22%] rounded-[1px] bg-transparent" data-node-ping-bar data-node-ping-state="pending" />
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
          class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr] rounded-lg bg-slate-500/5 text-left text-[10px] text-muted-foreground sm:text-[11px]"
          :class="slotClass"
          :title="`${nodeName}：${slot.reason}`"
          :data-node-ping-invalid-slot="slot.slotIndex + 1"
          @click.stop="handleUnavailableSlotClick"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="size-1.5 shrink-0 rounded-full" :class="catalog.error.value ? 'bg-destructive' : 'bg-amber-500'" />
            <span class="min-w-0 truncate">探测任务 {{ slot.slotIndex + 1 }}</span>
          </span>
          <span class="shrink-0">{{ slot.reason }}</span>
          <span class="col-span-2 grid min-w-0 gap-[2px]" aria-hidden="true">
            <span class="grid h-[3px] grid-cols-[12px_1fr] items-center gap-1" data-node-ping-panel="latency"><span class="text-[8px] leading-none" data-node-ping-header="latency">延迟</span><span class="grid h-full grid-cols-20 gap-px" data-node-ping-bars="latency"><i v-for="bar in placeholderBars" :key="`latency-${bar}`" class="rounded-[1px]" :class="catalog.error.value ? 'bg-transparent' : 'bg-muted-foreground/15'" data-node-ping-bar :data-node-ping-state="catalog.error.value ? 'pending' : 'confirmed-missing'" /></span></span>
            <span class="grid h-[3px] grid-cols-[12px_1fr] items-center gap-1" data-node-ping-panel="loss"><span class="text-[8px] leading-none" data-node-ping-header="loss">丢包</span><span class="grid h-full grid-cols-20 gap-px" data-node-ping-bars="loss"><i v-for="bar in placeholderBars" :key="`loss-${bar}`" class="rounded-[1px]" :class="catalog.error.value ? 'bg-transparent' : 'bg-muted-foreground/15'" data-node-ping-bar :data-node-ping-state="catalog.error.value ? 'pending' : 'confirmed-missing'" /></span></span>
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.grid-cols-20 {
  grid-template-columns: repeat(20, minmax(0, 1fr));
}
</style>
