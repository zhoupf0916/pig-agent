/**
 * A2A (Agent2Agent, protocol 0.3) JSON-RPC endpoint over the existing run API.
 *
 *   GET  /.well-known/agent-card.json   public Agent Card (bearer auth declared)
 *   POST /v1/a2a                        JSON-RPC: message/send, tasks/get, tasks/cancel
 *
 * A2A Task = cloud run, contextId = conversation. A message carrying a known contextId (or
 * referenceTaskIds) becomes a follow-up run in that conversation. Everything is forwarded to the
 * /v1 routes in-process with the caller's own credentials, so auth, quotas, execution policy,
 * approvals and idempotency (messageId → Idempotency-Key) are exactly those of the web API.
 */
import { createHash } from "node:crypto";
import type { Hono } from "hono";

type Json = Record<string, any>;
export type Forward = (method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: Json }>;
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

export function agentCard(origin: string, version = "0.1.1"): Json {
  return {
    protocolVersion: "0.3.0",
    name: "Pig Agent Cloud",
    description: "在隔离容器沙箱中执行代码/文件/数据任务的通用 Agent；支持多轮上下文、审批与成果文件。",
    url: `${origin}/v1/a2a`,
    preferredTransport: "JSONRPC",
    version,
    provider: { organization: "pig-agent", url: origin },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
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

export async function handleA2a(forward: Forward, req: Json, headers: Record<string, string>, opts: { blockingTimeoutMs?: number; pollMs?: number } = {}): Promise<Json> {
  const id = req?.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (e: { code: number; message: string }, data?: unknown) => ({ jsonrpc: "2.0", id, error: { ...e, ...(data === undefined ? {} : { data }) } });
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") return fail(A2A_ERRORS.invalidRequest);
  const params: Json = req.params ?? {};
  try {
    if (req.method === "message/send") {
      const message = params.message;
      if (!message || message.role !== "user" || typeof message.messageId !== "string" || message.messageId.length > 120) return fail(A2A_ERRORS.invalidParams, "message.role=user 与 messageId 必填");
      const prompt = textOf(message);
      if (!prompt) return fail(A2A_ERRORS.unsupportedContent, "目前只支持 text 部件");
      // Header-safe, bounded idempotency key derived from the client messageId (scoped per owner server-side).
      const h = { ...headers, "Idempotency-Key": `a2a:${createHash("sha256").update(message.messageId).digest("hex").slice(0, 48)}` };
      let parent: string | undefined = message.taskId ?? (Array.isArray(message.referenceTaskIds) ? message.referenceTaskIds.at(-1) : undefined);
      if (!parent && message.contextId) {
        const conv = await forward("GET", `/v1/conversations/${encodeURIComponent(message.contextId)}`, { headers: h });
        if (conv.status === 404) return fail(A2A_ERRORS.taskNotFound, "contextId 不存在");
        parent = (conv.body.runs ?? []).at(-1)?.id;
      }
      const created = parent
        ? await forward("POST", `/v1/runs/${encodeURIComponent(parent)}/follow-ups`, { headers: h, body: { prompt } })
        : await forward("POST", "/v1/runs", { headers: h, body: { prompt, ...(params.metadata?.pig ?? {}) } });
      if (created.status === 404) return fail(A2A_ERRORS.taskNotFound);
      if (created.status >= 400) return fail(A2A_ERRORS.invalidParams, created.body.error ?? `HTTP ${created.status}`);
      const runId = String(created.body.id);
      const deadline = Date.now() + (params.configuration?.blocking ? opts.blockingTimeoutMs ?? 60_000 : 0);
      let task = await buildTask(forward, runId, headers);
      while (task && !TERMINAL.has(task.status.state) && task.status.state !== "input-required" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
        task = await buildTask(forward, runId, headers);
      }
      return task ? ok(task) : fail(A2A_ERRORS.taskNotFound);
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
    if (req.method === "message/stream" || req.method === "tasks/resubscribe" || req.method.startsWith("tasks/pushNotificationConfig/")) return fail({ code: -32004, message: "This operation is not supported" });
    return fail(A2A_ERRORS.methodNotFound);
  } catch (error) {
    return fail(A2A_ERRORS.internal, (error as Error).message);
  }
}

export function registerA2aRoutes(app: Hono<any>): void {
  app.get("/.well-known/agent-card.json", (c) => {
    const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || new URL(c.req.url).origin;
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
    return c.json(await handleA2a(forward, req, headers, { blockingTimeoutMs: Number(process.env.A2A_BLOCKING_TIMEOUT_MS) || 60_000 }));
  });
}
