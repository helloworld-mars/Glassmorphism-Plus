import type { MaybeRefOrGetter } from 'vue'
import type {
  EffectiveNodePingPair,
  NodeCardPingCoordinatorSubscription,
  NodeCardPingPairSnapshot,
} from '@/types/node-card-ping'
import { computed, onScopeDispose, shallowRef, toValue, watch } from 'vue'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { nodeCardPingCoordinator } from '@/services/node-card-ping-coordinator.service'

export interface NodeMultiPingTaskInput {
  taskId: string | number
  taskName?: string
  intervalSeconds?: number
}

export interface UseNodeMultiPingStatsOptions {
  hours?: MaybeRefOrGetter<number>
  maxPoints?: MaybeRefOrGetter<number | undefined>
  bucketCount?: MaybeRefOrGetter<number | undefined>
  batchChunkSize?: MaybeRefOrGetter<number | undefined>
  enabled?: MaybeRefOrGetter<boolean>
  retainSnapshotWhenDisabled?: MaybeRefOrGetter<boolean>
}

/**
 * Vue lifecycle bridge for the page-wide task-grouped Ping coordinator.
 * Multiple card instances that resolve to the same task/window share one
 * scheduler target and one stable entity batch.
 */
export function useNodeMultiPingStats(
  nodeUuid: MaybeRefOrGetter<string>,
  tasks: MaybeRefOrGetter<readonly NodeMultiPingTaskInput[]>,
  options: UseNodeMultiPingStatsOptions = {},
) {
  const snapshots = shallowRef<readonly NodeCardPingPairSnapshot[]>([])
  let activeSubscription: NodeCardPingCoordinatorSubscription | null = null

  const resolved = computed(() => {
    const uuid = toValue(nodeUuid).trim().toLowerCase()
    const pairs: EffectiveNodePingPair[] = toValue(tasks).map(task => ({
      nodeUuid: uuid,
      taskId: task.taskId,
      taskName: task.taskName,
      intervalSeconds: task.intervalSeconds,
    }))
    return {
      enabled: options.enabled === undefined ? true : Boolean(toValue(options.enabled)),
      retainSnapshotWhenDisabled: options.retainSnapshotWhenDisabled === undefined
        ? false
        : Boolean(toValue(options.retainSnapshotWhenDisabled)),
      pairs,
      window: {
        hours: options.hours === undefined ? 1 : toValue(options.hours),
        maxPoints: options.maxPoints === undefined
          ? PING_SUMMARY_MAX_COUNT
          : toValue(options.maxPoints),
        bucketCount: options.bucketCount === undefined ? undefined : toValue(options.bucketCount),
        batchChunkSize: options.batchChunkSize === undefined ? undefined : toValue(options.batchChunkSize),
      },
    }
  })

  const stop = watch(
    resolved,
    (value, _, onCleanup) => {
      activeSubscription?.release()
      activeSubscription = null
      if (!value.enabled || !value.pairs.length || !value.pairs[0]?.nodeUuid) {
        if (!value.retainSnapshotWhenDisabled)
          snapshots.value = []
        return
      }

      snapshots.value = []

      let subscription: NodeCardPingCoordinatorSubscription | null = null
      const sync = () => {
        if (activeSubscription === subscription && subscription)
          snapshots.value = [...subscription.getSnapshots()]
      }
      subscription = nodeCardPingCoordinator.subscribe(value.pairs, value.window, sync)
      activeSubscription = subscription
      sync()

      onCleanup(() => {
        subscription?.release()
        if (activeSubscription === subscription)
          activeSubscription = null
      })
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    stop()
    activeSubscription?.release()
    activeSubscription = null
  })

  const snapshotsByTaskId = computed<ReadonlyMap<string, NodeCardPingPairSnapshot>>(() => new Map(
    snapshots.value.map(snapshot => [snapshot.taskId, snapshot]),
  ))

  return {
    snapshots,
    snapshotsByTaskId,
    loading: computed(() => snapshots.value.some(snapshot => snapshot.status === 'pending' || snapshot.refreshing)),
    hasData: computed(() => snapshots.value.some(snapshot => snapshot.status === 'data' || snapshot.status === 'stale')),
    stale: computed(() => snapshots.value.some(snapshot => snapshot.stale)),
    error: computed(() => snapshots.value.find(snapshot => snapshot.status === 'error')?.error
      ?? snapshots.value.find(snapshot => snapshot.error)?.error
      ?? null),
    refreshNow: () => activeSubscription?.refreshNow(),
    getDebugSnapshot: () => nodeCardPingCoordinator.getDebugSnapshot(),
  }
}
