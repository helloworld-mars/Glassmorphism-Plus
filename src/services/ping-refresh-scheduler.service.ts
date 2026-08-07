import { CACHE_CONFIG } from '@/constants/cache'

export interface PingRefreshOutcome {
  advanced: boolean
  latestSampleAt: number | null
  taskIntervalMs: number
}

export interface PingRefreshSubscription {
  refreshNow: () => void
  release: () => void
}

interface PingRefreshTarget {
  key: string
  refresh: () => Promise<PingRefreshOutcome>
  subscribers: number
  latestSampleAt: number | null
  taskIntervalMs: number
  nextRefreshAt: number
  retryIndex: number
  running: boolean
}

const REFRESH_CONFIG = CACHE_CONFIG.nodePingSummary.refresh

function normalizeTaskInterval(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.max(REFRESH_CONFIG.schedulerTick, Math.floor(value))
    : REFRESH_CONFIG.heartbeat
}

/**
 * One page-wide scheduler for selected Ping tasks. It separates the three-minute
 * render buckets from network refresh timing and shares one timer across cards.
 */
export class PingRefreshScheduler {
  private readonly targets = new Map<string, PingRefreshTarget>()
  private timer: ReturnType<typeof setInterval> | null = null
  private listening = false

  subscribe(
    key: string,
    refresh: () => Promise<PingRefreshOutcome>,
    initial: { latestSampleAt?: number | null, taskIntervalMs?: number } = {},
  ): PingRefreshSubscription {
    const existing = this.targets.get(key)
    const target = existing ?? {
      key,
      refresh,
      subscribers: 0,
      latestSampleAt: initial.latestSampleAt ?? null,
      taskIntervalMs: normalizeTaskInterval(initial.taskIntervalMs ?? REFRESH_CONFIG.heartbeat),
      nextRefreshAt: Date.now(),
      retryIndex: 0,
      running: false,
    }

    target.refresh = refresh
    target.subscribers += 1
    if (initial.latestSampleAt !== undefined && initial.latestSampleAt !== null)
      target.latestSampleAt = Math.max(target.latestSampleAt ?? 0, initial.latestSampleAt)
    if (initial.taskIntervalMs !== undefined)
      target.taskIntervalMs = normalizeTaskInterval(initial.taskIntervalMs)
    this.targets.set(key, target)
    this.ensureActive()
    void this.tick()

    let released = false
    return {
      refreshNow: () => {
        if (released)
          return
        target.nextRefreshAt = Date.now()
        void this.tick()
      },
      release: () => {
        if (released)
          return
        released = true
        target.subscribers = Math.max(0, target.subscribers - 1)
        if (target.subscribers === 0)
          this.targets.delete(key)
        this.stopIfIdle()
      },
    }
  }

  private ensureActive(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick()
      }, REFRESH_CONFIG.schedulerTick)
    }
    if (this.listening || typeof window === 'undefined' || typeof document === 'undefined')
      return

    window.addEventListener('online', this.handleOnline)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.listening = true
  }

  private stopIfIdle(): void {
    if (this.targets.size)
      return
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (!this.listening || typeof window === 'undefined' || typeof document === 'undefined')
      return

    window.removeEventListener('online', this.handleOnline)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.listening = false
  }

  private readonly handleOnline = (): void => {
    this.refreshAllNow()
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible')
      this.refreshAllNow()
  }

  private refreshAllNow(): void {
    const now = Date.now()
    for (const target of this.targets.values())
      target.nextRefreshAt = now
    void this.tick()
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    const dueTargets = [...this.targets.values()]
      .filter(target => target.subscribers > 0 && !target.running && target.nextRefreshAt <= now)

    await Promise.allSettled(dueTargets.map(target => this.runTarget(target)))
  }

  private async runTarget(target: PingRefreshTarget): Promise<void> {
    target.running = true
    try {
      const outcome = await target.refresh()
      const now = Date.now()
      target.taskIntervalMs = normalizeTaskInterval(outcome.taskIntervalMs)
      if (outcome.latestSampleAt !== null)
        target.latestSampleAt = Math.max(target.latestSampleAt ?? 0, outcome.latestSampleAt)

      const expectedNextSampleAt = target.latestSampleAt === null
        ? null
        : target.latestSampleAt + target.taskIntervalMs + REFRESH_CONFIG.sampleWriteGrace

      if (outcome.advanced) {
        target.retryIndex = 0
        target.nextRefreshAt = Math.max(now + REFRESH_CONFIG.schedulerTick, expectedNextSampleAt ?? now)
        return
      }

      if (expectedNextSampleAt !== null && now < expectedNextSampleAt) {
        target.retryIndex = 0
        target.nextRefreshAt = expectedNextSampleAt
        return
      }

      const retryDelay = REFRESH_CONFIG.retryDelays[target.retryIndex]
      if (retryDelay !== undefined) {
        target.retryIndex += 1
        target.nextRefreshAt = now + retryDelay
        return
      }

      target.retryIndex = 0
      target.nextRefreshAt = now + Math.max(REFRESH_CONFIG.heartbeat, target.taskIntervalMs)
    }
    catch {
      const now = Date.now()
      const retryDelay = REFRESH_CONFIG.retryDelays[target.retryIndex]
      if (retryDelay !== undefined) {
        target.retryIndex += 1
        target.nextRefreshAt = now + retryDelay
      }
      else {
        target.retryIndex = 0
        target.nextRefreshAt = now + Math.max(REFRESH_CONFIG.heartbeat, target.taskIntervalMs)
      }
    }
    finally {
      target.running = false
    }
  }
}

export const pingRefreshScheduler = new PingRefreshScheduler()
