<script setup lang="ts">
import type { AdminPingClient, AdminPingTask } from '@/services/node-card-ping-binding.service'
import type { NodeCardPingTaskBindings } from '@/utils/nodeCardPingBindings'
import { Icon } from '@iconify/vue'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { AppDialog } from '@/components/ui/app-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import {
  getAssignedPingTasks,
  loadNodeCardPingBindingAdminData,
  NodeCardPingBindingApiError,
  saveNodeCardPingTaskBindings,
} from '@/services/node-card-ping-binding.service'
import { useAppStore } from '@/stores/app'
import { getNodeCardPingTaskId, parseNodeCardPingTaskBindings } from '@/utils/nodeCardPingBindings'

interface NodeBindingRow {
  client: AdminPingClient
  candidates: AdminPingTask[]
  task: AdminPingTask | null
  configuredTaskId?: number
}

type PageState = 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'error'

const router = useRouter()
const appStore = useAppStore()
const state = ref<PageState>('loading')
const errorMessage = ref('')
const searchText = ref('')
const onlyUnbound = ref(false)
const tasks = ref<AdminPingTask[]>([])
const clients = ref<AdminPingClient[]>([])
const bindings = ref<NodeCardPingTaskBindings>({})
const theme = ref('')
const activeClient = ref<AdminPingClient | null>(null)
const selectedTaskValue = ref('__unassigned__')
const isSaving = ref(false)
const saveError = ref('')

const rows = computed<NodeBindingRow[]>(() => clients.value.map((client) => {
  const candidates = getAssignedPingTasks(tasks.value, client.uuid)
  const configuredTaskId = getNodeCardPingTaskId(bindings.value, client.uuid)
  const task = configuredTaskId === undefined
    ? null
    : candidates.find(candidate => candidate.id === configuredTaskId) ?? null
  return { client, candidates, task, configuredTaskId }
}))

const visibleRows = computed(() => {
  const keyword = searchText.value.trim().toLocaleLowerCase()
  return rows.value.filter((row) => {
    const isBound = row.task !== null
    if (onlyUnbound.value && isBound)
      return false
    if (!keyword)
      return true
    return [row.client.name, row.client.uuid, row.client.group, row.client.region]
      .some(value => value.toLocaleLowerCase().includes(keyword))
  })
})

const activeRow = computed(() => activeClient.value
  ? rows.value.find(row => row.client.uuid === activeClient.value?.uuid) ?? null
  : null)
const activeCandidates = computed(() => activeRow.value?.candidates ?? [])
const invalidBindingCount = computed(() => rows.value.filter(row => row.configuredTaskId !== undefined && !row.task).length)

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function closeManager(): void {
  const query = { ...router.currentRoute.value.query }
  delete query.view
  void router.push({ name: 'home', query })
}

function openLogin(): void {
  window.location.assign('/admin')
}

async function loadManager(): Promise<void> {
  if (!appStore.isLoggedIn) {
    state.value = 'unauthenticated'
    errorMessage.value = ''
    return
  }

  state.value = 'loading'
  errorMessage.value = ''
  try {
    const data = await loadNodeCardPingBindingAdminData()
    theme.value = data.theme
    tasks.value = data.tasks
    clients.value = data.clients
    bindings.value = parseNodeCardPingTaskBindings(data.settings.nodeCardPingTaskBindings)
    state.value = 'ready'
  }
  catch (error) {
    if (!applyAccessError(error)) {
      state.value = 'error'
      errorMessage.value = errorText(error, '加载延迟任务绑定失败')
    }
  }
}

function clearAdminData(): void {
  tasks.value = []
  clients.value = []
  bindings.value = {}
  theme.value = ''
  activeClient.value = null
}

function applyAccessError(error: unknown): boolean {
  if (!(error instanceof NodeCardPingBindingApiError))
    return false

  if (error.status === 401) {
    appStore.updateLoginState(false)
    clearAdminData()
    state.value = 'unauthenticated'
    return true
  }

  if (error.status === 403) {
    clearAdminData()
    state.value = 'forbidden'
    return true
  }

  return false
}

function openSelector(row: NodeBindingRow): void {
  activeClient.value = row.client
  selectedTaskValue.value = row.task ? String(row.task.id) : '__unassigned__'
  saveError.value = ''
}

function closeSelector(): void {
  if (isSaving.value)
    return
  activeClient.value = null
  saveError.value = ''
}

