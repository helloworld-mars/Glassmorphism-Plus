import type { NodeCardPingTaskBindings } from '@/utils/nodeCardPingBindings'
import {
  isNodeCardPingBindingUuid,
  isNodeCardPingTaskId,
  normalizeNodeCardPingTaskBindings,
} from '@/utils/nodeCardPingBindings'

export const NODE_CARD_MULTI_PING_SCHEMA_VERSION = 2 as const
export const NODE_CARD_MULTI_PING_MAX_SERIALIZED_BYTES = 64 * 1024
export const NODE_CARD_MULTI_PING_ENCODING_PREFIX = 'v2:'

const NODE_CARD_MULTI_PING_MAX_ENCODED_LENGTH
  = NODE_CARD_MULTI_PING_ENCODING_PREFIX.length
    + Math.ceil(NODE_CARD_MULTI_PING_MAX_SERIALIZED_BYTES * 4 / 3)
    + 4
const BASE64URL_PATTERN = /^[\w-]+$/u
const BASE64_PADDING_PATTERN = /=+$/u

export type NodeCardPingDisplayCount = 1 | 2 | 3
export type NodeCardMultiPingCoverage = 'full' | 'partial' | 'none' | 'invalid'

export interface NodeCardMultiPingSelection {
  displayCount: NodeCardPingDisplayCount
  taskIds: number[]
}

export interface NodeCardMultiPingInheritedNodeConfig {
  mode: 'inherit'
}

export interface NodeCardMultiPingCustomNodeConfig extends NodeCardMultiPingSelection {
  mode: 'custom'
}

export type NodeCardMultiPingNodeConfig = NodeCardMultiPingInheritedNodeConfig | NodeCardMultiPingCustomNodeConfig

export interface NodeCardMultiPingConfig {
  schemaVersion: typeof NODE_CARD_MULTI_PING_SCHEMA_VERSION
  global: NodeCardMultiPingSelection
  nodes: Record<string, NodeCardMultiPingNodeConfig>
}

export type NodeCardMultiPingConfigStatus = 'absent' | 'valid' | 'damaged'

export interface NodeCardMultiPingConfigInspection {
  status: NodeCardMultiPingConfigStatus
  config: NodeCardMultiPingConfig | null
  reason?: string
}

export type NodeCardMultiPingRuntimeSource = 'v2' | 'legacy-migration' | 'legacy-aggregate'

export interface NodeCardMultiPingRuntimeConfig {
  config: NodeCardMultiPingConfig
  source: NodeCardMultiPingRuntimeSource
  persistedStatus: NodeCardMultiPingConfigStatus
  damaged: boolean
}

export interface NodeCardMultiPingAssignableTask {
  id: number
  clients: readonly string[]
}

export interface NodeCardMultiPingResolution<TTask extends NodeCardMultiPingAssignableTask = NodeCardMultiPingAssignableTask> {
  nodeUuid: string
  source: 'v2-global' | 'v2-custom' | 'legacy-custom' | 'legacy-aggregate'
  displayCount: NodeCardPingDisplayCount
  configuredTaskIds: number[]
  resolvedTaskIds: number[]
  invalidTaskIds: number[]
  unassignedTaskIds: number[]
  deletedTaskIds: number[]
  tasks: TTask[]
  coverage: NodeCardMultiPingCoverage
  useLegacyAggregate: boolean
  damaged: boolean
}

export interface NodeCardMultiPingBulkPreview<TTask extends NodeCardMultiPingAssignableTask = NodeCardMultiPingAssignableTask> {
  displayCount: NodeCardPingDisplayCount
  taskIds: number[]
  selectedNodeUuids: string[]
  invalidNodeUuids: string[]
  eligibleNodeUuids: string[]
  excludedNodeUuids: string[]
  changedNodeUuids: string[]
  unchangedNodeUuids: string[]
  intersectionTasks: TTask[]
  invalidTaskIds: number[]
  selectionValid: boolean
  canApply: boolean
}

