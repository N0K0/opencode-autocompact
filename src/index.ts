// autocompact — OpenCode V2 server plugin.
//
// Claude Code's autocompact, but with a per-session knob: `/autocompact 500k`
// makes this session (and its children) compact once the live context reaches
// 500k tokens, well below the model's real limit. `/autocompact off` reverts to
// OpenCode's normal auto-compaction. With no `/autocompact`, the plugin stays
// completely out of the way.
//
// See README.md for the behaviour and the runtime facts this relies on.
import { basename } from "node:path"
import { Plugin } from "@opencode/plugin"
import { handleAutocompact } from "./command"
import { log } from "./log"
import { parseOptions } from "./options"
import { registerAutocompactRpc } from "./rpc"
import { makeResolver, makeThresholdStore } from "./thresholds"
import { createWatcher } from "./watch"

let moduleLoads = 0
let instanceSeq = 0

export default Plugin.define({
  id: "autocompact",
  async setup(ctx: Plugin.Context) {
    const options = parseOptions(ctx.options)
    const tag = `${basename(ctx.location.directory)}#${++instanceSeq}@${Math.random().toString(36).slice(2, 6)}`
    const instanceLog = (...args: unknown[]) => log(`(${tag})`, ...args)

    instanceLog(`module load #${++moduleLoads}`)
    instanceLog(`setup — OpenCode ${ctx.app.version} · location=${ctx.location.directory} · project=${ctx.location.project.id}`)
    instanceLog(`options: ${JSON.stringify(options)}`)

    if (!options.enabled) {
      instanceLog("disabled by options — doing nothing")
      return () => {}
    }

    const store = makeThresholdStore(ctx.storage)
    const resolver = makeResolver(store, async (sessionID) => {
      try {
        const info = await ctx.session.get({ sessionID })
        return info.parentID
      } catch {
        return undefined
      }
    })

    const modelLimit = async (sessionID: string): Promise<number | undefined> => {
      try {
        const info = await ctx.session.get({ sessionID })
        const model = info.model
        if (!model) return undefined
        const { data } = await ctx.model.list()
        const match = data.find((entry) => entry.providerID === model.providerID && entry.id === model.id)
        const limit = match?.limit?.context
        return typeof limit === "number" && limit > 0 ? limit : undefined
      } catch (error) {
        instanceLog(`model limit lookup failed (${sessionID}): ${String(error)}`)
        return undefined
      }
    }

    const watcher = createWatcher({
      resolver,
      store,
      log: instanceLog,
      minCheckIntervalMs: options.minCheckIntervalMs,
      compactionTimeoutMs: options.compactionTimeoutMs,
      compact: async (sessionID) => {
        await ctx.session.compact({ sessionID })
      },
      context: async (sessionID) => {
        return await ctx.session.context({ sessionID })
      },
    })

    // `/autocompact` — register, don't fail the whole plugin if it throws.
    let commandRegistration: { dispose(): Promise<void> } | undefined
    try {
      commandRegistration = await ctx.command.transform((editor) => {
        editor.add({
          name: "autocompact",
          description: "Set this session's compaction threshold (e.g. /autocompact 500k, /autocompact off)",
          execute: async (input) => {
            try {
              const result = await handleAutocompact(input.sessionID, input.prompt?.text ?? "", {
                store,
                resolver,
                modelLimit,
              })
              instanceLog(result.ok ? result.message : `rejected: ${result.message}`)
              // Nudge the TUI chip/panel so they reflect the new threshold.
              if (result.ok && (result.action === "set" || result.action === "off")) {
                rpcRegistration?.emit("updated", { sessionID: input.sessionID })
              }
            } catch (error) {
              instanceLog(`command failed (${input.sessionID}): ${String(error)}`)
            }
          },
        })
      })
      instanceLog("command registered (/autocompact)")
    } catch (error) {
      instanceLog(`command registration failed: ${String(error)}`)
    }

    // RPC for the TUI chip / side panel; best-effort so a failure never blocks
    // the compaction behaviour itself.
    const rpcRegistration = await registerAutocompactRpc(ctx, {
      resolver,
      modelLimit,
      context: async (sessionID) => await ctx.session.context({ sessionID }),
      log: instanceLog,
    }).catch((error) => {
      instanceLog(`rpc registration failed: ${String(error)}`)
      return undefined
    })

    const ac = new AbortController()
    void runEventLoop(ctx, watcher, options, instanceLog, ac.signal)

    let cleaned = false
    return async () => {
      if (cleaned) return
      cleaned = true
      instanceLog("cleanup")
      ac.abort()
      watcher.dispose()
      if (rpcRegistration) {
        try {
          await rpcRegistration.dispose()
        } catch (error) {
          instanceLog(`rpc dispose failed: ${String(error)}`)
        }
      }
      if (commandRegistration) {
        try {
          await commandRegistration.dispose()
        } catch (error) {
          instanceLog(`command dispose failed: ${String(error)}`)
        }
      }
      instanceLog("unloaded")
    }
  },
})

async function runEventLoop(
  ctx: Plugin.Context,
  watcher: ReturnType<typeof createWatcher>,
  opts: { debugEvents: boolean },
  instanceLog: (...args: unknown[]) => void,
  signal: AbortSignal,
): Promise<void> {
  instanceLog("event loop started")
  try {
    for await (const raw of ctx.event.subscribe({ signal })) {
      if (signal.aborted) break
      try {
        if (opts.debugEvents) instanceLog("event", JSON.stringify(raw))
        watcher.handleRaw(raw)
      } catch (error) {
        instanceLog("event handler error", String(error))
      }
    }
    instanceLog(`event loop ended (aborted=${signal.aborted})`)
  } catch (error) {
    instanceLog(`event loop failed (aborted=${signal.aborted})`, String(error))
  }
}
