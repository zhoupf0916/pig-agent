import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describe, expect, it } from "vitest";
import { agentCard, registerA2aRoutes, taskState } from "./a2a.ts";

/** Fake /v1 surface standing in for the real run API (auth + runs + conversations). */
function fakeCloud() {
  const app = new Hono();
  const runs = new Map<string, any>();
  const keys = new Map<string, string>();
  const seen: string[] = [];
  let n = 0;
  app.use("/v1/*", async (c, next) => {
    if (c.req.header("authorization") !== "Bearer good") return c.json({ error: "请登录后继续" }, 401);
    seen.push(`${c.req.method} ${c.req.path}`);
    await next();
  });
  registerA2aRoutes(app);
  const opts = { script: undefined as undefined | Array<Record<string, unknown> | { sleep: number }> };
  const create = (prompt: string, key: string | undefined, conv?: string) => {
    if (key && keys.has(key)) return keys.get(key)!;
    const id = `run_${++n}`;
    runs.set(id, { id, state: opts.script ? "running" : "succeeded", conversation_id: conv ?? `conv_${n}`, updated_at: "2026-10-08T00:00:00Z", prompt, error: null, script: opts.script });
    if (key) keys.set(key, id);
    return id;
  };
  app.post("/v1/runs", async (c) => { const b = await c.req.json(); const id = create(b.prompt, c.req.header("Idempotency-Key")); return c.json({ id, status: "queued" }, 201); });
  app.post("/v1/runs/:id/follow-ups", async (c) => {
    const parent = runs.get(c.req.param("id")); if (!parent) return c.json({ error: "任务不存在" }, 404);
    const b = await c.req.json(); const id = create(b.prompt, c.req.header("Idempotency-Key"), parent.conversation_id); return c.json({ id, status: "queued" }, 201);
  });
  app.get("/v1/runs/:id", (c) => { const r = runs.get(c.req.param("id")); return r ? c.json(r) : c.json({ error: "任务不存在" }, 404); });
  app.get("/v1/runs/:id/approvals", (c) => c.json({ approvals: runs.get(c.req.param("id"))?.pending ? [{ id: "a", state: "pending" }] : [] }));
  app.get("/v1/runs/:id/eventlog", (c) => c.json({ events: [{ seq: 1, event: { type: "message", message: { role: "assistant", content: `答复:${runs.get(c.req.param("id"))?.prompt}` } } }, { seq: 2, event: { type: "done" } }] }));
  app.get("/v1/runs/:id/artifacts", (c) => c.json({ artifacts: c.req.param("id") === "run_1" ? [{ id: "art1", path: "report.md", size: 12 }] : [] }));
  app.post("/v1/runs/:id/abort", (c) => { const r = runs.get(c.req.param("id")); r.state = "cancelled"; return c.json({ ok: true }); });
  app.get("/v1/runs/:id/events", (c) => {
    const run = runs.get(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      let seq = 0;
      for (const ev of run.script ?? []) {
        if ("sleep" in ev) { await stream.sleep(ev.sleep as number); continue; }
        await stream.writeSSE({ id: String(++seq), data: JSON.stringify(ev) });
        if (seq === 1) await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
      run.state = "succeeded"; run.pending = false;
      await stream.writeSSE({ data: JSON.stringify({ type: "status", status: "idle" }) });
    });
  });
  app.get("/v1/conversations/:id", (c) => {
    const list = [...runs.values()].filter((r) => r.conversation_id === c.req.param("id"));
    return list.length ? c.json({ runs: list }) : c.json({ error: "会话不存在" }, 404);
  });
  const rpc = async (method: string, params: unknown, auth = "Bearer good") => (await app.request("/v1/a2a", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) })).json() as Promise<any>;
  const stream = async (method: string, params: unknown) => {
    const res = await app.request("/v1/a2a", { method: "POST", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    return (await res.text()).split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
  };
  return { app, runs, rpc, seen, opts, stream };
}
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { role: "user", messageId: `m-${text}`, parts: [{ kind: "text", text }], ...extra } });