export class NodeCardMultiPingConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NodeCardMultiPingConfigError'
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(BASE64_PADDING_PATTERN, '')
}

function decodeBase64Url(value: string): string | null {
  if (!value || !BASE64URL_PATTERN.test(value))
    return null

  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return null
  }
}

function damaged(reason: string): NodeCardMultiPingConfigInspection {
  return { status: 'damaged', config: null, reason }
}

function normalizeTaskIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.some(taskId => !isNodeCardPingTaskId(taskId)))
    return null

  const seen = new Set<number>()
  const normalized: number[] = []
  for (const taskId of value) {
    if (!seen.has(taskId)) {
      seen.add(taskId)
      normalized.push(taskId)
    }
  }
  return normalized
}

function normalizeSelection(value: unknown): NodeCardMultiPingSelection | null {
  if (!isPlainRecord(value) || !isNodeCardPingDisplayCount(value.displayCount) || !Array.isArray(value.taskIds))
    return null
  if (value.displayCount === 1 && value.taskIds.length === 0)
    return { displayCount: 1, taskIds: [] }
  return normalizeStrictSelection(value)
}

function normalizeStrictSelection(value: unknown): NodeCardMultiPingSelection | null {
  if (!isPlainRecord(value) || !isNodeCardPingDisplayCount(value.displayCount) || !Array.isArray(value.taskIds))
    return null
  if (value.taskIds.length !== value.displayCount || value.taskIds.some(taskId => !isNodeCardPingTaskId(taskId)))
    return null

  const taskIds = value.taskIds as number[]
  if (new Set(taskIds).size !== taskIds.length)
    return null

  return {
    displayCount: value.displayCount,
    taskIds: [...taskIds],
  }
}

function normalizeNodeConfig(value: unknown): NodeCardMultiPingNodeConfig | null {
  if (!isPlainRecord(value))
    return null

  if (value.mode === 'inherit')
    return { mode: 'inherit' }

  if (value.mode !== 'custom')
    return null

  const selection = normalizeStrictSelection(value)
  return selection ? { mode: 'custom', ...selection } : null
}

function createEmptyConfig(): NodeCardMultiPingConfig {
  return {
    schemaVersion: NODE_CARD_MULTI_PING_SCHEMA_VERSION,
    global: {
      displayCount: 1,
      taskIds: [],
    },
    nodes: {},
  }
}

function canonicalizeConfig(value: unknown): NodeCardMultiPingConfig | null {
  if (!isPlainRecord(value) || value.schemaVersion !== NODE_CARD_MULTI_PING_SCHEMA_VERSION)
    return null

  const global = normalizeSelection(value.global)
  if (!global || !isPlainRecord(value.nodes))
    return null

  const normalizedNodes: Record<string, NodeCardMultiPingNodeConfig> = {}
  for (const [rawUuid, rawNodeConfig] of Object.entries(value.nodes)) {
    if (!isNodeCardPingBindingUuid(rawUuid))
      return null

    const normalizedNodeConfig = normalizeNodeConfig(rawNodeConfig)
    if (!normalizedNodeConfig)
      return null

    normalizedNodes[rawUuid.toLowerCase()] = normalizedNodeConfig
  }

  const nodes = Object.fromEntries(
    Object.entries(normalizedNodes).sort(([left], [right]) => left.localeCompare(right)),
  )
  return {
    schemaVersion: NODE_CARD_MULTI_PING_SCHEMA_VERSION,
    global,
    nodes,
  }
}

export function isNodeCardPingDisplayCount(value: unknown): value is NodeCardPingDisplayCount {
  return value === 1 || value === 2 || value === 3
}

export function createDefaultNodeCardMultiPingConfig(): NodeCardMultiPingConfig {
  return createEmptyConfig()
}

