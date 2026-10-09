/**
 * A2A (Agent2Agent, protocol 0.3) JSON-RPC endpoint over the existing run API.
 *
 *   GET  /.well-known/agent-card.json   public Agent Card (bearer auth declared)
 *   POST /v1/a2a                        JSON-RPC: message/send, tasks/get, tasks/cancel,
 *                                       message/stream + tasks/resubscribe (SSE)
 *
 * A2A Task = cloud run, contextId = conversation. A message carrying a known contextId (or
 * referenceTaskIds) becomes a follow-up run in that conversation. Everything is forwarded to the
 * /v1 routes in-process with the caller's own credentials, so auth, quotas, execution policy,
 * approvals and idempotency (messageId → Idempotency-Key) are exactly those of the web API.
 */
import { bus } from "./event-bus.ts";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";

type Json = Record<string, any>;
export type Forward = (method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: Json }>;
/** Opens a raw (streaming) GET on the /v1 surface, e.g. the run SSE event stream. */
export type OpenStream = (path: string, headers: Record<string, string>) => Promise<Response>;
export type TaskState = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected" | "auth-required" | "unknown";

export const A2A_ERRORS = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid Request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  internal: { code: -32603, message: "Internal error" },
  taskNotFound: { code: -32001, message: "Task not found" },
  taskNotCancelable: { code: -32002, message: "Task cannot be canceled" },
  unsupportedContent: { code: -32005, message: "Incompatible content types" },
} as const;

const TERMINAL = new Set<TaskState>(["completed", "canceled", "failed", "rejected"]);

export function taskState(runState: string, pendingApproval = false): TaskState {
  if (pendingApproval && !["succeeded", "failed", "cancelled"].includes(runState)) return "input-required";
  switch (runState) {
    case "queued": case "preparing": return "submitted";
    case "running": case "cancelling": return "working";
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "cancelled": return "canceled";
    default: return "unknown";
  }
}

/** Public origin for the agent card. PUBLIC_ORIGIN wins; otherwise WEB_PUBLIC_ORIGIN (what the rest of the app uses); otherwise the request origin. Behind a TLS-terminating proxy the request arrives as plain http, and advertising that URL would send clients' bearer tokens in cleartext. */
export function configuredPublicOrigin(): string | undefined {
  for (const value of [process.env.PUBLIC_ORIGIN, process.env.WEB_PUBLIC_ORIGIN]) {
    if (!value) continue;
    try { return new URL(value).origin; } catch { /* skip a malformed value, fall through */ }
  }
  return undefined;
}
export function agentCard(origin: string, version = "0.1.1"): Json {
  return {
    protocolVersion: "0.3.0",
    name: "Pig Agent Cloud",
    description: "在隔离容器沙箱中执行代码/文件/数据任务的通用 Agent；支持多轮上下文、审批与成果文件。",
    url: `${origin}/v1/a2a`,
    preferredTransport: "JSONRPC",
    version,
    provider: { organization: "pig-agent", url: origin },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Pig Cloud API token" } },
    security: [{ bearer: [] }],
    skills: [
      { id: "workbench", name: "云端工作台任务", description: "读写工作区文件、运行命令、分析数据并返回结果与产物", tags: ["code", "files", "shell", "data"], examples: ["统计 app.log 中 ERROR 行数", "创建 report.md 总结这些 CSV"] },
    ],
  };
}

function textOf(message: Json | undefined): string | null {
  if (!message || !Array.isArray(message.parts)) return null;
  const texts = message.parts.filter((p: Json) => (p?.kind ?? p?.type) === "text" && typeof p.text === "string").map((p: Json) => p.text);
  if (texts.length !== message.parts.length) return null; // files/data parts not supported yet
  const text = texts.join("\n").trim();
  return text || null;
}

