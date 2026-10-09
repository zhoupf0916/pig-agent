import { describe, expect, it } from "vitest";
import { compareToBaseline, toBaseline } from "./eval-gate.ts";
import type { TaskResult } from "./task-eval.ts";

const result = (id: string, checks: Record<string, boolean>, calls = 2, tools = 1): TaskResult => ({
  id, pass: Object.values(checks).every(Boolean), checks: Object.entries(checks).map(([name, pass]) => ({ name, pass })),
  modelCalls: calls, toolCalls: tools, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheHitRate: null, ms: 1, reply: "",
});

describe("eval gate", () => {
  const baseline = toBaseline([result("a", { x: true }), result("b", { y: false, z: true })], "mock");

  it("passes an identical run", () => {
    expect(compareToBaseline([result("a", { x: true }), result("b", { y: false, z: true })], baseline)).toEqual({ ok: true, regressions: [], improvements: [] });
  });
  it("flags failing cases, checks, missing cases and call blow-ups", () => {
    const r = compareToBaseline([result("a", { x: false }, 5, 9)], baseline);
    expect(r.ok).toBe(false);
    expect(r.regressions).toEqual([
      "a: passed in baseline, now fails",
      'a: check "x" now fails',
      "a: model calls 2 -> 5",
      "a: tool calls 1 -> 9",
      "b: case missing from run",
    ]);
  });
  it("reports improvements without failing and ignores missing cases in partial runs", () => {
    const r = compareToBaseline([result("b", { y: true, z: true }), result("c", { w: true })], baseline, { partial: true });
    expect(r.ok).toBe(true);
    expect(r.improvements).toEqual(["b: now passes", 'b: check "y" now passes', "c: new case (not in baseline)"]);
  });
  it("keeps the weakest observation across trials", () => {
    const b = toBaseline([result("a", { x: true }, 2), result("a", { x: false }, 3)], "mock");
    expect(b.cases.a).toEqual({ pass: false, checks: { x: false }, modelCalls: 3, toolCalls: 1 });
  });
});
