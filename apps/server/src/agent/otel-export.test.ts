import { describe, expect, it } from "vitest";
import { OtlpExporter, otlpPayload, spanIdFor, toOtlpSpan, traceIdFor } from "./otel-export.ts";

const model = { id: "m1", sessionId: "ses_1", kind: "model" as const, name: "deepseek-chat", status: "ok" as const, startedAtMs: 10, durationMs: 1200, turnId: "0",
  detail: { model: "deepseek-chat", provider: "api.deepseek.com", usage: { prompt_tokens: 3000, completion_tokens: 80 }, cache: { cachedTokens: 2700, hitRate: 0.9, prefix: "abc" }, finishReason: "stop", content: "SECRET PROMPT" } };

describe("OTLP export", () => {
  it("maps model spans to GenAI semantic conventions without content", () => {
    const s = toOtlpSpan(model, 1_700_000_000_000);
    expect(s.traceId).toBe(traceIdFor("ses_1"));
    expect(s.traceId).toHaveLength(32);
    expect(s.spanId).toHaveLength(16);
    expect(s.name).toBe("chat deepseek-chat");
    const a = Object.fromEntries(s.attributes.map((x) => [x.key, x.value]));
    expect(a["gen_ai.usage.input_tokens"]).toEqual({ intValue: "3000" });
    expect(a["gen_ai.usage.cache_read_input_tokens"]).toEqual({ intValue: "2700" });
    expect(a["pig.cache.hit_rate"]).toEqual({ doubleValue: 0.9 });
    expect(JSON.stringify(s)).not.toContain("SECRET PROMPT");
    expect(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)).toBe(1_200_000_000n);
  });
  it("links parents, marks errors and batches finished spans once", async () => {
    const posts: any[] = [];
    const exp = new OtlpExporter("http://collector/v1/traces", { "x-key": "1" }, { delayMs: 10_000, fetchImpl: (async (_u: string, init: any) => { posts.push({ headers: init.headers, body: JSON.parse(init.body) }); return new Response("{}"); }) as never });
    const tool = { id: "t1", parentId: "m1", sessionId: "ses_1", kind: "tool" as const, name: "read_file", status: "error" as const, startedAtMs: 20, durationMs: 5, detail: { error: "ENOENT" } };
    exp.enqueue({ ...model, status: "running" }, 0);
    exp.enqueue(model, 0); exp.enqueue(model, 0); exp.enqueue(tool, 0);
    await exp.flush();
    expect(posts).toHaveLength(1);
    const spans = posts[0].body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    expect(spans[1].parentSpanId).toBe(spanIdFor("ses_1", "m1"));
    expect(spans[1].status.code).toBe(2);
    expect(posts[0].headers["x-key"]).toBe("1");
    expect(otlpPayload([]).resourceSpans[0]!.resource.attributes[0]!.value.stringValue).toBe("pig-agent");
  });
});
