// autocompact — RPC contract + server registration.
//
// The TUI (./tui.tsx) imports `AutocompactRpc` to render the threshold chip and
// the side panel; `/autocompact` on the server emits `updated` so both refresh
// the moment the threshold changes. Schemas are portable JSON-schema
// descriptors (the plugin handshake cannot carry effect schemas), so the
// handler validates its input explicitly.
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import type { Resolver } from "./thresholds"
import { computeUsed } from "./used"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const objectOutput = { type: "object", additionalProperties: true } as const

export const AutocompactRpc = Rpc.define({
  id: "autocompact",
  methods: {
    /** Effective threshold, where it came from, the model limit and the live context size. */
    status: { input: sessionInput, output: objectOutput },
  },
  events: {
    /** `/autocompact` changed this session's threshold (set or off). */
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      } as const,
    },
  },
})

export interface RpcDeps {
  resolver: Resolver
  /** Model context limit for the session, if known. */
  modelLimit: (sessionID: string) => Promise<number | undefined>
  /** Read the session's messages (for the live context size). */
  context: (sessionID: string) => Promise<readonly unknown[]>
  log: (...args: unknown[]) => void
}

export interface AutocompactRpcRegistration {
  dispose(): Promise<void>
  /** Fire-and-forget event emission (failures are logged, never thrown). */
  emit(name: "updated", payload: Record<string, unknown>): void
}

/** Shape returned by the `status` method; mirrored by the TUI. */
export type RpcStatus = {
  sessionID: string
  /** "limit" = threshold set, "off" = explicitly disabled here, "none" = plugin idle. */
  source: "limit" | "off" | "none"
  /** True when the threshold was set on this session rather than inherited. */
  own: boolean
  threshold: number | null
  limit: number | null
  used: number | null
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid input: expected an object")
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid input: "${field}" must be a non-empty string`)
  }
  return value
}

export async function registerAutocompactRpc(
  ctx: Plugin.Context,
  deps: RpcDeps,
): Promise<AutocompactRpcRegistration> {
  let emitEvent: (name: "updated", payload: Record<string, unknown>) => Promise<void> = async () => {}

  const registration = await ctx.rpc.register(AutocompactRpc, {
    status: async (raw) => {
      const sessionID = requireString(requireObject(raw).sessionID, "sessionID")
      let resolution: Awaited<ReturnType<Resolver["resolve"]>>
      try {
        resolution = await deps.resolver.resolve(sessionID)
      } catch (error) {
        deps.log(`rpc status (${sessionID}): resolve failed: ${String(error)}`)
        throw error
      }

      const limit = await deps.modelLimit(sessionID)

      let used: number | undefined
      try {
        used = computeUsed(await deps.context(sessionID))
      } catch (error) {
        deps.log(`rpc status (${sessionID}): context lookup failed: ${String(error)}`)
      }

      const status: RpcStatus = {
        sessionID,
        source: resolution.kind === "none" ? "none" : resolution.kind,
        own: resolution.kind === "none" ? false : resolution.own,
        threshold: resolution.kind === "limit" ? resolution.threshold : null,
        limit: limit ?? null,
        used: used ?? null,
      }
      return status
    },
  })

  emitEvent = async (name, payload) => {
    try {
      await registration.events.emit(name, payload)
    } catch (error) {
      deps.log(`rpc emit ${name} failed: ${String(error)}`)
    }
  }

  return {
    dispose: () => registration.dispose(),
    emit: (name, payload) => {
      void emitEvent(name, payload)
    },
  }
}
