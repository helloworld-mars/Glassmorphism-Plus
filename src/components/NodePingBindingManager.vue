<script setup lang="ts">
import type { RouteLocationNormalized } from 'vue-router'
import type {
  AdminPingClient,
  AdminPingTask,
  NodeCardPingDisplayConfigAdminData,
} from '@/services/node-card-ping-binding.service'
import type {
  NodeCardPingConfig,
  NodeCardPingConfigInspection,
  NodeCardPingCoverage,
  NodeCardPingNodeConfig,
  NodeCardPingRuntimeConfig,
  NodeCardPingTaskSlots,
} from '@/utils/nodeCardPingConfig'
import type { PingTaskInfo } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { AppDialog } from '@/components/ui/app-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { loadPublicPingTasks } from '@/services/metrics.service'
import {
  invalidateNodeCardPingBindingAdminSession,
  loadNodeCardPingDisplayConfigAdminData,
  NodeCardPingBindingApiError,
  saveNodeCardPingDisplayConfigV3,
} from '@/services/node-card-ping-binding.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import {
  getNodeCardMultiPingTaskCandidates,
  getStrictNodeCardMultiPingTaskIntersection,
} from '@/utils/nodeCardMultiPingConfig'
import {
  cloneNodeCardPingTaskSlots,
  getActiveNodeCardPingTaskIds,
  getNodeCardPingDisplayCount,
  inspectNodeCardPingConfig,
  previewStrictNodeCardPingBulkAssignment,
  resolveNodeCardPingDisplay,
} from '@/utils/nodeCardPingConfig'

type CenterTab = 'overview' | 'config'
type PublicState = 'loading' | 'ready' | 'error'
type AdminState = 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'error'
type MainFilter = 'all' | 'inherit' | 'custom' | 'action'

