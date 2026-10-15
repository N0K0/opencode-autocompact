import { describe, expect, test } from "bun:test"
import { handleAutocompact, type CommandDeps } from "./command"
import { makeResolver, makeThresholdStore, type StorageLike } from "./thresholds"

function setup(modelLimitValue: number | undefined = 1_000_000, keep?: number): CommandDeps & {
  store: ReturnType<typeof makeThresholdStore>
  effective: (id: string) => Promise<number | undefined>
} {
  const map = new Map<string, unknown>()
  const storage: StorageLike = {
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
  const store = makeThresholdStore(storage)
  const resolver = makeResolver(store, async () => undefined)
  return {
    store,
    resolver,
    modelLimit: async () => modelLimitValue,
    keepTokens: keep === undefined ? undefined : async () => keep,
    effective: (id) => resolver.effective(id),
  }
}

describe("handleAutocompact", () => {
  test("sets a threshold from a k-suffixed value", async () => {
    const deps = setup(1_000_000)
    const result = await handleAutocompact("ses_1", "500k", deps)
    expect(result.ok).toBe(true)
    expect(result.action).toBe("set")
    expect(await deps.effective("ses_1")).toBe(500_000)
  })

  test("sets a threshold from a plain number", async () => {
    const deps = setup(1_000_000)
    await handleAutocompact("ses_1", "500000", deps)
    expect(await deps.effective("ses_1")).toBe(500_000)
  })

  test("rejects values at or above the model limit", async () => {
    const deps = setup(500_000)
    const result = await handleAutocompact("ses_1", "500k", deps)
    expect(result.ok).toBe(false)
    expect(await deps.effective("ses_1")).toBeUndefined()
  })

  test("off overrides inheritance and reverts to auto", async () => {
    const deps = setup(1_000_000)
    await handleAutocompact("ses_1", "300k", deps)
    const result = await handleAutocompact("ses_1", "off", deps)
    expect(result).toMatchObject({ ok: true, action: "off" })
    expect(await deps.effective("ses_1")).toBeUndefined()
  })

  test("status reports the effective threshold and the limit", async () => {
    const deps = setup(1_000_000)
    await handleAutocompact("ses_1", "500k", deps)
    const result = await handleAutocompact("ses_1", "", deps)
    expect(result).toMatchObject({ ok: true, action: "status", threshold: 500_000, limit: 1_000_000 })
  })

  test("invalid input is reported, not stored", async () => {
    const deps = setup(1_000_000)
    const result = await handleAutocompact("ses_1", "banana", deps)
    expect(result.ok).toBe(false)
    expect(result.action).toBe("invalid")
    expect(await deps.effective("ses_1")).toBeUndefined()
  })
})
