import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, estimateTokens, estimateToolSchemaTokens, TokenCalibrator } from "./tokens.ts";

describe("token estimation", () => {
  it("counts english roughly 1 token per 4 chars", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
  it("counts CJK denser than latin", () => {
    expect(estimateTokens("你好世界".repeat(25))).toBe(60);
  });
  it("includes tool calls and per-message overhead", () => {
    const n = estimateMessagesTokens([{ content: "abcd", toolCalls: [{ id: "x" }] }]);
    expect(n).toBeGreaterThan(5);
  });
  it("sums tool schemas including extra MCP/computer tools", () => {
    const base = estimateToolSchemaTokens([{ name: "a" }]);
    expect(estimateToolSchemaTokens([{ name: "a" }], [{ name: "mcp_tool", description: "x".repeat(400) }])).toBeGreaterThan(base + 90);
  });
  it("calibrates to provider-reported usage and clamps outliers", () => {
    const c = new TokenCalibrator();
    expect(c.apply(100)).toBe(100);
    c.observe(100, 150);
    expect(c.apply(100)).toBe(150);
    c.observe(100, 100000);
    expect(c.currentRatio).toBeLessThanOrEqual(2.5);
  });
});
