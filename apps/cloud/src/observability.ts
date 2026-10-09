import type { Context, Hono } from "hono";
import { BatchExporter, runContext, runRootSpanId, runTraceId, toOtlpJson, Tracer, validSpan, type SpanRecord } from "@pig-agent/contracts/telemetry";
import { db, POOL_MAX } from "./db.ts";
import { bus } from "./event-bus.ts";
import { Counter, Gauge, Histogram, Registry } from "./metrics.ts";
import { tracingMiddleware, type RequestRecord } from "./tracing.ts";
import type { CloudEnv } from "./types.ts";

/**
 * Observability for the control plane:
 * - traces: spans from cloud, gateway, worker and runner land in `trace_spans` (head-sampled: run traces,
 *   explicitly traced calls, errors, slow requests) and are forwarded to OTEL_EXPORTER_OTLP_ENDPOINT if set;
 * - metrics: Prometheus text at /internal/metrics (worker or METRICS_TOKEN bearer) and /v1/admin/metrics;
 * - span-derived metrics: model upstream outcomes (gateway) and run execution time (worker).
 */
export const registry = new Registry();
export const httpRequests = registry.register(new Counter("pig_http_requests_total", "HTTP requests by route and status class", 800));
export const httpDuration = registry.register(new Histogram("pig_http_request_duration_seconds", "HTTP request latency by route (streams excluded)"));
export const modelRequests = registry.register(new Counter("pig_model_requests_total", "Model requests through the gateway by upstream status"));
export const modelDuration = registry.register(new Histogram("pig_model_request_duration_seconds", "Gateway model request time to response headers"));
export const runExecution = registry.register(new Histogram("pig_run_execution_seconds", "Worker execution time per run attempt by outcome"));
export const spansIngested = registry.register(new Counter("pig_trace_spans_total", "Spans received by service"));
const runsByState = registry.register(new Gauge("pig_runs", "Runs by state (non-terminal) or finished in the last hour (terminal)"));
const queueAge = registry.register(new Gauge("pig_queue_oldest_seconds", "Age of the oldest queued run"));
const runnersOnline = registry.register(new Gauge("pig_runners_online", "Enabled runners with a heartbeat in the last 30 s"));
const webhookDeliveries = registry.register(new Gauge("pig_webhook_deliveries", "Webhook deliveries by state (dead/succeeded: last hour)"));
const busLive = registry.register(new Gauge("pig_event_bus_live", "1 when the LISTEN connection is up"));
const pool = registry.register(new Gauge("pig_pg_pool_connections", "Postgres pool connections by state"));
const processGauge = registry.register(new Gauge("pig_process", "Process stats of this cloud instance"));
const alertsFiring = registry.register(new Gauge("pig_alerts_firing", "Firing alerts by severity"));
const telemetryGauge = registry.register(new Gauge("pig_telemetry_exporter", "Span exporter queue/drops"));

// ---- span storage ---------------------------------------------------------------------------------

const otlpUrl = (() => {
  const t = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const b = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return t || (b ? b.replace(/\/$/, "") + "/v1/traces" : "");
})();
const otlpHeaders = Object.fromEntries(
  (process.env.OTEL_EXPORTER_OTLP_HEADERS || "").split(",").map((kv) => kv.split("=")).filter(([k, v]) => k && v).map(([k, v]) => [k!.trim(), v!.trim()]),
);

export async function storeSpans(spans: SpanRecord[]) {
  if (!spans.length) return;
  await db.query(
    `INSERT INTO trace_spans(trace_id,span_id,parent_span_id,service,name,kind,start_time,duration_ms,status,attributes)
     SELECT x.trace_id,x.span_id,x.parent_span_id,x.service,x.name,x.kind,to_timestamp(x.start_ms/1000.0),x.duration_ms,x.status,x.attributes
     FROM jsonb_to_recordset($1::jsonb) AS x(trace_id text,span_id text,parent_span_id text,service text,name text,kind text,start_ms double precision,duration_ms double precision,status text,attributes jsonb)
     ON CONFLICT (trace_id,span_id) DO NOTHING`,
    [JSON.stringify(spans.map((s) => ({ trace_id: s.traceId, span_id: s.spanId, parent_span_id: s.parentSpanId ?? null, service: s.service, name: s.name, kind: s.kind, start_ms: s.startMs, duration_ms: s.durationMs, status: s.status, attributes: s.attributes })))],
  );
  if (otlpUrl)
    await fetch(otlpUrl, { method: "POST", headers: { "Content-Type": "application/json", ...otlpHeaders }, body: JSON.stringify(toOtlpJson(spans)), signal: AbortSignal.timeout(5000) }).catch(() => {
      telemetryGauge.set(1, { stat: "otlp_forward_failed" });
    });
}

