<script setup lang="ts">
import type { AdminPingClient, AdminPingTask, NodeCardMultiPingDisplayConfigAdminData } from '@/services/node-card-ping-binding.service'
import type { NodeCardMultiPingConfig, NodeCardMultiPingConfigInspection, NodeCardMultiPingCoverage, NodeCardMultiPingRuntimeConfig } from '@/utils/nodeCardMultiPingConfig'
import type { PingTaskInfo } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { AppDialog } from '@/components/ui/app-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { loadPublicPingTasks } from '@/services/metrics.service'
import {
  invalidateNodeCardPingBindingAdminSession,
  loadNodeCardMultiPingDisplayConfigAdminData,
  NodeCardPingBindingApiError,
  saveNodeCardMultiPingDisplayConfigV2,
} from '@/services/node-card-ping-binding.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import {
  getNodeCardMultiPingTaskCandidates,
  getStrictNodeCardMultiPingTaskIntersection,
  inspectNodeCardMultiPingConfig,
  previewStrictNodeCardMultiPingBulkAssignment,
  resolveNodeCardMultiPingDisplay,
} from '@/utils/nodeCardMultiPingConfig'

type CenterTab = 'overview' | 'config'
type PublicState = 'loading' | 'ready' | 'error'
type AdminState = 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'error'
type ConfigFilter = 'all' | 'inherit' | 'custom' | NodeCardMultiPingCoverage

interface ConfigRow {
  client: AdminPingClient
  candidates: AdminPingTask[]
  mode: 'inherit' | 'custom'
  coverage: NodeCardMultiPingCoverage
  resolution: ReturnType<typeof resolveNodeCardMultiPingDisplay<AdminPingTask>>
}

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const nodesStore = useNodesStore()

const publicState = ref<PublicState>('loading')
const publicError = ref('')
const publicTasks = ref<PingTaskInfo[]>([])
const adminState = ref<AdminState>('idle')
const adminError = ref('')
const theme = ref('')
const adminTasks = ref<AdminPingTask[]>([])
const clients = ref<AdminPingClient[]>([])
const loadedRuntime = ref<NodeCardMultiPingRuntimeConfig | null>(null)
const loadedInspection = ref<NodeCardMultiPingConfigInspection | null>(null)
const draftConfig = ref<NodeCardMultiPingConfig | null>(null)
const originalConfig = ref<NodeCardMultiPingConfig | null>(null)
const draftUsesV2 = ref(false)
const draftDirty = ref(false)
const searchText = ref('')
const configFilter = ref<ConfigFilter>('all')
const selectedNodeUuids = ref<Set<string>>(new Set())
const bulkDisplayCount = ref<1 | 2 | 3>(1)
const bulkTaskIds = ref<number[]>([])
const activeClientUuid = ref('')
const isSaving = ref(false)
const saveError = ref('')
const savePreviewOpen = ref(false)
let adminRequestGeneration = 0

const activeTab = computed<CenterTab>(() => route.query.pingtab === 'overview' ? 'overview' : 'config')
const visiblePublicNodes = computed(() => nodesStore.visibleNodes)
const visiblePublicNodeIds = computed(() => new Set(visiblePublicNodes.value.map(node => node.uuid.toLowerCase())))
const publicTaskRows = computed(() => publicTasks.value.map((task) => {
  const assignedNodeIds = [...new Set((task.clients ?? []).map(uuid => uuid.toLowerCase()))]
    .filter(uuid => visiblePublicNodeIds.value.has(uuid))
  const assignedNodes = assignedNodeIds.flatMap(uuid => nodesStore.visibleNodesByUuid.get(uuid) ?? [])
  return { task, assignedNodes }
}))
const coveredPublicNodeCount = computed(() => {
  const covered = new Set<string>()
  for (const row of publicTaskRows.value) {
    for (const node of row.assignedNodes)
      covered.add(node.uuid)
  }
  return covered.size
})

const draftRuntime = computed<NodeCardMultiPingRuntimeConfig | null>(() => {
  if (!draftConfig.value || !loadedRuntime.value)
    return null
  return {
    ...loadedRuntime.value,
    config: draftConfig.value,
    source: draftUsesV2.value ? 'v2' : loadedRuntime.value.source,
  }
})

const rows = computed<ConfigRow[]>(() => {
  if (!draftRuntime.value)
    return []
  return clients.value.map((client) => {
    const nodeConfig = draftConfig.value?.nodes[client.uuid]
    const resolution = resolveNodeCardMultiPingDisplay(draftRuntime.value!, client.uuid, adminTasks.value)
    return {
      client,
      candidates: getNodeCardMultiPingTaskCandidates(adminTasks.value, client.uuid),
      mode: nodeConfig?.mode === 'custom' ? 'custom' : 'inherit',
      coverage: resolution.coverage,
      resolution,
    }
  })
})

const coverageCounts = computed<Record<NodeCardMultiPingCoverage, number>>(() => {
  const counts: Record<NodeCardMultiPingCoverage, number> = { full: 0, partial: 0, none: 0, invalid: 0 }
  for (const row of rows.value)
    counts[row.coverage]++
  return counts
})
const filteredRows = computed(() => {
  const keyword = searchText.value.trim().toLocaleLowerCase()
  return rows.value.filter((row) => {
    if (configFilter.value === 'inherit' || configFilter.value === 'custom') {
      if (row.mode !== configFilter.value)
        return false
    }
    else if (configFilter.value !== 'all' && row.coverage !== configFilter.value) {
      return false
    }
    if (!keyword)
      return true
    return [row.client.name, row.client.uuid, row.client.region, row.client.group]
      .some(value => value.toLocaleLowerCase().includes(keyword))
  })
})
const selectedRows = computed(() => rows.value.filter(row => selectedNodeUuids.value.has(row.client.uuid)))
const allFilteredSelected = computed(() => filteredRows.value.length > 0
  && filteredRows.value.every(row => selectedNodeUuids.value.has(row.client.uuid)))