describe("A2A endpoint", () => {
  it("serves a public agent card declaring JSON-RPC + bearer auth", async () => {
    const { app } = fakeCloud();
    const card = await (await app.request("http://cloud.test/.well-known/agent-card.json")).json() as any;
    expect(card).toMatchObject({ protocolVersion: "0.3.0", url: "http://cloud.test/v1/a2a", preferredTransport: "JSONRPC", security: [{ bearer: [] }] });
    expect(card.skills[0].id).toBe("workbench");
    expect(agentCard("https://x").capabilities.streaming).toBe(true);
  });
  it("maps run states (approval pending → input-required)", () => {
    expect(taskState("queued")).toBe("submitted");
    expect(taskState("running")).toBe("working");
    expect(taskState("running", true)).toBe("input-required");
    expect(taskState("succeeded", true)).toBe("completed");
    expect(taskState("cancelled")).toBe("canceled");
  });
  it("message/send creates a run (idempotent by messageId) and returns a completed task with reply + artifacts", async () => {
    const { rpc, runs } = fakeCloud();
    const a = await rpc("message/send", msg("统计日志"));
    expect(a.result).toMatchObject({ kind: "task", id: "run_1", contextId: "conv_1", status: { state: "completed" } });
    expect(a.result.artifacts[0].parts[0].text).toBe("答复:统计日志");
    expect(a.result.artifacts[1]).toMatchObject({ name: "report.md", parts: [{ kind: "data", data: { download: "/v1/runs/run_1/artifacts/art1" } }] });
    const again = await rpc("message/send", msg("统计日志"));
    expect(again.result.id).toBe("run_1");
    expect(runs.size).toBe(1);
  });
  it("continues a context as a follow-up run in the same conversation", async () => {
    const { rpc } = fakeCloud();
    const first = await rpc("message/send", msg("第一轮"));
    const second = await rpc("message/send", msg("第二轮", { contextId: first.result.contextId }));
    expect(second.result).toMatchObject({ id: "run_2", contextId: first.result.contextId });
    expect((await rpc("message/send", msg("x", { contextId: "conv_nope" }))).error.code).toBe(-32001);
  });
  it("tasks/get, tasks/cancel and JSON-RPC errors", async () => {
    const { rpc, runs, app } = fakeCloud();
    await rpc("message/send", msg("长任务"));
    runs.get("run_1").state = "running"; runs.get("run_1").pending = true;
    expect((await rpc("tasks/get", { id: "run_1" })).result.status.state).toBe("input-required");
    runs.get("run_1").pending = false;
    expect((await rpc("tasks/cancel", { id: "run_1" })).result.status.state).toBe("canceled");
    expect((await rpc("tasks/cancel", { id: "run_1" })).error.code).toBe(-32002);
    expect((await rpc("tasks/get", { id: "run_x" })).error.code).toBe(-32001);
    expect((await rpc("nope/method", {})).error.code).toBe(-32601);
    expect((await rpc("message/send", { message: { role: "user", messageId: "f", parts: [{ kind: "file", file: {} }] } })).error.code).toBe(-32005);
    const parse = await (await app.request("/v1/a2a", { method: "POST", headers: { authorization: "Bearer good" }, body: "{" })).json() as any;
    expect(parse.error.code).toBe(-32700);
  });
  it("is authenticated by the /v1 middleware", async () => {
    const { app } = fakeCloud();
    const res = await app.request("/v1/a2a", { method: "POST", headers: { authorization: "Bearer bad" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("message/stream emits Task, status-updates, streamed text artifacts, file artifacts and a final status", async () => {
    const { stream, opts } = fakeCloud();
    opts.script = [
      { type: "status", status: "running" },
      { type: "token", text: "先看" }, { type: "token", text: "一下" },
      { type: "message", message: { role: "assistant", content: "先看一下" } },
      { type: "tool_start", id: "c1", name: "read_file" },
      { type: "tool_end", id: "c1" },
      { type: "token", text: "统计完成" },
      { type: "message", message: { role: "assistant", content: "统计完成" } },
      { type: "done" },
    ];
    const events = await stream("message/stream", msg("统计"));
    expect(events.every((e) => e.jsonrpc === "2.0" && e.id === 9)).toBe(true);
    const r = events.map((e) => e.result);
    expect(r[0]).toMatchObject({ kind: "task", id: "run_1", status: { state: "working" } });
    expect(r[1]).toMatchObject({ kind: "status-update", status: { state: "working" }, final: false });
    const turn0 = r.filter((e) => e.kind === "artifact-update" && e.artifact.artifactId === "run_1:turn-0");
    expect(turn0.map((e) => e.artifact.parts[0].text).join("")).toBe("先看一下");
    expect(turn0.at(-1).lastChunk).toBe(true);
    expect(turn0[0].append).toBe(false);
    expect(r.find((e) => e.kind === "status-update" && e.metadata?.pig?.tool === "read_file").status.message.parts[0].text).toBe("调用工具 read_file");
    expect(r.filter((e) => e.artifact?.artifactId === "run_1:turn-1").map((e) => e.artifact.parts[0].text).join("")).toBe("统计完成");
    expect(r.find((e) => e.artifact?.name === "report.md")).toBeTruthy();
    const last = r.at(-1);
    expect(last).toMatchObject({ kind: "status-update", final: true, status: { state: "completed", message: { parts: [{ text: "答复:统计" }] } } });
    expect(r.filter((e) => e.final)).toHaveLength(1);
  });
  it("reports input-required while an approval is pending, then resumes", async () => {
    const { stream, opts, runs } = fakeCloud();
    opts.script = [{ type: "status", status: "running" }, { type: "tool_start", id: "w", name: "write_file" }, { sleep: 1900 }, { type: "token", text: "写好了" }, { type: "message", message: { role: "assistant", content: "写好了" } }];
    const pending = stream("message/stream", msg("写文件"));
    await new Promise((r) => setTimeout(r, 200));
    runs.get("run_1").pending = true;
    const states = (await pending).map((e) => e.result?.status?.state).filter(Boolean);
    expect(states).toContain("input-required");
    expect(states.indexOf("working", states.indexOf("input-required"))).toBeGreaterThan(states.indexOf("input-required"));
    expect(states.at(-1)).toBe("completed");
  });
  it("tasks/resubscribe on a finished task returns just the Task; errors are JSON-RPC events", async () => {
    const { stream, rpc } = fakeCloud();
    await rpc("message/send", msg("完成的"));
    const ev = await stream("tasks/resubscribe", { id: "run_1" });
    expect(ev).toHaveLength(1);
    expect(ev[0].result).toMatchObject({ kind: "task", status: { state: "completed" } });
    expect((await stream("tasks/resubscribe", { id: "run_x" }))[0].error.code).toBe(-32001);
    expect((await stream("message/stream", { message: { role: "user", messageId: "f", parts: [{ kind: "file", file: {} }] } }))[0].error.code).toBe(-32005);
  });
});