export function inspectNodeCardMultiPingConfig(value: unknown): NodeCardMultiPingConfigInspection {
  if (value === undefined || value === null || value === '')
    return { status: 'absent', config: null }

  let rawValue: unknown = value
  if (typeof value === 'string') {
    if (value.length > NODE_CARD_MULTI_PING_MAX_ENCODED_LENGTH)
      return damaged('配置超过大小限制')

    let serializedValue = value
    if (value.startsWith(NODE_CARD_MULTI_PING_ENCODING_PREFIX)) {
      const decoded = decodeBase64Url(value.slice(NODE_CARD_MULTI_PING_ENCODING_PREFIX.length))
      if (decoded === null)
        return damaged('配置编码无效')
      serializedValue = decoded
    }
    if (utf8ByteLength(serializedValue) > NODE_CARD_MULTI_PING_MAX_SERIALIZED_BYTES)
      return damaged('配置超过大小限制')

    try {
      rawValue = JSON.parse(serializedValue) as unknown
    }
    catch {
      return damaged('配置不是有效 JSON')
    }
  }

  const config = canonicalizeConfig(rawValue)
  if (!config)
    return damaged('配置结构或字段无效')

  const serialized = JSON.stringify(config)
  if (utf8ByteLength(serialized) > NODE_CARD_MULTI_PING_MAX_SERIALIZED_BYTES)
    return damaged('配置超过大小限制')

  return { status: 'valid', config }
}

export function parseNodeCardMultiPingConfig(value: unknown): NodeCardMultiPingConfig | null {
  return inspectNodeCardMultiPingConfig(value).config
}

export function normalizeNodeCardMultiPingConfig(value: unknown): NodeCardMultiPingConfig | null {
  return parseNodeCardMultiPingConfig(value)
}

export function serializeNodeCardMultiPingConfig(value: unknown): string {
  const inspection = inspectNodeCardMultiPingConfig(value)
  if (!inspection.config)
    throw new NodeCardMultiPingConfigError(inspection.reason ?? '配置无效')

  const serialized = JSON.stringify(inspection.config)
  if (utf8ByteLength(serialized) > NODE_CARD_MULTI_PING_MAX_SERIALIZED_BYTES)
    throw new NodeCardMultiPingConfigError('配置超过大小限制')
  return `${NODE_CARD_MULTI_PING_ENCODING_PREFIX}${encodeBase64Url(serialized)}`
}

export function migrateNodeCardPingBindingsToMultiPingConfig(
  bindings: NodeCardPingTaskBindings,
): NodeCardMultiPingConfig {
  const config = createEmptyConfig()
  for (const [nodeUuid, taskId] of Object.entries(normalizeNodeCardPingTaskBindings(bindings))) {
    config.nodes[nodeUuid] = {
      mode: 'custom',
      displayCount: 1,
      taskIds: [taskId],
    }
  }
  return config
}

export function resolveNodeCardMultiPingRuntimeConfig(
  persistedV2Value: unknown,
  legacyBindings: NodeCardPingTaskBindings,
): NodeCardMultiPingRuntimeConfig {
  const inspection = inspectNodeCardMultiPingConfig(persistedV2Value)
  if (inspection.config) {
    return {
      config: inspection.config,
      source: 'v2',
      persistedStatus: inspection.status,
      damaged: false,
    }
  }

  const normalizedLegacy = normalizeNodeCardPingTaskBindings(legacyBindings)
  const hasLegacyBindings = Object.keys(normalizedLegacy).length > 0
  return {
    config: migrateNodeCardPingBindingsToMultiPingConfig(normalizedLegacy),
    source: hasLegacyBindings ? 'legacy-migration' : 'legacy-aggregate',
    persistedStatus: inspection.status,
    damaged: inspection.status === 'damaged',
  }
}

export function getNodeCardMultiPingTaskCandidates<TTask extends NodeCardMultiPingAssignableTask>(
  tasks: readonly TTask[],
  nodeUuid: string,
): TTask[] {
  if (!isNodeCardPingBindingUuid(nodeUuid))
    return []

  const normalizedUuid = nodeUuid.toLowerCase()
  return tasks.filter(task => isNodeCardPingTaskId(task.id) && task.clients.some(client => (
    isNodeCardPingBindingUuid(client) && client.toLowerCase() === normalizedUuid
  )))
}

