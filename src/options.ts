// autocompact — options.
//
// Field-by-field type-checked parsing of `ctx.options`; invalid values fall
// back to the default with a warning so a typo never breaks loading.
import { log } from "./log"

export type Options = {
  /** Master switch. When false the plugin still loads but does nothing. */
  enabled: boolean
  /** Minimum gap between usage-driven checks for one session (coalescing). */
  minCheckIntervalMs: number
  /** Safety timeout that clears an in-flight compaction guard. */
  compactionTimeoutMs: number
  /** Log every raw event (payload verification aid). */
  debugEvents: boolean
}

export const DEFAULTS: Options = {
  enabled: true,
  minCheckIntervalMs: 2_000,
  compactionTimeoutMs: 300_000,
  debugEvents: false,
}

function readNumber(
  input: Record<string, unknown>,
  key: keyof Options,
  min: number,
  apply: (value: number) => void,
): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= min) {
    apply(raw)
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

function readBoolean(
  input: Record<string, unknown>,
  key: keyof Options,
  apply: (value: boolean) => void,
): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "boolean") {
    apply(raw)
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

export function parseOptions(raw: unknown): Options {
  const options: Options = { ...DEFAULTS }

  if (raw === undefined || raw === null) return options
  if (typeof raw !== "object" || Array.isArray(raw)) {
    log(`options: expected an object, got ${Array.isArray(raw) ? "array" : typeof raw} — using defaults`)
    return options
  }

  const input = raw as Record<string, unknown>
  readBoolean(input, "enabled", (v) => (options.enabled = v))
  readBoolean(input, "debugEvents", (v) => (options.debugEvents = v))
  readNumber(input, "minCheckIntervalMs", 0, (v) => (options.minCheckIntervalMs = v))
  readNumber(input, "compactionTimeoutMs", 0, (v) => (options.compactionTimeoutMs = v))

  // Unknown keys are intentionally ignored.
  return options
}
