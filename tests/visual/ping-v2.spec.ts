import type {
  EffectiveNodePingPair,
  NodeCardPingPairSnapshot,
} from '../../src/types/node-card-ping'
import type { NodeCardMultiPingConfig } from '../../src/utils/nodeCardMultiPingConfig'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { createServer } from 'vite'
import {
  inspectNodeCardMultiPingConfig,
  migrateNodeCardPingBindingsToMultiPingConfig,
  parseNodeCardMultiPingConfig,
  previewStrictNodeCardMultiPingBulkAssignment,
  resolveNodeCardMultiPingDisplay,
  resolveNodeCardMultiPingRuntimeConfig,
  serializeNodeCardMultiPingConfig,
} from '../../src/utils/nodeCardMultiPingConfig'
import { installKomariFixture, PRIMARY_NODE_UUID } from './fixtures/komari'

const NODE_2 = '00000000-0000-4000-8000-000000000002'
const NODE_3 = '00000000-0000-4000-8000-000000000003'
const FIXED_NOW = Date.parse('2026-09-02T12:00:00.000Z')

function config(value: Partial<NodeCardMultiPingConfig> = {}): NodeCardMultiPingConfig {
  return {
    schemaVersion: 2,
    global: { displayCount: 1, taskIds: [101] },
    nodes: {},
    ...value,
  }
}

test.describe('node-card multi-Ping v2 configuration invariants', () => {
  test('classifies absent, v1, damaged JSON, invalid encoding, raw v2, and encoded v2 without inventing defaults', () => {
    for (const value of [undefined, null, ''])
      expect(inspectNodeCardMultiPingConfig(value)).toMatchObject({ status: 'absent', config: null })

    for (const value of [
      '{broken',
      'v2:not+base64',
      JSON.stringify({ schemaVersion: 1, global: { displayCount: 1, taskIds: [101] }, nodes: {} }),
      JSON.stringify({ schemaVersion: 2, global: { displayCount: 4, taskIds: [101] }, nodes: {} }),
    ]) {
      expect(inspectNodeCardMultiPingConfig(value)).toMatchObject({ status: 'damaged', config: null })
    }

    const raw = JSON.stringify(config())
    const encoded = serializeNodeCardMultiPingConfig(raw)
    expect(inspectNodeCardMultiPingConfig(raw)).toMatchObject({ status: 'valid', config: config() })
    expect(encoded).toMatch(/^v2:/)
    expect(inspectNodeCardMultiPingConfig(encoded)).toMatchObject({ status: 'valid', config: config() })
  })

  test('canonicalizes unknown fields and node ordering, remains idempotent, and rejects malformed global selections', () => {
    const raw = {
      schemaVersion: 2,
      global: { displayCount: 3, taskIds: [101, 202, 303], ignored: true },
      nodes: {
        [NODE_3.toUpperCase()]: { mode: 'inherit', ignored: 'field' },
        [PRIMARY_NODE_UUID]: { mode: 'custom', displayCount: 2, taskIds: [202, 101], extra: 1 },
      },
      futureField: { safe: true },
    }
    const normalized = parseNodeCardMultiPingConfig(raw)
    expect(normalized).toEqual({
      schemaVersion: 2,
      global: { displayCount: 3, taskIds: [101, 202, 303] },
      nodes: {
        [PRIMARY_NODE_UUID]: { mode: 'custom', displayCount: 2, taskIds: [202, 101] },
        [NODE_3]: { mode: 'inherit' },
      },
    })

    const once = serializeNodeCardMultiPingConfig(raw)
    expect(serializeNodeCardMultiPingConfig(once)).toBe(once)

    for (const global of [
      { displayCount: 3, taskIds: [101, 101, 202] },
      { displayCount: 2, taskIds: [101, 202, 303] },
      { displayCount: 3, taskIds: [101, 202] },
    ]) {
      expect(inspectNodeCardMultiPingConfig(config({ global }))).toMatchObject({ status: 'damaged', config: null })
    }

    expect(inspectNodeCardMultiPingConfig(config({
      global: { displayCount: 1, taskIds: [] },
    }))).toMatchObject({ status: 'valid' })
    expect(inspectNodeCardMultiPingConfig(config({
      nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', displayCount: 2, taskIds: [101, 101] } },
    }))).toMatchObject({ status: 'damaged', config: null })
  })

  test('migrates absent or damaged v2 from legacy while a valid v2 value wins and preserves the old key', () => {
    const legacy = { [PRIMARY_NODE_UUID]: 202 }
    const migrated = migrateNodeCardPingBindingsToMultiPingConfig(legacy)
    expect(migrated.nodes[PRIMARY_NODE_UUID]).toEqual({ mode: 'custom', displayCount: 1, taskIds: [202] })

    expect(resolveNodeCardMultiPingRuntimeConfig(undefined, legacy)).toMatchObject({
      source: 'legacy-migration',
      persistedStatus: 'absent',
      damaged: false,
      config: migrated,
    })
    expect(resolveNodeCardMultiPingRuntimeConfig('{bad', legacy)).toMatchObject({
      source: 'legacy-migration',
      persistedStatus: 'damaged',
      damaged: true,
      config: migrated,
    })
    expect(resolveNodeCardMultiPingRuntimeConfig(undefined, {})).toMatchObject({ source: 'legacy-aggregate' })

    const v2 = config({ global: { displayCount: 2, taskIds: [101, 202] } })
    expect(resolveNodeCardMultiPingRuntimeConfig(serializeNodeCardMultiPingConfig(v2), legacy)).toMatchObject({
      source: 'v2',
      persistedStatus: 'valid',
      config: v2,
    })
  })

  test('resolves global, inherit, custom, unknown, deleted, and unassigned task coverage exactly', () => {
    const tasks = [
      { id: 101, name: 'shared', clients: [PRIMARY_NODE_UUID, NODE_2, NODE_3] },
      { id: 202, name: 'partial', clients: [PRIMARY_NODE_UUID, NODE_2] },
      { id: 303, name: 'one', clients: [PRIMARY_NODE_UUID] },
    ]
    const runtime = resolveNodeCardMultiPingRuntimeConfig(config({
      global: { displayCount: 3, taskIds: [101, 202, 303] },
      nodes: {
        [NODE_2]: { mode: 'inherit' },
        [NODE_3]: { mode: 'custom', displayCount: 2, taskIds: [101, 202] },
      },
    }), {})

    expect(resolveNodeCardMultiPingDisplay(runtime, PRIMARY_NODE_UUID, tasks)).toMatchObject({
      source: 'v2-global',
      coverage: 'full',
      resolvedTaskIds: [101, 202, 303],
      invalidTaskIds: [],
    })
    expect(resolveNodeCardMultiPingDisplay(runtime, NODE_2, tasks)).toMatchObject({
      source: 'v2-global',
      coverage: 'partial',
      resolvedTaskIds: [101, 202],
      unassignedTaskIds: [303],
      invalidTaskIds: [],
    })
    expect(resolveNodeCardMultiPingDisplay(runtime, NODE_3, tasks)).toMatchObject({
      source: 'v2-custom',
      coverage: 'invalid',
      resolvedTaskIds: [101],
      unassignedTaskIds: [202],
      invalidTaskIds: [202],
    })

    const deletedRuntime = resolveNodeCardMultiPingRuntimeConfig(config({
      nodes: { [PRIMARY_NODE_UUID]: { mode: 'custom', displayCount: 1, taskIds: [999] } },
    }), {})
    expect(resolveNodeCardMultiPingDisplay(deletedRuntime, PRIMARY_NODE_UUID, tasks)).toMatchObject({
      coverage: 'invalid',
      deletedTaskIds: [999],
      invalidTaskIds: [999],
      tasks: [],
    })
  })

  test('strict bulk assignment uses only the true task intersection and reports idempotent previews', () => {
    const tasks = [
      { id: 101, clients: [PRIMARY_NODE_UUID, NODE_2] },
      { id: 202, clients: [PRIMARY_NODE_UUID, NODE_2] },
      { id: 303, clients: [PRIMARY_NODE_UUID] },
    ]
    const base = config()
    const applicable = previewStrictNodeCardMultiPingBulkAssignment(
      base,
      [PRIMARY_NODE_UUID, NODE_2],
      2,
      [101, 202],
      tasks,
    )
    expect(applicable).toMatchObject({
      canApply: true,
      selectionValid: true,
      eligibleNodeUuids: [PRIMARY_NODE_UUID, NODE_2],
      excludedNodeUuids: [],
      changedNodeUuids: [PRIMARY_NODE_UUID, NODE_2],
      invalidTaskIds: [],
    })
    expect(applicable.intersectionTasks.map(task => task.id)).toEqual([101, 202])

    const idempotent = previewStrictNodeCardMultiPingBulkAssignment(config({
      nodes: {
        [PRIMARY_NODE_UUID]: { mode: 'custom', displayCount: 2, taskIds: [101, 202] },
        [NODE_2]: { mode: 'custom', displayCount: 2, taskIds: [101, 202] },
      },
    }), [PRIMARY_NODE_UUID, NODE_2], 2, [101, 202], tasks)
    expect(idempotent).toMatchObject({ canApply: true, changedNodeUuids: [], unchangedNodeUuids: [PRIMARY_NODE_UUID, NODE_2] })

    const rejected = previewStrictNodeCardMultiPingBulkAssignment(base, [PRIMARY_NODE_UUID, NODE_2], 2, [101, 303], tasks)
    expect(rejected).toMatchObject({ canApply: false, excludedNodeUuids: [NODE_2], invalidTaskIds: [303] })
  })

  test('preserves an orphan override byte-stably and recovers it when the exact node and task return', () => {
    const orphanUuid = '00000000-0000-4000-8000-000000000099'
    const orphanConfig = config({
      nodes: { [orphanUuid]: { mode: 'custom', displayCount: 1, taskIds: [777] } },
    })
    const encoded = serializeNodeCardMultiPingConfig(orphanConfig)
    expect(serializeNodeCardMultiPingConfig(encoded)).toBe(encoded)

    const runtime = resolveNodeCardMultiPingRuntimeConfig(encoded, {})
    expect(resolveNodeCardMultiPingDisplay(runtime, orphanUuid, [])).toMatchObject({
      source: 'v2-custom',
      coverage: 'invalid',
      deletedTaskIds: [777],
      invalidTaskIds: [777],
    })
    expect(resolveNodeCardMultiPingDisplay(runtime, orphanUuid, [{ id: 777, clients: [orphanUuid] }])).toMatchObject({
      source: 'v2-custom',
      coverage: 'full',
      resolvedTaskIds: [777],
      invalidTaskIds: [],
    })
  })
})

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(String(key), String(value)) }
}