export function getStrictNodeCardMultiPingTaskIntersection<TTask extends NodeCardMultiPingAssignableTask>(
  tasks: readonly TTask[],
  nodeUuids: readonly string[],
): TTask[] {
  const normalizedNodeUuids = [...new Set(
    nodeUuids
      .filter(isNodeCardPingBindingUuid)
      .map(nodeUuid => nodeUuid.toLowerCase()),
  )]
  if (normalizedNodeUuids.length === 0)
    return []

  const requiredNodes = new Set(normalizedNodeUuids)
  return tasks.filter((task) => {
    if (!isNodeCardPingTaskId(task.id))
      return false
    const assignedNodes = new Set(
      task.clients
        .filter(isNodeCardPingBindingUuid)
        .map(nodeUuid => nodeUuid.toLowerCase()),
    )
    return [...requiredNodes].every(nodeUuid => assignedNodes.has(nodeUuid))
  })
}

function resolveCoverage(
  source: NodeCardMultiPingResolution['source'],
  displayCount: NodeCardPingDisplayCount,
  configuredTaskIds: readonly number[],
  resolvedTaskIds: readonly number[],
  unassignedTaskIds: readonly number[],
  deletedTaskIds: readonly number[],
): NodeCardMultiPingCoverage {
  if (configuredTaskIds.length === 0)
    return 'none'
  if (deletedTaskIds.length > 0)
    return 'invalid'
  if ((source === 'v2-custom' || source === 'legacy-custom') && unassignedTaskIds.length > 0)
    return 'invalid'
  if (resolvedTaskIds.length === displayCount)
    return 'full'
  if (resolvedTaskIds.length === 0)
    return 'none'
  return 'partial'
}

export function resolveNodeCardMultiPingDisplay<TTask extends NodeCardMultiPingAssignableTask>(
  runtime: NodeCardMultiPingRuntimeConfig,
  nodeUuid: string,
  tasks: readonly TTask[],
): NodeCardMultiPingResolution<TTask> {
  const normalizedUuid = isNodeCardPingBindingUuid(nodeUuid) ? nodeUuid.toLowerCase() : nodeUuid
  const nodeConfig = runtime.config.nodes[normalizedUuid]
  const usesCustom = nodeConfig?.mode === 'custom'
  const selection = usesCustom ? nodeConfig : runtime.config.global
  const candidates = getNodeCardMultiPingTaskCandidates(tasks, normalizedUuid)
  const taskById = new Map(tasks.filter(task => isNodeCardPingTaskId(task.id)).map(task => [task.id, task]))
  const candidateById = new Map(candidates.map(task => [task.id, task]))
  const resolvedTaskIds = selection.taskIds.filter(taskId => candidateById.has(taskId))
  const deletedTaskIds = selection.taskIds.filter(taskId => !taskById.has(taskId))
  const unassignedTaskIds = selection.taskIds.filter(taskId => taskById.has(taskId) && !candidateById.has(taskId))
  const legacySource = runtime.source !== 'v2'
  const emptyGlobalAggregate = !usesCustom && selection.taskIds.length === 0
  const useLegacyAggregate = emptyGlobalAggregate
    || (legacySource && (!usesCustom || resolvedTaskIds.length === 0))

  let source: NodeCardMultiPingResolution<TTask>['source']
  if (runtime.source === 'v2')
    source = usesCustom ? 'v2-custom' : 'v2-global'
  else
    source = usesCustom ? 'legacy-custom' : 'legacy-aggregate'

  const invalidTaskIds = source === 'v2-global'
    ? [...deletedTaskIds]
    : [...deletedTaskIds, ...unassignedTaskIds]

  return {
    nodeUuid: normalizedUuid,
    source,
    displayCount: selection.displayCount,
    configuredTaskIds: [...selection.taskIds],
    resolvedTaskIds,
    invalidTaskIds,
    unassignedTaskIds,
    deletedTaskIds,
    tasks: resolvedTaskIds.flatMap(taskId => candidateById.get(taskId) ?? []),
    coverage: resolveCoverage(
      source,
      selection.displayCount,
      selection.taskIds,
      resolvedTaskIds,
      unassignedTaskIds,
      deletedTaskIds,
    ),
    useLegacyAggregate,
    damaged: runtime.damaged,
  }
}

