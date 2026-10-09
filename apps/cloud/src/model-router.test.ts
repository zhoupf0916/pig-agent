import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, estimateTokens, estimatedUsage, OutputMeter, outputCap, retryable, route, upstreamBody, type Provider } from "./model-router.ts";

const p = (id: string, extra: Partial<Provider> = {}): Provider => ({ id, baseUrl: `https://${id}.test/v1`, model: `m-${id}`, apiKey: "k", ...extra });
const sse = (frames: unknown[]) => new TextEncoder().encode(frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""));

describe("retry policy", () => {
  it("fails over on provider-side statuses only", () => {
    for (const s of [401, 402, 403, 408, 429, 500, 502, 503, 529]) expect(retryable(s), String(s)).toBe(true);
    for (const s of [400, 404, 413, 422]) expect(retryable(s), String(s)).toBe(false);
  });
});

describe("circuit breaker", () => {
  it("opens after consecutive failures, orders open providers last and recovers", () => {
    const b = new CircuitBreaker(2, 1000);
    const list = [p("a"), p("b")];
    b.failure("a", 0);
    expect(b.order(list, 10).map((x) => x.id)).toEqual(["a", "b"]);
    b.failure("a", 0);
    expect(b.isOpen("a", 10)).toBe(true);
    expect(b.order(list, 10).map((x) => x.id)).toEqual(["b", "a"]);
    expect(b.order(list, 2000).map((x) => x.id)).toEqual(["a", "b"]);
    b.success("a");
    expect(b.snapshot()).toEqual([]);
  });
});

describe("upstream body", () => {
  it("applies the provider model and output cap", () => {
    expect(upstreamBody({ max_tokens: 99999, model: "x", max_completion_tokens: 5, stream: true }, p("a", { maxOutputTokens: 2048 }))).toMatchObject({
      model: "m-a", max_tokens: 2048, n: 1, max_completion_tokens: undefined, stream_options: { include_usage: true },
    });
    expect(upstreamBody({ max_tokens: 100 }, p("a")).max_tokens).toBe(100);
    expect(upstreamBody({}, p("a")).max_tokens).toBe(4096);
    expect(outputCap({ maxOutputTokens: 999999 })).toBe(32768);
  });
});

describe("route", () => {
  const signal = new AbortController().signal;
  it("fails over on network errors and retryable statuses, in order", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("a.test")) throw new TypeError("fetch failed");
      if (url.includes("b.test")) return new Response("busy", { status: 429 });
      return new Response("{}", { status: 200 });
    });
    const breaker = new CircuitBreaker();
    const r = await route({ providers: [p("a"), p("b"), p("c")], body: {}, fetch, breaker, signal });
    expect(r.ok && r.provider.id).toBe("c");
    expect(r.attempts.map((a) => [a.provider, a.status])).toEqual([["a", "network"], ["b", 429], ["c", 200]]);
    expect(breaker.snapshot().map((s) => s.key)).toEqual(["a", "b"]);
    const sent = JSON.parse(String((fetch.mock.calls[2] as unknown as [string, RequestInit])[1].body));
    expect(sent.model).toBe("m-c");
  });
  it("returns request errors without failing over", async () => {
    const fetch = vi.fn(async () => new Response("bad", { status: 400 }));
    const r = await route({ providers: [p("a"), p("b")], body: {}, fetch, breaker: new CircuitBreaker(), signal });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports the last status when every provider fails", async () => {
    const fetch = vi.fn(async (url: string) => new Response("x", { status: url.includes("a.test") ? 503 : 402 }));
    const r = await route({ providers: [p("a"), p("b")], body: {}, fetch, breaker: new CircuitBreaker(), signal });
    expect(!r.ok && r.status).toBe(402);
    expect(r.attempts).toHaveLength(2);
  });
  it("times out slow headers and moves on", async () => {
    const fetch = vi.fn((url: string, init: RequestInit) =>
      url.includes("a.test")
        ? new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve(new Response("{}", { status: 200 })),
    );
    const r = await route({ providers: [p("a"), p("b")], body: {}, fetch, breaker: new CircuitBreaker(), signal, headersTimeoutMs: 20 });
    expect(r.attempts.map((a) => a.status)).toEqual(["timeout", 200]);
  });
  it("stops when the caller goes away", async () => {
    const ctrl = new AbortController();
    const fetch = vi.fn(async () => {
      ctrl.abort();
      throw new Error("aborted");
    });
    const r = await route({ providers: [p("a"), p("b")], body: {}, fetch, breaker: new CircuitBreaker(), signal: ctrl.signal });
    expect(r.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("output meter", () => {
  it("estimates CJK and latin text", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("hello world!")).toBe(3);
  });
  it("captures usage and counts content, reasoning and tool calls", () => {
    const m = new OutputMeter(100);
    expect(m.push(sse([{ choices: [{ delta: { content: "你好" } }] }, { choices: [{ delta: { reasoning_content: "abcdefgh" } }] }]))).toBe(false);
    m.push(sse([{ choices: [{ delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } }] }, { usage: { prompt_tokens: 5, completion_tokens: 9 }, choices: [] }, "[DONE]"]));
    expect(m.estimatedOutput).toBe(2 + 2 + 2);
    expect(m.usage).toEqual({ prompt_tokens: 5, completion_tokens: 9 });
  });
  it("handles frames split across chunks and flags overruns past cap + slack", () => {
    const m = new OutputMeter(10, 0);
    const bytes = sse([{ choices: [{ delta: { content: "一二三四五六七八九十十一" } }] }]);
    expect(m.push(bytes.slice(0, 7))).toBe(false);
    expect(m.push(bytes.slice(7))).toBe(true);
    expect(estimatedUsage({ messages: [{ role: "user", content: "hi" }] }, m)).toMatchObject({ completion_tokens: 12, estimated: true });
  });
});