interface PairMode {
  latency?: number | null
  loss?: number
  metric?: 'success' | 'empty' | 'error'
  delayMs?: number
  errorMessage?: string
}

interface RpcHarness {
  clock: { now: number }
  calls: Array<{ method: string, params: Record<string, unknown> }>
  modes: Map<string, PairMode>
  legacyFailures: Set<string>
  rejectBatch: { value: boolean }
  holdMetricRequests: () => () => void
  setOnline: (online: boolean) => void
  setVisibility: (state: 'hidden' | 'visible') => void
  setMode: (nodeUuid: string, taskId: string | number, mode: PairMode) => void
  restore: () => void
}

interface CoordinatorRuntime {
  NodeCardPingCoordinator: typeof import('../../src/services/node-card-ping-coordinator.service').NodeCardPingCoordinator
  requestManager: typeof import('../../src/services/request.service').requestManager
  resetSharedRpc: typeof import('../../src/utils/rpc').resetSharedRpc
}

function nodeUuid(index: number): string {
  return `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function pairModeKey(nodeUuidValue: string, taskId: string): string {
  return `${nodeUuidValue.toLowerCase()}:${taskId}`
}

function rpcTaskId(params: Record<string, unknown>): string {
  const tags = params.tags as Record<string, unknown> | undefined
  return String(tags?.task_id ?? params.task_id ?? '1')
}

function rpcEntityIds(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.entity_ids))
    return params.entity_ids.map(String).map(value => value.toLowerCase())
  const value = params.entity_id ?? params.uuid
  return value ? [String(value).toLowerCase()] : []
}

function installRpcHarness(runtime: CoordinatorRuntime): RpcHarness {
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as Record<string, unknown>).window
  const originalDocument = (globalThis as Record<string, unknown>).document
  const originalLocalStorage = (globalThis as Record<string, unknown>).localStorage
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalDateNow = Date.now
  const clock = { now: FIXED_NOW }
  const calls: RpcHarness['calls'] = []
  const modes = new Map<string, PairMode>()
  const legacyFailures = new Set<string>()
  const rejectBatch = { value: false }
  const windowTarget = new EventTarget() as EventTarget & { location: { origin: string } }
  windowTarget.location = { origin: 'http://127.0.0.1:4173' }
  const documentTarget = new EventTarget() as EventTarget & { visibilityState: string }
  documentTarget.visibilityState = 'visible'
  const navigatorState = { onLine: true }
  let metricRequestGate: Promise<void> | null = null

  Object.assign(globalThis, {
    window: windowTarget,
    document: documentTarget,
    localStorage: new MemoryStorage(),
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigatorState })
  Date.now = () => clock.now

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as {
      id: number
      method: string
      params?: Record<string, unknown>
    }
    const params = payload.params ?? {}
    calls.push({ method: payload.method, params: structuredClone(params) })
    const taskId = rpcTaskId(params)
    const entityIds = rpcEntityIds(params)
    if (metricRequestGate
      && (payload.method === 'public:getPingMetricStats' || payload.method === 'public:queryMetrics')) {
      await metricRequestGate
    }
    const responseDelay = Math.max(0, ...entityIds.map(entityId => modes.get(pairModeKey(entityId, taskId))?.delayMs ?? 0))
    if (responseDelay > 0)
      await new Promise(resolve => setTimeout(resolve, responseDelay))
    const resultEnvelope = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const errorEnvelope = (code: number, message: string) => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      error: { code, message },
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    if (rejectBatch.value && entityIds.length > 1
      && (payload.method === 'public:getPingMetricStats' || payload.method === 'public:queryMetrics')) {
      return errorEnvelope(-32602, 'entity_ids is not supported by this Komari version')
    }

    if (payload.method === 'public:getPingMetricStats') {
      const errorMode = entityIds.map(entityId => modes.get(pairModeKey(entityId, taskId))).find(mode => mode?.metric === 'error')
      if (errorMode)
        return errorEnvelope(-32001, errorMode.errorMessage ?? `stats failed for task ${taskId}`)
      const stats = entityIds.flatMap((entityId) => {
        const mode = modes.get(pairModeKey(entityId, taskId)) ?? {}
        if (mode.metric === 'empty')
          return []
        const latency = mode.latency === undefined ? Number(taskId) : mode.latency
        const loss = mode.loss ?? 0
        return [{
          entity_id: entityId,
          task_id: taskId,
          tags: { task_id: taskId },
          total: 1,
          valid: latency === null || loss >= 1 ? 0 : 1,
          avg: latency,
          latest: latency,
          loss: loss * 100,
          loss_approximate: false,
          interval: 60,
        }]
      })
      return resultEnvelope({
        start: new Date(clock.now - 3_600_000).toISOString(),
        end: new Date(clock.now).toISOString(),
        interval_seconds: 60,
        stats,
        count: stats.length,
      })
    }

    if (payload.method === 'public:queryMetrics') {
      const errorMode = entityIds.map(entityId => modes.get(pairModeKey(entityId, taskId))).find(mode => mode?.metric === 'error')
      if (errorMode)
        return errorEnvelope(-32001, errorMode.errorMessage ?? `series failed for task ${taskId}`)
      const sampleTime = new Date(clock.now - 30_000).toISOString()
      const series = entityIds.flatMap((entityId) => {
        const mode = modes.get(pairModeKey(entityId, taskId)) ?? {}
        if (mode.metric === 'empty')
          return []
        const latency = mode.latency === undefined ? Number(taskId) : mode.latency
        const loss = mode.loss ?? 0
        return [
          {
            metric_key: 'ping.latency_ms',
            entity_id: entityId,
            type: 'gauge',
            tags: { task_id: taskId },
            count: 1,
            points: [{ time: sampleTime, value: latency, count: 1 }],
          },
          {
            metric_key: 'ping.loss',
            entity_id: entityId,
            type: 'gauge',
            tags: { task_id: taskId },
            count: 1,
            points: [{ time: sampleTime, value: loss, count: 1 }],
          },
        ]
      })
      return resultEnvelope({
        start: new Date(clock.now - 3_600_000).toISOString(),
        end: new Date(clock.now).toISOString(),
        series,
        count: series.length,
      })
    }

    if (payload.method === 'common:getRecords') {
      const entityId = String(params.uuid ?? '').toLowerCase()
      if (legacyFailures.has(entityId))
        return errorEnvelope(-32601, `legacy failed for ${entityId}`)
      const records = [...modes.entries()].flatMap(([key, mode]) => {
        const separator = key.lastIndexOf(':')
        if (key.slice(0, separator) !== entityId || mode.metric !== 'empty')
          return []
        return [{
          client: entityId,
          task_id: Number(key.slice(separator + 1)),
          time: new Date(clock.now - 30_000).toISOString(),
          value: mode.latency ?? 10,
        }]
      })
      return resultEnvelope({ count: records.length, records })
    }

    return resultEnvelope(null)
  }) as typeof fetch

  return {
    clock,
    calls,
    modes,
    legacyFailures,
    rejectBatch,
    holdMetricRequests: () => {
      let release!: () => void
      metricRequestGate = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        metricRequestGate = null
        release()
      }
    },
    setOnline: (online) => {
      navigatorState.onLine = online
      if (online)
        windowTarget.dispatchEvent(new Event('online'))
    },
    setVisibility: (state) => {
      documentTarget.visibilityState = state
      documentTarget.dispatchEvent(new Event('visibilitychange'))
    },
    setMode: (entityId, taskId, mode) => modes.set(pairModeKey(entityId, String(taskId)), { ...mode }),
    restore: () => {
      runtime.requestManager.abortAll()
      runtime.resetSharedRpc()
      globalThis.fetch = originalFetch
      Date.now = originalDateNow
      if (originalWindow === undefined)
        delete (globalThis as Record<string, unknown>).window
      else
        (globalThis as Record<string, unknown>).window = originalWindow
      if (originalDocument === undefined)
        delete (globalThis as Record<string, unknown>).document
      else
        (globalThis as Record<string, unknown>).document = originalDocument
      if (originalLocalStorage === undefined)
        delete (globalThis as Record<string, unknown>).localStorage
      else
        (globalThis as Record<string, unknown>).localStorage = originalLocalStorage
      if (originalNavigatorDescriptor)
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
      else
        delete (globalThis as Record<string, unknown>).navigator
    },
  }
}

function buildPairs(nodeCount: number, taskIds: readonly number[], uniqueTasks = false): EffectiveNodePingPair[] {
  return Array.from({ length: nodeCount }, (_, nodeIndex) => taskIds.map((taskId, taskIndex) => ({
    nodeUuid: nodeUuid(nodeIndex),
    taskId: uniqueTasks ? taskId + nodeIndex * 10_000 + taskIndex : taskId,
    taskName: `Task ${taskId}`,
    intervalSeconds: 60,
  }))).flat()
}

async function waitFor(predicate: () => boolean, timeout = 8_000): Promise<void> {
  const deadline = performance.now() + timeout
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error('Timed out waiting for coordinator state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function settled(snapshots: readonly NodeCardPingPairSnapshot[]): boolean {
  return snapshots.length > 0 && snapshots.every(snapshot => !snapshot.refreshing && snapshot.status !== 'pending')
}

test.describe('task-grouped multi-Ping coordinator request budgets', () => {
  let runtime: CoordinatorRuntime
  let closeRuntime: (() => Promise<void>) | undefined

  test.beforeAll(async () => {
    const server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      root: process.cwd(),
      resolve: { alias: { '@': resolve(process.cwd(), 'src') } },
      server: { middlewareMode: true },
    })
    const coordinatorModule = await server.ssrLoadModule('/src/services/node-card-ping-coordinator.service.ts') as typeof import('../../src/services/node-card-ping-coordinator.service')
    const requestModule = await server.ssrLoadModule('/src/services/request.service.ts') as typeof import('../../src/services/request.service')
    const rpcModule = await server.ssrLoadModule('/src/utils/rpc.ts') as typeof import('../../src/utils/rpc')
    runtime = {
      NodeCardPingCoordinator: coordinatorModule.NodeCardPingCoordinator,
      requestManager: requestModule.requestManager,
      resetSharedRpc: rpcModule.resetSharedRpc,
    }
    closeRuntime = () => server.close()
  })

  test.afterAll(async () => {
    await closeRuntime?.()
  })

  test('groups shared tasks for 12x1/2/3, 30x3, and 50x3 while unique tasks remain pair-scoped', async () => {
    const harness = installRpcHarness(runtime)
    try {
      const coldEvidence: Array<Record<string, unknown>> = []
      const scenarios = [
        { nodes: 12, tasks: [101], chunks: 1 },
        { nodes: 12, tasks: [101, 202], chunks: 1 },
        { nodes: 12, tasks: [101, 202, 303], chunks: 1 },
        { nodes: 30, tasks: [101, 202, 303], chunks: 1 },
        { nodes: 50, tasks: [101, 202, 303], chunks: 2 },
      ] as const

      for (const scenario of scenarios) {
        globalThis.localStorage.clear()
        const coordinator = new runtime.NodeCardPingCoordinator()
        const pairs = buildPairs(scenario.nodes, scenario.tasks)
        const startedAt = performance.now()
        const subscription = coordinator.subscribe(pairs, { hours: 1, maxPoints: 60, bucketCount: 20, batchChunkSize: 32 })
        await waitFor(() => subscription.getSnapshots().some(snapshot => snapshot.status === 'data'))
        const firstMs = performance.now() - startedAt
        await waitFor(() => settled(subscription.getSnapshots()))
        const allMs = performance.now() - startedAt
        const debug = coordinator.getDebugSnapshot()
        const expectedBatchRequests = scenario.tasks.length * scenario.chunks
        expect(debug.targets).toBe(scenario.tasks.length)
        expect(debug.subscribers).toBe(pairs.length)
        expect(debug.schedulerSubscribers).toBe(scenario.tasks.length)
        expect(debug.timerCount).toBe(1)
        expect(debug.listenerCount).toBe(2)
        expect(debug.requestCounters.metricStatsBatch).toBeGreaterThanOrEqual(expectedBatchRequests)
        expect(debug.requestCounters.metricStatsBatch).toBeLessThanOrEqual(expectedBatchRequests * 2)
        expect(debug.requestCounters.metricSeriesBatch).toBeGreaterThanOrEqual(expectedBatchRequests)
        expect(debug.requestCounters.metricSeriesBatch).toBeLessThanOrEqual(expectedBatchRequests * 2)
        expect(debug.requestCounters).toMatchObject({ metricStatsPair: 0, metricSeriesPair: 0, legacyPair: 0 })
        coldEvidence.push({
          shape: `${scenario.nodes}x${scenario.tasks.length}`,
          firstMs: Number(firstMs.toFixed(2)),
          allMs: Number(allMs.toFixed(2)),
          subscribers: debug.subscribers,
          targets: debug.targets,
          timerCount: debug.timerCount,
          listenerCount: debug.listenerCount,
          requests: debug.requestCounters,
        })
        subscription.release()
        expect(coordinator.getDebugSnapshot()).toMatchObject({
          targets: 0,
          subscribers: 0,
          schedulerSubscribers: 0,
          timerCount: 0,
          listenerCount: 0,
          inflight: 0,
        })
      }

      const uniqueCoordinator = new runtime.NodeCardPingCoordinator()
      const uniquePairs = buildPairs(12, [101, 202, 303], true)
      const uniqueSubscription = uniqueCoordinator.subscribe(uniquePairs, { hours: 1, maxPoints: 60, bucketCount: 20 })
      await waitFor(() => settled(uniqueSubscription.getSnapshots()))
      const uniqueDebug = uniqueCoordinator.getDebugSnapshot()
      expect(uniqueDebug).toMatchObject({
        targets: 36,
        subscribers: 36,
        timerCount: 1,
        listenerCount: 2,
      })
      expect(uniqueDebug.requestCounters).toMatchObject({ metricStatsBatch: 0, metricSeriesBatch: 0, legacyPair: 0, aggregate: 0 })
      expect(uniqueDebug.requestCounters.metricStatsPair).toBeGreaterThanOrEqual(36)
      expect(uniqueDebug.requestCounters.metricStatsPair).toBeLessThanOrEqual(72)
      expect(uniqueDebug.requestCounters.metricSeriesPair).toBeGreaterThanOrEqual(36)
      expect(uniqueDebug.requestCounters.metricSeriesPair).toBeLessThanOrEqual(72)
      await test.info().attach('v2-performance-cold', { body: JSON.stringify({ cold: coldEvidence, unique12x3: {
        subscribers: uniqueDebug.subscribers,
        targets: uniqueDebug.targets,
        timerCount: uniqueDebug.timerCount,
        listenerCount: uniqueDebug.listenerCount,
        requests: uniqueDebug.requestCounters,
      } }), contentType: 'application/json' })
      uniqueSubscription.release()
      expect(uniqueCoordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0 })
    }
    finally {
      harness.restore()
    }
  })

  test('keeps exact pair identity, zero latency, 100% loss, independent error, missing, and recovery states', async () => {
    const harness = installRpcHarness(runtime)
    const coordinator = new runtime.NodeCardPingCoordinator()
    const entityId = nodeUuid(0)
    // Use an exact window distinct from the request-budget matrix above. The
    // production raw-Metric cache intentionally shares only identical windows.
    harness.clock.now += 24 * 60 * 60 * 1000
    harness.setMode(entityId, 101, { latency: 0, loss: 0 })
    harness.setMode(entityId, 202, { latency: null, loss: 1 })
    harness.setMode(entityId, 303, { metric: 'empty' })
    harness.setMode(entityId, 404, { metric: 'error' })
    harness.legacyFailures.add(entityId)
    const subscription = coordinator.subscribe(buildPairs(1, [101, 202, 303, 404]), {
      hours: 1,
      maxPoints: 60,
      bucketCount: 20,
    })
    try {
      await waitFor(() => {
        const statusByTask = new Map(subscription.getSnapshots().map(snapshot => [snapshot.taskId, snapshot.status]))
        return statusByTask.get('101') === 'data'
          && statusByTask.get('202') === 'data'
          && statusByTask.get('404') === 'error'
      })
      const byTask = new Map(subscription.getSnapshots().map(snapshot => [snapshot.taskId, snapshot]))
      expect(byTask.get('101')).toMatchObject({ status: 'data', avgLatency: 0, avgLoss: 0, taskId: '101', nodeUuid: entityId })
      expect(byTask.get('202')).toMatchObject({ status: 'data', avgLatency: null, avgLoss: 100, taskId: '202', nodeUuid: entityId })
      expect(byTask.get('303')?.samples).toHaveLength(0)
      expect(['pending', 'error']).toContain(byTask.get('303')?.status)
      expect(byTask.get('404')).toMatchObject({ status: 'error', taskId: '404', nodeUuid: entityId })
      expect(byTask.get('101')?.samples.every(sample => sample.taskId === '101' && sample.entityId === entityId)).toBe(true)
      expect(byTask.get('202')?.samples.every(sample => sample.taskId === '202' && sample.entityId === entityId)).toBe(true)

      harness.legacyFailures.delete(entityId)
      harness.setMode(entityId, 303, { latency: 33, loss: 0 })
      harness.clock.now += 45_000
      subscription.refreshNow()
      await waitFor(() => subscription.getSnapshots().find(snapshot => snapshot.taskId === '303')?.status === 'data')
      expect(subscription.getSnapshots().find(snapshot => snapshot.taskId === '303')).toMatchObject({
        status: 'data',
        avgLatency: 33,
        avgLoss: 0,
        source: 'metric',
      })
    }
    finally {
      subscription.release()
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0 })
      harness.restore()
    }
  })

  test('isolates one slow task and one timeout failure from a concurrently successful task', async () => {
    const harness = installRpcHarness(runtime)
    harness.clock.now += 36 * 60 * 60 * 1000
    const coordinator = new runtime.NodeCardPingCoordinator()
    const entityId = nodeUuid(0)
    harness.setMode(entityId, 1001, { latency: 11, loss: 0 })
    harness.setMode(entityId, 1002, { latency: 22, loss: 0, delayMs: 140 })
    harness.setMode(entityId, 1003, { metric: 'error', delayMs: 60, errorMessage: 'request timed out' })
    harness.legacyFailures.add(entityId)
    const subscription = coordinator.subscribe(buildPairs(1, [1001, 1002, 1003]), { hours: 1, maxPoints: 60, bucketCount: 20 })
    try {
      await waitFor(() => subscription.getSnapshots().find(snapshot => snapshot.taskId === '1001')?.status === 'data')
      expect(subscription.getSnapshots().find(snapshot => snapshot.taskId === '1001')).toMatchObject({ avgLatency: 11, status: 'data' })
      expect(subscription.getSnapshots().find(snapshot => snapshot.taskId === '1002')).toMatchObject({ status: 'pending', refreshing: true })

      await waitFor(() => subscription.getSnapshots().find(snapshot => snapshot.taskId === '1002')?.status === 'data'
        && subscription.getSnapshots().find(snapshot => snapshot.taskId === '1003')?.status === 'error')
      expect(subscription.getSnapshots().find(snapshot => snapshot.taskId === '1002')).toMatchObject({ avgLatency: 22, status: 'data' })
      expect(subscription.getSnapshots().find(snapshot => snapshot.taskId === '1003')).toMatchObject({
        status: 'error',
        taskId: '1003',
        nodeUuid: entityId,
      })
      expect(subscription.getSnapshots().find(snapshot => snapshot.taskId === '1003')?.error).toContain('request timed out')
      await waitFor(() => coordinator.getDebugSnapshot().inflight === 0)
    }
    finally {
      subscription.release()
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0, inflight: 0 })
      harness.restore()
    }
  })

  test('reuses memory and persistent exact-pair snapshots and keeps one shared scheduler through ten simulated minutes', async () => {
    const harness = installRpcHarness(runtime)
    const coordinator = new runtime.NodeCardPingCoordinator()
    const pairs = buildPairs(12, [101, 202, 303])
    const first = coordinator.subscribe(pairs, { hours: 1, maxPoints: 60, bucketCount: 20 })
    try {
      await waitFor(() => settled(first.getSnapshots()))
      first.release()

      const warmStartedAt = performance.now()
      const warm = coordinator.subscribe(pairs, { hours: 1, maxPoints: 60, bucketCount: 20 })
      expect(warm.getSnapshots().every(snapshot => snapshot.status === 'data')).toBe(true)
      const warmFirstPaintMs = performance.now() - warmStartedAt
      expect(coordinator.getDebugSnapshot().cacheHits).toBe(pairs.length)
      const warmBaseline = coordinator.getDebugSnapshot().requestCounters.metricStatsBatch
      await waitFor(() => coordinator.getDebugSnapshot().requestCounters.metricStatsBatch > warmBaseline)
      await waitFor(() => coordinator.getDebugSnapshot().inflight === 0)
      await new Promise(resolve => setTimeout(resolve, 20))

      coordinator.resetDebugCounters()
      for (let minute = 0; minute < 10; minute += 1) {
        const before = coordinator.getDebugSnapshot().requestCounters.metricStatsBatch
        harness.clock.now += 60_000
        warm.refreshNow()
        await waitFor(() => coordinator.getDebugSnapshot().requestCounters.metricStatsBatch > before
          && coordinator.getDebugSnapshot().inflight === 0)
      }
      const debug = coordinator.getDebugSnapshot()
      expect(debug).toMatchObject({ targets: 3, subscribers: 36, timerCount: 1, listenerCount: 2, inflight: 0 })
      expect(debug.requestCounters.metricStatsBatch).toBeGreaterThanOrEqual(30)
      expect(debug.requestCounters.metricStatsBatch).toBeLessThanOrEqual(60)
      expect(debug.requestCounters.metricSeriesBatch).toBeGreaterThanOrEqual(30)
      expect(debug.requestCounters.metricSeriesBatch).toBeLessThanOrEqual(60)

      ;(globalThis.window as EventTarget).dispatchEvent(new Event('online'))
      ;(globalThis.document as EventTarget).dispatchEvent(new Event('visibilitychange'))
      await waitFor(() => coordinator.getDebugSnapshot().inflight === 0)
      expect(coordinator.getDebugSnapshot()).toMatchObject({ timerCount: 1, listenerCount: 2 })
      const beforeUnmount = { ...coordinator.getDebugSnapshot().requestCounters }
      warm.release()
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0, inflight: 0 })
      await new Promise(resolve => setTimeout(resolve, 30))
      const afterUnmount = coordinator.getDebugSnapshot()
      expect(afterUnmount.requestCounters).toEqual(beforeUnmount)
      await test.info().attach('v2-performance-warm', { body: JSON.stringify({ warm12x3: {
        firstPaintMs: Number(warmFirstPaintMs.toFixed(2)),
        cacheHits: pairs.length,
      }, simulated10Minutes: {
        subscribers: debug.subscribers,
        targets: debug.targets,
        timerCount: debug.timerCount,
        listenerCount: debug.listenerCount,
        requests: debug.requestCounters,
      }, afterUnmount: {
        subscribers: afterUnmount.subscribers,
        targets: afterUnmount.targets,
        timerCount: afterUnmount.timerCount,
        listenerCount: afterUnmount.listenerCount,
        inflight: afterUnmount.inflight,
        requests: afterUnmount.requestCounters,
      } }), contentType: 'application/json' })

      const persistentCoordinator = new runtime.NodeCardPingCoordinator()
      const persisted = persistentCoordinator.subscribe([pairs[0]], { hours: 1, maxPoints: 60, bucketCount: 20 })
      expect(persisted.getSnapshots()[0]?.status).toBe('data')
      expect(persistentCoordinator.getDebugSnapshot().persistentCacheHits).toBe(1)
      persisted.release()
      expect(persistentCoordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0 })
    }
    finally {
      first.release()
      harness.restore()
    }
  })

  test('latches refreshNow when a late pair joins a task group during an in-flight refresh', async () => {
    const harness = installRpcHarness(runtime)
    harness.clock.now += 72 * 60 * 60 * 1000
    const coordinator = new runtime.NodeCardPingCoordinator()
    const firstPair = buildPairs(1, [808])[0]
    const latePair = { ...buildPairs(2, [808])[1] }
    harness.setMode(firstPair.nodeUuid, firstPair.taskId, { latency: 81, loss: 0 })
    harness.setMode(latePair.nodeUuid, latePair.taskId, { latency: 82, loss: 0 })
    const releaseRequests = harness.holdMetricRequests()
    const first = coordinator.subscribe([firstPair], { hours: 1, maxPoints: 60, bucketCount: 20 })
    let late: ReturnType<typeof coordinator.subscribe> | undefined
    try {
      await waitFor(() => coordinator.getDebugSnapshot().inflight === 1
        && harness.calls.some(call => call.method === 'public:getPingMetricStats'))
      late = coordinator.subscribe([latePair], { hours: 1, maxPoints: 60, bucketCount: 20 })
      expect(late.getSnapshots()[0]).toMatchObject({ status: 'pending', nodeUuid: latePair.nodeUuid, taskId: '808' })
      releaseRequests()

      await waitFor(() => settled(first.getSnapshots()) && settled(late!.getSnapshots()))
      expect(first.getSnapshots()[0]).toMatchObject({ status: 'data', avgLatency: 81 })
      expect(late.getSnapshots()[0]).toMatchObject({ status: 'data', avgLatency: 82 })
      const statsCalls = harness.calls.filter(call => call.method === 'public:getPingMetricStats')
      expect(statsCalls.length).toBeGreaterThanOrEqual(2)
      expect(statsCalls.slice(1).some(call => rpcEntityIds(call.params).includes(latePair.nodeUuid))).toBe(true)
    }
    finally {
      releaseRequests()
      late?.release()
      first.release()
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0, inflight: 0 })
      harness.restore()
    }
  })

  test('pauses explicit refreshes while hidden or offline and resumes on visibility and online events', async () => {
    const harness = installRpcHarness(runtime)
    harness.clock.now += 96 * 60 * 60 * 1000
    const coordinator = new runtime.NodeCardPingCoordinator()
    const subscription = coordinator.subscribe(buildPairs(3, [909]), { hours: 1, maxPoints: 60, bucketCount: 20 })
    try {
      await waitFor(() => settled(subscription.getSnapshots()) && coordinator.getDebugSnapshot().inflight === 0)
      await new Promise(resolve => setTimeout(resolve, 20))

      coordinator.resetDebugCounters()
      harness.setVisibility('hidden')
      harness.clock.now += 60_000
      subscription.refreshNow()
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(coordinator.getDebugSnapshot()).toMatchObject({ inflight: 0 })
      expect(coordinator.getDebugSnapshot().requestCounters).toMatchObject({ metricStatsBatch: 0, metricSeriesBatch: 0 })

      harness.setVisibility('visible')
      await waitFor(() => coordinator.getDebugSnapshot().requestCounters.metricStatsBatch > 0
        && coordinator.getDebugSnapshot().inflight === 0)

      coordinator.resetDebugCounters()
      harness.setOnline(false)
      harness.clock.now += 60_000
      subscription.refreshNow()
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(coordinator.getDebugSnapshot()).toMatchObject({ inflight: 0 })
      expect(coordinator.getDebugSnapshot().requestCounters).toMatchObject({ metricStatsBatch: 0, metricSeriesBatch: 0 })

      harness.setOnline(true)
      await waitFor(() => coordinator.getDebugSnapshot().requestCounters.metricStatsBatch > 0
        && coordinator.getDebugSnapshot().inflight === 0)
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 1, subscribers: 3, timerCount: 1, listenerCount: 2 })
    }
    finally {
      subscription.release()
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0, inflight: 0 })
      harness.restore()
    }
  })

  test('downgrades invalid entity_ids once to exact pairs without mixing entity or task identities', async () => {
    const harness = installRpcHarness(runtime)
    harness.clock.now += 48 * 60 * 60 * 1000
    harness.rejectBatch.value = true
    const coordinator = new runtime.NodeCardPingCoordinator()
    const pairs = buildPairs(3, [707])
    pairs.forEach((pair, index) => harness.setMode(pair.nodeUuid, pair.taskId, { latency: 70 + index, loss: index / 100 }))
    const subscription = coordinator.subscribe(pairs, { hours: 1, maxPoints: 60, bucketCount: 20 })
    try {
      await waitFor(() => settled(subscription.getSnapshots()))
      const snapshots = subscription.getSnapshots()
      expect(snapshots.map(snapshot => snapshot.avgLatency)).toEqual([70, 71, 72])
      for (const snapshot of snapshots) {
        expect(snapshot.samples.every(sample => sample.entityId === snapshot.nodeUuid && sample.taskId === snapshot.taskId)).toBe(true)
      }
      const counters = coordinator.getDebugSnapshot().requestCounters
      expect(counters.metricStatsBatch).toBe(1)
      expect(counters.metricSeriesBatch).toBe(1)
      expect(counters.metricStatsPair).toBeGreaterThanOrEqual(3)
      expect(counters.metricStatsPair).toBeLessThanOrEqual(6)
      expect(counters.metricSeriesPair).toBeGreaterThanOrEqual(3)
      expect(counters.metricSeriesPair).toBeLessThanOrEqual(6)
      expect(counters.legacyPair).toBe(0)
      expect(harness.calls.filter(call => call.method === 'public:getPingMetricStats' && Array.isArray(call.params.entity_ids))).toHaveLength(1)
      expect(harness.calls.filter(call => call.method === 'public:queryMetrics' && Array.isArray(call.params.entity_ids))).toHaveLength(1)
    }
    finally {
      subscription.release()
      expect(coordinator.getDebugSnapshot()).toMatchObject({ targets: 0, subscribers: 0, timerCount: 0, listenerCount: 0, inflight: 0 })
      harness.restore()
    }
  })
})

const UI_STABLE_STYLE = `
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .earth-globe-host canvas, .earth-globe-canvas { opacity: 0 !important; }
`

const CARD_SIZES = ['mini', 'compact', 'comfortable', 'large'] as const
const SHARED_TASK_IDS = [101, 202, 303] as const

function primaryCard(page: import('@playwright/test').Page) {
  return page.locator(`[data-node-card-uuid="${PRIMARY_NODE_UUID}"]`)
}

test.describe('multi-Ping node-card geometry and route persistence', () => {
  for (const size of CARD_SIZES) {
    for (const taskCount of [1, 2, 3] as const) {
      test(`${size} card contains ${taskCount} exact Ping task strip${taskCount > 1 ? 's' : ''} without overflow`, async ({ page }) => {
        const encoded = serializeNodeCardMultiPingConfig(config({
          global: { displayCount: taskCount, taskIds: SHARED_TASK_IDS.slice(0, taskCount) },
        }))
        await installKomariFixture(page, {
          hideEarth: true,
          nodeCardSize: size,
          nodeCount: 6,
          nodeCardPingDisplayConfigV2: encoded,
          nodeCardPingFixture: { metric: 'valid', legacy: 'valid', thirdSharedTask: true },
        })
        await page.goto('/')
        await page.addStyleTag({ content: UI_STABLE_STYLE })
        const card = primaryCard(page)
        const group = card.locator('[data-node-ping-mode="multi"]')
        await expect(card).toBeVisible()
        await expect(group).toHaveAttribute('data-node-ping-task-count', String(taskCount))
        await expect(group).toHaveAttribute('data-node-ping-display-count', String(taskCount))
        await expect(group).toHaveAttribute('data-node-ping-coverage', 'full')
        const strips = group.locator('[data-node-ping-task-id]')
        await expect(strips).toHaveCount(taskCount)
        await expect.poll(async () => strips.evaluateAll(elements => elements.map(element => element.getAttribute('data-node-ping-status'))))
          .toEqual(Array.from({ length: taskCount }).fill('data'))
        expect(await strips.evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-node-ping-task-id')))))
          .toEqual(SHARED_TASK_IDS.slice(0, taskCount))

        const assertGeometry = async () => {
          const cards = await page.locator('[data-node-card-uuid]').evaluateAll((cardElements) => {
            return cardElements.map((cardElement) => {
              const cardRect = cardElement.getBoundingClientRect()
              const groupElement = cardElement.querySelector('[data-node-ping-mode="multi"]')
              const groupRect = groupElement?.getBoundingClientRect()
              const stripRects = Array.from(cardElement.querySelectorAll('[data-node-ping-task-id]'), element => element.getBoundingClientRect())
              return {
                card: { left: cardRect.left, top: cardRect.top, right: cardRect.right, bottom: cardRect.bottom, height: cardRect.height },
                group: groupRect && { left: groupRect.left, top: groupRect.top, right: groupRect.right, bottom: groupRect.bottom },
                strips: stripRects.map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })),
                overflow: {
                  horizontal: cardElement.scrollWidth - cardElement.clientWidth,
                  vertical: cardElement.scrollHeight - cardElement.clientHeight,
                },
              }
            })
          })
          expect(cards).toHaveLength(6)
          for (const geometry of cards) {
            expect(geometry.group).toBeTruthy()
            expect(geometry.strips).toHaveLength(taskCount)
            expect(geometry.overflow.horizontal).toBeLessThanOrEqual(1)
            expect(geometry.overflow.vertical).toBeLessThanOrEqual(1)
            for (const strip of geometry.strips) {
              expect(strip.width).toBeGreaterThan(0)
              expect(strip.height).toBeGreaterThan(0)
              expect(strip.left).toBeGreaterThanOrEqual(geometry.card.left - 1)
              expect(strip.right).toBeLessThanOrEqual(geometry.card.right + 1)
              expect(strip.top).toBeGreaterThanOrEqual(geometry.card.top - 1)
              expect(strip.bottom).toBeLessThanOrEqual(geometry.card.bottom + 1)
            }
            for (let leftIndex = 0; leftIndex < geometry.strips.length; leftIndex += 1) {
              for (let rightIndex = leftIndex + 1; rightIndex < geometry.strips.length; rightIndex += 1) {
                const left = geometry.strips[leftIndex]
                const right = geometry.strips[rightIndex]
                const overlaps = left.left < right.right - 1
                  && left.right > right.left + 1
                  && left.top < right.bottom - 1
                  && left.bottom > right.top + 1
                expect(overlaps).toBe(false)
              }
            }
          }

          const rows = new Map<number, typeof cards>()
          for (const geometry of cards) {
            const rowTop = Math.round(geometry.card.top)
            rows.set(rowTop, [...(rows.get(rowTop) ?? []), geometry])
          }
          for (const row of rows.values()) {
            const heights = row.map(item => Math.round(item.card.height))
            expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
          }
        }

        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 768, height: 1024 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport)
          for (const dark of [false, true]) {
            await page.evaluate((enabled) => {
              document.documentElement.classList.toggle('dark', enabled)
            }, dark)
            await assertGeometry()
          }
        }

        await page.setViewportSize({ width: 1280, height: 900 })
        await page.evaluate(() => document.documentElement.classList.remove('dark'))

        await card.getByText('主控-洛杉矶', { exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/instance/${PRIMARY_NODE_UUID}$`))
        await page.getByRole('button', { name: '返回首页' }).click()
        await expect(page).toHaveURL(/\/$/)
        await expect(primaryCard(page).locator('[data-node-ping-mode="multi"]')).toHaveAttribute('data-node-ping-task-count', String(taskCount))
      })
    }
  }
})