export const spanStore = new BatchExporter(storeSpans, { maxQueue: 5000, maxBatch: 500, intervalMs: 1000 });
export const tracer = new Tracer("cloud", (span) => {
  observeSpan(span);
  spanStore.push(span);
});

/** Span-derived metrics, for spans from any service. */
export function observeSpan(span: SpanRecord) {
  spansIngested.inc({ service: span.service });
  if (span.service === "gateway" && span.attributes["http.route"] === "/v1/chat/completions") {
    const status = String(span.attributes["pig.upstream.status"] ?? span.attributes["http.response.status_code"] ?? "error");
    modelRequests.inc({ status });
    modelDuration.observe(span.durationMs / 1000);
    recentModel.push({ t: Date.now(), status });
  }
  if (span.service === "worker" && span.name === "worker.execute")
    runExecution.observe(span.durationMs / 1000, { outcome: span.status === "ok" ? "ok" : "error" });
}

// Sliding windows for alert rules (process-local).
export const recentModel: Array<{ t: number; status: string }> = [];
export const recentHttp: Array<{ t: number; status: number }> = [];
const trim = <T extends { t: number }>(list: T[], maxAgeMs: number) => {
  const cutoff = Date.now() - maxAgeMs;
  let i = 0;
  while (i < list.length && list[i]!.t < cutoff) i++;
  if (i) list.splice(0, i);
  if (list.length > 20_000) list.splice(0, list.length - 20_000);
};

// ---- request tracing + HTTP metrics ---------------------------------------------------------------

// Long-lived streams and polling: excluded from latency histograms, never stored as spans unless failing.
const STREAMING = /\/events$|^\/v1\/a2a$|^\/internal\/claim$|^\/internal\/approvals\/:id\/poll$/;
const NOISE = new Set(["/internal/runs/:id/heartbeat", "/internal/runs/:id/event", "/internal/workers/heartbeat", "/internal/claim", "/internal/telemetry/spans", "/internal/metrics", "/health"]);
const SLOW_S = 2;

export function shouldRecord(r: Pick<RequestRecord, "route" | "status" | "seconds"> & { sampledParent: boolean }) {
  if (r.status >= 500) return true;
  if (NOISE.has(r.route)) return false;
  if (r.sampledParent) return true;
  return r.seconds > SLOW_S && !STREAMING.test(r.route);
}

export const cloudTracingMiddleware = tracingMiddleware(tracer, {
  ignore: (path) => path.startsWith("/assets/"),
  trustParent: (path) => path.startsWith("/internal/"),
  shouldRecord: (r) => shouldRecord({ ...r, sampledParent: !!r.span.parent?.sampled }),
  onRequest: ({ method, route, status, seconds }) => {
    const statusClass = `${Math.floor(status / 100)}xx`;
    httpRequests.inc({ method, route, status: statusClass });
    if (!STREAMING.test(route)) httpDuration.observe(seconds, { route });
    if (!NOISE.has(route)) recentHttp.push({ t: Date.now(), status });
  },
});

// ---- run traces -------------------------------------------------------------------------------------

/** Records the queue wait of a just-claimed run under the run's root span. */
export function recordQueued(runId: string, createdAt: Date, workerId: string) {
  const startMs = createdAt.getTime();
  tracer.record({ traceId: runTraceId(runId), parentSpanId: runRootSpanId(runId), name: "run.queued", kind: "internal", startMs, durationMs: Math.max(0, Date.now() - startMs), status: "ok", attributes: { "pig.run_id": runId, "pig.worker_id": workerId } });
}