interface ConfigRow {
  client: AdminPingClient
  candidates: AdminPingTask[]
  mode: 'inherit' | 'custom'
  coverage: NodeCardPingCoverage
  resolution: ReturnType<typeof resolveNodeCardPingDisplay<AdminPingTask>>
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
const loadedRuntime = ref<NodeCardPingRuntimeConfig | null>(null)
const loadedInspection = ref<NodeCardPingConfigInspection | null>(null)
const draftConfig = ref<NodeCardPingConfig | null>(null)
const originalConfig = ref<NodeCardPingConfig | null>(null)
const searchText = ref('')
const mainFilter = ref<MainFilter>('all')
const coverageFilter = ref<NodeCardPingCoverage | null>(null)
const selectedNodeUuids = ref<Set<string>>(new Set())
const bulkTaskIds = ref<NodeCardPingTaskSlots>([null, null, null])
const activeClientUuid = ref('')
const activeEditorConfig = ref<NodeCardPingNodeConfig | null>(null)
const isSaving = ref(false)
const saveError = ref('')
const savePreviewOpen = ref(false)
const leaveConfirmOpen = ref(false)
let adminRequestGeneration = 0
let allowNextNavigation = false
let pendingNavigation: (() => void) | null = null

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

const draftRuntime = computed<NodeCardPingRuntimeConfig | null>(() => {
  if (!draftConfig.value || !loadedRuntime.value)
    return null
  return {
    ...loadedRuntime.value,
    config: draftConfig.value,
    source: 'v3',
    migrationNeeded: false,
  }
})
const displayCount = computed(() => draftConfig.value ? getNodeCardPingDisplayCount(draftConfig.value) : 1)
const threeNetworkEnabled = computed(() => displayCount.value === 3)

const rows = computed<ConfigRow[]>(() => {
  if (!draftRuntime.value || !draftConfig.value)
    return []
  return clients.value.map((client) => {
    const nodeConfig = draftConfig.value?.nodes[client.uuid]
    const resolution = resolveNodeCardPingDisplay(draftRuntime.value!, client.uuid, adminTasks.value)
    return {
      client,
      candidates: getNodeCardMultiPingTaskCandidates(adminTasks.value, client.uuid),
      mode: nodeConfig?.mode === 'custom' ? 'custom' : 'inherit',
      coverage: resolution.coverage,
      resolution,
    }
  })
})

const coverageCounts = computed<Record<NodeCardPingCoverage, number>>(() => {
  const counts: Record<NodeCardPingCoverage, number> = { full: 0, partial: 0, none: 0, invalid: 0 }
  for (const row of rows.value)
    counts[row.coverage]++
  return counts
})
const actionCount = computed(() => coverageCounts.value.partial + coverageCounts.value.none + coverageCounts.value.invalid)
const filteredRows = computed(() => {
  const keyword = searchText.value.trim().toLocaleLowerCase()
  return rows.value.filter((row) => {
    if (mainFilter.value === 'inherit' && row.mode !== 'inherit')
      return false
    if (mainFilter.value === 'custom' && row.mode !== 'custom')
      return false
    if (mainFilter.value === 'action' && row.coverage === 'full')
      return false
    if (coverageFilter.value && row.coverage !== coverageFilter.value)
      return false
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
  return previewStrictNodeCardPingBulkAssignment(
    draftConfig.value,
    selectedRows.value.map(row => row.client.uuid),
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
    reasons.push(`需要选择 ${displayCount.value} 个不重复的探测任务。`)
  if (preview.invalidTaskIds.length)
    reasons.push(`以下任务不属于全部所选节点的共同候选：${preview.invalidTaskIds.join('、')}。`)
  if (preview.invalidNodeUuids.length)
    reasons.push(`节点标识格式无效：${preview.invalidNodeUuids.join('、')}。`)
  if (preview.excludedNodeUuids.length) {
    const labels = preview.excludedNodeUuids.map(uuid => clients.value.find(client => client.uuid === uuid)?.name || uuid)
    reasons.push(`不兼容节点：${labels.join('、')}。`)
  }
  return reasons
})

const activeRow = computed(() => rows.value.find(row => row.client.uuid === activeClientUuid.value) ?? null)
const activeMode = computed<'inherit' | 'custom'>(() => activeEditorConfig.value?.mode === 'custom' ? 'custom' : 'inherit')
const activeCustomConfig = computed(() => activeEditorConfig.value?.mode === 'custom' ? activeEditorConfig.value : null)
const activeEditorIssues = computed(() => {
  if (!activeRow.value || !activeCustomConfig.value)
    return []
  const activeIds = getActiveNodeCardPingTaskIds(activeCustomConfig.value.taskIds, displayCount.value)
  const candidateIds = new Set(activeRow.value.candidates.map(task => task.id))
  const issues: string[] = []
  if (activeIds.length !== displayCount.value)
    issues.push(`需要选择 ${displayCount.value} 个不重复的探测任务。`)
  const incompatible = activeIds.filter(taskId => !candidateIds.has(taskId))
  if (incompatible.length)
    issues.push(`任务 ${incompatible.join('、')} 已删除或未分配给此节点。`)
  return issues
})

const orphanNodeUuids = computed(() => {
  if (!draftConfig.value)
    return []
  const knownNodeUuids = new Set(clients.value.map(client => client.uuid))
  return Object.keys(draftConfig.value.nodes).filter(uuid => !knownNodeUuids.has(uuid))
})
const validationIssues = computed(() => {
  const draft = draftConfig.value
  if (!draft)
    return ['配置尚未加载。']

  const issues: string[] = []
  const activeGlobalIds = getActiveNodeCardPingTaskIds(draft.global.taskIds, displayCount.value)
  const knownTaskIds = new Set(adminTasks.value.map(task => task.id))
  if (activeGlobalIds.length !== displayCount.value)
    issues.push(`全局配置需要选择 ${displayCount.value} 个不重复的探测任务。`)
  for (const taskId of draft.global.taskIds.filter(taskId => taskId !== null)) {
    if (!knownTaskIds.has(taskId))
      issues.push(`全局探测任务 ${taskId} 已删除。`)
  }
  for (const nodeUuid of orphanNodeUuids.value)
    issues.push(`配置中的节点 ${nodeUuid} 已不存在，请先移除该覆盖。`)
  for (const row of rows.value) {
    const nodeConfig = draft.nodes[row.client.uuid]
    if (nodeConfig?.mode !== 'custom')
      continue
    const activeIds = getActiveNodeCardPingTaskIds(nodeConfig.taskIds, displayCount.value)
    if (activeIds.length !== displayCount.value)
      issues.push(`${row.client.name} 需要选择 ${displayCount.value} 个不重复的探测任务。`)
    if (row.resolution.deletedTaskIds.length)
      issues.push(`${row.client.name} 包含已删除任务：${row.resolution.deletedTaskIds.join('、')}。`)
    if (row.resolution.unassignedTaskIds.length)
      issues.push(`${row.client.name} 包含未分配给该节点的任务：${row.resolution.unassignedTaskIds.join('、')}。`)
    const hiddenDeleted = nodeConfig.taskIds
      .slice(displayCount.value)
      .filter((taskId): taskId is number => taskId !== null && !knownTaskIds.has(taskId))
    if (hiddenDeleted.length)
      issues.push(`${row.client.name} 保留的隐藏任务已删除：${hiddenDeleted.join('、')}。`)
  }
  const inspection = inspectNodeCardPingConfig(draft)
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
const draftDirty = computed(() => Boolean(
  draftConfig.value
  && originalConfig.value
  && JSON.stringify(draftConfig.value) !== JSON.stringify(originalConfig.value),
))
const migrationPending = computed(() => Boolean(loadedRuntime.value?.migrationNeeded))
const hasPendingWrite = computed(() => draftDirty.value || migrationPending.value)

function cloneConfig(config: NodeCardPingConfig): NodeCardPingConfig {
  return {
    schemaVersion: 3,
    global: {
      threeNetworkEnabled: config.global.threeNetworkEnabled,
      taskIds: cloneNodeCardPingTaskSlots(config.global.taskIds),
    },
    nodes: Object.fromEntries(Object.entries(config.nodes).map(([uuid, nodeConfig]) => [
      uuid,
      nodeConfig.mode === 'custom'
        ? { mode: 'custom', taskIds: cloneNodeCardPingTaskSlots(nodeConfig.taskIds) }
        : { mode: 'inherit' },
    ])),
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function navigateAfterConfirmation(callback: () => void): void {
  if (draftDirty.value) {
    pendingNavigation = callback
    leaveConfirmOpen.value = true
    return
  }
  allowNextNavigation = true
  callback()
}

function closeCenter(): void {
  navigateAfterConfirmation(() => {
    const query = { ...route.query }
    delete query.view
    delete query.pingtab
    void router.replace({ name: 'home', query })
  })
}

function switchTab(tab: CenterTab): void {
  if (tab === activeTab.value)
    return
  navigateAfterConfirmation(() => {
    const query = {
      ...route.query,
      view: 'pingsettings',
      pingtab: tab === 'overview' ? 'overview' : undefined,
    }
    void router.replace({ name: 'home', query })
  })
}

function routeGuard(to: RouteLocationNormalized): boolean {
  if (allowNextNavigation) {
    allowNextNavigation = false
    return true
  }
  if (!draftDirty.value)
    return true
  pendingNavigation = () => {
    allowNextNavigation = true
    void router.replace(to.fullPath)
  }
  leaveConfirmOpen.value = true
  return false
}

function cancelPendingNavigation(): void {
  pendingNavigation = null
  leaveConfirmOpen.value = false
}

function confirmPendingNavigation(): void {
  const callback = pendingNavigation
  pendingNavigation = null
  leaveConfirmOpen.value = false
  if (originalConfig.value)
    draftConfig.value = cloneConfig(originalConfig.value)
  callback?.()
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!draftDirty.value)
    return
  event.preventDefault()
  event.returnValue = ''
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
  activeEditorConfig.value = null
  savePreviewOpen.value = false
  leaveConfirmOpen.value = false
  pendingNavigation = null
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

function applyAdminData(data: NodeCardPingDisplayConfigAdminData): void {
  theme.value = data.theme
  adminTasks.value = data.tasks
  clients.value = data.clients
  loadedRuntime.value = data.runtimeConfig
  loadedInspection.value = data.configInspection
  draftConfig.value = cloneConfig(data.runtimeConfig.config)
  originalConfig.value = cloneConfig(data.runtimeConfig.config)
  selectedNodeUuids.value = new Set()
  bulkTaskIds.value = cloneNodeCardPingTaskSlots(data.runtimeConfig.config.global.taskIds)
  saveError.value = ''
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
    const data = await loadNodeCardPingDisplayConfigAdminData()
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
  saveError.value = ''
}

function readTaskId(event: Event): number | null {
  const value = Number((event.target as HTMLSelectElement).value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function replaceTaskSlot(taskIds: NodeCardPingTaskSlots, index: number, taskId: number | null): NodeCardPingTaskSlots {
  const next = cloneNodeCardPingTaskSlots(taskIds)
  next[index] = taskId
  return next
}

function setThreeNetworkEnabled(enabled: boolean): void {
  if (!draftConfig.value || draftConfig.value.global.threeNetworkEnabled === enabled)
    return
  draftConfig.value.global.threeNetworkEnabled = enabled
  markDraftChanged()
}

function setGlobalTask(index: number, event: Event): void {
  if (!draftConfig.value)
    return
  draftConfig.value.global.taskIds = replaceTaskSlot(draftConfig.value.global.taskIds, index, readTaskId(event))
  markDraftChanged()
}

function setMainFilter(filter: MainFilter): void {
  mainFilter.value = filter
  coverageFilter.value = null
}

function setCoverageFilter(coverage: NodeCardPingCoverage): void {
  coverageFilter.value = coverageFilter.value === coverage ? null : coverage
  if (coverageFilter.value)
    mainFilter.value = 'all'
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

function cancelBulkSelection(): void {
  selectedNodeUuids.value = new Set()
}

function setBulkTask(index: number, event: Event): void {
  bulkTaskIds.value = replaceTaskSlot(bulkTaskIds.value, index, readTaskId(event))
}

function applyBulkInherit(): void {
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
    const existing = draftConfig.value.nodes[uuid]
    const preserved = existing?.mode === 'custom'
      ? cloneNodeCardPingTaskSlots(existing.taskIds)
      : cloneNodeCardPingTaskSlots(draftConfig.value.global.taskIds)
    for (let index = 0; index < displayCount.value; index++)
      preserved[index] = bulkTaskIds.value[index] ?? null
    draftConfig.value.nodes[uuid] = { mode: 'custom', taskIds: preserved }
  }
  markDraftChanged()
}

function openNodeEditor(row: ConfigRow): void {
  activeClientUuid.value = row.client.uuid
  const stored = draftConfig.value?.nodes[row.client.uuid]
  activeEditorConfig.value = stored?.mode === 'custom'
    ? { mode: 'custom', taskIds: cloneNodeCardPingTaskSlots(stored.taskIds) }
    : { mode: 'inherit' }
}

function closeNodeEditor(): void {
  activeClientUuid.value = ''
  activeEditorConfig.value = null
}

function setActiveMode(mode: 'inherit' | 'custom'): void {
  if (!activeRow.value || !draftConfig.value)
    return
  if (mode === 'inherit') {
    activeEditorConfig.value = { mode: 'inherit' }
    return
  }
  if (activeEditorConfig.value?.mode === 'custom')
    return
  activeEditorConfig.value = {
    mode: 'custom',
    taskIds: cloneNodeCardPingTaskSlots(activeRow.value.resolution.configuredTaskSlots),
  }
}

function setActiveTask(index: number, event: Event): void {
  if (!activeCustomConfig.value)
    return
  activeCustomConfig.value.taskIds = replaceTaskSlot(activeCustomConfig.value.taskIds, index, readTaskId(event))
}

function completeNodeEditor(): void {
  if (!draftConfig.value || !activeRow.value || !activeEditorConfig.value || activeEditorIssues.value.length)
    return
  const uuid = activeRow.value.client.uuid
  const previous = draftConfig.value.nodes[uuid]
  if (activeEditorConfig.value.mode === 'inherit')
    delete draftConfig.value.nodes[uuid]
  else
    draftConfig.value.nodes[uuid] = { mode: 'custom', taskIds: cloneNodeCardPingTaskSlots(activeEditorConfig.value.taskIds) }
  if (JSON.stringify(previous) !== JSON.stringify(draftConfig.value.nodes[uuid]))
    markDraftChanged()
  closeNodeEditor()
}

function clearOrphanOverrides(): void {
  if (!draftConfig.value || !orphanNodeUuids.value.length)
    return
  for (const nodeUuid of orphanNodeUuids.value)
    delete draftConfig.value.nodes[nodeUuid]
  markDraftChanged()
}

function discardDraft(): void {
  if (!originalConfig.value)
    return
  draftConfig.value = cloneConfig(originalConfig.value)
  selectedNodeUuids.value = new Set()
  bulkTaskIds.value = cloneNodeCardPingTaskSlots(originalConfig.value.global.taskIds)
  saveError.value = ''
  savePreviewOpen.value = false
  window.$message?.success('未保存修改已放弃。')
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
    const result = await saveNodeCardPingDisplayConfigV3({ theme: theme.value, config: draftConfig.value })
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

function modeLabel(mode: ConfigRow['mode']): string {
  return mode === 'custom' ? '单独配置' : '继承全局'
}

function coverageLabel(coverage: NodeCardPingCoverage): string {
  return { full: '完整覆盖', partial: '部分覆盖', none: '未覆盖', invalid: '配置失效' }[coverage]
}

function coverageClass(coverage: NodeCardPingCoverage): string {
  return { full: 'text-emerald-500', partial: 'text-amber-500', none: 'text-muted-foreground', invalid: 'text-destructive' }[coverage]
}

function taskOptionLabel(task: AdminPingTask): string {
  const knownNodeUuids = new Set(clients.value.map(client => client.uuid))
  const coverage = new Set(task.clients.filter(uuid => knownNodeUuids.has(uuid))).size
  const interval = task.interval === null ? '间隔未知' : `${task.interval} 秒`
  return `${task.name} · ID ${task.id} · ${task.type} · ${interval} · ${task.target} · 覆盖 ${coverage}`
}

function displayTaskNames(row: ConfigRow): string {
  if (row.resolution.useLegacyAggregate)
    return '旧版全部任务汇总'
  const names = row.resolution.tasks.map(task => task.name)
  return names.length ? names.join('、') : '暂无有效探测任务'
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

onBeforeRouteLeave(routeGuard)
onBeforeRouteUpdate(routeGuard)
onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  void loadOverview()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <section class="ping-center px-4 py-6 sm:px-6 sm:py-8" data-testid="ping-center" data-legacy-testid="node-ping-binding-manager">
    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div class="flex items-center gap-2">
          <Icon icon="tabler:activity-heartbeat" class="shrink-0 text-selection" width="24" height="24" />
          <h1 class="text-2xl font-bold tracking-tight">
            延迟监测中心
          </h1>
        </div>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          查看公开 Ping 任务与节点覆盖；管理员可配置首页卡片显示单项任务或三项三网任务。
        </p>
      </div>
      <Button variant="outline" size="sm" data-testid="ping-center-close" @click="closeCenter">
        <Icon icon="tabler:arrow-left" />返回首页
      </Button>
    </div>

    <div class="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-border/60 bg-background/55 p-1 backdrop-blur-sm" data-testid="ping-center-tabs">
      <button type="button" class="rounded-md px-3 py-1.5 text-sm transition-colors" :class="activeTab === 'overview' ? 'bg-background text-selection shadow-sm' : 'text-muted-foreground hover:text-foreground'" data-testid="ping-center-tab-overview" @click="switchTab('overview')">
        延迟任务概览
      </button>
      <button v-if="appStore.isLoggedIn || activeTab === 'config'" type="button" class="rounded-md px-3 py-1.5 text-sm transition-colors" :class="activeTab === 'config' ? 'bg-background text-selection shadow-sm' : 'text-muted-foreground hover:text-foreground'" data-testid="ping-center-tab-settings" @click="switchTab('config')">
        延迟任务配置
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
        <article v-for="row in publicTaskRows" :key="row.task.id" class="flex h-full flex-col rounded-lg border border-border/60 bg-background/55 p-4 shadow-xs backdrop-blur-sm" :data-testid="`ping-center-public-task-${row.task.id}`">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate font-medium">
                {{ row.task.name }}
              </h2><p class="mt-1 text-xs text-muted-foreground">
                ID {{ row.task.id }} · {{ row.task.type || 'Ping' }} · {{ row.task.interval }} 秒
              </p>
            </div><Badge variant="outline">
              {{ row.assignedNodes.length }} 台
            </Badge>
          </div>
          <div class="mt-4 rounded-md border border-border/45 bg-muted/25 p-3" :data-testid="`ping-center-covered-nodes-${row.task.id}`">
            <div class="mb-2 flex items-center justify-between gap-3 text-xs">
              <span class="flex items-center gap-1.5 font-medium text-foreground">
                <Icon icon="tabler:server-2" class="shrink-0 text-selection" width="14" height="14" />
                覆盖节点
              </span>
              <span class="shrink-0 text-muted-foreground">共 {{ row.assignedNodes.length }} 台</span>
            </div>
            <ul v-if="row.assignedNodes.length" class="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto pr-1" :aria-label="`${row.task.name} 覆盖节点`">
              <li v-for="node in row.assignedNodes" :key="node.uuid" class="min-w-0 max-w-full">
                <Badge variant="secondary" class="max-w-full bg-background/70 text-foreground shadow-none" :data-testid="`ping-center-covered-node-${row.task.id}`">
                  <span class="truncate" :title="node.name">{{ node.name }}</span>
                </Badge>
              </li>
            </ul>
            <p v-else class="text-xs leading-5 text-muted-foreground">
              当前公开节点中暂无覆盖。
            </p>
          </div>
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
        <Empty description="此配置仅允许已登录管理员读取和保存。访客不会触发任何管理接口。">
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
        <div class="mb-4 grid gap-3 rounded-lg border border-border/60 bg-background/55 p-3 sm:grid-cols-3" data-testid="ping-center-current-state">
          <div>
            <div class="text-xs text-muted-foreground">
              当前模式
            </div><div class="mt-1 font-medium">
              {{ threeNetworkEnabled ? '三网监控' : '单项监控' }}
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">
              节点覆盖
            </div><div class="mt-1 font-medium">
              {{ coverageCounts.full }}/{{ rows.length }} 完整
            </div>
          </div>
          <div>
            <div class="text-xs text-muted-foreground">
              保存状态
            </div><div class="mt-1 font-medium" :class="draftDirty ? 'text-amber-500' : migrationPending ? 'text-sky-500' : 'text-emerald-500'">
              {{ draftDirty ? '有未保存修改' : migrationPending ? '等待写入新版配置' : '已保存' }}
            </div>
          </div>
        </div>

        <div v-if="loadedInspection?.status === 'damaged'" class="mb-4 flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="ping-center-damaged-config">
          <div>
            <div class="font-medium text-destructive">
              已保存的新版 Ping 配置损坏
            </div><p class="mt-1 text-xs leading-5 text-muted-foreground">
              {{ loadedInspection.reason || '配置无法安全解析。' }} 当前仅使用可验证的旧配置，不读取损坏字段。
            </p>
          </div><Button size="sm" variant="outline" @click="openSavePreview">
            检查并修复
          </Button>
        </div>
        <div v-else-if="migrationPending" class="mb-4 flex flex-col gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="ping-center-legacy-migration">
          <p class="text-xs leading-5 text-muted-foreground">
            已无损载入旧版 Ping 配置。旧任务编号和旧配置键会完整保留；确认保存后仅新增新版配置。
          </p><Button size="sm" variant="outline" @click="openSavePreview">
            检查迁移结果
          </Button>
        </div>
        <div v-if="orphanNodeUuids.length" class="mb-4 flex flex-col gap-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="ping-center-orphan-config">
          <div class="min-w-0">
            <div class="font-medium text-amber-600 dark:text-amber-400">
              {{ orphanNodeUuids.length }} 个节点覆盖已失效
            </div><p class="mt-1 break-all text-xs leading-5 text-muted-foreground">
              {{ orphanNodeUuids.join('、') }}
            </p>
          </div><Button size="sm" variant="outline" @click="clearOrphanOverrides">
            移除失效覆盖
          </Button>
        </div>

        <div class="mb-4 rounded-lg border border-border/60 bg-background/55 p-4" data-testid="ping-center-global-config">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <h2 class="font-semibold">
                全局默认显示
              </h2><p class="mt-1 text-xs leading-5 text-muted-foreground">
                未单独配置的节点继承这里；关闭三网只隐藏任务 2、3，不会删除其编号。
              </p>
            </div>
            <div class="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 sm:justify-end" data-testid="ping-center-three-network-control">
              <div class="text-right">
                <label for="ping-center-three-network-switch" class="block cursor-pointer text-sm font-medium" data-testid="ping-center-three-network-label">三网监控</label>
                <span class="block text-xs text-muted-foreground" data-testid="ping-center-three-network-state">{{ draftConfig.global.threeNetworkEnabled ? '已开启' : '已关闭' }}</span>
              </div>
              <Switch id="ping-center-three-network-switch" :model-value="draftConfig.global.threeNetworkEnabled" aria-label="三网监控" data-testid="ping-center-three-network-switch" @update:model-value="setThreeNetworkEnabled" />
            </div>
          </div>
          <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label v-for="index in displayCount" :key="index" class="min-w-0 text-xs text-muted-foreground">探测任务 {{ index }}<select :value="draftConfig.global.taskIds[index - 1] ?? ''" class="mt-1 block h-10 w-full truncate rounded-md border border-input bg-background px-3 text-sm text-foreground" :data-testid="`ping-center-global-slot-${index}`" @change="setGlobalTask(index - 1, $event)"><option value="">请选择探测任务</option><option v-for="task in adminTasks" :key="task.id" :value="task.id" :disabled="draftConfig.global.taskIds.some((id, slot) => id === task.id && slot !== index - 1)">{{ taskOptionLabel(task) }}</option></select></label>
          </div>
          <div class="mt-4 flex flex-wrap gap-2 text-xs" aria-label="按覆盖状态筛选">
            <button v-for="coverage in (['full', 'partial', 'none', 'invalid'] as const)" :key="coverage" type="button" class="rounded-full border border-border/70 px-2.5 py-1 transition-colors" :class="[coverageClass(coverage), coverageFilter === coverage && 'bg-selection/15 ring-1 ring-selection']" :aria-pressed="coverageFilter === coverage" :data-testid="`ping-center-coverage-${coverage}`" @click="setCoverageFilter(coverage)">
              {{ coverageLabel(coverage) }} {{ coverageCounts[coverage] }}
            </button>
          </div>
        </div>

        <div class="mb-4 rounded-lg border border-border/60 bg-background/55 p-3">
          <div class="grid gap-2 xl:grid-cols-[minmax(15rem,1fr)_auto_auto] xl:items-center">
            <div class="relative min-w-0">
              <Icon icon="tabler:search" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" width="16" /><Input v-model="searchText" class="pl-9" placeholder="搜索名称 / 节点标识 / 地区 / 分组" data-testid="ping-center-settings-search" />
            </div>
            <div class="flex max-w-full gap-1 overflow-x-auto rounded-md border border-border/60 p-1" data-testid="ping-center-settings-filter">
              <button v-for="filter in ([['all', '全部', rows.length], ['inherit', '继承全局', rows.filter(row => row.mode === 'inherit').length], ['custom', '单独配置', rows.filter(row => row.mode === 'custom').length], ['action', '需要处理', actionCount]] as const)" :key="filter[0]" type="button" class="whitespace-nowrap rounded px-2.5 py-1 text-sm" :class="mainFilter === filter[0] && !coverageFilter ? 'bg-selection/15 text-selection' : 'text-muted-foreground hover:text-foreground'" :aria-pressed="mainFilter === filter[0] && !coverageFilter" :data-filter="filter[0]" @click="setMainFilter(filter[0])">
                {{ filter[1] }} {{ filter[2] }}
              </button>
            </div>
            <Button size="sm" variant="outline" data-testid="ping-center-filter-select-all" @click="toggleFilteredSelection">
              <Icon :icon="allFilteredSelected ? 'tabler:square-minus' : 'tabler:checks'" />{{ allFilteredSelected ? '取消当前结果' : '全选当前结果' }}
            </Button>
          </div>
          <div class="mt-2 text-xs text-muted-foreground">
            {{ filteredRows.length }} 条结果 · 已选 {{ selectedRows.length }} 台<span v-if="coverageFilter"> · 精确状态：{{ coverageLabel(coverageFilter) }}</span>
          </div>
        </div>

        <div v-if="selectedRows.length" class="sticky top-2 z-10 mb-4 rounded-lg border border-selection/30 bg-card/95 p-3 shadow-lg backdrop-blur-xl" data-testid="ping-center-bulk-panel">
          <div class="flex flex-wrap items-center gap-2">
            <div class="mr-auto">
              <div class="text-sm font-medium">
                已选 {{ selectedRows.length }} 台 · 共同候选 {{ strictBulkTasks.length }} 个
              </div><div class="mt-0.5 text-xs text-muted-foreground">
                任一节点不兼容时，单独配置不会部分套用。
              </div>
            </div><Button size="sm" variant="outline" data-testid="ping-center-bulk-inherit" @click="applyBulkInherit">
              批量继承全局
            </Button><Button size="sm" variant="ghost" data-testid="ping-center-bulk-cancel" @click="cancelBulkSelection">
              取消选择
            </Button>
          </div>
          <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_auto] xl:items-end">
            <label v-for="index in displayCount" :key="index" class="min-w-0 text-xs text-muted-foreground">探测任务 {{ index }}<select :value="bulkTaskIds[index - 1] ?? ''" class="mt-1 block h-9 w-full truncate rounded-md border border-input bg-background px-3 text-sm text-foreground" :data-testid="`ping-center-bulk-slot-${index}`" @change="setBulkTask(index - 1, $event)"><option value="">请选择共同任务</option><option v-for="task in strictBulkTasks" :key="task.id" :value="task.id" :disabled="bulkTaskIds.some((id, slot) => id === task.id && slot !== index - 1)">{{ taskOptionLabel(task) }}</option></select></label><Button size="sm" :disabled="!bulkPreview?.canApply" data-testid="ping-center-bulk-custom" @click="applyBulkCustom">
              批量单独配置
            </Button>
          </div>
          <div v-if="bulkPreview" class="mt-3 rounded-md border border-border/60 px-3 py-2 text-xs" data-testid="ping-center-bulk-preview">
            <div :class="bulkPreview.canApply ? 'text-emerald-500' : 'text-amber-500'">
              预览：适用 {{ bulkPreview.eligibleNodeUuids.length }}/{{ bulkPreview.selectedNodeUuids.length }} · 不兼容 {{ bulkPreview.excludedNodeUuids.length }} · 将变更 {{ bulkPreview.changedNodeUuids.length }} · 保持不变 {{ bulkPreview.unchangedNodeUuids.length }}
            </div><ul v-if="bulkFailureReasons.length" class="mt-1 list-disc space-y-1 pl-4 text-amber-500">
              <li v-for="reason in bulkFailureReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
        </div>

        <div v-if="filteredRows.length" class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <article v-for="row in filteredRows" :key="row.client.uuid" class="rounded-lg border border-border/60 bg-background/55 p-3" :data-testid="`node-binding-row-${row.client.uuid}`">
            <div class="flex items-start gap-3">
              <input :checked="selectedNodeUuids.has(row.client.uuid)" type="checkbox" class="mt-1 size-4 accent-primary" :aria-label="`选择 ${row.client.name}`" @change="setSelected(row.client.uuid, ($event.target as HTMLInputElement).checked)"><div class="min-w-0 flex-1">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <h3 class="min-w-0 flex-1 truncate font-medium" :title="row.client.name">
                    {{ row.client.name }}
                  </h3><Badge variant="outline">
                    {{ modeLabel(row.mode) }}
                  </Badge><Badge variant="outline" :class="coverageClass(row.coverage)">
                    {{ coverageLabel(row.coverage) }}
                  </Badge>
                </div><p class="mt-1 truncate text-xs text-muted-foreground" :title="`${row.client.uuid} · ${row.client.region || '未设置地区'} · ${row.client.group || '未设置分组'}`">
                  {{ row.client.region || '未设置地区' }} · {{ row.client.group || '未设置分组' }} · 候选 {{ row.candidates.length }}
                </p><p class="mt-2 truncate rounded-md bg-muted/35 px-2.5 py-1.5 text-xs text-muted-foreground" :title="displayTaskNames(row)">
                  {{ displayTaskNames(row) }}
                </p>
              </div>
            </div>
            <div class="mt-2 flex justify-end">
              <Button size="sm" variant="outline" @click="openNodeEditor(row)">
                <Icon icon="tabler:adjustments-horizontal" />单节点配置
              </Button>
            </div>
          </article>
        </div>
        <div v-else class="rounded-lg border border-border/60 bg-background/50">
          <Empty description="没有匹配的节点。" />
        </div>

        <div class="sticky bottom-3 z-10 mt-5 flex flex-col gap-2 rounded-lg border border-border/70 bg-card/95 p-3 shadow-lg backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
          <div class="text-xs text-muted-foreground">
            <span v-if="draftDirty">待保存：{{ changedNodeCount }} 台节点{{ globalChanged ? ' + 全局设置' : '' }}</span><span v-else-if="migrationPending">旧配置已安全载入，等待写入新版配置</span><span v-else>当前没有未保存修改</span>
          </div><div class="flex gap-2">
            <Button v-if="draftDirty" size="sm" variant="outline" data-testid="ping-center-discard" @click="discardDraft">
              放弃修改
            </Button><Button :disabled="!hasPendingWrite || isSaving" data-testid="ping-center-save-preview" @click="openSavePreview">
              <Icon icon="tabler:device-floppy" />保存预览
            </Button>
          </div>
        </div>
      </template>
    </div>

    <AppDialog :open="Boolean(activeRow)" :title="activeRow ? `${activeRow.client.name} · Ping 显示` : '单节点 Ping 显示'" :description="`任务数量由全局${threeNetworkEnabled ? '三网监控' : '单项监控'}模式决定；单独配置只能选择已分配给此节点的任务。`" content-class="max-w-4xl" @update:open="open => !open && closeNodeEditor()">
      <div v-if="activeRow && activeEditorConfig" class="space-y-4" data-testid="ping-center-node-editor">
        <div class="truncate rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground" :title="activeRow.client.uuid">
          {{ activeRow.client.uuid }}
        </div>
        <div class="inline-flex max-w-full gap-1 rounded-lg border border-border/60 p-1">
          <Button size="sm" :variant="activeMode === 'inherit' ? 'default' : 'ghost'" data-testid="ping-center-node-mode-inherit" @click="setActiveMode('inherit')">
            继承全局
          </Button><Button size="sm" :variant="activeMode === 'custom' ? 'default' : 'ghost'" data-testid="ping-center-node-mode-custom" @click="setActiveMode('custom')">
            单独配置
          </Button>
        </div>
        <template v-if="activeCustomConfig">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label v-for="index in displayCount" :key="index" class="block min-w-0 text-xs text-muted-foreground">探测任务 {{ index }}<select :value="activeCustomConfig.taskIds[index - 1] ?? ''" class="mt-1 h-10 w-full truncate rounded-md border border-input bg-background px-3 text-sm text-foreground" :data-testid="`ping-center-node-slot-${index}`" @change="setActiveTask(index - 1, $event)"><option value="">请选择探测任务</option><option v-for="task in activeRow.candidates" :key="task.id" :value="task.id" :disabled="activeCustomConfig.taskIds.some((id, slot) => id === task.id && slot !== index - 1)">{{ taskOptionLabel(task) }}</option></select></label>
          </div><div v-if="activeEditorIssues.length" class="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-500" data-testid="ping-center-node-invalid-reason">
            <div v-for="issue in activeEditorIssues" :key="issue">
              {{ issue }}
            </div>
          </div>
        </template>
        <div class="flex justify-end gap-2">
          <Button variant="outline" @click="closeNodeEditor">
            取消
          </Button><Button :disabled="activeEditorIssues.length > 0" data-testid="ping-center-node-complete" @click="completeNodeEditor">
            完成
          </Button>
        </div>
      </div>
    </AppDialog>

    <AppDialog :open="savePreviewOpen" title="保存 Ping 显示配置" description="提交时会重新读取最新主题设置并合并；旧版配置键不会被覆盖。" content-class="max-w-3xl" @update:open="savePreviewOpen = $event">
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
              完整覆盖
            </div><div class="mt-1 text-xl font-semibold text-emerald-500">
              {{ coverageCounts.full }}
            </div>
          </div><div class="rounded-md bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">
              部分覆盖
            </div><div class="mt-1 text-xl font-semibold text-amber-500">
              {{ coverageCounts.partial }}
            </div>
          </div><div class="rounded-md bg-muted/40 p-3">
            <div class="text-xs text-muted-foreground">
              需要处理
            </div><div class="mt-1 text-xl font-semibold text-destructive">
              {{ actionCount }}
            </div>
          </div>
        </div>
        <div class="rounded-md border border-border/60 p-3 text-sm">
          <div class="font-medium">
            全局：{{ threeNetworkEnabled ? '三网监控，显示 3 项任务' : '单项监控，显示 1 项任务' }}
          </div><div class="mt-1 text-xs text-muted-foreground">
            {{ getActiveNodeCardPingTaskIds(draftConfig!.global.taskIds, displayCount).map(id => adminTasks.find(task => task.id === id)?.name || `任务 ${id}`).join('、') || '尚未选择任务' }}
          </div>
        </div>
        <div v-if="validationIssues.length" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="ping-center-save-blockers">
          <div class="font-medium">
            需要先修正：
          </div><ul class="mt-2 list-disc space-y-1 pl-5">
            <li v-for="issue in validationIssues" :key="issue">
              {{ issue }}
            </li>
          </ul>
        </div>
        <p v-if="saveError" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {{ saveError }}
        </p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="isSaving" @click="savePreviewOpen = false">
            取消
          </Button><Button :disabled="validationIssues.length > 0 || isSaving || !appStore.isLoggedIn" data-testid="ping-center-save-confirm" @click="saveConfig">
            <Icon :icon="isSaving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="isSaving && 'animate-spin'" />确认保存
          </Button>
        </div>
      </div>
    </AppDialog>

    <AppDialog :open="leaveConfirmOpen" title="放弃未保存修改？" description="当前 Ping 配置尚未保存，离开后这些修改将丢失。" content-class="max-w-md" @update:open="open => !open && cancelPendingNavigation()">
      <div class="flex justify-end gap-2" data-testid="ping-center-leave-confirm">
        <Button variant="outline" @click="cancelPendingNavigation">
          继续编辑
        </Button>
        <Button data-testid="ping-center-leave-discard" @click="confirmPendingNavigation">
          放弃并离开
        </Button>
      </div>
    </AppDialog>
  </section>
</template>
