import { describe, expect, it, vi } from "vitest";
import { validSpan } from "@pig-agent/contracts/telemetry";
import type { DebugSpan } from "@pig-agent/contracts";
import { runnerTelemetry } from "./run-telemetry.ts";

const parent = "00-" + "3".repeat(32) + "-" + "4".repeat(16) + "-01";
const debug = (over: Partial<DebugSpan>): DebugSpan => ({ id: "s1", sessionId: "run_x", kind: "model", name: "deepseek-chat", status: "ok", startedAtMs: 10, durationMs: 20, ...over }) as DebugSpan;

describe("runner telemetry", () => {
  it("is inert without TRACEPARENT", () => {
    const t = runnerTelemetry({}, "http://gateway:8891");
    const f = vi.fn();
    expect(t.wrapFetch(f as never)).toBe(f);
    expect(t.finish("run_x", true, [debug({})], 0)).toEqual([]);
  });
  it("propagates traceparent to the gateway only", async () => {
    const t = runnerTelemetry({ TRACEPARENT: parent }, "http://gateway:8891");
    const base = vi.fn(async () => new Response("ok"));
    const f = t.wrapFetch(base as never);
    await f("http://gateway:8891/v1/chat/completions", { headers: { a: "1" } });
    await f("https://example.com/");
    const calls = base.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const h = new Headers(calls[0]![1]!.headers);
    expect(h.get("traceparent")).toBe(t.agent!.traceparent);
    expect(h.get("a")).toBe("1");
    expect(calls[1]![1]).toBeUndefined();
  });
  it("converts finished debug spans to metadata-only OTel spans", () => {
    const t = runnerTelemetry({ TRACEPARENT: parent }, "http://gateway:8891");
    const spans = t.finish("run_x", true, [
      debug({ detail: { model: "deepseek-chat", usage: { prompt_tokens: 100, completion_tokens: 7 }, ttftMs: 300, finishReason: "stop", prompt: "SECRET" } as never }),
      debug({ id: "s2", kind: "tool", name: "read_file", parentId: "s1", status: "error", detail: { error: "boom", args: { path: "/etc" } } as never }),
      debug({ id: "s3", status: "running" }),
    ], 1_700_000_000_000);
    expect(spans.map((s) => s.name)).toEqual(["runner.agent", "chat deepseek-chat", "execute_tool read_file"]);
    expect(spans.every(validSpan)).toBe(true);
    const [agent, model, tool] = spans;
    expect(agent!.parentSpanId).toBe("4".repeat(16));
    expect(agent!.traceId).toBe("3".repeat(32));
    expect(model!.parentSpanId).toBe(agent!.spanId);
    expect(model!.startMs).toBe(1_700_000_000_010);
    expect(model!.attributes).toMatchObject({ "gen_ai.request.model": "deepseek-chat", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 7, "pig.ttft_ms": 300 });
    expect(tool!.parentSpanId).toBe(model!.spanId);
    expect(tool!.status).toBe("error");
    expect(JSON.stringify(spans)).not.toContain("SECRET");
    expect(JSON.stringify(spans)).not.toContain("/etc");
  });
});