test.describe('v2 multi-Ping visual baselines', () => {
  test('large three-task cards remain balanced on light desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCardSize: 'large',
      nodeCount: 6,
      nodeCardPingDisplayConfigV2: serializeNodeCardMultiPingConfig(config({
        global: { displayCount: 3, taskIds: SHARED_TASK_IDS },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', thirdSharedTask: true },
    })
    await page.goto('/')
    await page.addStyleTag({ content: UI_STABLE_STYLE })
    const strips = primaryCard(page).locator('[data-node-ping-task-id]')
    await expect(strips).toHaveCount(3)
    await expect.poll(async () => strips.evaluateAll(elements => elements.map(element => element.getAttribute('data-node-ping-status'))))
      .toEqual(['data', 'data', 'data'])
    await expect(page).toHaveScreenshot('v2-multiping-large-3-light-desktop.png', { fullPage: false })
  })

  test('mini three-task cards remain readable on dark mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installKomariFixture(page, {
      dark: true,
      hideEarth: true,
      nodeCardSize: 'mini',
      nodeCount: 3,
      nodeCardPingDisplayConfigV2: serializeNodeCardMultiPingConfig(config({
        global: { displayCount: 3, taskIds: SHARED_TASK_IDS },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', thirdSharedTask: true },
    })
    await page.goto('/')
    await page.addStyleTag({ content: UI_STABLE_STYLE })
    const strips = primaryCard(page).locator('[data-node-ping-task-id]')
    await expect(strips).toHaveCount(3)
    await expect.poll(async () => strips.evaluateAll(elements => elements.map(element => element.getAttribute('data-node-ping-status'))))
      .toEqual(['data', 'data', 'data'])
    await expect(page).toHaveScreenshot('v2-multiping-mini-3-dark-mobile.png', { fullPage: false })
  })

  test('administrator Ping Center keeps global and server configuration legible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCount: 6,
      nodeCardPingDisplayConfigV2: serializeNodeCardMultiPingConfig(config({
        global: { displayCount: 3, taskIds: SHARED_TASK_IDS },
      })),
      nodeCardPingFixture: { metric: 'valid', legacy: 'valid', thirdSharedTask: true },
    })
    await page.goto('/?view=pingsettings&pingtab=config')
    await page.addStyleTag({ content: UI_STABLE_STYLE })
    await expect(page.getByTestId('ping-center-global-config')).toBeVisible()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
    await expect(page).toHaveScreenshot('v2-ping-center-admin-desktop.png', { fullPage: false })
  })
})