function lastAssistant(events: Array<{ event: Json }>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = events[i]!.event?.message;
    if (events[i]!.event?.type === "message" && m?.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

export async function buildTask(forward: Forward, id: string, headers: Record<string, string>): Promise<Json | null> {
  const run = await forward("GET", `/v1/runs/${id}`, { headers });
  if (run.status === 404) return null;
  if (run.status >= 400) throw Object.assign(new Error(run.body.error ?? "run lookup failed"), { status: run.status });
  const r = run.body;
  const approvals = r.state === "running" || r.state === "preparing" ? await forward("GET", `/v1/runs/${id}/approvals`, { headers }) : { status: 200, body: {} };
  const pending = (approvals.body.approvals ?? []).some((a: Json) => a.state === "pending");
  const state = taskState(r.state, pending);
  const task: Json = { kind: "task", id, contextId: r.conversation_id, status: { state, timestamp: new Date(r.updated_at ?? Date.now()).toISOString() } };
  if (state === "failed" && r.error) task.status.message = { kind: "message", role: "agent", messageId: `${id}:error`, parts: [{ kind: "text", text: String(r.error) }] };
  if (state === "input-required") task.status.message = { kind: "message", role: "agent", messageId: `${id}:approval`, parts: [{ kind: "text", text: "任务在等待人工审批（在 Pig Cloud 网页中处理）。" }] };
  if (TERMINAL.has(state)) {
    const [log, files] = await Promise.all([forward("GET", `/v1/runs/${id}/eventlog`, { headers }), forward("GET", `/v1/runs/${id}/artifacts`, { headers })]);
    const reply = lastAssistant(log.body.events ?? []);
    const artifacts: Json[] = [];
    if (reply) artifacts.push({ artifactId: `${id}:reply`, name: "reply", parts: [{ kind: "text", text: reply }] });
    for (const a of files.body.artifacts ?? []) artifacts.push({ artifactId: String(a.id), name: String(a.path), parts: [{ kind: "data", data: { path: a.path, size: a.size, download: `/v1/runs/${id}/artifacts/${a.id}` } }] });
    if (artifacts.length) task.artifacts = artifacts;
    if (reply) task.status.message = { kind: "message", role: "agent", messageId: `${id}:final`, taskId: id, contextId: r.conversation_id, parts: [{ kind: "text", text: reply }] };
  }
  return task;
}

type Created = { runId: string } | { error: { code: number; message: string }; data?: unknown };

/** Validate an A2A user message and turn it into a run (new conversation or follow-up). */
async function createFromMessage(forward: Forward, params: Json, headers: Record<string, string>): Promise<Created> {
  const message = params.message;
  if (!message || message.role !== "user" || typeof message.messageId !== "string" || message.messageId.length > 120) return { error: A2A_ERRORS.invalidParams, data: "message.role=user 与 messageId 必填" };
  const prompt = textOf(message);
  if (!prompt) return { error: A2A_ERRORS.unsupportedContent, data: "目前只支持 text 部件" };
  // Header-safe, bounded idempotency key derived from the client messageId (scoped per owner server-side).
  const h = { ...headers, "Idempotency-Key": `a2a:${createHash("sha256").update(message.messageId).digest("hex").slice(0, 48)}` };
  let parent: string | undefined = message.taskId ?? (Array.isArray(message.referenceTaskIds) ? message.referenceTaskIds.at(-1) : undefined);
  if (!parent && message.contextId) {
    const conv = await forward("GET", `/v1/conversations/${encodeURIComponent(message.contextId)}`, { headers: h });
    if (conv.status === 404) return { error: A2A_ERRORS.taskNotFound, data: "contextId 不存在" };
    parent = (conv.body.runs ?? []).at(-1)?.id;
  }
  const created = parent
    ? await forward("POST", `/v1/runs/${encodeURIComponent(parent)}/follow-ups`, { headers: h, body: { prompt } })
    : await forward("POST", "/v1/runs", { headers: h, body: { prompt, ...(params.metadata?.pig ?? {}) } });
  if (created.status === 404) return { error: A2A_ERRORS.taskNotFound };
  if (created.status >= 400) return { error: A2A_ERRORS.invalidParams, data: created.body.error ?? `HTTP ${created.status}` };
  return { runId: String(created.body.id) };
}

export async function handleA2a(forward: Forward, req: Json, headers: Record<string, string>, opts: { blockingTimeoutMs?: number; pollMs?: number } = {}): Promise<Json> {
  const id = req?.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (e: { code: number; message: string }, data?: unknown) => ({ jsonrpc: "2.0", id, error: { ...e, ...(data === undefined ? {} : { data }) } });
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") return fail(A2A_ERRORS.invalidRequest);
  const params: Json = req.params ?? {};
  try {
    if (req.method === "message/send") {
      const created = await createFromMessage(forward, params, headers);
      if ("error" in created) return fail(created.error, created.data);
      const runId = created.runId;
      const deadline = Date.now() + (params.configuration?.blocking ? opts.blockingTimeoutMs ?? 60_000 : 0);
      // Woken by the event bus on run changes; without the bus this is the previous poll interval.
      const sub = bus.subscribe([`run:${runId}`]);
      try {
        let task = await buildTask(forward, runId, headers);
        while (task && !TERMINAL.has(task.status.state) && task.status.state !== "input-required" && Date.now() < deadline) {
          await sub.wait({ liveMs: Math.min(deadline - Date.now(), 15_000), pollMs: opts.pollMs ?? 1000 });
          task = await buildTask(forward, runId, headers);
        }
        return task ? ok(task) : fail(A2A_ERRORS.taskNotFound);
      } finally {
        sub.close();
      }
    }
    if (req.method === "tasks/get") {
      if (typeof params.id !== "string") return fail(A2A_ERRORS.invalidParams, "id 必填");
      const task = await buildTask(forward, params.id, headers);
      return task ? ok(task) : fail(A2A_ERRORS.taskNotFound);
    }
    if (req.method === "tasks/cancel") {
      if (typeof params.id !== "string") return fail(A2A_ERRORS.invalidParams, "id 必填");
      const before = await buildTask(forward, params.id, headers);
      if (!before) return fail(A2A_ERRORS.taskNotFound);
      if (TERMINAL.has(before.status.state)) return fail(A2A_ERRORS.taskNotCancelable, `任务已是 ${before.status.state}`);
      const res = await forward("POST", `/v1/runs/${params.id}/abort`, { headers });
      if (res.status >= 400) return fail(A2A_ERRORS.taskNotCancelable, res.body.error);
      return ok(await buildTask(forward, params.id, headers));
    }
    if (req.method.startsWith("tasks/pushNotificationConfig/")) return fail({ code: -32004, message: "This operation is not supported" });
    return fail(A2A_ERRORS.methodNotFound);
  } catch (error) {
    return fail(A2A_ERRORS.internal, (error as Error).message);
  }
}

/** Parse an SSE byte stream into `data:` payloads (ignores comments, ids and named heartbeat events). */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Json | "idle"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
  try {
    while (!signal?.aborted) {
      pending ??= reader.read();
      // Surface idle gaps so the caller can poll side state (approvals) without losing the read.
      const next = await Promise.race([pending, new Promise<"idle">((r) => setTimeout(() => r("idle"), 1500))]);
      if (next === "idle") { yield "idle"; continue; }
      pending = undefined;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (/^event: *heartbeat/m.test(frame)) continue;
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { yield JSON.parse(data) as Json; } catch { /* ignore malformed frame */ }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Follow a run and emit A2A stream events (JSON-RPC results):
 *  - TaskStatusUpdateEvent (kind "status-update"): working / tool progress / input-required (approval
 *    pending in the web UI; stream stays open) / final state with the reply as status.message, final=true
 *  - TaskArtifactUpdateEvent (kind "artifact-update"): streamed assistant text per model turn
 *    (append=true chunks, lastChunk at turn end) and produced files at the end
 */
export async function* followRun(forward: Forward, open: OpenStream, runId: string, contextId: string, headers: Record<string, string>, opts: { signal?: AbortSignal; flushMs?: number } = {}): AsyncGenerator<Json> {
  const now = () => new Date().toISOString();
  const status = (state: TaskState, text?: string, extra: Json = {}, final = false): Json => ({
    kind: "status-update", taskId: runId, contextId, final,
    status: { state, timestamp: now(), ...(text ? { message: { kind: "message", role: "agent", messageId: `${runId}:s:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, taskId: runId, contextId, parts: [{ kind: "text", text }] } } : {}) },
    ...extra,
  });
  let state: TaskState = "submitted";
  let turn = 0;
  let chunkIndex = 0;
  let buffer = "";
  let lastFlush = Date.now();
  const flush = (lastChunk: boolean): Json | null => {
    if (!buffer && !(lastChunk && chunkIndex > 0)) return null;
    const ev = { kind: "artifact-update", taskId: runId, contextId, append: chunkIndex > 0, lastChunk, artifact: { artifactId: `${runId}:turn-${turn}`, name: `assistant-turn-${turn}`, parts: [{ kind: "text", text: buffer }] } };
    buffer = ""; lastFlush = Date.now();
    if (lastChunk) { turn += 1; chunkIndex = 0; } else chunkIndex += 1;
    return ev;
  };
  const res = await open(`/v1/runs/${runId}/events`, headers);
  if (!res.ok || !res.body) throw new Error(`run events HTTP ${res.status}`);
  for await (const ev of sseData(res.body, opts.signal)) {
    if (ev === "idle") {
      if (state === "working" || state === "submitted") {
        const approvals = await forward("GET", `/v1/runs/${runId}/approvals`, { headers });
        if ((approvals.body.approvals ?? []).some((a: Json) => a.state === "pending")) { state = "input-required"; yield status(state, "任务在等待人工审批（在 Pig Cloud 网页中处理）。"); }
      }
      continue;
    }
    if (state !== "working" && ev.type !== "status") { state = "working"; yield status("working"); }
    if (ev.type === "token" && typeof ev.text === "string") {
      buffer += ev.text;
      if (Date.now() - lastFlush >= (opts.flushMs ?? 250) || buffer.length >= 400) { const out = flush(false); if (out) yield out; }
    } else if (ev.type === "message" && ev.message?.role === "assistant") {
      if (!buffer && chunkIndex === 0 && typeof ev.message.content === "string") buffer = ev.message.content; // non-streamed turn
      const out = flush(true); if (out) yield out;
    } else if (ev.type === "tool_start" && typeof ev.name === "string") {
      const out = flush(false); if (out) yield out;
      yield status("working", `调用工具 ${ev.name}`, { metadata: { pig: { tool: ev.name, callId: ev.id } } });
    }
  }
  if (opts.signal?.aborted) return;
  const tail = flush(true); if (tail) yield tail;
  const task = await buildTask(forward, runId, headers);
  if (!task) throw new Error("task disappeared");
  for (const a of (task.artifacts ?? []).filter((x: Json) => x.name !== "reply")) yield { kind: "artifact-update", taskId: runId, contextId, append: false, lastChunk: true, artifact: a };
  yield { kind: "status-update", taskId: runId, contextId, final: TERMINAL.has(task.status.state), status: task.status };
}

/** JSON-RPC streaming methods: message/stream and tasks/resubscribe. Yields JSON-RPC responses. */
export async function* handleA2aStream(forward: Forward, open: OpenStream, req: Json, headers: Record<string, string>, opts: { signal?: AbortSignal; flushMs?: number } = {}): AsyncGenerator<Json> {
  const id = req?.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (e: { code: number; message: string }, data?: unknown) => ({ jsonrpc: "2.0", id, error: { ...e, ...(data === undefined ? {} : { data }) } });
  const params: Json = req.params ?? {};
  try {
    let task: Json | null;
    if (req.method === "message/stream") {
      const created = await createFromMessage(forward, params, headers);
      if ("error" in created) { yield fail(created.error, created.data); return; }
      task = await buildTask(forward, created.runId, headers);
    } else {
      if (typeof params.id !== "string") { yield fail(A2A_ERRORS.invalidParams, "id 必填"); return; }
      task = await buildTask(forward, params.id, headers);
    }
    if (!task) { yield fail(A2A_ERRORS.taskNotFound); return; }
    yield ok(task);
    if (TERMINAL.has(task.status.state)) return; // resubscribe to a finished task: the Task object is the whole answer
    for await (const ev of followRun(forward, open, task.id, task.contextId, headers, opts)) yield ok(ev);
  } catch (error) {
    yield fail(A2A_ERRORS.internal, (error as Error).message);
  }
}

export function registerA2aRoutes(app: Hono<any>): void {
  app.get("/.well-known/agent-card.json", (c) => {
    const origin = configuredPublicOrigin() || new URL(c.req.url).origin;
    c.header("Cache-Control", "public, max-age=300");
    return c.json(agentCard(origin));
  });
  app.post("/v1/a2a", async (c) => {
    const req = await c.req.json().catch(() => undefined);
    if (req === undefined) return c.json({ jsonrpc: "2.0", id: null, error: A2A_ERRORS.parse });
    const headers: Record<string, string> = {};
    for (const name of ["authorization", "cookie", "origin"]) { const v = c.req.header(name); if (v) headers[name] = v; }
    const forward: Forward = async (method, path, init = {}) => {
      const res = await app.request(path, { method, headers: { ...headers, ...(init.headers ?? {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: res.status, body: await res.json().catch(() => ({})) as Json };
    };
    if (req?.jsonrpc === "2.0" && (req.method === "message/stream" || req.method === "tasks/resubscribe")) {
      const open: OpenStream = async (path, h) => app.request(path, { method: "GET", headers: { ...headers, ...h } });
      return streamSSE(c, async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());
        for await (const event of handleA2aStream(forward, open, req, headers, { signal: abort.signal })) {
          if (stream.aborted) break;
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
      });
    }
    return c.json(await handleA2a(forward, req, headers, { blockingTimeoutMs: Number(process.env.A2A_BLOCKING_TIMEOUT_MS) || 60_000 }));
  });
}
