// autocompact — the watcher.
//
// The event stream tells us when a model call finished
// (`session.usage.updated`). At that point we compute the session's live context
// size and, if it has reached the session's threshold, request compaction via
// the session API. Compaction is admitted immediately and runs at the next safe
// point, so by the time the model nears its real limit the session has already
// been trimmed well below it.
//
// Guards:
// - checks are coalesced per session (`minCheckIntervalMs`);
// - a compaction in flight blocks further requests for that session, using the
//   `session.compaction.*` lifecycle events as the release signal, with a
//   timeout in case those events are missed (e.g. a reload mid-compaction);
// - sessions without an effective threshold are skipped after one cheap walk.
import { computeUsed, shouldCompact } from "./used"
import type { Resolver, ThresholdStore } from "./thresholds"

export type WatcherDeps = {
  resolver: Resolver
  store: ThresholdStore
  log: (...args: unknown[]) => void
  minCheckIntervalMs: number
  compactionTimeoutMs: number
  /** Request compaction for a session (runs at the next safe point). */
  compact: (sessionID: string) => Promise<void>
  /** Read the session's messages (for the live context size). */
  context: (sessionID: string) => Promise<readonly unknown[]>
  now?: () => number
}

export interface Watcher {
  handleRaw(raw: unknown): void
  handleEvent(type: string, data: Record<string, unknown>): void
  /** Run a check immediately (tests / manual). Returns true if compaction was requested. */
  checkNow(sessionID: string): Promise<boolean>
  inFlight(sessionID: string): boolean
  dispose(): void
}

export type NormalizedEvent = { type: string; data: Record<string, unknown> }

export function normalizeEvent(raw: unknown): NormalizedEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const source = raw as Record<string, unknown>
  const type = typeof source.type === "string" ? source.type : undefined
  if (!type) return undefined
  const rawData = source.data
  const data =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : source
  return { type, data }
}

function readSessionID(data: Record<string, unknown>): string | undefined {
  const value = data.sessionID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function createWatcher(deps: WatcherDeps): Watcher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inflight = new Map<string, ReturnType<typeof setTimeout>>()

  function markInFlight(sessionID: string): void {
    const existing = inflight.get(sessionID)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      inflight.delete(sessionID)
      deps.log(`compaction guard timed out (${sessionID}) — re-arming`)
    }, deps.compactionTimeoutMs)
    inflight.set(sessionID, timer)
  }

  function clearInFlight(sessionID: string): void {
    const timer = inflight.get(sessionID)
    if (timer) clearTimeout(timer)
    inflight.delete(sessionID)
  }

  async function runCheck(sessionID: string): Promise<boolean> {
    if (inflight.has(sessionID)) return false

    let threshold: number | undefined
    try {
      threshold = await deps.resolver.effective(sessionID)
    } catch (error) {
      deps.log(`resolve threshold failed (${sessionID}): ${String(error)}`)
      return false
    }
    if (threshold === undefined) return false

    let messages: readonly unknown[]
    try {
      messages = await deps.context(sessionID)
    } catch (error) {
      deps.log(`read session context failed (${sessionID}): ${String(error)}`)
      return false
    }

    const used = computeUsed(messages)
    if (!shouldCompact(used, threshold)) return false

    markInFlight(sessionID)
    try {
      await deps.compact(sessionID)
      deps.log(`compaction requested (${sessionID}) — used ${used} >= threshold ${threshold}`)
      return true
    } catch (error) {
      clearInFlight(sessionID)
      deps.log(`compaction request failed (${sessionID}): ${String(error)}`)
      return false
    }
  }

  function schedule(sessionID: string): void {
    if (inflight.has(sessionID)) return
    if (timers.has(sessionID)) return
    const timer = setTimeout(() => {
      timers.delete(sessionID)
      void runCheck(sessionID)
    }, deps.minCheckIntervalMs)
    timers.set(sessionID, timer)
  }

  function forget(sessionID: string): void {
    const timer = timers.get(sessionID)
    if (timer) clearTimeout(timer)
    timers.delete(sessionID)
    clearInFlight(sessionID)
    deps.resolver.invalidate(sessionID)
    void deps.store.clear(sessionID).catch((error) => deps.log(`clear threshold failed (${sessionID}): ${String(error)}`))
  }

  function handleEvent(type: string, data: Record<string, unknown>): void {
    const sessionID = readSessionID(data)
    switch (type) {
      case "session.usage.updated":
        if (sessionID) schedule(sessionID)
        return
      case "session.compaction.started":
        if (sessionID) {
          // Another instance may already own this compaction; just guard.
          markInFlight(sessionID)
        }
        return
      case "session.compaction.ended":
      case "session.compaction.failed":
        if (sessionID) clearInFlight(sessionID)
        return
      case "session.deleted":
        if (sessionID) forget(sessionID)
        return
      default:
        return
    }
  }

  return {
    handleRaw(raw) {
      const event = normalizeEvent(raw)
      if (event) handleEvent(event.type, event.data)
    },
    handleEvent,
    checkNow: runCheck,
    inFlight: (sessionID) => inflight.has(sessionID),
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const timer of inflight.values()) clearTimeout(timer)
      inflight.clear()
    },
  }
}
