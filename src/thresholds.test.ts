import { describe, expect, test } from "bun:test"
import { decodeEntry, makeResolver, makeThresholdStore, type StorageLike } from "./thresholds"

function fakeStorage(): StorageLike & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
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

describe("decodeEntry", () => {
  test("accepts valid shapes and rejects junk", () => {
    expect(decodeEntry({ kind: "limit", threshold: 1000 })).toEqual({ kind: "limit", threshold: 1000 })
    expect(decodeEntry({ kind: "off" })).toEqual({ kind: "off" })
    expect(decodeEntry({ kind: "limit", threshold: -1 })).toBeUndefined()
    expect(decodeEntry({ kind: "limit" })).toBeUndefined()
    expect(decodeEntry(null)).toBeUndefined()
    expect(decodeEntry("nope")).toBeUndefined()
  })
})

describe("resolver inheritance", () => {
  // root -> child -> grandchild
  const parents: Record<string, string | undefined> = { child: "root", grandchild: "child", root: undefined }

  test("inherits the nearest ancestor threshold", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    await store.setLimit("root", 500_000)

    expect(await resolver.effective("root")).toBe(500_000)
    expect(await resolver.effective("child")).toBe(500_000)
    expect(await resolver.effective("grandchild")).toBe(500_000)
  })

  test("a nearer threshold wins", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    await store.setLimit("root", 500_000)
    await store.setLimit("child", 200_000)

    expect(await resolver.effective("grandchild")).toBe(200_000)
  })

  test("off stops the walk and disables descendants; a nearer limit wins over a farther off", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    await store.setLimit("root", 500_000)
    await store.setOff("child")

    expect(await resolver.effective("child")).toBeUndefined()
    expect(await resolver.effective("grandchild")).toBeUndefined()
    expect(await resolver.effective("root")).toBe(500_000)
  })

  test("cache returns stale values until invalidated", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    expect(await resolver.effective("child")).toBeUndefined()

    await store.setLimit("root", 300_000)
    expect(await resolver.effective("child")).toBeUndefined() // still cached

    resolver.invalidate()
    expect(await resolver.effective("child")).toBe(300_000)
  })

  test("cycles do not hang", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => (id === "a" ? "b" : "a"))
    expect(await resolver.effective("a")).toBeUndefined()
  })
})

describe("resolver.resolve", () => {
  // root -> child -> grandchild
  const parents: Record<string, string | undefined> = { child: "root", grandchild: "child", root: undefined }

  test("reports the entry kind and whether it is the session's own", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    await store.setLimit("root", 500_000)

    expect(await resolver.resolve("root")).toEqual({ kind: "limit", threshold: 500_000, own: true })
    expect(await resolver.resolve("child")).toEqual({ kind: "limit", threshold: 500_000, own: false })
    expect(await resolver.resolve("grandchild")).toEqual({ kind: "limit", threshold: 500_000, own: false })
  })

  test("off is reported too, with its own/inherited flag", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    await store.setOff("child")

    expect(await resolver.resolve("child")).toEqual({ kind: "off", own: true })
    expect(await resolver.resolve("grandchild")).toEqual({ kind: "off", own: false })
  })

  test("an unconfigured session resolves to none", async () => {
    const store = makeThresholdStore(fakeStorage())
    const resolver = makeResolver(store, async (id) => parents[id])
    expect(await resolver.resolve("grandchild")).toEqual({ kind: "none" })
  })
})