function selectedTaskId(): number | undefined {
  if (selectedTaskValue.value === '__unassigned__')
    return undefined
  const value = Number(selectedTaskValue.value)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function saveBinding(client: AdminPingClient, taskId: number | undefined, closeOnSuccess = false): Promise<void> {
  if (isSaving.value)
    return

  isSaving.value = true
  saveError.value = ''
  try {
    const result = await saveNodeCardPingTaskBindings({
      theme: theme.value,
      selectedNodeUuid: client.uuid,
      selectedTaskId: taskId,
    })
    tasks.value = result.tasks
    clients.value = result.clients
    bindings.value = result.bindings
    appStore.publicSettings = result.publicSettings
    window.$message?.success(result.prunedCount > 0 ? `绑定已保存，并清理 ${result.prunedCount} 条失效映射。` : '节点延迟任务绑定已保存。')
    if (closeOnSuccess)
      closeSelector()
  }
  catch (error) {
    if (applyAccessError(error))
      return
    saveError.value = errorText(error, '保存绑定失败，请稍后重试')
    window.$message?.error(saveError.value)
  }
  finally {
    isSaving.value = false
  }
}

async function saveSelector(): Promise<void> {
  if (!activeClient.value)
    return

  const taskId = selectedTaskId()
  if (selectedTaskValue.value !== '__unassigned__' && !activeCandidates.value.some(task => task.id === taskId)) {
    saveError.value = '所选任务不是该节点已分配的有效任务。'
    return
  }
  await saveBinding(activeClient.value, taskId, true)
}

async function clearBinding(row: NodeBindingRow): Promise<void> {
  await saveBinding(row.client, undefined)
}

async function cleanInvalidBindings(): Promise<void> {
  if (isSaving.value)
    return

  isSaving.value = true
  try {
    const result = await saveNodeCardPingTaskBindings({ theme: theme.value })
    tasks.value = result.tasks
    clients.value = result.clients
    bindings.value = result.bindings
    appStore.publicSettings = result.publicSettings
    window.$message?.success(`已清理 ${result.prunedCount} 条失效映射。`)
  }
  catch (error) {
    if (applyAccessError(error))
      return
    const message = errorText(error, '清理失效映射失败，请稍后重试')
    window.$message?.error(message)
  }
  finally {
    isSaving.value = false
  }
}

onMounted(() => {
  void loadManager()
})
</script>

<template>
  <section class="node-ping-binding-manager px-4 py-6 sm:py-8" data-testid="node-ping-binding-manager">
    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div class="flex items-center gap-2">
          <Icon icon="tabler:activity-heartbeat" class="shrink-0 text-selection" width="24" height="24" />
          <h1 class="text-2xl font-bold tracking-tight">
            延迟任务绑定
          </h1>
        </div>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          以节点为主选择首页卡片的单一延迟监控任务。候选项只来自该任务 <code>clients</code> 中实际包含此节点 UUID 的任务；未绑定或失效时，卡片继续使用原有全部任务聚合。
        </p>
      </div>
      <Button variant="outline" size="sm" @click="closeManager">
        <Icon icon="tabler:arrow-left" />返回首页
      </Button>
    </div>

    <div v-if="state === 'loading'" class="rounded-lg border border-border/60 bg-background/50">
      <Empty description="正在验证管理权限并加载节点和延迟任务…" />
    </div>

    <div v-else-if="state === 'unauthenticated'" class="rounded-lg border border-border/60 bg-background/50" data-testid="node-ping-binding-unauthenticated">
      <Empty description="此页面仅允许已登录管理员操作。登录管理员账户后，可为每台节点选择首页卡片使用的延迟监控任务。">
        <template #extra>
          <Button size="sm" @click="openLogin">
            <Icon icon="tabler:login" />前往登录
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else-if="state === 'forbidden'" class="rounded-lg border border-border/60 bg-background/50" data-testid="node-ping-binding-forbidden">
      <Empty description="当前账户没有管理员权限，无法读取或保存延迟任务绑定。" />
    </div>

    <div v-else-if="state === 'error'" class="rounded-lg border border-destructive/40 bg-destructive/5">
      <Empty :description="errorMessage || '加载失败'">
        <template #extra>
          <Button size="sm" variant="outline" @click="loadManager">
            <Icon icon="tabler:refresh" />重试
          </Button>
        </template>
      </Empty>
    </div>

    <template v-else>
      <div class="mb-4 flex flex-col gap-2 rounded-lg border border-border/60 bg-background/50 p-3 backdrop-blur-sm md:flex-row md:items-center">
        <div class="relative min-w-0 flex-1">
          <Icon icon="tabler:search" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" width="16" />
          <Input v-model="searchText" class="pl-9" placeholder="搜索节点名称 / UUID / 分组 / 地区" aria-label="搜索节点延迟任务绑定" />
        </div>
        <label class="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground">
          <input v-model="onlyUnbound" type="checkbox" class="size-4 accent-primary">
          仅显示未绑定节点
        </label>
        <Button v-if="invalidBindingCount" variant="outline" size="sm" :disabled="isSaving" @click="cleanInvalidBindings">
          <Icon icon="tabler:broom" />清理 {{ invalidBindingCount }} 条失效映射
        </Button>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{{ clients.length }} 台节点</span>
        <span>{{ tasks.length }} 个有效 Ping 任务</span>
        <span>{{ visibleRows.length }} 条匹配结果</span>
      </div>

      <div v-if="visibleRows.length" class="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <article v-for="row in visibleRows" :key="row.client.uuid" class="rounded-lg border border-border/60 bg-background/55 p-4 shadow-xs backdrop-blur-sm" :data-testid="`node-binding-row-${row.client.uuid}`">
          <div class="flex gap-3">
            <Icon icon="tabler:server" class="mt-0.5 shrink-0 text-selection" width="19" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="min-w-0 truncate font-medium">
                  {{ row.client.name }}
                </h2>
                <Badge variant="outline">
                  {{ row.candidates.length }} 个候选
                </Badge>
              </div>
              <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                {{ row.client.uuid }}
              </p>
              <p v-if="row.client.region || row.client.group" class="mt-1 text-xs text-muted-foreground">
                <span v-if="row.client.region">地区：{{ row.client.region }}</span>
                <span v-if="row.client.region && row.client.group"> · </span>
                <span v-if="row.client.group">分组：{{ row.client.group }}</span>
              </p>
            </div>
          </div>

          <div class="mt-3 rounded-md bg-muted/45 px-3 py-2 text-sm">
            <template v-if="row.task">
              <div class="font-medium">
                {{ row.task.name }}
              </div>
              <div class="mt-1 text-xs text-muted-foreground">
                ID {{ row.task.id }} · {{ row.task.type }} · {{ row.task.interval === null ? '周期未知' : `${row.task.interval}s` }} · {{ row.task.target }}
              </div>
            </template>
            <template v-else-if="row.configuredTaskId !== undefined">
              <div class="font-medium text-destructive">
                失效绑定 · ID {{ row.configuredTaskId }}
              </div>
              <div class="mt-1 text-xs text-muted-foreground">
                任务已删除或不再分配给该节点；首页会自动使用原聚合数据。
              </div>
            </template>
            <template v-else>
              <div class="font-medium text-muted-foreground">
                未绑定
              </div>
              <div class="mt-1 text-xs text-muted-foreground">
                首页节点卡片将使用原有全部任务聚合数据。
              </div>
            </template>
          </div>

          <div class="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" :disabled="isSaving" @click="openSelector(row)">
              <Icon icon="tabler:list-check" />{{ row.task ? '修改任务' : '选择任务' }}
            </Button>
            <Button v-if="row.configuredTaskId !== undefined" size="sm" variant="ghost" :disabled="isSaving" @click="clearBinding(row)">
              <Icon icon="tabler:unlink" />清除绑定
            </Button>
          </div>
        </article>
      </div>
      <div v-else class="rounded-lg border border-border/60 bg-background/50">
        <Empty description="没有匹配的节点。" />
      </div>
    </template>

    <AppDialog
      :open="Boolean(activeClient)"
      :title="activeClient ? `选择 ${activeClient.name} 的延迟任务` : '选择延迟任务'"
      description="只显示任务 clients 中包含此节点 UUID 的有效任务。"
      content-class="max-w-3xl"
      @update:open="open => !open && closeSelector()"
    >
      <div v-if="activeClient" class="space-y-3">
        <p class="break-all rounded-md bg-muted/45 p-2 font-mono text-xs text-muted-foreground">
          {{ activeClient.uuid }}
        </p>
        <p v-if="saveError" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {{ saveError }}
        </p>
        <label class="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 transition-colors hover:bg-muted/40">
          <input v-model="selectedTaskValue" type="radio" value="__unassigned__" name="node-ping-task" class="mt-1 size-4 accent-primary">
          <span>
            <span class="block font-medium">不绑定任务</span>
            <span class="mt-1 block text-xs text-muted-foreground">保留首页卡片原有的全部任务聚合显示。</span>
          </span>
        </label>
        <label v-for="task in activeCandidates" :key="task.id" class="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 transition-colors hover:bg-muted/40">
          <input v-model="selectedTaskValue" type="radio" :value="String(task.id)" name="node-ping-task" class="mt-1 size-4 accent-primary">
          <span class="min-w-0">
            <span class="block font-medium">{{ task.name }}</span>
            <span class="mt-1 block break-all text-xs text-muted-foreground">ID {{ task.id }} · {{ task.type }} · {{ task.interval === null ? '周期未知' : `${task.interval}s` }} · {{ task.target }}</span>
          </span>
        </label>
        <Empty v-if="!activeCandidates.length" description="该节点目前没有可选择的已分配 Ping 任务；可保留未绑定状态。" class="border border-dashed border-border/60 rounded-lg" />
        <div class="flex justify-end gap-2 pt-1">
          <Button variant="outline" :disabled="isSaving" @click="closeSelector">
            取消
          </Button>
          <Button :disabled="isSaving" @click="saveSelector">
            <Icon :icon="isSaving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="isSaving && 'animate-spin'" />保存
          </Button>
        </div>
      </div>
    </AppDialog>
  </section>
</template>
