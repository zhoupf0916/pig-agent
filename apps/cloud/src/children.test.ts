import { describe, expect, it } from "vitest";
import { childPrompt, spawnSchema, summarize } from "./children.ts";
import { checkSchema, extractJson, validate } from "./json-schema-lite.ts";

const schema = { type: "object", properties: { item: { type: "string" }, length: { type: "integer", minimum: 1 } }, required: ["item", "length"], additionalProperties: false };
describe("json-schema-lite", () => {
  it("accepts supported schemas and rejects unsupported keywords", () => {
    expect(checkSchema(schema)).toBeUndefined();
    expect(checkSchema({ type: "object", patternProperties: {} })).toMatch(/不支持的关键字/);
    expect(checkSchema({ type: "date" })).toMatch(/未知类型/);
  });
  it("validates types, required, extras, bounds and arrays", () => {
    expect(validate(schema, { item: "a", length: 1 })).toEqual([]);
    expect(validate(schema, { item: "a" })).toEqual(["$: 缺少必填字段 length"]);
    expect(validate(schema, { item: "a", length: 1.5 })[0]).toMatch(/integer/);
    expect(validate(schema, { item: "a", length: 0 })[0]).toMatch(/≥ 1/);
    expect(validate(schema, { item: "a", length: 1, x: 1 })[0]).toMatch(/不允许的字段 x/);
    expect(validate({ type: "array", items: { enum: ["a", "b"] }, maxItems: 2 }, ["a", "c", "b"]).length).toBe(2);
  });
  it("extracts JSON from plain text, fences or surrounding prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson("结果：\n```json\n[1,2]\n```")).toEqual({ ok: true, value: [1, 2] });
    expect(extractJson('答案是 {"a":2} 。')).toEqual({ ok: true, value: { a: 2 } });
    expect(extractJson("没有 JSON").ok).toBe(false);
  });
});
describe("parallel subtasks", () => {
  it("bounds the request", () => {
    const base = { token: "t", callId: "c", instruction: "做" };
    expect(spawnSchema.safeParse({ ...base, items: ["a"] }).success).toBe(true);
    expect(spawnSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    expect(spawnSchema.safeParse({ ...base, items: Array(21).fill("x") }).success).toBe(false);
    expect(spawnSchema.safeParse({ ...base, items: ["a"], maxParallel: 6 }).success).toBe(false);
  });
  it("builds an isolated child prompt with schema and retry feedback", () => {
    const p = childPrompt({ instruction: "统计", output_schema: schema }, "苹果", 0, 3, "缺少 length");
    expect(p).toContain("[PARALLEL_CHILD]");
    expect(p).toContain("本项（第 1/3 项）：苹果");
    expect(p).toContain('"required":["item","length"]');
    expect(p).toContain("上一次的回答不符合要求（缺少 length）");
    expect(childPrompt({ instruction: "x", output_schema: null }, "a", 1, 2)).toContain("简洁的中文");
  });
  it("summarizes outcomes, truncates and points to the artifact", () => {
    const s = summarize("call1", [
      { idx: 0, item: "苹果", state: "succeeded", output: { item: "苹果", length: 2 }, output_text: null, error: null },
      { idx: 1, item: "香蕉", state: "failed", output: null, output_text: null, error: "超时" },
      { idx: 2, item: "x", state: "succeeded", output: null, output_text: "长".repeat(5000), error: null },
    ]);
    expect(s.split("\n")[0]).toBe("并行子任务完成：成功 2/3，失败 1。完整结果已保存为成果文件 parallel/call1.json。");
    expect(s).toContain('[1] 苹果 → {"item":"苹果","length":2}');
    expect(s).toContain("[2] 香蕉 → 失败：超时");
    expect(s.length).toBeLessThan(2000);
  });
});
