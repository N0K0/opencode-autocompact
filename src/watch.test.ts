import { describe, expect, test } from "bun:test"
import { createWatcher, normalizeEvent } from "./watch"
import { makeResolver, makeThresholdStore, type StorageLike } from "./thresholds"

function fakeStorage(): StorageLike {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
  }
}

const assistant = (input: number, read = 0) => ({
  type: "assistant",
  tokens: { input, output: 1, reasoning: 0, cache: { read, write: 0 } },
})

type Harness = {
  watcher: ReturnType<typeof createWatcher>
  compactions: string[]
  cleared: string[]
  store: ReturnType<typeof makeThresholdStore>
  resolver: ReturnType<typeof makeResolver>
}

function harness(opts: {
  parentOf?: Record<string, string | undefined>
  threshold?: number
  messages?: readonly unknown[]
  minCheckIntervalMs?: number
}): Harness {
  const store = makeThresholdStore(fakeStorage())
  const resolver = makeResolver(store, async (id) => opts.parentOf?.[id])
  const compactions: string[] = []
  const cleared: string[] = []

  const watcher = createWatcher({
    resolver,
    store: {
      get: (id) => store.get(id),
      setLimit: (id, t) => store.setLimit(id, t),
      setOff: (id) => store.setOff(id),
      clear: async (id) => {
        cleared.push(id)
        await store.clear(id)
      },
    },
    log: () => {},
    minCheckIntervalMs: opts.minCheckIntervalMs ?? 0,
    compactionTimeoutMs: 60_000,
    compact: async (id) => {
      compactions.push(id)
    },
    context: async () => opts.messages ?? [assistant(600_000)],
  })

  return { watcher, compactions, cleared, store, resolver }
}

describe("normalizeEvent", () => {
  test("unwraps the SSE envelope and tolerates bare shapes", () => {
    expect(normalizeEvent({ id: "evt_1", type: "session.usage.updated", data: { sessionID: "ses_1" } })).toEqual({
      type: "session.usage.updated",
      data: { sessionID: "ses_1" },
    })
    // bare shape (no `data`): the whole envelope doubles as the payload
    expect(normalizeEvent({ type: "session.deleted", sessionID: "ses_2" })).toEqual({
      type: "session.deleted",
      data: { type: "session.deleted", sessionID: "ses_2" },
    })
    expect(normalizeEvent(null)).toBeUndefined()
    expect(normalizeEvent({ data: {} })).toBeUndefined()
  })
})

describe("watcher", () => {
  test("compacts once the live context reaches the threshold", async () => {
    const h = harness({ parentOf: { ses_1: undefined }, messages: [assistant(400_000), assistant(500_000)] })
    await h.store.setLimit("ses_1", 500_000)

    expect(await h.watcher.checkNow("ses_1")).toBe(true)
    expect(h.compactions).toEqual(["ses_1"])
    expect(h.watcher.inFlight("ses_1")).toBe(true)
  })

  test("does nothing below the threshold", async () => {
    const h = harness({ messages: [assistant(499_999)] })
    await h.store.setLimit("ses_1", 500_000)

    expect(await h.watcher.checkNow("ses_1")).toBe(false)
    expect(h.compactions).toEqual([])
  })

  test("stays out of the way when no threshold applies", async () => {
    const h = harness({ messages: [assistant(900_000)] })
    expect(await h.watcher.checkNow("ses_1")).toBe(false)
    expect(h.compactions).toEqual([])
  })

  test("a child inherits its parent's threshold", async () => {
    const h = harness({ parentOf: { ses_child: "ses_parent", ses_parent: undefined }, messages: [assistant(500_000)] })
    await h.store.setLimit("ses_parent", 500_000)

    expect(await h.watcher.checkNow("ses_child")).toBe(true)
    expect(h.compactions).toEqual(["ses_child"])
  })

  test("in-flight guard blocks a second request until compaction ends", async () => {
    const h = harness({ messages: [assistant(600_000)] })
    await h.store.setLimit("ses_1", 500_000)

    expect(await h.watcher.checkNow("ses_1")).toBe(true)
    expect(await h.watcher.checkNow("ses_1")).toBe(false) // guarded
    expect(h.compactions).toEqual(["ses_1"])

    h.watcher.handleEvent("session.compaction.ended", { sessionID: "ses_1" })
    expect(h.watcher.inFlight("ses_1")).toBe(false)
    expect(await h.watcher.checkNow("ses_1")).toBe(true)
    expect(h.compactions).toEqual(["ses_1", "ses_1"])
  })

  test("a failed compaction releases the guard", async () => {
    const h = harness({ messages: [assistant(600_000)] })
    await h.store.setLimit("ses_1", 500_000)
    await h.watcher.checkNow("ses_1")
    h.watcher.handleEvent("session.compaction.failed", { sessionID: "ses_1" })
    expect(h.watcher.inFlight("ses_1")).toBe(false)
  })

  test("usage.updated schedules a coalesced check", async () => {
    const h = harness({ messages: [assistant(600_000)], minCheckIntervalMs: 1 })
    await h.store.setLimit("ses_1", 500_000)

    watcherLoop: {
      h.watcher.handleEvent("session.usage.updated", { sessionID: "ses_1" })
      h.watcher.handleEvent("session.usage.updated", { sessionID: "ses_1" })
      await Bun.sleep(20)
    }
    expect(h.compactions).toEqual(["ses_1"])
  })

  test("session.deleted clears stored state", async () => {
    const h = harness({ messages: [assistant(100)] })
    await h.store.setLimit("ses_1", 500_000)
    expect(await h.store.get("ses_1")).toEqual({ kind: "limit", threshold: 500_000 })

    h.watcher.handleEvent("session.deleted", { sessionID: "ses_1" })
    await Bun.sleep(5)
    expect(h.cleared).toContain("ses_1")
    expect(await h.store.get("ses_1")).toBeUndefined()
  })
})
