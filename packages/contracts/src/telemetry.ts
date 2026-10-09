/**
 * Dependency-free, OpenTelemetry-compatible tracing primitives shared by cloud, gateway, worker and runner.
 *
 * - W3C Trace Context (`traceparent`) parsing/formatting.
 * - Every run has a deterministic trace: trace id = the 32 hex digits of `run_<hex>`, root span id derived
 *   from the run id. Any process that knows the run id can join the run's trace without extra plumbing.
 * - Spans are plain records; `toOtlpJson` encodes them as OTLP/HTTP JSON (`POST <endpoint>/v1/traces`).
 * - `BatchExporter` buffers spans (bounded, drops when full) and flushes on an interval.
 * Uses only Web APIs (crypto.getRandomValues, fetch), so it is safe in every runtime.
 */
export type SpanKind = "internal" | "server" | "client" | "consumer";
export type SpanStatus = "ok" | "error" | "unset";
export type AttrValue = string | number | boolean;
export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: string;
  kind: SpanKind;
  /** Epoch milliseconds (fractional allowed). */
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, AttrValue>;
};
export type SpanContext = { traceId: string; spanId: string; sampled: boolean };

const HEX = /^[0-9a-f]+$/;
const zero = (s: string) => /^0+$/.test(s);
const randomHex = (bytes: number) =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
export const newTraceId = () => randomHex(16);
export const newSpanId = () => randomHex(8);

export function parseTraceparent(header: string | null | undefined): SpanContext | undefined {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(header ?? "").trim().toLowerCase());
  if (!m || m[1] === "ff" || zero(m[2]!) || zero(m[3]!)) return undefined;
  return { traceId: m[2]!, spanId: m[3]!, sampled: (parseInt(m[4]!, 16) & 1) === 1 };
}
export const formatTraceparent = (c: { traceId: string; spanId: string; sampled?: boolean }) =>
  `00-${c.traceId}-${c.spanId}-${c.sampled === false ? "00" : "01"}`;

/** 64-bit FNV-1a, hex. Deterministic ids only; not a security primitive. */
export function fnv64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(text)) h = BigInt.asUintN(64, (h ^ BigInt(ch)) * 0x100000001b3n);
  const out = h.toString(16).padStart(16, "0");
  return zero(out) ? "0000000000000001" : out;
}
export function runTraceId(runId: string): string {
  const hex = /^run_([0-9a-f]{32})$/.exec(runId)?.[1];
  return hex && !zero(hex) ? hex : fnv64("trace-a:" + runId) + fnv64("trace-b:" + runId);
}
export const runRootSpanId = (runId: string) => fnv64("root:" + runId);
/** Context whose parent is the run's root span, for processes joining a run. */
export const runContext = (runId: string): SpanContext => ({ traceId: runTraceId(runId), spanId: runRootSpanId(runId), sampled: true });

export type SpanSink = (span: SpanRecord) => void;

export class Span {
  readonly spanId = newSpanId();
  readonly traceId: string;
  readonly startMs = Date.now();
  private readonly t0 = performance.now();
  private ended = false;
  status: SpanStatus = "unset";
  constructor(
    private readonly sink: SpanSink,
    readonly service: string,
    public name: string,
    readonly kind: SpanKind,
    readonly parent: SpanContext | undefined,
    readonly attributes: Record<string, AttrValue> = {},
    readonly sampled = parent?.sampled ?? true,
  ) {
    this.traceId = parent?.traceId ?? newTraceId();
  }
  get context(): SpanContext {
    return { traceId: this.traceId, spanId: this.spanId, sampled: this.sampled };
  }
  get traceparent() {
    return formatTraceparent(this.context);
  }
  set(attrs: Record<string, AttrValue | undefined | null>) {
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) this.attributes[k] = v;
    return this;
  }
  fail(error: unknown) {
    this.status = "error";
    this.attributes["error.message"] = String((error as Error)?.message ?? error).slice(0, 300);
    return this;
  }
  /** Records the span (once). `record=false` drops it (e.g. unsampled noise). */
  end(status?: SpanStatus, record = true) {
    if (this.ended) return;
    this.ended = true;
    if (status) this.status = status;
    if (!record || !this.sampled) return;
    this.sink({
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parent ? { parentSpanId: this.parent.spanId } : {}),
      name: this.name,
      service: this.service,
      kind: this.kind,
      startMs: this.startMs,
      durationMs: Math.max(0, performance.now() - this.t0),
      status: this.status,
      attributes: this.attributes,
    });
  }
}

export class Tracer {
  constructor(
    readonly service: string,
    private readonly sink: SpanSink,
  ) {}
  start(name: string, opts: { parent?: SpanContext; kind?: SpanKind; attributes?: Record<string, AttrValue> } = {}) {
    return new Span(this.sink, this.service, name, opts.kind ?? "internal", opts.parent, { ...opts.attributes });
  }
  /** Runs `fn` inside a span; the span ends with ok/error. */
  async trace<T>(name: string, opts: Parameters<Tracer["start"]>[1], fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.start(name, opts);
    try {
      const value = await fn(span);
      span.end(span.status === "unset" ? "ok" : span.status);
      return value;
    } catch (error) {
      span.fail(error).end("error");
      throw error;
    }
  }
  /** Records a span that already happened (e.g. queue wait measured from timestamps). */
  record(span: Omit<SpanRecord, "service" | "spanId"> & { spanId?: string }) {
    this.sink({ ...span, spanId: span.spanId ?? newSpanId(), service: this.service });
  }
}

