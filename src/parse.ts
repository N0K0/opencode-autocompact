// autocompact — argument parsing.
//
// `/autocompact 500k`, `/autocompact 500000`, `/autocompact 1m`,
// `/autocompact` (status), `/autocompact off` (revert to normal auto).

export type Parsed =
  | { kind: "status" }
  | { kind: "off" }
  | { kind: "limit"; value: number }
  | { kind: "invalid"; reason: string }

export const OFF_WORDS = new Set(["off", "disable", "disabled", "none", "auto", "default"])

const NUM_RE = /^(\d+(?:\.\d+)?)([km])?$/i

/**
 * Parse a user-supplied compaction threshold.
 *
 * Accepts plain integers (`500000`), `k`/`m` suffixes (`500k`, `1m`, case
 * insensitive, optional space before the suffix) and the words in {@link
 * OFF_WORDS}. Empty input asks for status.
 */
export function parseThreshold(input: string | undefined): Parsed {
  const text = (input ?? "").trim()
  if (!text) return { kind: "status" }

  const compacted = text.replace(/[_\s]/g, "")
  if (OFF_WORDS.has(compacted.toLowerCase())) return { kind: "off" }

  const match = NUM_RE.exec(compacted)
  if (!match) {
    return { kind: "invalid", reason: `cannot parse ${JSON.stringify(text)} as a token count` }
  }

  const value = Number(match[1])
  const suffix = match[2]?.toLowerCase()
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1
  const tokens = Math.round(value * multiplier)

  if (!Number.isFinite(tokens) || tokens <= 0) {
    return { kind: "invalid", reason: "threshold must be a positive token count" }
  }
  return { kind: "limit", value: tokens }
}

/** Human-friendly rendering used in logs: 500000 -> "500k", 1000000 -> "1M". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`
  }
  return String(value)
}
