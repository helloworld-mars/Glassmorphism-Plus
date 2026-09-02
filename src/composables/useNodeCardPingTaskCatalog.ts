import type { PingTaskInfo } from '@/utils/rpc'
import { onMounted, readonly, ref, shallowRef } from 'vue'
import { loadPublicPingTasks } from '@/services/metrics.service'

export interface NodeCardPublicPingTask extends PingTaskInfo {
  clients: string[]
}

const tasks = shallowRef<NodeCardPublicPingTask[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref<string | null>(null)
let pendingLoad: Promise<void> | null = null

function normalizeTasks(value: readonly PingTaskInfo[]): NodeCardPublicPingTask[] {
  return value.flatMap((task) => {
    if (!Number.isSafeInteger(task.id) || task.id <= 0 || typeof task.name !== 'string')
      return []
    return [{
      ...task,
      clients: [...new Set((task.clients ?? [])
        .filter(client => typeof client === 'string' && client.trim())
        .map(client => client.trim().toLowerCase()))],
    }]
  })
}

export function ensureNodeCardPingTaskCatalog(): Promise<void> {
  if (loaded.value)
    return Promise.resolve()
  if (pendingLoad)
    return pendingLoad

  loading.value = true
  error.value = null
  pendingLoad = loadPublicPingTasks()
    .then((value) => {
      tasks.value = normalizeTasks(value)
      loaded.value = true
    })
    .catch((reason) => {
      error.value = reason instanceof Error && reason.message.trim()
        ? reason.message
        : 'Ping 任务目录加载失败'
    })
    .finally(() => {
      loading.value = false
      pendingLoad = null
    })
  return pendingLoad
}

export function useNodeCardPingTaskCatalog() {
  onMounted(() => {
    void ensureNodeCardPingTaskCatalog()
  })

  return {
    tasks: readonly(tasks),
    loading: readonly(loading),
    loaded: readonly(loaded),
    error: readonly(error),
    retry: ensureNodeCardPingTaskCatalog,
  }
}
