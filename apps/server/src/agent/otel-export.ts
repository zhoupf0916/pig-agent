/**
 * OpenTelemetry export for Pig debug spans (OTLP/HTTP JSON, no SDK dependency).
 *
 * Enabled when OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is set;
 * works with Jaeger, Grafana Tempo, Langfuse, Phoenix, any OTLP collector. One trace per
 * session; model spans carry GenAI semantic-convention attributes. Only metrics/metadata
 * are exported — never prompt or tool content.
 */
import { createHash } from "node:crypto";
import type { DebugSpan } from "@pig-agent/contracts";

type Attr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } };
export type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: Attr[]; status: { code: number; message?: string } };

const hex = (input: string, bytes: number) => createHash("sha256").update(input).digest("hex").slice(0, bytes * 2);
export const traceIdFor = (sessionId: string) => hex(`trace:${sessionId}`, 16);
export const spanIdFor = (sessionId: string, spanId: string) => hex(`span:${sessionId}:${spanId}`, 8);

function attr(key: string, v: unknown): Attr | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  if (typeof v === "number") return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  if (typeof v === "string") return { key, value: { stringValue: v.slice(0, 512) } };
  return undefined;
}

export function toOtlpSpan(span: DebugSpan, wallOriginMs: number): OtlpSpan {
  const d = (span.detail ?? {}) as Record<string, any>;
  const startMs = span.wallStartedAt ? Date.parse(span.wallStartedAt) : wallOriginMs + span.startedAtMs;
  const endMs = startMs + Math.max(0, span.durationMs ?? 0);
  const usage = d.usage ?? {};
  const attrs = [
    attr("pig.session_id", span.sessionId), attr("pig.span.kind", span.kind), attr("pig.turn", span.turnId), attr("pig.run_id", span.runId),
    ...(span.kind === "model" ? [
      attr("gen_ai.operation.name", "chat"), attr("gen_ai.system", d.provider), attr("gen_ai.request.model", d.model ?? span.name),
      attr("gen_ai.usage.input_tokens", usage.prompt_tokens), attr("gen_ai.usage.output_tokens", usage.completion_tokens),
      attr("gen_ai.usage.cache_read_input_tokens", d.cache?.cachedTokens ?? undefined), attr("pig.cache.hit_rate", d.cache?.hitRate ?? undefined),
      attr("pig.cache.prefix", d.cache?.prefix), attr("gen_ai.response.finish_reasons", d.finishReason), attr("pig.ttft_ms", d.ttftMs ?? undefined),
      attr("pig.route", d.route),
    ] : []),
    ...(span.kind === "tool" ? [attr("gen_ai.operation.name", "execute_tool"), attr("gen_ai.tool.name", span.name), attr("pig.sandbox.effective", d.sandboxEffective)] : []),
    ...(span.name === "context_compaction" ? [attr("pig.compaction.folded", d.foldedMessages), attr("pig.compaction.before_chars", d.beforeChars), attr("pig.compaction.after_chars", d.afterChars)] : []),
    attr("error.type", d.error ? "error" : undefined),
  ].filter((a): a is Attr => Boolean(a));
  return {
    traceId: traceIdFor(span.sessionId), spanId: spanIdFor(span.sessionId, span.id),
    ...(span.parentId ? { parentSpanId: spanIdFor(span.sessionId, span.parentId) } : {}),
    name: span.kind === "model" ? `chat ${d.model ?? span.name}` : span.kind === "tool" ? `execute_tool ${span.name}` : span.name,
    kind: span.kind === "model" ? 3 /* CLIENT */ : 1 /* INTERNAL */,
    startTimeUnixNano: `${BigInt(Math.round(startMs)) * 1_000_000n}`, endTimeUnixNano: `${BigInt(Math.round(endMs)) * 1_000_000n}`,
    attributes: attrs,
    status: span.status === "error" ? { code: 2, message: String(d.error ?? "").slice(0, 200) } : { code: span.status === "ok" ? 1 : 0 },
  };
}

export function otlpPayload(spans: OtlpSpan[], serviceName = process.env.OTEL_SERVICE_NAME || "pig-agent") {
  return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] }, scopeSpans: [{ scope: { name: "pig-agent", version: "0.3.0" }, spans }] }] };
}

function parseHeaders(raw = ""): Record<string, string> {
  return Object.fromEntries(raw.split(",").map((kv) => kv.split("=")).filter(([k, v]) => k && v).map(([k, v]) => [decodeURIComponent(k!.trim()), decodeURIComponent(v!.trim())]));
}

export class OtlpExporter {
  private queue: OtlpSpan[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private exported = new Set<string>();
  constructor(private url: string, private headers: Record<string, string> = {}, private opts: { maxBatch?: number; delayMs?: number; fetchImpl?: typeof fetch } = {}) {}
  /** Queue a finished span once (running spans are skipped; updates of the same span are deduped). */
  enqueue(span: DebugSpan, wallOriginMs: number): void {
    if (span.status === "running") return;
    const key = `${span.sessionId}:${span.id}`;
    if (this.exported.has(key)) return;
    this.exported.add(key);
    if (this.exported.size > 50_000) this.exported.clear();
    this.queue.push(toOtlpSpan(span, wallOriginMs));
    if (this.queue.length >= (this.opts.maxBatch ?? 64)) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.opts.delayMs ?? 2000);
    this.timer?.unref?.();
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = this.queue.splice(0);
    if (!batch.length) return;
    try {
      await (this.opts.fetchImpl ?? fetch)(this.url, { method: "POST", headers: { "Content-Type": "application/json", ...this.headers }, body: JSON.stringify(otlpPayload(batch)), signal: AbortSignal.timeout(5000) });
    } catch { /* telemetry must never break the agent */ }
  }
}

let singleton: OtlpExporter | null | undefined;
export function exporterFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpExporter | null {
  if (singleton !== undefined) return singleton;
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = traces || (base ? `${base.replace(/\/$/, "")}/v1/traces` : "");
  singleton = url && env.OTEL_SDK_DISABLED !== "true" ? new OtlpExporter(url, parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)) : null;
  return singleton;
}
export function resetExporterForTests(): void { singleton = undefined; }
