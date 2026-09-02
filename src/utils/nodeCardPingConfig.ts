import type { NodeCardMultiPingConfig, NodeCardMultiPingConfigStatus } from '@/utils/nodeCardMultiPingConfig'
import type { NodeCardPingTaskBindings } from '@/utils/nodeCardPingBindings'
import {
  getNodeCardMultiPingTaskCandidates,
  getStrictNodeCardMultiPingTaskIntersection,
  inspectNodeCardMultiPingConfig,
} from '@/utils/nodeCardMultiPingConfig'
import {
  isNodeCardPingBindingUuid,
  isNodeCardPingTaskId,
  normalizeNodeCardPingTaskBindings,
} from '@/utils/nodeCardPingBindings'

export const NODE_CARD_PING_SCHEMA_VERSION = 3 as const
export const NODE_CARD_PING_MAX_SERIALIZED_BYTES = 64 * 1024
export const NODE_CARD_PING_ENCODING_PREFIX = 'v3:'

const NODE_CARD_PING_MAX_ENCODED_LENGTH
  = NODE_CARD_PING_ENCODING_PREFIX.length
    + Math.ceil(NODE_CARD_PING_MAX_SERIALIZED_BYTES * 4 / 3)
    + 4
const BASE64URL_PATTERN = /^[\w-]+$/u
const BASE64_PADDING_PATTERN = /=+$/u

export type NodeCardPingDisplayCount = 1 | 3
export type NodeCardPingCoverage = 'full' | 'partial' | 'none' | 'invalid'
export type NodeCardPingTaskSlots = [number | null, number | null, number | null]

export interface NodeCardPingSelection {
  threeNetworkEnabled: boolean
  taskIds: NodeCardPingTaskSlots
}

export interface NodeCardPingInheritedNodeConfig {
  mode: 'inherit'
}

export interface NodeCardPingCustomNodeConfig {
  mode: 'custom'
  taskIds: NodeCardPingTaskSlots
}

export type NodeCardPingNodeConfig = NodeCardPingInheritedNodeConfig | NodeCardPingCustomNodeConfig

export interface NodeCardPingConfig {
  schemaVersion: typeof NODE_CARD_PING_SCHEMA_VERSION
  global: NodeCardPingSelection
  nodes: Record<string, NodeCardPingNodeConfig>
}

export type NodeCardPingConfigStatus = NodeCardMultiPingConfigStatus

export interface NodeCardPingConfigInspection {
  status: NodeCardPingConfigStatus
  config: NodeCardPingConfig | null
  reason?: string
}

export type NodeCardPingRuntimeSource = 'v3' | 'v2-migration' | 'legacy-migration' | 'legacy-aggregate'

export interface NodeCardPingRuntimeConfig {
  config: NodeCardPingConfig
  source: NodeCardPingRuntimeSource
  persistedStatus: NodeCardPingConfigStatus
  damaged: boolean
  migrationNeeded: boolean
}

export interface NodeCardPingAssignableTask {
  id: number
  clients: readonly string[]
}

export interface NodeCardPingResolution<TTask extends NodeCardPingAssignableTask = NodeCardPingAssignableTask> {
  nodeUuid: string
  source: 'global' | 'custom' | 'legacy-custom' | 'legacy-aggregate'
  displayCount: NodeCardPingDisplayCount
  configuredTaskSlots: NodeCardPingTaskSlots
  configuredTaskIds: number[]
  resolvedTaskIds: number[]
  invalidTaskIds: number[]
  unassignedTaskIds: number[]
  deletedTaskIds: number[]
  tasks: TTask[]
  coverage: NodeCardPingCoverage
  useLegacyAggregate: boolean
  damaged: boolean
}

