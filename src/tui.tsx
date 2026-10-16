/** @jsxImportSource @opentui/solid */
// autocompact — OpenCode V2 CLI (TUI) plugin.
//
// Contributions:
// - `prompt.footer.status`: a compact chip appended next to OpenCode's own
//   context indicator (used/threshold and live context size) — `append`, never
//   `replace`, so the built-in readout stays put;
// - `session.panel` (name `autocompact.status`): the same numbers in detail
//   ("Autocompact: open side panel");
// - subscribes to the RPC `updated` event so both refresh the moment
//   `/autocompact` changes the threshold.
//
// The threshold itself lives on the server plugin (it owns storage); this file
// only reads it over RPC and maps the numbers to OpenTUI elements.
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { Context } from "@opencode/plugin/tui/plugin"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { log } from "./log"
import { formatTokens } from "./parse"
import { AutocompactRpc, type RpcStatus } from "./rpc"

/** Defensive theme reader: unknown token shapes degrade to no color. */
function themeColor(theme: unknown, path: string): string | undefined {
  let node: unknown = theme
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === "string" ? node : undefined
}

/** The one-line footer chip, or undefined when autocompact is idle (nothing to say). */
function chipLabel(status: RpcStatus | undefined): string | undefined {
  if (!status || status.source === "none") return undefined
  if (status.source === "off") return "autocompact off"
  const threshold = status.threshold !== null ? formatTokens(status.threshold) : "?"
  if (status.used === null) return `autocompact ≤${threshold}`
  return `autocompact ${formatTokens(status.used)}/${threshold}`
}

function modeLabel(status: RpcStatus): string {
  if (status.source === "off") return "off (normal auto)"
  if (status.source === "limit") return "threshold"
  return "idle (normal auto)"
}

function sourceLabel(status: RpcStatus): string {
  if (status.source !== "limit") return "—"
  return status.own ? "this session" : "inherited"
}

export default Plugin.define({
  id: "autocompact.tui",
  setup(context) {
    try {
      return register(context)
    } catch (error) {
      log("tui", `setup failed: ${String(error)}`)
      return () => {}
    }
  },
})

function register(context: Context) {
  log("tui", "setup", context.app.version ?? "")
  const rpc = context.client.rpc(AutocompactRpc)
  // Snapshot per session; only `status` populates it, so it never goes stale
  // without a matching refresh.
  const [statuses, setStatuses] = createSignal<Record<string, RpcStatus>>({})

  const notify = (message: string, variant: "info" | "warning" | "error" | "success") => {
    try {
      context.ui.toast.show({ title: "autocompact", message, variant })
    } catch (error) {
      log("tui", `toast failed: ${String(error)}`)
    }
  }

  const refresh = async (sessionID: string) => {
    try {
      const result = (await rpc.status({ sessionID })) as RpcStatus | undefined
      if (!result || result.sessionID !== sessionID) return
      setStatuses((previous) => ({ ...previous, [sessionID]: result }))
    } catch (error) {
      log("tui", `refresh(${sessionID}) failed: ${String(error)}`)
    }
  }

  const offUpdated = rpc.events.on("updated", (event: { data?: unknown }) => {
    const sessionID = (event.data as { sessionID?: unknown } | undefined)?.sessionID
    if (typeof sessionID === "string") void refresh(sessionID)
  })

  // ---- footer chip --------------------------------------------------------

  function Chip(props: { sessionID?: string }) {
    const themed = usePlugin()
    createEffect(() => {
      const sessionID = props.sessionID
      if (sessionID) void refresh(sessionID)
    })
    const label = () => (props.sessionID ? chipLabel(statuses()[props.sessionID]) : undefined)
    return (
      <Show when={label()}>
        {(text: () => string) => <text fg={themeColor(themed.theme, "text.subdued")}>{text()}</text>}
      </Show>
    )
  }

  // ---- side panel ---------------------------------------------------------

  function StatusPanel(props: { panel: PanelInput }) {
    const themed = usePlugin()
    const sessionID = () => props.panel.sessionID
    const status = () => statuses()[sessionID()]

    createEffect(() => {
      void refresh(sessionID())
    })
    // Live context size changes with every turn; poll while the panel is open.
    const poll = setInterval(() => void refresh(sessionID()), 3000)
    onCleanup(() => clearInterval(poll))

    const base = () => themeColor(themed.theme, "text.base")
    const muted = () => themeColor(themed.theme, "text.muted")
    const accent = () => themeColor(themed.theme, "text.action.primary.base") ?? base()
    const line = (label: string, value: string) => (
      <text fg={base()}>{label.padEnd(13) + value}</text>
    )
    const lines = (status: RpcStatus): Array<[string, string]> => [
      ["mode", modeLabel(status)],
      ["threshold", status.threshold !== null ? formatTokens(status.threshold) : "—"],
      ["source", sourceLabel(status)],
      ["used", status.used !== null ? formatTokens(status.used) : "—"],
      ["model limit", status.limit !== null ? formatTokens(status.limit) : "unknown"],
    ]

    return (
      <box flexDirection="column">
        <text fg={accent()}>autocompact</text>
        <Show when={status()} fallback={<text fg={muted()}>loading…</text>}>
          {(value: () => RpcStatus) => (
            <box flexDirection="column">{lines(value()).map(([label, text]) => line(label, text))}</box>
          )}
        </Show>
      </box>
    )
  }

  // ---- slots, commands ----------------------------------------------------

  const disposeChip = context.ui.slot({
    append: "prompt.footer.status",
    render: (input) => <Chip sessionID={input.sessionID} />,
  })
  const disposePanel = context.ui.slot({
    append: "session.panel",
    render: (panel: PanelInput) => (
      <Show when={panel.name === "autocompact.status"}>
        <StatusPanel panel={panel} />
      </Show>
    ),
  })
  log("tui", "slots registered (prompt.footer.status, session.panel autocompact.status)")

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "autocompact.open-panel",
        title: "Autocompact: open side panel",
        description: "Show this session's compaction threshold and live context use",
        group: "Autocompact",
        palette: true,
        run: () => {
          if (!context.ui.panel.open("autocompact.status")) {
            notify("Open a session to see autocompact", "warning")
          }
        },
      },
    ],
  }))

  log("tui", "ready")
  return () => {
    offUpdated()
    disposeChip()
    disposePanel()
    log("tui", "disposed")
  }
}
