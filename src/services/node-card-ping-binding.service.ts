import type { PublicSettings } from '@/utils/api'
import type { NodeCardPingTaskBindings } from '@/utils/nodeCardPingBindings'
import { loadPublicPingTasks } from '@/services/metrics.service'
import { requestManager } from '@/services/request.service'
import { orderPingTasksByBackend } from '@/utils/metricSeries'
import {
  isNodeCardPingBindingUuid,
  isNodeCardPingTaskId,
  normalizeNodeCardPingTaskBindings,
  parseNodeCardPingTaskBindings,
  serializeNodeCardPingTaskBindings,
} from '@/utils/nodeCardPingBindings'

export const NODE_CARD_PING_BINDINGS_SETTING_KEY = 'nodeCardPingTaskBindings'

export class NodeCardPingBindingApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'NodeCardPingBindingApiError'
  }
}

export interface AdminPingTask {
  id: number
  name: string
  clients: string[]
  type: string
  interval: number | null
  target: string
  weight: number
}

export interface AdminPingClient {
  uuid: string
  name: string
  region: string
  group: string
}

export interface NodeCardPingBindingAdminData {
  theme: string
  publicSettings: PublicSettings
  settings: Record<string, unknown>
  tasks: AdminPingTask[]
  clients: AdminPingClient[]
}

export interface SaveNodeCardPingBindingsOptions {
  theme: string
  selectedNodeUuid?: string
  selectedTaskId?: number
}

export interface SaveNodeCardPingBindingsResult {
  bindings: NodeCardPingTaskBindings
  prunedCount: number
  publicSettings: PublicSettings
  settings: Record<string, unknown>
  tasks: AdminPingTask[]
  clients: AdminPingClient[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readApiMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.message === 'string' && value.message.trim()
    ? value.message
    : fallback
}

async function requestJson<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { ...init, credentials: 'include', signal })
  }
  catch (error) {
    if (error instanceof NodeCardPingBindingApiError)
      throw error
    throw new NodeCardPingBindingApiError(error instanceof Error ? error.message : '网络请求失败')
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  }
  catch {
    throw new NodeCardPingBindingApiError(response.ok ? '服务器返回了无效数据' : `请求失败（${response.status}）`, response.status)
  }

  if (!response.ok)
    throw new NodeCardPingBindingApiError(readApiMessage(payload, `请求失败（${response.status}）`), response.status)

  if (isRecord(payload) && payload.status === 'error')
    throw new NodeCardPingBindingApiError(readApiMessage(payload, '请求失败'), response.status)

  if (isRecord(payload) && payload.status === 'success' && 'data' in payload)
    return payload.data as T

  return payload as T
}

function normalizeAdminPingTasks(value: unknown): AdminPingTask[] {
  if (!Array.isArray(value))
    throw new NodeCardPingBindingApiError('延迟任务列表数据格式异常')

  return value.flatMap((item) => {
    if (!isRecord(item) || !isNodeCardPingTaskId(item.id) || !Array.isArray(item.clients))
      return []

    const clients = item.clients.filter(isNodeCardPingBindingUuid).map(uuid => uuid.toLowerCase())
    return [{
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `任务 ${item.id}`,
      clients,
      type: typeof item.type === 'string' && item.type.trim() ? item.type.trim() : '未知协议',
      interval: typeof item.interval === 'number' && Number.isFinite(item.interval) ? item.interval : null,
      target: typeof item.target === 'string' && item.target.trim() ? item.target.trim() : '未提供目标',
      weight: typeof item.weight === 'number' && Number.isFinite(item.weight) ? item.weight : Number.MAX_SAFE_INTEGER,
    }]
  })
}

function orderAdminPingTasksByPublic(tasks: AdminPingTask[], publicTasks: readonly { id: number }[]): AdminPingTask[] {
  return publicTasks.length ? orderPingTasksByBackend(tasks, publicTasks) : tasks
}

function normalizeAdminClients(value: unknown): AdminPingClient[] {
  if (!Array.isArray(value))
    throw new NodeCardPingBindingApiError('节点列表数据格式异常')

  return value.flatMap((item) => {
    if (!isRecord(item) || !isNodeCardPingBindingUuid(item.uuid))
      return []

    return [{
      uuid: item.uuid.toLowerCase(),
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.uuid,
      region: typeof item.region === 'string' ? item.region.trim() : '',
      group: typeof item.group === 'string' ? item.group.trim() : '',
    }]
  }).sort((left, right) => left.name.localeCompare(right.name) || left.uuid.localeCompare(right.uuid))
}

function normalizePublicSettings(value: unknown): PublicSettings {
  if (!isRecord(value) || typeof value.theme !== 'string')
    throw new NodeCardPingBindingApiError('主题配置数据格式异常')
  return value as unknown as PublicSettings
}

function themeSettingsFromPublicSettings(publicSettings: PublicSettings): Record<string, unknown> {
  return isRecord(publicSettings.theme_settings) ? { ...publicSettings.theme_settings } : {}
}

function hasAssignedTask(tasks: AdminPingTask[], nodeUuid: string, taskId: number): boolean {
  return tasks.some(task => task.id === taskId && task.clients.includes(nodeUuid))
}

export function getAssignedPingTasks(tasks: AdminPingTask[], nodeUuid: string): AdminPingTask[] {
  const normalizedUuid = nodeUuid.toLowerCase()
  return tasks.filter(task => task.clients.includes(normalizedUuid))
}

