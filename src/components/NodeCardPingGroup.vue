<script setup lang="ts">
import { computed } from 'vue'
import NodeCardPingTaskStrip from '@/components/NodeCardPingTaskStrip.vue'
import { useNodeCardPingTaskCatalog } from '@/composables/useNodeCardPingTaskCatalog'
import { useNodeMultiPingStats } from '@/composables/useNodeMultiPingStats'
import { useAppStore } from '@/stores/app'
import { resolveNodeCardMultiPingDisplay } from '@/utils/nodeCardMultiPingConfig'

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
const resolution = computed(() => resolveNodeCardMultiPingDisplay(
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
  { enabled: () => props.enabled && catalog.loaded.value },
)

const gridClass = computed(() => {
  const count = configuredCount.value
  if (props.size === 'large')
    return count >= 3 ? 'sm:grid-cols-3' : count === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'
  if (props.size === 'comfortable' && count === 2)
    return 'sm:grid-cols-2'
  return 'grid-cols-1'
})
const slotClass = computed(() => ({
  mini: 'min-h-9 gap-1 px-1.5 py-1',
  compact: 'min-h-12 gap-1.5 px-2 py-1.5',
  comfortable: 'min-h-14 gap-2 px-2.5 py-2',
  large: 'min-h-14 gap-2 px-2.5 py-2',
}[props.size]))
const resolvedTaskById = computed(() => new Map(resolution.value.tasks.map(task => [task.id, task])))
const displaySlots = computed(() => Array.from({ length: configuredCount.value }, (_, slotIndex) => {
  const taskId = resolution.value.configuredTaskIds[slotIndex]
  const task = taskId === undefined ? undefined : resolvedTaskById.value.get(taskId)
  const reason = catalog.error.value
    || (taskId === undefined
      ? `Slot ${slotIndex + 1} 未配置`
      : resolution.value.deletedTaskIds.includes(taskId)
        ? `任务 ${taskId} 已删除`
        : resolution.value.unassignedTaskIds.includes(taskId)
          ? `任务 ${taskId} 未覆盖此节点`
          : `任务 ${taskId} 暂无有效目录数据`)
  return { slotIndex, taskId, task, reason }
}))
const coverageText = computed(() => ({
  full: '',
  partial: `部分覆盖 ${resolution.value.resolvedTaskIds.length}/${configuredCount.value}`,
  none: '未覆盖',
  invalid: '配置无效',
}[resolution.value.coverage]))
const placeholderCount = computed(() => catalog.loaded.value || catalog.error.value
  ? 0
  : Math.max(1, configuredCount.value))

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
    <div v-if="placeholderCount" class="grid gap-1.5" :class="gridClass" aria-label="正在加载 Ping 任务">
      <div
        v-for="slot in placeholderCount"
        :key="slot"
        class="rounded-lg bg-slate-500/8 motion-reduce:animate-none"
        :class="[slotClass, !appStore.disablePageAnimation && 'animate-pulse']"
        data-node-ping-placeholder
      />
    </div>
    <div v-else class="grid gap-1.5" :class="gridClass">
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
          class="flex min-w-0 items-center rounded-lg bg-slate-500/5 text-left text-[10px] text-muted-foreground sm:text-[11px]"
          :class="slotClass"
          :title="`${nodeName}：${slot.reason}`"
          :data-node-ping-invalid-slot="slot.slotIndex + 1"
          @click.stop="handleUnavailableSlotClick"
        >
          <span class="mr-1.5 size-1.5 shrink-0 rounded-full" :class="catalog.error.value ? 'bg-destructive' : 'bg-amber-500'" />
          <span class="min-w-0 flex-1 truncate">{{ slot.reason }}</span>
          <span v-if="catalog.error.value" class="shrink-0">重试</span>
        </button>
      </template>
    </div>
    <div class="mt-1 min-h-3 truncate text-[10px] text-amber-600 dark:text-amber-400">
      <span v-if="coverageText">{{ coverageText }}；仅显示真实有效任务</span>
    </div>
  </div>
</template>
