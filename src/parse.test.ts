import { describe, expect, test } from "bun:test"
import { formatTokens, parseThreshold } from "./parse"

describe("parseThreshold", () => {
  test("empty input asks for status", () => {
    expect(parseThreshold("")).toEqual({ kind: "status" })
    expect(parseThreshold("   ")).toEqual({ kind: "status" })
    expect(parseThreshold(undefined)).toEqual({ kind: "status" })
  })

  test("off words disable", () => {
    for (const word of ["off", "OFF", "disable", "none", "auto", "default"]) {
      expect(parseThreshold(word)).toEqual({ kind: "off" })
    }
  })

  test("plain, k and m forms", () => {
    expect(parseThreshold("500000")).toEqual({ kind: "limit", value: 500000 })
    expect(parseThreshold("500k")).toEqual({ kind: "limit", value: 500000 })
    expect(parseThreshold("500K")).toEqual({ kind: "limit", value: 500000 })
    expect(parseThreshold("500 k")).toEqual({ kind: "limit", value: 500000 })
    expect(parseThreshold("1m")).toEqual({ kind: "limit", value: 1_000_000 })
    expect(parseThreshold("250_000")).toEqual({ kind: "limit", value: 250000 })
    expect(parseThreshold("1.5k")).toEqual({ kind: "limit", value: 1500 })
  })

  test("garbage is invalid, not silently ignored", () => {
    expect(parseThreshold("lots").kind).toBe("invalid")
    expect(parseThreshold("0").kind).toBe("invalid")
    expect(parseThreshold("0k").kind).toBe("invalid")
    expect(parseThreshold("k").kind).toBe("invalid")
  })
})

describe("formatTokens", () => {
  test("renders thousands and millions", () => {
    expect(formatTokens(500)).toBe("500")
    expect(formatTokens(500000)).toBe("500k")
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(1_500_000)).toBe("1.5M")
  })
})