const strictBulkTasks = computed(() => getStrictNodeCardMultiPingTaskIntersection(
  adminTasks.value,
  selectedRows.value.map(row => row.client.uuid),
))
const bulkPreview = computed(() => {
  if (!draftConfig.value)
    return null
  return previewStrictNodeCardMultiPingBulkAssignment(
    draftConfig.value,
    selectedRows.value.map(row => row.client.uuid),
    bulkDisplayCount.value,
    bulkTaskIds.value,
    adminTasks.value,
  )
})
const bulkFailureReasons = computed(() => {
  const preview = bulkPreview.value
  if (!preview || preview.canApply)
    return []
  const reasons: string[] = []
  if (!preview.selectionValid)
    reasons.push(`需要选择 ${bulkDisplayCount.value} 个不重复任务。`)
  if (preview.invalidTaskIds.length)
    reasons.push(`不属于全部节点交集的任务：${preview.invalidTaskIds.join('、')}。`)
  if (preview.invalidNodeUuids.length)
    reasons.push(`UUID 格式无效：${preview.invalidNodeUuids.join('、')}。`)
  if (preview.excludedNodeUuids.length) {
    const labels = preview.excludedNodeUuids.map(uuid => clients.value.find(client => client.uuid === uuid)?.name || uuid)
    reasons.push(`不兼容节点：${labels.join('、')}。`)
  }
  return reasons
})
const activeRow = computed(() => rows.value.find(row => row.client.uuid === activeClientUuid.value) ?? null)
const activeNodeConfig = computed(() => activeRow.value && draftConfig.value
  ? draftConfig.value.nodes[activeRow.value.client.uuid]
  : undefined)
const activeMode = computed<'inherit' | 'custom'>(() => activeNodeConfig.value?.mode === 'custom' ? 'custom' : 'inherit')
const activeCustomConfig = computed(() => activeNodeConfig.value?.mode === 'custom' ? activeNodeConfig.value : null)
const orphanNodeUuids = computed(() => {
  if (!draftConfig.value)
    return []
  const knownNodeUuids = new Set(clients.value.map(client => client.uuid))
  return Object.keys(draftConfig.value.nodes).filter(uuid => !knownNodeUuids.has(uuid))
})

const validationIssues = computed(() => {
  const issues: string[] = []
  const draft = draftConfig.value
  if (!draft)
    return ['配置尚未加载。']

  if (draft.global.taskIds.length === 0) {
    if (draft.global.displayCount !== 1)
      issues.push('全局未指定任务时，显示数量必须为 1（旧版聚合模式）。')
  }
  else if (draft.global.taskIds.length !== draft.global.displayCount) {
    issues.push(`全局需要选择 ${draft.global.displayCount} 个不重复任务。`)
  }

  const knownTaskIds = new Set(adminTasks.value.map(task => task.id))
  for (const nodeUuid of orphanNodeUuids.value)
    issues.push(`配置中的节点 ${nodeUuid} 已不存在，请先移除该覆盖。`)
  for (const taskId of draft.global.taskIds) {
    if (!knownTaskIds.has(taskId))
      issues.push(`全局任务 ${taskId} 已删除。`)
  }
  for (const row of rows.value) {
    const nodeConfig = draft.nodes[row.client.uuid]
    if (nodeConfig?.mode !== 'custom')
      continue
    if (nodeConfig.taskIds.length !== nodeConfig.displayCount)
      issues.push(`${row.client.name} 需要选择 ${nodeConfig.displayCount} 个不重复任务。`)
    if (row.resolution.deletedTaskIds.length)
      issues.push(`${row.client.name} 包含已删除任务：${row.resolution.deletedTaskIds.join('、')}。`)
    if (row.resolution.unassignedTaskIds.length)
      issues.push(`${row.client.name} 包含未分配给该节点的任务：${row.resolution.unassignedTaskIds.join('、')}。`)
  }
  const inspection = inspectNodeCardMultiPingConfig(draft)
  if (inspection.status !== 'valid' && !issues.length)
    issues.push(inspection.reason ?? '配置结构无效。')
  return [...new Set(issues)]
})

const changedNodeCount = computed(() => {
  if (!draftConfig.value || !originalConfig.value)
    return 0
  const uuids = new Set([...Object.keys(draftConfig.value.nodes), ...Object.keys(originalConfig.value.nodes)])
  let count = 0
  for (const uuid of uuids) {
    if (JSON.stringify(draftConfig.value.nodes[uuid]) !== JSON.stringify(originalConfig.value.nodes[uuid]))
      count++
  }
  return count
})
const globalChanged = computed(() => Boolean(
  draftConfig.value
  && originalConfig.value
  && JSON.stringify(draftConfig.value.global) !== JSON.stringify(originalConfig.value.global),
))

