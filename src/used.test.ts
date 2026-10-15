import { describe, expect, test } from "bun:test"
import { computeUsed, messageUsedTokens, shouldCompact } from "./used"

const assistant = (input: number, read = 0, write = 0) => ({
  type: "assistant",
  tokens: { input, output: 10, reasoning: 0, cache: { read, write } },
})

describe("messageUsedTokens", () => {
  test("uses input + cache read + cache write", () => {
    expect(messageUsedTokens(assistant(1000, 200, 50))).toBe(1250)
  })

  test("tolerates a missing cache object", () => {
    expect(messageUsedTokens({ type: "assistant", tokens: { input: 42 } })).toBe(42)
  })

  test("ignores non-assistant and malformed messages", () => {
    expect(messageUsedTokens({ type: "user" })).toBeUndefined()
    expect(messageUsedTokens({ type: "assistant" })).toBeUndefined()
    expect(messageUsedTokens({ type: "assistant", tokens: {} })).toBeUndefined()
    expect(messageUsedTokens(null)).toBeUndefined()
  })
})

describe("computeUsed", () => {
  test("returns the newest assistant usage, skipping usage-less ones", () => {
    const messages = [
      assistant(100),
      { type: "user" },
      assistant(1000, 500),
      { type: "assistant" }, // aborted, no tokens
    ]
    expect(computeUsed(messages)).toBe(1500)
  })

  test("undefined when nothing recorded usage", () => {
    expect(computeUsed([{ type: "user" }])).toBeUndefined()
    expect(computeUsed(undefined)).toBeUndefined()
  })
})

describe("shouldCompact", () => {
  test("true only at or above the threshold", () => {
    expect(shouldCompact(500000, 500000)).toBe(true)
    expect(shouldCompact(500001, 500000)).toBe(true)
    expect(shouldCompact(499999, 500000)).toBe(false)
    expect(shouldCompact(undefined, 500000)).toBe(false)
    expect(shouldCompact(500000, undefined)).toBe(false)
  })
})
