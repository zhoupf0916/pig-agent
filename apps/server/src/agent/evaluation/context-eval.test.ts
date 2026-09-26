import { describe, expect, it } from "vitest";
import { gradeAnswer, modelMessages, runOffline } from "./context-eval.ts";
import { contextCases } from "./context-cases.ts";
describe("context evaluation harness", () => {
  it("rejects an incorrect result even when the response mentions all expected evidence", () => {
    expect(gradeAnswer('{"total":"999","explanation":"391"}', { total: "391" })).toBe(false);
  });
  it("does not award a missing answer or malformed JSON", () => {
    expect(gradeAnswer('total is 391', { total: "391" })).toBe(false);
    expect(gradeAnswer('{}', { total: "391" })).toBe(false);
  });
  it("accepts the exact structured outcome", () => {
    expect(gradeAnswer('```json\n{"total":"391"}\n```', { total: "391" })).toBe(true);
  });
  it("keeps the answer key outside model requests", () => {
    const task = contextCases().find(t => t.family === "middle-evidence")!;
    expect(JSON.stringify(modelMessages([task.messages.at(-1)!]))).not.toContain("391");
  });
  it("meets every offline gate on the versioned scenario matrix", () => {
    const result = runOffline(1);
    expect(result.rows.filter(r => r.strategy === "structured-v2" && r.failures.length)).toEqual([]);
    expect(result.rows.some(r => r.strategy === "baseline-v1" && r.failures.length)).toBe(true);
  });
});
