import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { registerAutocompactRpc } from "./rpc"
import { makeResolver, makeThresholdStore, type StorageLike } from "./thresholds"

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

/** Minimal `ctx.rpc.register` stand-in that captures the handlers. */
function fakeCtx() {
  const state: { handlers?: Record<string, (raw: unknown) => Promise<unknown>> } = {}
  const ctx = {
    rpc: {
      async register(_definition: unknown, handlers: Record<string, (raw: unknown) => Promise<unknown>>) {
        state.handlers = handlers
        return {
          async dispose() {},
          events: { async emit() {} },
        }
      },
    },
  } as unknown as Plugin.Context
  return { ctx, state }
}

const assistants = [
  { type: "user", text: "hi" },
  { type: "assistant", tokens: { input: 1000, cache: { read: 200, write: 50 } } },
]

function deps(store: ReturnType<typeof makeThresholdStore>, parents: Record<string, string | undefined>) {
  const logs: string[] = []
  return {
    logs,
    deps: {
      resolver: makeResolver(store, async (id) => parents[id]),
      modelLimit: async () => 1_000_000,
      context: async () => assistants,
      log: (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    },
  }
}

describe("registerAutocompactRpc status", () => {
  const parents: Record<string, string | undefined> = { child: "root", grandchild: "child", root: undefined }

  test("maps an inherited limit, the model limit and the live context size", async () => {
    const store = makeThresholdStore(fakeStorage())
    await store.setLimit("root", 500_000)
    const { ctx, state } = fakeCtx()
    await registerAutocompactRpc(ctx, deps(store, parents).deps)

    const result = (await state.handlers!.status({ sessionID: "child" })) as Record<string, unknown>
    expect(result).toEqual({
      sessionID: "child",
      source: "limit",
      own: false,
      threshold: 500_000,
      limit: 1_000_000,
      used: 1250,
    })
  })

  test("reports own vs inherited and off", async () => {
    const store = makeThresholdStore(fakeStorage())
    const { ctx, state } = fakeCtx()
    await registerAutocompactRpc(ctx, deps(store, parents).deps)

    const none = (await state.handlers!.status({ sessionID: "child" })) as Record<string, unknown>
    expect(none.source).toBe("none")
    expect(none.own).toBe(false)
    expect(none.threshold).toBeNull()

    await store.setOff("child")
    const off = (await state.handlers!.status({ sessionID: "grandchild" })) as Record<string, unknown>
    expect(off.source).toBe("off")
    expect(off.own).toBe(false)
  })

  test("rejects a missing sessionID", async () => {
    const store = makeThresholdStore(fakeStorage())
    const { ctx, state } = fakeCtx()
    await registerAutocompactRpc(ctx, deps(store, parents).deps)
    await expect(state.handlers!.status({})).rejects.toThrow("sessionID")
  })
})
