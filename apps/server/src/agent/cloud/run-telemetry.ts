import { fnv64, parseTraceparent, Tracer, type AttrValue, type SpanContext, type SpanRecord } from "@pig-agent/contracts/telemetry";
import type { DebugSpan } from "@pig-agent/contracts";

/**
 * Cloud runner telemetry: joins the run trace from TRACEPARENT (set by the worker), propagates it to the
 * gateway, and converts the runner's debug spans (model / tool / approval / sandbox) into OTel spans.
 * Only metadata is exported (model, token counts, tool name, timings) — never prompt or tool content.
 */
export function runnerTelemetry(env: NodeJS.ProcessEnv, gateway: string) {
  const parent = parseTraceparent(env.TRACEPARENT);
  const records: SpanRecord[] = [];
  const tracer = new Tracer("runner", (s) => records.push(s));
  const agent = parent ? tracer.start("runner.agent", { parent }) : undefined;

  /** fetch wrapper: gateway calls carry the runner span's traceparent. */
  function wrapFetch(base: typeof fetch): typeof fetch {
    if (!agent) return base;
    return ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(gateway)) return base(input, init);
      const headers = new Headers(init?.headers);
      headers.set("traceparent", agent.traceparent);
      return base(input, { ...init, headers });
    }) as typeof fetch;
  }

  function finish(runId: string, ok: boolean, debugSpans: DebugSpan[], wallOrigin: number | undefined) {
    if (!agent || !parent) return [];
    agent.set({ "pig.run_id": runId, "pig.result.ok": ok }).end(ok ? "ok" : "error");
    const origin = wallOrigin ?? agent.startMs;
    for (const span of debugSpans) {
      if (span.status === "running") continue;
      records.push(convert(span, agent.context, origin));
    }
    return records.splice(0);
  }
  return { parent, agent, wrapFetch, finish };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : undefined);

export function convert(span: DebugSpan, agent: SpanContext, wallOrigin: number): SpanRecord {
  const d = (span.detail ?? {}) as Record<string, any>;
  const startMs = span.wallStartedAt ? Date.parse(span.wallStartedAt) : wallOrigin + span.startedAtMs;
  const attributes: Record<string, AttrValue> = { "pig.span.kind": span.kind };
  const put = (k: string, v: AttrValue | undefined) => {
    if (v !== undefined) attributes[k] = v;
  };
  if (span.kind === "model") {
    put("gen_ai.operation.name", "chat");
    put("gen_ai.request.model", str(d.model) ?? span.name);
    put("gen_ai.usage.input_tokens", num(d.usage?.prompt_tokens));
    put("gen_ai.usage.output_tokens", num(d.usage?.completion_tokens));
    put("gen_ai.usage.cache_read_input_tokens", num(d.cache?.cachedTokens));
    put("pig.ttft_ms", num(d.ttftMs));
    put("gen_ai.response.finish_reasons", str(d.finishReason));
  }
  if (span.kind === "tool") {
    put("gen_ai.operation.name", "execute_tool");
    put("gen_ai.tool.name", span.name);
  }
  if (d.error) put("error.type", "error");
  const id = (x: string) => fnv64(`dbg:${span.sessionId}:${x}`);
  return {
    traceId: agent.traceId,
    spanId: id(span.id),
    parentSpanId: span.parentId ? id(span.parentId) : agent.spanId,
    name: span.kind === "model" ? `chat ${str(d.model) ?? span.name}` : span.kind === "tool" ? `execute_tool ${span.name}` : span.name.slice(0, 200),
    service: "runner",
    kind: span.kind === "model" ? "client" : "internal",
    startMs: Number.isFinite(startMs) ? startMs : wallOrigin,
    durationMs: Math.max(0, span.durationMs ?? 0),
    status: span.status === "error" ? "error" : span.status === "ok" ? "ok" : "unset",
    attributes,
  };
}