function sameCustomSelection(
  nodeConfig: NodeCardMultiPingNodeConfig | undefined,
  displayCount: NodeCardPingDisplayCount,
  taskIds: readonly number[],
): boolean {
  return nodeConfig?.mode === 'custom'
    && nodeConfig.displayCount === displayCount
    && nodeConfig.taskIds.length === taskIds.length
    && nodeConfig.taskIds.every((taskId, index) => taskId === taskIds[index])
}

export function previewStrictNodeCardMultiPingBulkAssignment<TTask extends NodeCardMultiPingAssignableTask>(
  config: NodeCardMultiPingConfig,
  selectedNodeUuids: readonly string[],
  displayCount: NodeCardPingDisplayCount,
  requestedTaskIds: readonly number[],
  tasks: readonly TTask[],
): NodeCardMultiPingBulkPreview<TTask> {
  if (!isNodeCardPingDisplayCount(displayCount))
    throw new NodeCardMultiPingConfigError('显示数量必须为 1、2 或 3')

  const taskIds = normalizeTaskIds(requestedTaskIds)
  if (!taskIds)
    throw new NodeCardMultiPingConfigError('延迟任务 ID 无效')
  const normalizedTaskIds = taskIds.slice(0, displayCount)
  const selectionValid = requestedTaskIds.length === displayCount
    && taskIds.length === requestedTaskIds.length

  const invalidNodeUuids = [...new Set(selectedNodeUuids.filter(nodeUuid => !isNodeCardPingBindingUuid(nodeUuid)))]
  const normalizedNodeUuids = [...new Set(
    selectedNodeUuids
      .filter(isNodeCardPingBindingUuid)
      .map(nodeUuid => nodeUuid.toLowerCase()),
  )]
  const intersectionTasks = getStrictNodeCardMultiPingTaskIntersection(tasks, normalizedNodeUuids)
  const intersectionTaskIds = new Set(intersectionTasks.map(task => task.id))
  const invalidTaskIds = normalizedTaskIds.filter(taskId => !intersectionTaskIds.has(taskId))

  const eligibleNodeUuids: string[] = []
  const excludedNodeUuids: string[] = []
  for (const nodeUuid of normalizedNodeUuids) {
    const candidateTaskIds = new Set(getNodeCardMultiPingTaskCandidates(tasks, nodeUuid).map(task => task.id))
    if (normalizedTaskIds.every(taskId => candidateTaskIds.has(taskId)))
      eligibleNodeUuids.push(nodeUuid)
    else
      excludedNodeUuids.push(nodeUuid)
  }

  const canApply = normalizedNodeUuids.length > 0
    && selectionValid
    && invalidNodeUuids.length === 0
    && excludedNodeUuids.length === 0
    && invalidTaskIds.length === 0
  const changedNodeUuids = canApply
    ? eligibleNodeUuids.filter(nodeUuid => !sameCustomSelection(config.nodes[nodeUuid], displayCount, normalizedTaskIds))
    : []
  const unchangedNodeUuids = canApply
    ? eligibleNodeUuids.filter(nodeUuid => sameCustomSelection(config.nodes[nodeUuid], displayCount, normalizedTaskIds))
    : []

  return {
    displayCount,
    taskIds: normalizedTaskIds,
    selectedNodeUuids: normalizedNodeUuids,
    invalidNodeUuids,
    eligibleNodeUuids,
    excludedNodeUuids,
    changedNodeUuids,
    unchangedNodeUuids,
    intersectionTasks,
    invalidTaskIds,
    selectionValid,
    canApply,
  }
}