/** Root span of a run (created -> terminal); written when the run finishes. */
export async function recordRunRoot(runId: string) {
  const r = (await db.query("SELECT state,created_at,updated_at,execution_profile,owner_id FROM runs WHERE id=$1", [runId])).rows[0];
  if (!r) return;
  const startMs = new Date(r.created_at).getTime();
  tracer.record({
    traceId: runTraceId(runId), spanId: runRootSpanId(runId), name: "run", kind: "server", startMs,
    durationMs: Math.max(0, new Date(r.updated_at).getTime() - startMs), status: r.state === "succeeded" ? "ok" : r.state === "failed" ? "error" : "unset",
    attributes: { "pig.run_id": runId, "pig.run.state": r.state, "pig.run.profile": r.execution_profile },
  });
}

function spanView(row: any) {
  return {
    traceId: row.trace_id, spanId: row.span_id, parentSpanId: row.parent_span_id ?? undefined, service: row.service, name: row.name, kind: row.kind,
    startTime: new Date(row.start_time).toISOString(), durationMs: Math.round(Number(row.duration_ms) * 10) / 10, status: row.status, attributes: row.attributes,
  };
}

const TRACE_SPAN_LIMIT = 2000;
export async function runTrace(run: { id: string; state: string; created_at: Date; updated_at: Date }) {
  const traceId = runTraceId(run.id);
  const rootId = runRootSpanId(run.id);
  // Root first so it survives the cap; then chronological.
  const rows = (await db.query("SELECT *, count(*) OVER () AS total FROM trace_spans WHERE trace_id=$1 ORDER BY (span_id=$2) DESC, start_time, span_id LIMIT $3", [traceId, rootId, TRACE_SPAN_LIMIT])).rows;
  const total = Number(rows[0]?.total ?? 0);
  const spans = rows.map(spanView);
  if (!spans.some((s) => s.spanId === rootId)) {
    const start = new Date(run.created_at);
    spans.unshift({ traceId, spanId: rootId, parentSpanId: undefined, service: "cloud", name: "run", kind: "server", startTime: start.toISOString(),
      durationMs: Math.max(0, (["succeeded", "failed", "cancelled"].includes(run.state) ? new Date(run.updated_at).getTime() : Date.now()) - start.getTime()),
      status: run.state === "failed" ? "error" : run.state === "succeeded" ? "ok" : "unset", attributes: { "pig.run_id": run.id, "pig.run.state": run.state, synthesized: true } });
  }
  const services = [...new Set(spans.map((s) => s.service))].sort();
  return { traceId, rootSpanId: rootId, services, spanCount: spans.length, truncated: total > spans.length, spans };
}

// ---- routes ---------------------------------------------------------------------------------------

const MAX_INGEST = 500;
export const adminOnly = (c: Context<CloudEnv>) => (c.get("principal")?.role === "admin" ? undefined : c.json({ error: "需要管理员权限" }, 403));
export function registerObservabilityRoutes(app: Hono<CloudEnv>, runFor: (id: string, p: any) => Promise<any>) {
  app.post("/internal/telemetry/spans", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { spans?: unknown[] } | null;
    const list = Array.isArray(body?.spans) ? body!.spans.slice(0, MAX_INGEST) : [];
    let accepted = 0;
    for (const s of list) {
      if (!validSpan(s) || !["gateway", "worker", "runner"].includes(s.service)) continue;
      observeSpan(s);
      spanStore.push(s);
      accepted++;
    }
    return c.json({ accepted, rejected: list.length - accepted });
  });
  app.get("/v1/runs/:id/trace", async (c) => {
    const run = await runFor(c.req.param("id"), c.get("principal"));
    if (!run) return c.json({ error: "Not found" }, 404);
    await spanStore.flush();
    return c.json(await runTrace(run));
  });
  app.get("/v1/admin/metrics", async (c) => adminOnly(c) ?? c.text(await registry.render(), 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }));
  app.get("/v1/admin/traces", async (c) => {
    const denied = adminOnly(c);
    if (denied) return denied;
    const limit = Math.max(1, Math.min(100, Number(c.req.query("limit")) || 20));
    const errorsOnly = c.req.query("status") === "error";
    await spanStore.flush();
    const { rows } = await db.query(
      `SELECT trace_id, min(start_time) AS start_time, count(*)::int AS spans, array_agg(DISTINCT service) AS services,
              bool_or(status='error') AS has_error, max(duration_ms) AS max_ms,
              (array_agg(name ORDER BY start_time))[1] AS first_span, max(attributes->>'pig.run_id') AS run_id
       FROM trace_spans WHERE created_at > now() - interval '7 days'
       GROUP BY trace_id HAVING ($2::boolean IS FALSE OR bool_or(status='error'))
       ORDER BY min(start_time) DESC LIMIT $1`,
      [limit, errorsOnly],
    );
    return c.json({ traces: rows.map((r) => ({ traceId: r.trace_id, startTime: r.start_time, spans: r.spans, services: r.services.sort(), hasError: r.has_error, maxDurationMs: Math.round(r.max_ms), firstSpan: r.first_span, runId: r.run_id ?? undefined })) });
  });
}

