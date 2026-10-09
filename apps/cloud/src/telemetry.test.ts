import { describe, expect, it, vi } from "vitest";
import {
  BatchExporter, controlPlaneExporter, fnv64, formatTraceparent, parseTraceparent, runContext, runRootSpanId, runTraceId, toOtlpJson, Tracer, validSpan,
  type SpanRecord,
} from "@pig-agent/contracts/telemetry";

const span = (over: Partial<SpanRecord> = {}): SpanRecord => ({
  traceId: "a".repeat(32), spanId: "b".repeat(16), name: "x", service: "worker", kind: "internal", startMs: 1_700_000_000_000, durationMs: 5, status: "ok", attributes: {}, ...over,
});

describe("traceparent", () => {
  it("round-trips and honours the sampled flag", () => {
    const c = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", sampled: true };
    expect(parseTraceparent(formatTraceparent(c))).toEqual(c);
    expect(parseTraceparent(`00-${c.traceId}-${c.spanId}-00`)?.sampled).toBe(false);
  });
  it("rejects malformed, all-zero and version ff headers", () => {
    for (const bad of [undefined, "", "garbage", `00-${"0".repeat(32)}-b7ad6b7169203331-01`, `00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`, `ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`])
      expect(parseTraceparent(bad)).toBeUndefined();
  });
});

describe("run trace ids", () => {
  it("uses the run id hex and is deterministic", () => {
    const id = "run_" + "1f".repeat(16);
    expect(runTraceId(id)).toBe("1f".repeat(16));
    expect(runContext(id)).toEqual({ traceId: "1f".repeat(16), spanId: runRootSpanId(id), sampled: true });
    expect(runRootSpanId(id)).toMatch(/^[0-9a-f]{16}$/);
    expect(runTraceId("legacy-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(runTraceId("legacy-id")).toBe(runTraceId("legacy-id"));
    expect(fnv64("a")).not.toBe(fnv64("b"));
  });
});

describe("Tracer", () => {
  it("records child spans with parent ids, status and errors", async () => {
    const out: SpanRecord[] = [];
    const tracer = new Tracer("worker", (s) => out.push(s));
    const parent = runContext("run_" + "2".repeat(32));
    await tracer.trace("ok", { parent }, async (s) => s.set({ a: 1, skip: undefined }));
    await expect(tracer.trace("boom", { parent }, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(out.map((s) => [s.name, s.status, s.parentSpanId, s.traceId])).toEqual([
      ["ok", "ok", parent.spanId, parent.traceId],
      ["boom", "error", parent.spanId, parent.traceId],
    ]);
    expect(out[0]!.attributes).toEqual({ a: 1 });
    expect(out[1]!.attributes["error.message"]).toBe("nope");
    expect(out.every(validSpan)).toBe(true);
  });
  it("does not record unsampled spans or spans ended twice", () => {
    const out: SpanRecord[] = [];
    const tracer = new Tracer("cloud", (s) => out.push(s));
    tracer.start("u", { parent: { traceId: "c".repeat(32), spanId: "d".repeat(16), sampled: false } }).end("ok");
    const s = tracer.start("s");
    s.end("ok");
    s.end("error");
    expect(out.map((x) => [x.name, x.status])).toEqual([["s", "ok"]]);
  });
});

describe("validSpan", () => {
  it("rejects bad ids, kinds, durations and oversized attributes", () => {
    expect(validSpan(span())).toBe(true);
    expect(validSpan(span({ traceId: "xyz" }))).toBe(false);
    expect(validSpan(span({ parentSpanId: "1" }))).toBe(false);
    expect(validSpan(span({ kind: "producer" as never }))).toBe(false);
    expect(validSpan(span({ durationMs: -1 }))).toBe(false);
    expect(validSpan(span({ attributes: { a: { nested: 1 } as never } }))).toBe(false);
    expect(validSpan(span({ attributes: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, i])) }))).toBe(false);
    expect(validSpan(null)).toBe(false);
  });
});

describe("toOtlpJson", () => {
  it("groups by service and converts times to unix nanos", () => {
    const json = toOtlpJson([span({ service: "worker", attributes: { s: "v", n: 2, f: 1.5, b: true } }), span({ service: "runner", kind: "client", status: "error" })]);
    expect(json.resourceSpans).toHaveLength(2);
    const w = json.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(w.startTimeUnixNano).toBe("1700000000000000000");
    expect(w.endTimeUnixNano).toBe("1700000000005000000");
    expect(w.attributes).toEqual([
      { key: "s", value: { stringValue: "v" } }, { key: "n", value: { intValue: "2" } }, { key: "f", value: { doubleValue: 1.5 } }, { key: "b", value: { boolValue: true } },
    ]);
    const r = json.resourceSpans[1]!.scopeSpans[0]!.spans[0]!;
    expect([r.kind, r.status.code]).toEqual([3, 2]);
  });
});

describe("BatchExporter", () => {
  it("batches, bounds the queue and keeps spans after a failed send", async () => {
    const sent: number[] = [];
    let fail = true;
    const exporter = new BatchExporter(async (b) => { if (fail) throw new Error("down"); sent.push(b.length); }, { maxQueue: 5, maxBatch: 100 });
    for (let i = 0; i < 7; i++) exporter.push(span());
    expect(exporter.stats).toMatchObject({ queued: 5, dropped: 2 });
    await exporter.flush();
    expect(exporter.stats).toMatchObject({ queued: 5, failedBatches: 1, exported: 0 });
    fail = false;
    await exporter.flush();
    expect(sent).toEqual([5]);
    expect(exporter.stats).toMatchObject({ queued: 0, exported: 5 });
  });
  it("control plane exporter posts spans with the worker token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const exporter = controlPlaneExporter("http://cloud:8890", "tok", fetchImpl as never);
    exporter.push(span());
    await exporter.stop();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://cloud:8890/internal/telemetry/spans");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body)).spans).toHaveLength(1);
  });
});
