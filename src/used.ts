// autocompact — "how full is this session right now".
//
// `Session.Info.tokens` and the `session.usage.updated` event carry *cumulative*
// session usage, which keeps growing across every request. The number we care
// about is the live context size: how big the prompt sent on the latest model
// call was. That lives on each assistant message as `tokens`, and equals
// `input + cache.read + cache.write` (the same measure OpenCode's own tooling
// uses for context occupancy).
//
// So we look at the most recent assistant message that recorded usage. Messages
// before the last compaction are irrelevant — we only ever read the newest one.

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Live context tokens contributed by a single session message, if it has usage. */
export function messageUsedTokens(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined
  const record = message as Record<string, unknown>
  if (record.type !== "assistant") return undefined

  const tokens = record.tokens
  if (!tokens || typeof tokens !== "object") return undefined
  const tokenRecord = tokens as Record<string, unknown>

  const input = num(tokenRecord.input)
  if (input === undefined) return undefined

  const cache = tokenRecord.cache && typeof tokenRecord.cache === "object"
    ? (tokenRecord.cache as Record<string, unknown>)
    : undefined
  const read = cache ? num(cache.read) ?? 0 : 0
  const write = cache ? num(cache.write) ?? 0 : 0

  return input + read + write
}

/**
 * Current context size for a session, from its message list. Returns the newest
 * assistant message with recorded usage, skipping anything that failed or was
 * aborted without a usage record.
 */
export function computeUsed(messages: readonly unknown[] | undefined): number | undefined {
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const used = messageUsedTokens(messages[index])
    if (used !== undefined) return used
  }
  return undefined
}

/** Whether the session has reached (or passed) the configured threshold. */
export function shouldCompact(used: number | undefined, threshold: number | undefined): boolean {
  return used !== undefined && threshold !== undefined && used >= threshold
}
