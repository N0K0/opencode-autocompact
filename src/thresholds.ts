// autocompact — per-session thresholds and inheritance.
//
// A threshold is stored against the session where `/autocompact` was run and is
// inherited by that session's descendants (children/subagents) by walking the
// `parentID` chain. An explicit `off` marker stops the walk and disables the
// plugin for that session and its descendants, falling back to OpenCode's own
// auto-compaction.

export type Entry =
  | { kind: "limit"; threshold: number }
  | { kind: "off" }

/** Minimal shape of the plugin storage we depend on (kept injectable for tests). */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface ThresholdStore {
  get(sessionID: string): Promise<Entry | undefined>
  setLimit(sessionID: string, threshold: number): Promise<void>
  setOff(sessionID: string): Promise<void>
  clear(sessionID: string): Promise<void>
}

const KEY_PREFIX = "autocompact/threshold/"

function keyFor(sessionID: string): string {
  return `${KEY_PREFIX}${sessionID}`
}

/** Validate a stored value defensively — storage survives across reloads. */
export function decodeEntry(raw: unknown): Entry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.kind === "off") return { kind: "off" }
  if (record.kind === "limit") {
    const threshold = record.threshold
    if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0) {
      return { kind: "limit", threshold }
    }
  }
  return undefined
}

export function makeThresholdStore(storage: StorageLike): ThresholdStore {
  return {
    async get(sessionID) {
      return decodeEntry(await storage.get(keyFor(sessionID)))
    },
    async setLimit(sessionID, threshold) {
      await storage.set(keyFor(sessionID), { kind: "limit", threshold })
    },
    async setOff(sessionID) {
      await storage.set(keyFor(sessionID), { kind: "off" })
    },
    async clear(sessionID) {
      await storage.remove(keyFor(sessionID))
    },
  }
}

/** Resolve a session's `parentID` (used to inherit from ancestors). */
export type SessionParentLookup = (sessionID: string) => Promise<string | undefined>

export interface Resolver {
  /** Effective threshold, or undefined when the plugin should stay out of the way. */
  effective(sessionID: string): Promise<number | undefined>
  /** Drop the memoized results (call after any threshold write or delete). */
  invalidate(sessionID?: string): void
}

const MAX_DEPTH = 64

export function makeResolver(store: ThresholdStore, lookupParent: SessionParentLookup): Resolver {
  const cache = new Map<string, number | undefined>()

  async function resolve(sessionID: string): Promise<number | undefined> {
    const seen = new Set<string>()
    let current: string | undefined = sessionID
    let depth = 0

    while (current && depth < MAX_DEPTH && !seen.has(current)) {
      seen.add(current)
      const entry = await store.get(current)
      if (entry) return entry.kind === "off" ? undefined : entry.threshold
      current = await lookupParent(current)
      depth += 1
    }
    return undefined
  }

  return {
    async effective(sessionID) {
      if (cache.has(sessionID)) return cache.get(sessionID)
      const value = await resolve(sessionID)
      cache.set(sessionID, value)
      return value
    },
    invalidate(sessionID) {
      if (sessionID === undefined) cache.clear()
      else cache.delete(sessionID)
    },
  }
}