function cloneConfig(config: NodeCardMultiPingConfig): NodeCardMultiPingConfig {
  return {
    schemaVersion: 2,
    global: { displayCount: config.global.displayCount, taskIds: [...config.global.taskIds] },
    nodes: Object.fromEntries(Object.entries(config.nodes).map(([uuid, nodeConfig]) => [
      uuid,
      nodeConfig.mode === 'custom'
        ? { mode: 'custom', displayCount: nodeConfig.displayCount, taskIds: [...nodeConfig.taskIds] }
        : { mode: 'inherit' },
    ])),
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function closeCenter(): void {
  const query = { ...route.query }
  delete query.view
  delete query.pingtab
  void router.replace({ name: 'home', query })
}

function switchTab(tab: CenterTab): void {
  const query = {
    ...route.query,
    view: 'pingsettings',
    pingtab: tab === 'overview' ? 'overview' : undefined,
  }
  void router.replace({ name: 'home', query })
}

function openLogin(): void {
  window.location.assign('/admin')
}

async function loadOverview(): Promise<void> {
  publicState.value = 'loading'
  publicError.value = ''
  try {
    publicTasks.value = await loadPublicPingTasks()
    publicState.value = 'ready'
  }
  catch (error) {
    publicTasks.value = []
    publicState.value = 'error'
    publicError.value = errorText(error, '加载公开 Ping 任务失败')
  }
}

function clearAdminData(): void {
  adminRequestGeneration++
  invalidateNodeCardPingBindingAdminSession()
  theme.value = ''
  adminTasks.value = []
  clients.value = []
  loadedRuntime.value = null
  loadedInspection.value = null
  draftConfig.value = null
  originalConfig.value = null
  selectedNodeUuids.value = new Set()
  activeClientUuid.value = ''
  draftDirty.value = false
  savePreviewOpen.value = false
  saveError.value = ''
}

function applyAccessError(error: unknown): boolean {
  if (!(error instanceof NodeCardPingBindingApiError))
    return false
  if (error.status === 401) {
    appStore.updateLoginState(false)
    clearAdminData()
    adminState.value = 'unauthenticated'
    return true
  }
  if (error.status === 403) {
    clearAdminData()
    adminState.value = 'forbidden'
    return true
  }
  return false
}

function applyAdminData(data: NodeCardMultiPingDisplayConfigAdminData): void {
  theme.value = data.theme
  adminTasks.value = data.tasks
  clients.value = data.clients
  loadedRuntime.value = data.runtimeConfig
  loadedInspection.value = data.configInspection
  draftConfig.value = cloneConfig(data.runtimeConfig.config)
  originalConfig.value = cloneConfig(data.runtimeConfig.config)
  draftUsesV2.value = data.runtimeConfig.source === 'v2'
  draftDirty.value = false
  selectedNodeUuids.value = new Set()
}

async function loadAdminConfig(): Promise<void> {
  if (!appStore.isLoggedIn) {
    clearAdminData()
    adminState.value = 'unauthenticated'
    return
  }
  const requestGeneration = ++adminRequestGeneration
  adminState.value = 'loading'
  adminError.value = ''
  try {
    const data = await loadNodeCardMultiPingDisplayConfigAdminData()
    if (requestGeneration !== adminRequestGeneration || !appStore.isLoggedIn)
      return
    applyAdminData(data)
    adminState.value = 'ready'
  }
  catch (error) {
    if (requestGeneration !== adminRequestGeneration)
      return
    if (!applyAccessError(error)) {
      adminState.value = 'error'
      adminError.value = errorText(error, '加载 Ping 显示配置失败')
    }
  }
}

function markDraftChanged(): void {
  draftDirty.value = true
  draftUsesV2.value = true
  saveError.value = ''
}

function readTaskId(event: Event): number | null {
  const value = Number((event.target as HTMLSelectElement).value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function replaceTaskSlot(taskIds: number[], index: number, taskId: number | null, count: number): number[] {
  const next = [...taskIds]
  if (taskId === null)
    next.splice(index, 1)
  else
    next[index] = taskId
  return [...new Set(next.filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, count)
}

function setGlobalDisplayCount(event: Event): void {
  if (!draftConfig.value)
    return
  const count = Number((event.target as HTMLSelectElement).value) as 1 | 2 | 3
  draftConfig.value.global.displayCount = count
  draftConfig.value.global.taskIds = draftConfig.value.global.taskIds.slice(0, count)
  markDraftChanged()
}

function setGlobalTask(index: number, event: Event): void {
  if (!draftConfig.value)
    return
  draftConfig.value.global.taskIds = replaceTaskSlot(draftConfig.value.global.taskIds, index, readTaskId(event), draftConfig.value.global.displayCount)
  markDraftChanged()
}

function setSelected(uuid: string, selected: boolean): void {
  const next = new Set(selectedNodeUuids.value)
  selected ? next.add(uuid) : next.delete(uuid)
  selectedNodeUuids.value = next
}

function toggleFilteredSelection(): void {
  const next = new Set(selectedNodeUuids.value)
  for (const row of filteredRows.value) {
    if (allFilteredSelected.value)
      next.delete(row.client.uuid)
    else
      next.add(row.client.uuid)
  }
  selectedNodeUuids.value = next
}

function setBulkDisplayCount(event: Event): void {
  bulkDisplayCount.value = Number((event.target as HTMLSelectElement).value) as 1 | 2 | 3
  bulkTaskIds.value = bulkTaskIds.value.slice(0, bulkDisplayCount.value)
}

function setBulkTask(index: number, event: Event): void {
  bulkTaskIds.value = replaceTaskSlot(bulkTaskIds.value, index, readTaskId(event), bulkDisplayCount.value)
}

function applyBulkInherit(): void {
  if (!draftConfig.value || !selectedRows.value.length)
    return
  for (const row of selectedRows.value)
    draftConfig.value.nodes[row.client.uuid] = { mode: 'inherit' }
  markDraftChanged()
}

function clearBulkOverrides(): void {
  if (!draftConfig.value || !selectedRows.value.length)
    return
  for (const row of selectedRows.value)
    delete draftConfig.value.nodes[row.client.uuid]
  markDraftChanged()
}

function applyBulkCustom(): void {
  if (!draftConfig.value || !bulkPreview.value?.canApply)
    return
  for (const uuid of bulkPreview.value.eligibleNodeUuids) {
    draftConfig.value.nodes[uuid] = { mode: 'custom', displayCount: bulkDisplayCount.value, taskIds: [...bulkPreview.value.taskIds] }
  }
  markDraftChanged()
}

function openNodeEditor(row: ConfigRow): void {
  activeClientUuid.value = row.client.uuid
}

function closeNodeEditor(): void {
  activeClientUuid.value = ''
}

function setActiveMode(mode: 'inherit' | 'custom'): void {
  if (!draftConfig.value || !activeRow.value)
    return
  const uuid = activeRow.value.client.uuid
  if (mode === 'inherit') {
    draftConfig.value.nodes[uuid] = { mode: 'inherit' }
  }
  else if (draftConfig.value.nodes[uuid]?.mode !== 'custom') {
    const firstCandidate = activeRow.value.candidates[0]
    draftConfig.value.nodes[uuid] = { mode: 'custom', displayCount: 1, taskIds: firstCandidate ? [firstCandidate.id] : [] }
  }
  markDraftChanged()
}

function clearActiveOverride(): void {
  if (!draftConfig.value || !activeRow.value)
    return
  delete draftConfig.value.nodes[activeRow.value.client.uuid]
  markDraftChanged()
}

function clearOrphanOverrides(): void {
  if (!draftConfig.value || !orphanNodeUuids.value.length)
    return
  for (const nodeUuid of orphanNodeUuids.value)
    delete draftConfig.value.nodes[nodeUuid]
  markDraftChanged()
}

function setActiveDisplayCount(event: Event): void {
  if (!activeCustomConfig.value)
    return
  const count = Number((event.target as HTMLSelectElement).value) as 1 | 2 | 3
  activeCustomConfig.value.displayCount = count
  activeCustomConfig.value.taskIds = activeCustomConfig.value.taskIds.slice(0, count)
  markDraftChanged()
}

function setActiveTask(index: number, event: Event): void {
  if (!activeCustomConfig.value)
    return
  activeCustomConfig.value.taskIds = replaceTaskSlot(activeCustomConfig.value.taskIds, index, readTaskId(event), activeCustomConfig.value.displayCount)
  markDraftChanged()
}

function openSavePreview(): void {
  saveError.value = ''
  savePreviewOpen.value = true
}

async function saveConfig(): Promise<void> {
  if (!draftConfig.value || validationIssues.value.length || isSaving.value || !appStore.isLoggedIn)
    return
  isSaving.value = true
  saveError.value = ''
  const requestGeneration = ++adminRequestGeneration
  try {
    const result = await saveNodeCardMultiPingDisplayConfigV2({ theme: theme.value, config: draftConfig.value })
    if (requestGeneration !== adminRequestGeneration || !appStore.isLoggedIn)
      return
    appStore.publicSettings = result.publicSettings
    applyAdminData(result)
    adminState.value = 'ready'
    savePreviewOpen.value = false
    window.$message?.success('Ping 显示配置已保存。')
  }
  catch (error) {
    if (requestGeneration !== adminRequestGeneration)
      return
    if (applyAccessError(error)) {
      savePreviewOpen.value = false
      return
    }
    saveError.value = errorText(error, '保存 Ping 显示配置失败')
    window.$message?.error(saveError.value)
  }
  finally {
    isSaving.value = false
  }
}

function coverageLabel(coverage: NodeCardMultiPingCoverage): string {
  return { full: '完整', partial: '部分', none: '无覆盖', invalid: '失效' }[coverage]
}

function coverageClass(coverage: NodeCardMultiPingCoverage): string {
  return { full: 'text-emerald-500', partial: 'text-amber-500', none: 'text-muted-foreground', invalid: 'text-destructive' }[coverage]
}

function taskOptionLabel(task: AdminPingTask): string {
  const knownNodeUuids = new Set(clients.value.map(client => client.uuid))
  const coverage = new Set(task.clients.filter(uuid => knownNodeUuids.has(uuid))).size
  const interval = task.interval === null ? '间隔未知' : `${task.interval}s`
  return `${task.name} · ID ${task.id} · ${task.type} · ${interval} · ${task.target} · 覆盖 ${coverage}`
}

watch(activeTab, (tab) => {
  if (tab === 'config' && adminState.value !== 'ready' && adminState.value !== 'loading')
    void loadAdminConfig()
}, { immediate: true })

watch(() => appStore.isLoggedIn, (loggedIn) => {
  if (!loggedIn) {
    clearAdminData()
    adminState.value = 'unauthenticated'
  }
  else if (activeTab.value === 'config' && (adminState.value === 'unauthenticated' || adminState.value === 'idle')) {
    void loadAdminConfig()
  }
})

onMounted(() => void loadOverview())
</script>

<template>
  <section class="ping-center px-4 py-6 sm:py-8" data-testid="ping-center" data-legacy-testid="node-ping-binding-manager">
    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div class="flex items-center gap-2">
          <Icon icon="tabler:activity-heartbeat" class="shrink-0 text-selection" width="24" height="24" /><h1 class="text-2xl font-bold tracking-tight">
            Ping 监控中心
          </h1>
        </div>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          查看公开 Ping 任务与节点覆盖；管理员可在同一入口配置首页卡片显示的 1–3 个探测任务。
        </p>
      </div>
      <Button variant="outline" size="sm" data-testid="ping-center-close" @click="closeCenter">
        <Icon icon="tabler:arrow-left" />返回首页
      </Button>
    </div>

    <div class="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-border/60 bg-background/55 p-1 backdrop-blur-sm" data-testid="ping-center-tabs">
      <button type="button" class="rounded-md px-3 py-1.5 text-sm transition-colors" :class="activeTab === 'overview' ? 'bg-background text-selection shadow-sm' : 'text-muted-foreground hover:text-foreground'" data-testid="ping-center-tab-overview" @click="switchTab('overview')">
        Ping 监控概览
      </button>
      <button v-if="appStore.isLoggedIn || activeTab === 'config'" type="button" class="rounded-md px-3 py-1.5 text-sm transition-colors" :class="activeTab === 'config' ? 'bg-background text-selection shadow-sm' : 'text-muted-foreground hover:text-foreground'" data-testid="ping-center-tab-settings" @click="switchTab('config')">
        首页 Ping 配置
      </button>
    </div>

    <div v-if="activeTab === 'overview'" data-testid="ping-center-overview">
      <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-lg border border-border/60 bg-background/55 p-4">
          <div class="text-xs text-muted-foreground">
            公开任务
          </div><div class="mt-1 text-2xl font-semibold tabular-nums">
            {{ publicTasks.length }}
          </div>
        </div>
        <div class="rounded-lg border border-border/60 bg-background/55 p-4">
          <div class="text-xs text-muted-foreground">
            公开节点
          </div><div class="mt-1 text-2xl font-semibold tabular-nums">
            {{ visiblePublicNodes.length }}
          </div>
        </div>
        <div class="rounded-lg border border-border/60 bg-background/55 p-4">
          <div class="text-xs text-muted-foreground">
            已有任务覆盖
          </div><div class="mt-1 text-2xl font-semibold tabular-nums">
            {{ coveredPublicNodeCount }}
          </div>
        </div>
        <div class="rounded-lg border border-border/60 bg-background/55 p-4">
          <div class="text-xs text-muted-foreground">
            在线节点
          </div><div class="mt-1 text-2xl font-semibold tabular-nums">
            {{ nodesStore.onlineCount }}
          </div>
        </div>
      </div>
      <div v-if="publicState === 'loading'" class="rounded-lg border border-border/60 bg-background/50" data-testid="ping-center-public-loading">
        <Empty description="正在加载公开 Ping 任务…" />
      </div>
      <div v-else-if="publicState === 'error'" class="rounded-lg border border-destructive/40 bg-destructive/5" data-testid="ping-center-public-error">
        <Empty :description="publicError || '加载失败'">
          <template #extra>
            <Button size="sm" variant="outline" @click="loadOverview">
              <Icon icon="tabler:refresh" />重试
            </Button>
          </template>
        </Empty>
      </div>
      <div v-else-if="publicTaskRows.length" class="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <article v-for="row in publicTaskRows" :key="row.task.id" class="rounded-lg border border-border/60 bg-background/55 p-4 shadow-xs backdrop-blur-sm" :data-testid="`ping-center-public-task-${row.task.id}`">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate font-medium">
                {{ row.task.name }}
              </h2><p class="mt-1 text-xs text-muted-foreground">
                ID {{ row.task.id }} · {{ row.task.type || 'Ping' }} · {{ row.task.interval }}s
              </p>
            </div><Badge variant="outline">
              {{ row.assignedNodes.length }} 台
            </Badge>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 rounded-md bg-muted/35 p-3 text-sm">
            <div>
              <span class="text-muted-foreground">延迟</span><div class="mt-0.5 font-medium tabular-nums">
                {{ row.task.latest ?? row.task.avg ?? '—' }} ms
              </div>
            </div><div>
              <span class="text-muted-foreground">丢包</span><div class="mt-0.5 font-medium tabular-nums">
                {{ Number.isFinite(row.task.loss) ? `${row.task.loss.toFixed(2)}%` : '—' }}
              </div>
            </div>
          </div>
          <p class="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {{ row.assignedNodes.length ? row.assignedNodes.map(node => node.name).join('、') : '当前公开节点中暂无覆盖。' }}
          </p>
        </article>
      </div>
      <div v-else class="rounded-lg border border-border/60 bg-background/50">
        <Empty description="当前没有公开 Ping 任务。" />
      </div>
    </div>

    <div v-else data-testid="ping-center-settings">
      <div v-if="adminState === 'loading'" class="rounded-lg border border-border/60 bg-background/50">
        <Empty description="正在验证管理权限并加载 Ping 配置…" />
      </div>
      <div v-else-if="adminState === 'unauthenticated'" class="rounded-lg border border-border/60 bg-background/50" data-testid="ping-center-settings-login-required">
        <Empty description="此配置仅允许已登录管理员读取和保存。访客不会触发任何管理 API。">
          <template #extra>
            <Button size="sm" @click="openLogin">
              <Icon icon="tabler:login" />前往登录
            </Button>
          </template>
        </Empty>
      </div>
      <div v-else-if="adminState === 'forbidden'" class="rounded-lg border border-border/60 bg-background/50" data-testid="node-ping-binding-forbidden">
        <Empty description="当前账户没有管理员权限，无法读取或保存 Ping 配置。" />
      </div>
      <div v-else-if="adminState === 'error'" class="rounded-lg border border-destructive/40 bg-destructive/5" data-testid="ping-center-settings-error">
        <Empty :description="adminError || '加载失败'">
          <template #extra>
            <Button size="sm" variant="outline" @click="loadAdminConfig">
              <Icon icon="tabler:refresh" />重试
            </Button>
          </template>
        </Empty>
      </div>

      <template v-else-if="adminState === 'ready' && appStore.isLoggedIn && draftConfig">
        <div
          v-if="loadedInspection?.status === 'damaged'"
          class="mb-4 flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          data-testid="ping-center-damaged-config"
        >
          <div>
            <div class="font-medium text-destructive">
              已保存的 v2 Ping 配置损坏
            </div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">
              {{ loadedInspection.reason || '配置无法安全解析。' }} 当前已回退到旧版单任务绑定或聚合模式，未读取不可信字段。
            </p>
          </div>
          <Button size="sm" variant="outline" @click="markDraftChanged">
            使用当前安全配置修复
          </Button>
        </div>
        <div
          v-else-if="loadedRuntime?.source === 'legacy-migration'"
          class="mb-4 flex flex-col gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          data-testid="ping-center-legacy-migration"
        >
          <p class="text-xs leading-5 text-muted-foreground">
            已无损载入 v1.x 单任务绑定；每个旧任务仍是对应节点的 Slot 1。保存后会写入 v2 配置，同时保留旧 key 供降级使用。
          </p>
          <Button size="sm" variant="outline" @click="markDraftChanged">
            写入 v2 配置
          </Button>
        </div>
        <div
          v-if="orphanNodeUuids.length"
          class="mb-4 flex flex-col gap-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          data-testid="ping-center-orphan-config"
        >
          <div class="min-w-0">
            <div class="font-medium text-amber-600 dark:text-amber-400">
              {{ orphanNodeUuids.length }} 个节点覆盖已失效
            </div>
            <p class="mt-1 break-all text-xs leading-5 text-muted-foreground">
              {{ orphanNodeUuids.join('、') }}
            </p>
          </div>
          <Button size="sm" variant="outline" @click="clearOrphanOverrides">
            移除失效覆盖
          </Button>
        </div>
        <div class="mb-4 rounded-lg border border-border/60 bg-background/55 p-4" data-testid="ping-center-global-config">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 class="font-semibold">
                全局默认显示
              </h2><p class="mt-1 text-xs leading-5 text-muted-foreground">
                未设置单节点 custom 的节点继承这里；单栏留空表示继续使用旧版全部任务聚合。
              </p>
            </div>
            <div class="flex flex-wrap items-end gap-2">
              <label class="text-xs text-muted-foreground">显示数量<select :value="draftConfig.global.displayCount" class="mt-1 block h-9 rounded-md border border-input bg-background px-3 text-sm" data-testid="ping-center-global-count" @change="setGlobalDisplayCount"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option></select></label>
              <label v-for="index in draftConfig.global.displayCount" :key="index" class="min-w-44 text-xs text-muted-foreground">Slot {{ index }}<select :value="draftConfig.global.taskIds[index - 1] ?? ''" class="mt-1 block h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" :data-testid="`ping-center-global-slot-${index}`" @change="setGlobalTask(index - 1, $event)"><option value="">{{ draftConfig.global.displayCount === 1 ? '聚合 / 未指定' : '请选择任务' }}</option><option v-for="task in adminTasks" :key="task.id" :value="task.id" :disabled="draftConfig.global.taskIds.some((id, slot) => id === task.id && slot !== index - 1)">{{ taskOptionLabel(task) }}</option></select></label>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap gap-2 text-xs">
            <Badge variant="outline" class="text-emerald-500">
              完整 {{ coverageCounts.full }}
            </Badge><Badge variant="outline" class="text-amber-500">
              部分 {{ coverageCounts.partial }}
            </Badge><Badge variant="outline">
              无覆盖 {{ coverageCounts.none }}
            </Badge><Badge variant="outline" class="text-destructive">
              失效 {{ coverageCounts.invalid }}
            </Badge>
          </div>
        </div>

        <div class="mb-4 rounded-lg border border-border/60 bg-background/55 p-3">
          <div class="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div class="relative min-w-0 flex-1">
              <Icon icon="tabler:search" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" width="16" /><Input v-model="searchText" class="pl-9" placeholder="搜索名称 / UUID / 地区 / 分组" data-testid="ping-center-settings-search" />
            </div><select v-model="configFilter" class="h-9 rounded-md border border-input bg-background px-3 text-sm" data-testid="ping-center-settings-filter">
              <option value="all">
                全部
              </option><option value="inherit">
                inherit
              </option><option value="custom">
                custom
              </option><option value="full">
                full
              </option><option value="partial">
                partial
              </option><option value="none">
                none
              </option><option value="invalid">
                invalid
              </option>
            </select><Button size="sm" variant="outline" data-testid="ping-center-filter-select-all" @click="toggleFilteredSelection">
              <Icon :icon="allFilteredSelected ? 'tabler:square-minus' : 'tabler:checks'" />{{ allFilteredSelected ? '取消当前筛选' : '全选当前筛选' }}
            </Button>
          </div>
          <div class="mt-2 text-xs text-muted-foreground">
            {{ filteredRows.length }} 条结果 · 已选 {{ selectedRows.length }} 台
          </div>
        </div>

        <div v-if="selectedRows.length" class="mb-4 rounded-lg border border-selection/30 bg-selection/5 p-4" data-testid="ping-center-bulk-panel">
          <div class="flex flex-col gap-3 xl:flex-row xl:items-end">
            <div class="min-w-40">
              <div class="text-sm font-medium">
                严格批量配置
              </div><div class="mt-1 text-xs text-muted-foreground">
                共同候选 {{ strictBulkTasks.length }} 个；任一节点不兼容则 custom 不会部分套用。
              </div>
            </div><label class="text-xs text-muted-foreground">数量<select :value="bulkDisplayCount" class="mt-1 block h-9 rounded-md border border-input bg-background px-3 text-sm" data-testid="ping-center-bulk-count" @change="setBulkDisplayCount"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option></select></label><label v-for="index in bulkDisplayCount" :key="index" class="min-w-44 flex-1 text-xs text-muted-foreground">Slot {{ index }}<select :value="bulkTaskIds[index - 1] ?? ''" class="mt-1 block h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" :data-testid="`ping-center-bulk-slot-${index}`" @change="setBulkTask(index - 1, $event)"><option value="">请选择共同任务</option><option v-for="task in strictBulkTasks" :key="task.id" :value="task.id" :disabled="bulkTaskIds.some((id, slot) => id === task.id && slot !== index - 1)">{{ taskOptionLabel(task) }}</option></select></label><div class="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" data-testid="ping-center-bulk-inherit" @click="applyBulkInherit">
                设为 inherit
              </Button><Button size="sm" variant="outline" data-testid="ping-center-bulk-clear" @click="clearBulkOverrides">
                清除覆盖
              </Button><Button size="sm" :disabled="!bulkPreview?.canApply" data-testid="ping-center-bulk-custom" @click="applyBulkCustom">
                套用 custom
              </Button>
            </div>
          </div>
          <div v-if="bulkPreview" class="mt-3 rounded-md border border-border/60 px-3 py-2 text-xs" data-testid="ping-center-bulk-preview">
            <div :class="bulkPreview.canApply ? 'text-emerald-500' : 'text-amber-500'">
              适用 {{ bulkPreview.eligibleNodeUuids.length }}/{{ bulkPreview.selectedNodeUuids.length }} · 跳过 {{ bulkPreview.excludedNodeUuids.length }} · 变更 {{ bulkPreview.changedNodeUuids.length }} · 不变 {{ bulkPreview.unchangedNodeUuids.length }}
            </div>
            <ul v-if="bulkFailureReasons.length" class="mt-1 list-disc space-y-1 pl-4 text-amber-500">
              <li v-for="reason in bulkFailureReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
        </div>

        <div v-if="filteredRows.length" class="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <article v-for="row in filteredRows" :key="row.client.uuid" class="rounded-lg border border-border/60 bg-background/55 p-4" :data-testid="`node-binding-row-${row.client.uuid}`">
            <div class="flex items-start gap-3">
              <input :checked="selectedNodeUuids.has(row.client.uuid)" type="checkbox" class="mt-1 size-4 accent-primary" :aria-label="`选择 ${row.client.name}`" @change="setSelected(row.client.uuid, ($event.target as HTMLInputElement).checked)"><div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="truncate font-medium">
                    {{ row.client.name }}
                  </h3><Badge variant="outline">
                    {{ row.mode }}
                  </Badge><Badge variant="outline" :class="coverageClass(row.coverage)">
                    {{ coverageLabel(row.coverage) }}
                  </Badge>
                </div><p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {{ row.client.uuid }}
                </p><p class="mt-1 text-xs text-muted-foreground">
                  {{ row.client.region || '未设置地区' }} · {{ row.client.group || '未设置分组' }} · 候选 {{ row.candidates.length }}
                </p>
              </div>
            </div>
            <div class="mt-3 rounded-md bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              <span v-if="row.resolution.resolvedTaskIds.length">有效：{{ row.resolution.tasks.map(task => task.name).join('、') }}</span><span v-else-if="row.resolution.useLegacyAggregate">旧版聚合显示</span><span v-else>没有有效显示任务</span><span v-if="row.resolution.deletedTaskIds.length" class="ml-2 text-destructive">已删除 {{ row.resolution.deletedTaskIds.join('、') }}</span><span v-if="row.resolution.unassignedTaskIds.length" class="ml-2 text-destructive">未分配 {{ row.resolution.unassignedTaskIds.join('、') }}</span>
            </div>
            <div class="mt-3 flex justify-end">
              <Button size="sm" variant="outline" @click="openNodeEditor(row)">
                <Icon icon="tabler:adjustments-horizontal" />单节点配置
              </Button>
            </div>
          </article>
        </div>
        <div v-else class="rounded-lg border border-border/60 bg-background/50">
          <Empty description="没有匹配的节点。" />
        </div>

        <div class="sticky bottom-3 z-5 mt-5 flex flex-col gap-2 rounded-lg border border-border/70 bg-card/90 p-3 shadow-lg backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div class="text-xs text-muted-foreground">
            <span v-if="draftDirty">待保存：{{ changedNodeCount }} 台节点{{ globalChanged ? ' + 全局设置' : '' }}</span><span v-else>当前没有未保存修改</span>
          </div><Button :disabled="!draftDirty || isSaving" data-testid="ping-center-save-preview" @click="openSavePreview">
            <Icon icon="tabler:device-floppy" />保存预览
          </Button>
        </div>
      </template>
    </div>

    <AppDialog :open="Boolean(activeRow)" :title="activeRow ? `${activeRow.client.name} · Ping 显示` : '单节点 Ping 显示'" description="inherit 使用全局默认；custom 仅能选择该任务 clients 中包含本节点 UUID 的任务。" content-class="max-w-3xl" @update:open="open => !open && closeNodeEditor()">
      <div v-if="activeRow" class="space-y-4" data-testid="ping-center-node-editor">
        <div class="break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground">
          {{ activeRow.client.uuid }}
        </div><div class="flex flex-wrap gap-2">
          <Button size="sm" :variant="activeMode === 'inherit' ? 'default' : 'outline'" data-testid="ping-center-node-mode-inherit" @click="setActiveMode('inherit')">
            inherit
          </Button><Button size="sm" :variant="activeMode === 'custom' ? 'default' : 'outline'" data-testid="ping-center-node-mode-custom" @click="setActiveMode('custom')">
            custom
          </Button><Button size="sm" variant="ghost" data-testid="ping-center-node-clear" @click="clearActiveOverride">
            清除覆盖
          </Button>
        </div>
        <template v-if="activeCustomConfig">
          <label class="block text-xs text-muted-foreground">显示数量<select :value="activeCustomConfig.displayCount" class="mt-1 h-9 rounded-md border border-input bg-background px-3 text-sm" data-testid="ping-center-node-count" @change="setActiveDisplayCount"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option></select></label><label v-for="index in activeCustomConfig.displayCount" :key="index" class="block text-xs text-muted-foreground">Slot {{ index }}<select :value="activeCustomConfig.taskIds[index - 1] ?? ''" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" :data-testid="`ping-center-node-slot-${index}`" @change="setActiveTask(index - 1, $event)"><option value="">请选择任务</option><option v-for="task in activeRow.candidates" :key="task.id" :value="task.id" :disabled="activeCustomConfig.taskIds.some((id, slot) => id === task.id && slot !== index - 1)">{{ taskOptionLabel(task) }}</option></select></label><div v-if="activeRow.coverage !== 'full'" class="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-500" data-testid="ping-center-node-invalid-reason">
            <div v-if="activeCustomConfig.taskIds.length < activeCustomConfig.displayCount">
              尚缺 {{ activeCustomConfig.displayCount - activeCustomConfig.taskIds.length }} 个任务。
            </div><div v-if="activeRow.resolution.deletedTaskIds.length">
              任务已删除：{{ activeRow.resolution.deletedTaskIds.join('、') }}
            </div><div v-if="activeRow.resolution.unassignedTaskIds.length">
              任务已不再分配给本节点：{{ activeRow.resolution.unassignedTaskIds.join('、') }}
            </div>
          </div>
        </template>
        <div class="flex justify-end">
          <Button variant="outline" @click="closeNodeEditor">
            完成
          </Button>
        </div>
      </div>
    </AppDialog>

    <AppDialog :open="savePreviewOpen" title="保存 Ping 显示配置" description="保存前再次核对变更与覆盖状态；提交时会重新读取最新主题设置并合并。" content-class="max-w-3xl" @update:open="savePreviewOpen = $event">
      <div class="space-y-4" data-testid="ping-center-save-dialog">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div class="rounded-md bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">
              节点变更
            </div><div class="mt-1 text-xl font-semibold">
              {{ changedNodeCount }}
            </div>
          </div><div class="rounded-md bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">
              完整
            </div><div class="mt-1 text-xl font-semibold text-emerald-500">
              {{ coverageCounts.full }}
            </div>
          </div><div class="rounded-md bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">
              部分
            </div><div class="mt-1 text-xl font-semibold text-amber-500">
              {{ coverageCounts.partial }}
            </div>
          </div><div class="rounded-md bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">
              无效
            </div><div class="mt-1 text-xl font-semibold text-destructive">
              {{ coverageCounts.invalid }}
            </div>
          </div>
        </div>
        <div class="rounded-md border border-border/60 p-3 text-sm">
          <div class="font-medium">
            全局：{{ draftConfig?.global.displayCount }} 个显示位
          </div><div class="mt-1 text-xs text-muted-foreground">
            {{ draftConfig?.global.taskIds.length ? draftConfig.global.taskIds.map(id => adminTasks.find(task => task.id === id)?.name || `任务 ${id}`).join('、') : '旧版全部任务聚合' }}
          </div>
        </div><div v-if="validationIssues.length" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="ping-center-save-blockers">
          <div class="font-medium">
            需要先修正：
          </div><ul class="mt-2 list-disc space-y-1 pl-5">
            <li v-for="issue in validationIssues" :key="issue">
              {{ issue }}
            </li>
          </ul>
        </div><p v-if="saveError" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {{ saveError }}
        </p><div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="isSaving" @click="savePreviewOpen = false">
            取消
          </Button><Button :disabled="validationIssues.length > 0 || isSaving || !appStore.isLoggedIn" data-testid="ping-center-save-confirm" @click="saveConfig">
            <Icon :icon="isSaving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="isSaving && 'animate-spin'" />确认保存
          </Button>
        </div>
      </div>
    </AppDialog>
  </section>
</template>