/** Prometheus endpoint, registered before the /internal auth so a separate METRICS_TOKEN can be used. */
export function registerMetricsEndpoint(app: Hono<CloudEnv>) {
  app.get("/internal/metrics", async (c) => {
    const auth = c.req.header("Authorization") || "";
    const ok = [process.env.METRICS_TOKEN, process.env.WORKER_TOKEN].some((t) => t && auth === `Bearer ${t}`);
    if (!ok) return c.json({ error: "Unauthorized" }, 401);
    return c.text(await registry.render(), 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
  });
}

// ---- scrape-time collectors -------------------------------------------------------------------------

registry.onCollect(async () => {
  const { rows } = await db.query(
    `SELECT state, count(*)::int AS n FROM runs
     WHERE state NOT IN ('succeeded','failed','cancelled') OR updated_at > now() - interval '1 hour' GROUP BY state`,
  );
  runsByState.reset();
  for (const state of ["queued", "preparing", "running", "cancelling", "succeeded", "failed", "cancelled"]) runsByState.set(rows.find((r) => r.state === state)?.n ?? 0, { state });
  const q = (await db.query("SELECT coalesce(extract(epoch FROM now()-min(created_at)),0) AS age FROM runs WHERE state='queued'")).rows[0];
  queueAge.set(Math.round(Number(q.age)));
  runnersOnline.set((await db.query("SELECT count(*)::int AS n FROM workers WHERE enabled AND seen_at > now() - interval '30 seconds'")).rows[0].n);
  const w = (await db.query(
    "SELECT state, count(*)::int AS n FROM webhook_deliveries WHERE state IN ('pending','delivering') OR created_at > now() - interval '1 hour' GROUP BY state",
  )).rows;
  webhookDeliveries.reset();
  for (const state of ["pending", "delivering", "succeeded", "dead"]) webhookDeliveries.set(w.find((r) => r.state === state)?.n ?? 0, { state });
  const a = (await db.query("SELECT severity, count(*)::int AS n FROM alerts WHERE state='firing' GROUP BY severity")).rows;
  alertsFiring.reset();
  for (const severity of ["info", "warning", "critical"]) alertsFiring.set(a.find((r) => r.severity === severity)?.n ?? 0, { severity });
});
registry.onCollect(() => {
  busLive.set(bus.live ? 1 : 0);
  pool.set(db.totalCount, { state: "total" });
  pool.set(db.idleCount, { state: "idle" });
  pool.set(db.waitingCount, { state: "waiting" });
  pool.set(POOL_MAX, { state: "max" });
  const m = process.memoryUsage();
  processGauge.set(Math.round(process.uptime()), { stat: "uptime_seconds" });
  processGauge.set(m.rss, { stat: "rss_bytes" });
  processGauge.set(m.heapUsed, { stat: "heap_used_bytes" });
  telemetryGauge.set(spanStore.stats.queued, { stat: "queued" });
  telemetryGauge.set(spanStore.stats.dropped, { stat: "dropped" });
  telemetryGauge.set(spanStore.stats.failedBatches, { stat: "failed_batches" });
  trim(recentModel, 30 * 60_000);
  trim(recentHttp, 10 * 60_000);
});

let pruneTimer: ReturnType<typeof setInterval> | undefined;
export function startObservability() {
  spanStore.start();
  pruneTimer ??= setInterval(() => {
    void db.query("DELETE FROM trace_spans WHERE created_at < now() - make_interval(days => $1)", [Math.max(1, Number(process.env.TRACE_RETENTION_DAYS) || 7)]).catch(() => {});
    void db.query("DELETE FROM alerts WHERE state='resolved' AND resolved_at < now() - interval '30 days'").catch(() => {});
  }, 3_600_000);
  pruneTimer.unref();
}
export { runContext, trim };