export interface NodeCardPingBulkPreview<TTask extends NodeCardPingAssignableTask = NodeCardPingAssignableTask> {
  displayCount: NodeCardPingDisplayCount
  taskIds: NodeCardPingTaskSlots
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

export class NodeCardPingConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NodeCardPingConfigError'
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

function damaged(reason: string): NodeCardPingConfigInspection {
  return { status: 'damaged', config: null, reason }
}

function normalizeTaskSlots(value: unknown): NodeCardPingTaskSlots | null {
  if (!Array.isArray(value) || value.length !== 3)
    return null
  if (value.some(taskId => taskId !== null && !isNodeCardPingTaskId(taskId)))
    return null

  const taskIds = value.filter(isNodeCardPingTaskId)
  if (new Set(taskIds).size !== taskIds.length)
    return null

  return [
    value[0] as number | null,
    value[1] as number | null,
    value[2] as number | null,
  ]
}

function normalizeNodeConfig(value: unknown): NodeCardPingNodeConfig | null {
  if (!isPlainRecord(value))
    return null
  if (value.mode === 'inherit')
    return { mode: 'inherit' }
  if (value.mode !== 'custom')
    return null

  const taskIds = normalizeTaskSlots(value.taskIds)
  return taskIds ? { mode: 'custom', taskIds } : null
}

function canonicalizeConfig(value: unknown): NodeCardPingConfig | null {
  if (!isPlainRecord(value) || value.schemaVersion !== NODE_CARD_PING_SCHEMA_VERSION)
    return null
  if (!isPlainRecord(value.global) || typeof value.global.threeNetworkEnabled !== 'boolean')
    return null

  const taskIds = normalizeTaskSlots(value.global.taskIds)
  if (!taskIds || !isPlainRecord(value.nodes))
    return null

  const normalizedNodes: Record<string, NodeCardPingNodeConfig> = {}
  for (const [rawUuid, rawNodeConfig] of Object.entries(value.nodes)) {
    if (!isNodeCardPingBindingUuid(rawUuid))
      return null
    const normalizedNodeConfig = normalizeNodeConfig(rawNodeConfig)
    if (!normalizedNodeConfig)
      return null
    normalizedNodes[rawUuid.toLowerCase()] = normalizedNodeConfig
  }

  return {
    schemaVersion: NODE_CARD_PING_SCHEMA_VERSION,
    global: {
      threeNetworkEnabled: value.global.threeNetworkEnabled,
      taskIds,
    },
    nodes: Object.fromEntries(
      Object.entries(normalizedNodes).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

function slotsFromIds(taskIds: readonly number[]): NodeCardPingTaskSlots {
  return [taskIds[0] ?? null, taskIds[1] ?? null, taskIds[2] ?? null]
}

export function cloneNodeCardPingTaskSlots(taskIds: readonly (number | null)[]): NodeCardPingTaskSlots {
  return [taskIds[0] ?? null, taskIds[1] ?? null, taskIds[2] ?? null]
}

export function getNodeCardPingDisplayCount(config: Pick<NodeCardPingConfig, 'global'>): NodeCardPingDisplayCount {
  return config.global.threeNetworkEnabled ? 3 : 1
}

export function getActiveNodeCardPingTaskIds(
  taskIds: NodeCardPingTaskSlots,
  displayCount: NodeCardPingDisplayCount,
): number[] {
  return taskIds.slice(0, displayCount).filter(isNodeCardPingTaskId)
}

export function createDefaultNodeCardPingConfig(): NodeCardPingConfig {
  return {
    schemaVersion: NODE_CARD_PING_SCHEMA_VERSION,
    global: {
      threeNetworkEnabled: false,
      taskIds: [null, null, null],
    },
    nodes: {},
  }
}

export function inspectNodeCardPingConfig(value: unknown): NodeCardPingConfigInspection {
  if (value === undefined || value === null || value === '')
    return { status: 'absent', config: null }

  let rawValue: unknown = value
  if (typeof value === 'string') {
    if (value.length > NODE_CARD_PING_MAX_ENCODED_LENGTH)
      return damaged('配置超过大小限制')

    let serializedValue = value
    if (value.startsWith(NODE_CARD_PING_ENCODING_PREFIX)) {
      const decoded = decodeBase64Url(value.slice(NODE_CARD_PING_ENCODING_PREFIX.length))
      if (decoded === null)
        return damaged('配置编码无效')
      serializedValue = decoded
    }
    if (utf8ByteLength(serializedValue) > NODE_CARD_PING_MAX_SERIALIZED_BYTES)
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
  if (utf8ByteLength(JSON.stringify(config)) > NODE_CARD_PING_MAX_SERIALIZED_BYTES)
    return damaged('配置超过大小限制')
  return { status: 'valid', config }
}

export function parseNodeCardPingConfig(value: unknown): NodeCardPingConfig | null {
  return inspectNodeCardPingConfig(value).config
}

export function serializeNodeCardPingConfig(value: unknown): string {
  const inspection = inspectNodeCardPingConfig(value)
  if (!inspection.config)
    throw new NodeCardPingConfigError(inspection.reason ?? '配置无效')

  const serialized = JSON.stringify(inspection.config)
  if (utf8ByteLength(serialized) > NODE_CARD_PING_MAX_SERIALIZED_BYTES)
    throw new NodeCardPingConfigError('配置超过大小限制')
  return `${NODE_CARD_PING_ENCODING_PREFIX}${encodeBase64Url(serialized)}`
}

export function migrateNodeCardMultiPingConfigToV3(config: NodeCardMultiPingConfig): NodeCardPingConfig {
  const migrated = createDefaultNodeCardPingConfig()
  migrated.global = {
    threeNetworkEnabled: config.global.displayCount !== 1,
    taskIds: slotsFromIds(config.global.taskIds),
  }
  for (const [nodeUuid, nodeConfig] of Object.entries(config.nodes)) {
    migrated.nodes[nodeUuid] = nodeConfig.mode === 'custom'
      ? { mode: 'custom', taskIds: slotsFromIds(nodeConfig.taskIds) }
      : { mode: 'inherit' }
  }
  return migrated
}

export function migrateNodeCardPingBindingsToV3(bindings: NodeCardPingTaskBindings): NodeCardPingConfig {
  const config = createDefaultNodeCardPingConfig()
  for (const [nodeUuid, taskId] of Object.entries(normalizeNodeCardPingTaskBindings(bindings))) {
    config.nodes[nodeUuid] = {
      mode: 'custom',
      taskIds: [taskId, null, null],
    }
  }
  return config
}

export function resolveNodeCardPingRuntimeConfig(
  persistedV3Value: unknown,
  persistedV2Value: unknown,
  legacyBindings: NodeCardPingTaskBindings,
): NodeCardPingRuntimeConfig {
  const v3Inspection = inspectNodeCardPingConfig(persistedV3Value)
  if (v3Inspection.config) {
    return {
      config: v3Inspection.config,
      source: 'v3',
      persistedStatus: v3Inspection.status,
      damaged: false,
      migrationNeeded: false,
    }
  }

  const v2Inspection = inspectNodeCardMultiPingConfig(persistedV2Value)
  if (v2Inspection.config) {
    return {
      config: migrateNodeCardMultiPingConfigToV3(v2Inspection.config),
      source: 'v2-migration',
      persistedStatus: v3Inspection.status,
      damaged: v3Inspection.status === 'damaged',
      migrationNeeded: true,
    }
  }

  const normalizedLegacy = normalizeNodeCardPingTaskBindings(legacyBindings)
  const hasLegacyBindings = Object.keys(normalizedLegacy).length > 0
  return {
    config: migrateNodeCardPingBindingsToV3(normalizedLegacy),
    source: hasLegacyBindings ? 'legacy-migration' : 'legacy-aggregate',
    persistedStatus: v3Inspection.status,
    damaged: v3Inspection.status === 'damaged' || v2Inspection.status === 'damaged',
    migrationNeeded: true,
  }
}

function resolveCoverage(
  source: NodeCardPingResolution['source'],
  displayCount: NodeCardPingDisplayCount,
  configuredTaskIds: readonly number[],
  resolvedTaskIds: readonly number[],
  unassignedTaskIds: readonly number[],
  deletedTaskIds: readonly number[],
): NodeCardPingCoverage {
  if (configuredTaskIds.length === 0)
    return 'none'
  if (deletedTaskIds.length > 0)
    return 'invalid'
  if ((source === 'custom' || source === 'legacy-custom') && unassignedTaskIds.length > 0)
    return 'invalid'
  if (configuredTaskIds.length === displayCount && resolvedTaskIds.length === displayCount)
    return 'full'
  if (resolvedTaskIds.length === 0)
    return 'none'
  return 'partial'
}

export function resolveNodeCardPingDisplay<TTask extends NodeCardPingAssignableTask>(
  runtime: NodeCardPingRuntimeConfig,
  nodeUuid: string,
  tasks: readonly TTask[],
): NodeCardPingResolution<TTask> {
  const normalizedUuid = isNodeCardPingBindingUuid(nodeUuid) ? nodeUuid.toLowerCase() : nodeUuid
  const nodeConfig = runtime.config.nodes[normalizedUuid]
  const usesCustom = nodeConfig?.mode === 'custom'
  const taskIds = cloneNodeCardPingTaskSlots(usesCustom ? nodeConfig.taskIds : runtime.config.global.taskIds)
  const displayCount = getNodeCardPingDisplayCount(runtime.config)
  const activeTaskIds = getActiveNodeCardPingTaskIds(taskIds, displayCount)
  const candidates = getNodeCardMultiPingTaskCandidates(tasks, normalizedUuid)
  const taskById = new Map(tasks.filter(task => isNodeCardPingTaskId(task.id)).map(task => [task.id, task]))
  const candidateById = new Map(candidates.map(task => [task.id, task]))
  const resolvedTaskIds = activeTaskIds.filter(taskId => candidateById.has(taskId))
  const deletedTaskIds = activeTaskIds.filter(taskId => !taskById.has(taskId))
  const unassignedTaskIds = activeTaskIds.filter(taskId => taskById.has(taskId) && !candidateById.has(taskId))
  const useLegacyAggregate = !usesCustom && displayCount === 1 && activeTaskIds.length === 0

  let source: NodeCardPingResolution<TTask>['source']
  if (useLegacyAggregate)
    source = 'legacy-aggregate'
  else if (usesCustom)
    source = runtime.source === 'legacy-migration' ? 'legacy-custom' : 'custom'
  else
    source = 'global'

  const invalidTaskIds = source === 'global'
    ? [...deletedTaskIds]
    : [...deletedTaskIds, ...unassignedTaskIds]

  return {
    nodeUuid: normalizedUuid,
    source,
    displayCount,
    configuredTaskSlots: taskIds,
    configuredTaskIds: activeTaskIds,
    resolvedTaskIds,
    invalidTaskIds,
    unassignedTaskIds,
    deletedTaskIds,
    tasks: resolvedTaskIds.flatMap(taskId => candidateById.get(taskId) ?? []),
    coverage: resolveCoverage(
      source,
      displayCount,
      activeTaskIds,
      resolvedTaskIds,
      unassignedTaskIds,
      deletedTaskIds,
    ),
    useLegacyAggregate,
    damaged: runtime.damaged,
  }
}

function sameActiveCustomSelection(
  nodeConfig: NodeCardPingNodeConfig | undefined,
  displayCount: NodeCardPingDisplayCount,
  taskIds: NodeCardPingTaskSlots,
): boolean {
  return nodeConfig?.mode === 'custom'
    && nodeConfig.taskIds.slice(0, displayCount).every((taskId, index) => taskId === taskIds[index])
}

export function previewStrictNodeCardPingBulkAssignment<TTask extends NodeCardPingAssignableTask>(
  config: NodeCardPingConfig,
  selectedNodeUuids: readonly string[],
  requestedTaskIds: NodeCardPingTaskSlots,
  tasks: readonly TTask[],
): NodeCardPingBulkPreview<TTask> {
  const displayCount = getNodeCardPingDisplayCount(config)
  const taskIds = cloneNodeCardPingTaskSlots(requestedTaskIds)
  const activeTaskIds = getActiveNodeCardPingTaskIds(taskIds, displayCount)
  const selectionValid = activeTaskIds.length === displayCount
    && new Set(activeTaskIds).size === activeTaskIds.length

  const invalidNodeUuids = [...new Set(selectedNodeUuids.filter(nodeUuid => !isNodeCardPingBindingUuid(nodeUuid)))]
  const normalizedNodeUuids = [...new Set(
    selectedNodeUuids
      .filter(isNodeCardPingBindingUuid)
      .map(nodeUuid => nodeUuid.toLowerCase()),
  )]
  const intersectionTasks = getStrictNodeCardMultiPingTaskIntersection(tasks, normalizedNodeUuids)
  const intersectionTaskIds = new Set(intersectionTasks.map(task => task.id))
  const invalidTaskIds = activeTaskIds.filter(taskId => !intersectionTaskIds.has(taskId))

  const eligibleNodeUuids: string[] = []
  const excludedNodeUuids: string[] = []
  for (const nodeUuid of normalizedNodeUuids) {
    const candidateTaskIds = new Set(getNodeCardMultiPingTaskCandidates(tasks, nodeUuid).map(task => task.id))
    if (activeTaskIds.every(taskId => candidateTaskIds.has(taskId)))
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
    ? eligibleNodeUuids.filter(nodeUuid => !sameActiveCustomSelection(config.nodes[nodeUuid], displayCount, taskIds))
    : []
  const unchangedNodeUuids = canApply
    ? eligibleNodeUuids.filter(nodeUuid => sameActiveCustomSelection(config.nodes[nodeUuid], displayCount, taskIds))
    : []

  return {
    displayCount,
    taskIds,
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