// ---- OTLP/HTTP JSON ------------------------------------------------------------------------------

const KIND = { internal: 1, server: 2, client: 3, consumer: 5 } as const;
const STATUS = { unset: 0, ok: 1, error: 2 } as const;
const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
const attr = (key: string, v: AttrValue) => ({
  key,
  value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
});

export function toOtlpJson(spans: SpanRecord[], resource: Record<string, AttrValue> = {}) {
  const byService = new Map<string, SpanRecord[]>();
  for (const s of spans) byService.set(s.service, [...(byService.get(s.service) ?? []), s]);
  return {
    resourceSpans: [...byService].map(([service, list]) => ({
      resource: { attributes: Object.entries({ "service.name": service, "service.namespace": "pig-agent", ...resource }).map(([k, v]) => attr(k, v)) },
      scopeSpans: [
        {
          scope: { name: "pig-agent", version: "1" },
          spans: list.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            kind: KIND[s.kind],
            startTimeUnixNano: nanos(s.startMs),
            endTimeUnixNano: nanos(s.startMs + s.durationMs),
            attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
            status: { code: STATUS[s.status] },
          })),
        },
      ],
    })),
  };
}

/** Validates spans received from another process before storing them. */
export function validSpan(s: unknown): s is SpanRecord {
  const x = s as SpanRecord;
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.traceId === "string" && x.traceId.length === 32 && HEX.test(x.traceId) &&
    typeof x.spanId === "string" && x.spanId.length === 16 && HEX.test(x.spanId) &&
    (x.parentSpanId === undefined || (typeof x.parentSpanId === "string" && x.parentSpanId.length === 16 && HEX.test(x.parentSpanId))) &&
    typeof x.name === "string" && x.name.length > 0 && x.name.length <= 200 &&
    typeof x.service === "string" && x.service.length <= 40 &&
    ["internal", "server", "client", "consumer"].includes(x.kind) &&
    ["ok", "error", "unset"].includes(x.status) &&
    Number.isFinite(x.startMs) && Number.isFinite(x.durationMs) && x.durationMs >= 0 && x.durationMs < 86_400_000 &&
    !!x.attributes && typeof x.attributes === "object" && Object.keys(x.attributes).length <= 40 &&
    Object.values(x.attributes).every((v) => ["string", "number", "boolean"].includes(typeof v) && String(v).length <= 1000)
  );
}

export type ExporterStats = { queued: number; exported: number; dropped: number; failedBatches: number };

/** Bounded batching exporter. `send` must not throw for long; failures keep at most `maxQueue` spans. */
export class BatchExporter {
  private queue: SpanRecord[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  readonly stats: ExporterStats = { queued: 0, exported: 0, dropped: 0, failedBatches: 0 };
  constructor(
    private readonly send: (spans: SpanRecord[]) => Promise<void>,
    private readonly opts: { maxQueue?: number; maxBatch?: number; intervalMs?: number } = {},
  ) {}
  readonly push: SpanSink = (span) => {
    if (this.queue.length >= (this.opts.maxQueue ?? 2048)) {
      this.stats.dropped++;
      return;
    }
    this.queue.push(span);
    this.stats.queued = this.queue.length;
    if (this.queue.length >= (this.opts.maxBatch ?? 256)) void this.flush();
  };
  start() {
    this.timer ??= setInterval(() => void this.flush(), this.opts.intervalMs ?? 2000);
    (this.timer as { unref?: () => void }).unref?.();
    return this;
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.queue.length) return Promise.resolve();
    this.flushing = (async () => {
      try {
        while (this.queue.length) {
          const batch = this.queue.splice(0, this.opts.maxBatch ?? 256);
          try {
            await this.send(batch);
            this.stats.exported += batch.length;
          } catch {
            this.stats.failedBatches++;
            // Keep the newest spans for the next attempt, within the bound.
            const room = (this.opts.maxQueue ?? 2048) - this.queue.length;
            this.stats.dropped += Math.max(0, batch.length - room);
            this.queue.unshift(...batch.slice(Math.max(0, batch.length - room)));
            break;
          }
        }
      } finally {
        this.stats.queued = this.queue.length;
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }
}

/** Exporter that ships spans to the cloud control plane (`/internal/telemetry/spans`, worker token). */
export function controlPlaneExporter(control: string, token: string | undefined, fetchImpl?: typeof fetch) {
  return new BatchExporter(async (spans) => {
    if (!token) return;
    const r = await (fetchImpl ?? globalThis.fetch)(control + "/internal/telemetry/spans", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ spans }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw Error(`telemetry ${r.status}`);
  });
}