test.describe('Ping center route, access, and hidden-entry contracts', () => {
  test('visitor overview is public and never calls an admin endpoint', async ({ page }) => {
    const adminRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/admin/'))
        adminRequests.push(request.url())
    })
    await installKomariFixture(page, { adminAccess: 'guest', nodeCount: 3 })
    await page.goto('/?view=pingsettings&pingtab=overview')
    await expect(page.getByTestId('ping-center-overview')).toBeVisible()
    await expect(page.getByTestId('ping-center-public-task-1')).toBeVisible()
    expect(adminRequests).toEqual([])
  })

  test('fresh visitor config access stays read-protected and never loads admin data', async ({ page }) => {
    const adminRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/admin/'))
        adminRequests.push(request.url())
    })
    await installKomariFixture(page, { adminAccess: 'guest' })
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('ping-center-settings-login-required')).toBeVisible()
    expect(adminRequests).toEqual([])
  })

  test('403 admin probe shows the forbidden state without exposing editable rows', async ({ page }) => {
    await installKomariFixture(page, { adminAccess: 'forbidden' })
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('node-ping-binding-forbidden')).toBeVisible()
    await expect(page.locator('[data-testid^="node-binding-row-"]')).toHaveCount(0)
  })

  test('hidden entry removes only navigation while a direct admin route remains usable', async ({ page }) => {
    const encoded = serializeNodeCardMultiPingConfig(config())
    await installKomariFixture(page, {
      adminAccess: 'admin',
      hidePingTaskBindingEntry: true,
      nodeCardPingDisplayConfigV2: encoded,
    })
    await page.goto('/')
    await expect(page.getByTestId('ping-center-entry')).toHaveCount(0)
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('ping-center-global-config')).toBeVisible()
    await expect(page.getByTestId(`node-binding-row-${PRIMARY_NODE_UUID}`)).toBeVisible()
  })

  test('admin route canonicalizes the legacy view key and preserves unrelated query parameters', async ({ page }) => {
    await installKomariFixture(page, { adminAccess: 'admin' })
    await page.goto('/?view=node-ping-bindings&source=legacy&pingtab=config')
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('pingsettings')
    expect(new URL(page.url()).searchParams.get('source')).toBe('legacy')
    await expect(page.getByTestId('ping-center-global-config')).toBeVisible()
  })

  test('logout during an in-flight save clears ready data and rapid relogin uses a fresh admin request', async ({ page }) => {
    let adminPingRequests = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/admin/ping')
        adminPingRequests += 1
    })
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCardPingDisplayConfigV2: serializeNodeCardMultiPingConfig(config()),
      nodeCardPingFixture: { metric: 'valid' },
    })
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('ping-center-global-config')).toBeVisible()
    await page.getByTestId('ping-center-global-count').selectOption('2')
    await page.getByTestId('ping-center-global-slot-2').selectOption('202')
    await page.getByTestId('ping-center-save-preview').click()
    await expect(page.getByTestId('ping-center-save-dialog')).toBeVisible()

    const releaseAdmin = fixture.pauseAdminResponses()
    const freshAdminRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/admin/ping')
    await page.getByTestId('ping-center-save-confirm').click()
    await freshAdminRequest
    await page.getByTestId('ping-center-tab-overview').evaluate((element: HTMLElement) => element.click())
    fixture.setAdminAccess('guest')
    releaseAdmin()

    await expect(page.getByTestId('ping-center-overview')).toBeVisible()
    await expect(page.getByTestId('ping-center-tab-settings')).toHaveCount(0)
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('ping-center-settings-login-required')).toBeVisible()
    await expect(page.locator('[data-testid^="node-binding-row-"]')).toHaveCount(0)
    expect(fixture.getThemeSaveCount()).toBe(0)

    const requestsBeforeRelogin = adminPingRequests
    fixture.setAdminAccess('admin')
    await page.reload()
    await expect(page.getByTestId('ping-center-global-config')).toBeVisible()
    await expect(page.getByTestId('ping-center-global-count')).toHaveValue('1')
    expect(adminPingRequests).toBeGreaterThan(requestsBeforeRelogin)
    expect(fixture.getThemeSaveCount()).toBe(0)
  })

  test('save refetches and merges fresh settings, preserves legacy bytes, verifies v2, and clears an orphan override', async ({ page }) => {
    const legacyBytes = `{ "${PRIMARY_NODE_UUID}" : 202 }`
    const orphanUuid = '00000000-0000-4000-8000-000000000099'
    const initialV2 = serializeNodeCardMultiPingConfig(config({
      nodes: { [orphanUuid]: { mode: 'custom', displayCount: 1, taskIds: [101] } },
    }))
    const fixture = await installKomariFixture(page, {
      adminAccess: 'admin',
      nodeCount: 3,
      nodeCardPingTaskBindings: legacyBytes,
      nodeCardPingDisplayConfigV2: initialV2,
      nodeCardPingFixture: { metric: 'valid', thirdSharedTask: true },
    })
    fixture.setThemeSetting('concurrentUnrelated', { revision: 1 })
    await page.goto('/?view=pingsettings&pingtab=config')
    await expect(page.getByTestId('ping-center-orphan-config')).toBeVisible()

    // Simulate a concurrent setting writer after the manager's initial read.
    fixture.setThemeSetting('concurrentUnrelated', { revision: 2, owner: 'other-writer' })
    await page.getByTestId('ping-center-orphan-config').getByRole('button', { name: '移除失效覆盖' }).click()
    await expect(page.getByTestId('ping-center-orphan-config')).toHaveCount(0)
    await page.getByTestId('ping-center-save-preview').click()
    await expect(page.getByTestId('ping-center-save-dialog')).toBeVisible()
    await page.getByTestId('ping-center-save-confirm').click()
    await expect.poll(() => fixture.getThemeSaveCount()).toBe(1)

    const saved = fixture.getSavedThemeSettings()
    expect(saved.nodeCardPingTaskBindings).toBe(legacyBytes)
    expect(saved.concurrentUnrelated).toEqual({ revision: 2, owner: 'other-writer' })
    const savedInspection = inspectNodeCardMultiPingConfig(saved.nodeCardPingDisplayConfigV2)
    expect(savedInspection).toMatchObject({ status: 'valid' })
    expect(savedInspection.config?.nodes[orphanUuid]).toBeUndefined()
    expect(serializeNodeCardMultiPingConfig(savedInspection.config!)).toBe(saved.nodeCardPingDisplayConfigV2)
  })
})