export function pruneNodeCardPingTaskBindings(
  bindings: NodeCardPingTaskBindings,
  clients: AdminPingClient[],
  tasks: AdminPingTask[],
): NodeCardPingTaskBindings {
  const knownNodes = new Set(clients.map(client => client.uuid))
  const kept: Record<string, number> = {}
  for (const [uuid, taskId] of Object.entries(bindings)) {
    if (knownNodes.has(uuid) && hasAssignedTask(tasks, uuid, taskId))
      kept[uuid] = taskId
  }
  return normalizeNodeCardPingTaskBindings(kept)
}

async function loadFreshPublicSettings(signal: AbortSignal): Promise<PublicSettings> {
  return normalizePublicSettings(await requestJson<unknown>('/api/public', { method: 'GET' }, signal))
}

async function loadFreshAdminPingTasks(signal: AbortSignal): Promise<AdminPingTask[]> {
  return normalizeAdminPingTasks(await requestJson<unknown>('/api/admin/ping', { method: 'GET' }, signal))
}

async function loadFreshAdminClients(signal: AbortSignal): Promise<AdminPingClient[]> {
  return normalizeAdminClients(await requestJson<unknown>('/api/admin/client/list', { method: 'GET' }, signal))
}

function runAdminRequest<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return requestManager.run(key, task, { retryAttempts: 0, shouldRetry: () => false })
}

export async function loadNodeCardPingBindingAdminData(): Promise<NodeCardPingBindingAdminData> {
  return runAdminRequest('node-card-ping-bindings:load', async (signal) => {
    // Use the Ping endpoint as the permission probe. A 401/403 stops before any
    // other management request is issued, so a known non-admin cannot receive
    // or trigger the rest of the manager data flow.
    const tasks = await loadFreshAdminPingTasks(signal)
    const [publicSettings, clients, publicTasks] = await Promise.all([
      loadFreshPublicSettings(signal),
      loadFreshAdminClients(signal),
      loadPublicPingTasks().catch(() => []),
    ])
    return {
      theme: publicSettings.theme,
      publicSettings,
      settings: themeSettingsFromPublicSettings(publicSettings),
      tasks: orderAdminPingTasksByPublic(tasks, publicTasks),
      clients,
    }
  })
}

export async function saveNodeCardPingTaskBindings(options: SaveNodeCardPingBindingsOptions): Promise<SaveNodeCardPingBindingsResult> {
  if (!options.theme.trim())
    throw new NodeCardPingBindingApiError('未找到当前主题名称')

  return runAdminRequest('node-card-ping-bindings:save', async (signal) => {
    const [publicSettings, tasks, clients, publicTasks] = await Promise.all([
      loadFreshPublicSettings(signal),
      loadFreshAdminPingTasks(signal),
      loadFreshAdminClients(signal),
      loadPublicPingTasks().catch(() => []),
    ])
    const orderedTasks = orderAdminPingTasksByPublic(tasks, publicTasks)
    const freshSettings = themeSettingsFromPublicSettings(publicSettings)
    if (publicSettings.theme !== options.theme)
      throw new NodeCardPingBindingApiError('当前主题已切换，请重新打开绑定页面后再保存')
    const originalBindings = parseNodeCardPingTaskBindings(freshSettings[NODE_CARD_PING_BINDINGS_SETTING_KEY])
    const nextBindings = { ...pruneNodeCardPingTaskBindings(originalBindings, clients, orderedTasks) }

    if (options.selectedNodeUuid) {
      const nodeUuid = options.selectedNodeUuid.toLowerCase()
      if (!clients.some(client => client.uuid === nodeUuid))
        throw new NodeCardPingBindingApiError('节点已不存在，无法保存绑定')

      if (options.selectedTaskId === undefined) {
        delete nextBindings[nodeUuid]
      }
      else if (isNodeCardPingTaskId(options.selectedTaskId) && hasAssignedTask(orderedTasks, nodeUuid, options.selectedTaskId)) {
        nextBindings[nodeUuid] = options.selectedTaskId
      }
      else {
        throw new NodeCardPingBindingApiError('所选延迟任务已删除或不再分配给该节点')
      }
    }

    const serializedBindings = serializeNodeCardPingTaskBindings(nextBindings)
    const mergedSettings = {
      ...freshSettings,
      [NODE_CARD_PING_BINDINGS_SETTING_KEY]: serializedBindings,
    }
    await requestJson<unknown>(`/api/admin/theme/settings?theme=${encodeURIComponent(options.theme)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mergedSettings),
    }, signal)

    const verifiedPublicSettings = await loadFreshPublicSettings(signal)
    const verifiedSettings = themeSettingsFromPublicSettings(verifiedPublicSettings)
    const verifiedBindings = parseNodeCardPingTaskBindings(verifiedSettings[NODE_CARD_PING_BINDINGS_SETTING_KEY])
    if (serializeNodeCardPingTaskBindings(verifiedBindings) !== serializedBindings)
      throw new NodeCardPingBindingApiError('主题设置保存后未能确认，请刷新后重试')

    return {
      bindings: verifiedBindings,
      prunedCount: Object.keys(originalBindings).length - Object.keys(pruneNodeCardPingTaskBindings(originalBindings, clients, orderedTasks)).length,
      publicSettings: verifiedPublicSettings,
      settings: verifiedSettings,
      tasks: orderedTasks,
      clients,
    }
  })
}
