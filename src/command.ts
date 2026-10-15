// autocompact — the `/autocompact` command.
//
//   /autocompact 500k    set this session's compaction threshold (inherited by children)
//   /autocompact 500000  same, plain token count
//   /autocompact 1m      suffix form
//   /autocompact         report the effective threshold and the model's limit
//   /autocompact off     revert this session (and descendants) to normal auto
//
// The command never submits a prompt; it only records state. Feedback is
// logged (`<data>/opencode/log/autocompact.log`) rather than shown in the TUI.
import { formatTokens, parseThreshold } from "./parse"
import type { Resolver, ThresholdStore } from "./thresholds"

export type CommandDeps = {
  store: ThresholdStore
  resolver: Resolver
  /** Model context limit for the session, if known. */
  modelLimit: (sessionID: string) => Promise<number | undefined>
  /** `compaction.keep.tokens` if exposed, for a "can't make room" warning. */
  keepTokens?: () => Promise<number | undefined>
}

export type CommandResult =
  | { ok: true; action: "status"; threshold?: number; limit?: number; message: string }
  | { ok: true; action: "off"; message: string }
  | { ok: true; action: "set"; threshold: number; limit?: number; message: string }
  | { ok: false; action: "invalid"; message: string }

export async function handleAutocompact(
  sessionID: string,
  argument: string,
  deps: CommandDeps,
): Promise<CommandResult> {
  const parsed = parseThreshold(argument)

  if (parsed.kind === "status") {
    const threshold = await deps.resolver.effective(sessionID)
    const limit = await deps.modelLimit(sessionID)
    const message =
      `status (${sessionID}): threshold=${threshold === undefined ? "auto (plugin idle)" : formatTokens(threshold)}` +
      ` limit=${limit === undefined ? "unknown" : formatTokens(limit)}`
    return { ok: true, action: "status", threshold, limit, message }
  }

  if (parsed.kind === "off") {
    await deps.store.setOff(sessionID)
    deps.resolver.invalidate()
    return { ok: true, action: "off", message: `disabled for ${sessionID} and its children — normal auto-compaction applies` }
  }

  if (parsed.kind === "invalid") {
    return { ok: false, action: "invalid", message: `invalid argument: ${parsed.reason}` }
  }

  const limit = await deps.modelLimit(sessionID)
  if (limit !== undefined && parsed.value >= limit) {
    return {
      ok: false,
      action: "invalid",
      message:
        `threshold ${formatTokens(parsed.value)} must be lower than the model limit ` +
        `${formatTokens(limit)}; refusing to set`,
    }
  }

  await deps.store.setLimit(sessionID, parsed.value)
  deps.resolver.invalidate()

  let warning = ""
  try {
    const keep = await deps.keepTokens?.()
    if (keep !== undefined && parsed.value <= keep) {
      warning = ` (warning: <= compaction.keep.tokens ${formatTokens(keep)}, little room to trim)`
    }
  } catch {
    // keep lookup is best-effort
  }

  return {
    ok: true,
    action: "set",
    threshold: parsed.value,
    limit,
    message:
      `compaction threshold set to ${formatTokens(parsed.value)} for ${sessionID} and its children` +
      ` (model limit ${limit === undefined ? "unknown" : formatTokens(limit)})${warning}`,
  }
}
