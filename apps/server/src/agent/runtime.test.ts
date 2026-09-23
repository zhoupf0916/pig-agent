import {loadWorkbench,saveWorkbench} from "../store/workbench.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, Session, Settings } from "../types.ts";
import { dropDebugSession, readDebugTrace, setDebugContent } from "./debug-trace.ts";
import { MAX_HISTORY_CHARS, deliverableSummary, runAgent, ToolAuthorizationDenied } from "./runtime.ts";

function pigSettings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "test",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "pig",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "",
    cloudMode: "local-stub",
    ...extra,
  };
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_test",
    title: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "整理工作区并写一份报告",
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

function startScriptedLlm(
  script: Array<(reqBody: string, res: ServerResponse) => void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  let turn = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const handler = script[Math.min(turn, script.length - 1)];
      turn += 1;
      handler?.(raw, res);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function toolDelta(
  res: ServerResponse,
  calls: Array<{ id: string; name: string; args: unknown }>,
): void {
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
  });
}

describe("runAgent harness", () => {
  it("keeps an oversized approved web result in the next model request without losing its tool call", async () => {
    let nextMessages: Array<{role: string; content: string; tool_call_id?: string; tool_calls?: unknown[]}> = [];
    const fetchPage = vi.fn(async () => '<title>联网结果已取得</title>' + 'x'.repeat(200000) + 'PAGE_END');
    const llm = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [{id: "large-web", name: "http_fetch", args: {url: "https://example.com/"}}]),
      (raw, res) => { nextMessages = JSON.parse(raw).messages; sse(res, {choices: [{delta: {content: "网页标题是联网结果已取得。"}}]}); },
    ]);
    try {
      const result = await runAgent({session: emptySession(), settings: pigSettings(mkdtempSync(join(tmpdir(), "pig-large-page-")), {llmBaseUrl: llm.url}), signal: new AbortController().signal, emit: () => {}, networkFetch: fetchPage});
      const tool = nextMessages.find(m => m.role === "tool");
      expect(tool?.content).toContain('<title>联网结果已取得</title>');
      expect(tool?.content).toContain('PAGE_END');
      expect(tool?.content).toContain('已截断');
      expect(tool?.tool_call_id).toBe('large-web');
      expect(nextMessages.some(m => m.role === "assistant" && m.tool_calls?.length)).toBe(true);
      expect(nextMessages.filter(m => m.role !== 'system').reduce((n, m) => n + (m.content?.length ?? 0), 0)).toBeLessThan(MAX_HISTORY_CHARS);
      expect(result.messages.find(m => m.role === 'tool')?.content.length).toBeGreaterThan(200000);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    } finally { await llm.close(); }
  });
  it.each([true,false])("local file policy review=%s actually gates filesystem mutation", async (review)=>{
    const root=mkdtempSync(join(tmpdir(),"pig-policy-"));
    const session=emptySession({id:"ses_policy_"+Date.now()+String(review),deliveryMode:true});
    const policy=await loadWorkbench(session.id,root);policy.policy.review=review;await saveWorkbench(session.id,policy);
    const mock=await startScriptedLlm([
      (_raw,res)=>toolDelta(res,[{id:"policy-write",name:"write_file",args:{path:"proof.txt",content:"policy verified"}}]),
      (_raw,res)=>sse(res,{choices:[{delta:{content:"完成"}}]}),
    ]);
    try{
      await runAgent({session,settings:pigSettings(root,{llmBaseUrl:mock.url}),signal:new AbortController().signal,emit:()=>{}});
      expect(existsSync(join(root,"proof.txt"))).toBe(!review);
      const state=await loadWorkbench(session.id,root);
      expect(state.operations[0]?.status).toBe(review?"pending":"applied");
    }finally{await mock.close();}
  });

  it("stops the entire batch when a remote network approval is rejected", async () => {
    const root=mkdtempSync(join(tmpdir(),"pig-rejected-network-"));
    let models=0;
    const mock=await startScriptedLlm([(_raw,res)=>{models++;toolDelta(res,[{id:"deny-net",name:"http_fetch",args:{url:"https://example.com/"}},{id:"after-denial",name:"write_file",args:{path:"must-not-exist.txt",content:"bad"}}]);}]);
    try {
      const result=await runAgent({session:emptySession(),settings:pigSettings(root,{llmBaseUrl:mock.url}),signal:new AbortController().signal,emit:()=>{},networkFetch:async()=>{throw new ToolAuthorizationDenied("用户拒绝网络访问");}});
      expect(models).toBe(1);expect(result.lastError).toContain("用户拒绝");expect(existsSync(join(root,"must-not-exist.txt"))).toBe(false);
    } finally {await mock.close();}
  });
  it("queues one-time HTTP approval even when automatic write execution is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-network-review-"));
    const session=emptySession({id:"ses_network_review",deliveryMode:true});
    const state=await loadWorkbench(session.id,root);state.policy.review=false;await saveWorkbench(session.id,state);
    const mock=await startScriptedLlm([(_raw,res)=>toolDelta(res,[{id:"fetch-once",name:"http_fetch",args:{url:"https://example.com/"}}])]);
    try {
      const result=await runAgent({session,settings:pigSettings(root,{llmBaseUrl:mock.url}),signal:new AbortController().signal,emit:()=>{}});
      const saved=await loadWorkbench(session.id,root);
      expect(saved.operations).toHaveLength(1);expect(saved.operations[0]).toMatchObject({tool:"http_fetch",status:"pending",args:{url:"https://example.com/"},before:[],after:[]});
      expect(result.messages.some(m=>m.role==="tool")).toBe(false);
      expect(saved.checkpoint?.blockedCallId).toBe(saved.operations[0]?.callId);
    }finally{await mock.close();}
  });

  it.each([true, false])("waits for mutation authorization and respects decision %s", async (approved) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-approval-"));
    const target = join(workspaceRoot, "approved.txt");
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [{ id: "write", name: "write_file", args: { path: "approved.txt", content: "authorized" } }]),
      (_raw, res) => sse(res, { choices: [{ delta: { content: "完成" } }] }),
    ]);
    let decide!: (allowed: boolean) => void;
    let reached!: () => void;
    const pending = new Promise<boolean>((resolve) => { decide = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    try {
      const running = runAgent({
        session: emptySession(), settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal, emit: () => {},
        authorizeTool: async (call) => {
          expect(call).toEqual({ callId: "write", tool: "write_file", args: { path: "approved.txt", content: "authorized" } });
          reached();
          return pending;
        },
      });
      await waiting;
      expect(existsSync(target)).toBe(false);
      decide(approved);
      const result = await running;
      expect(existsSync(target)).toBe(approved);
      if (approved) expect(readFileSync(target, "utf8")).toBe("authorized");
      else expect(result.lastError).toContain("用户拒绝了远端操作");
    } finally { decide(false); await mock.close(); }
  });

  it("closes the approval span when remote authorization is rejected and does not run the next write", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-approval-trace-"));
    const id = "ses_approval_reject_" + Date.now();
    dropDebugSession(id);
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [
        { id: "denied-write", name: "write_file", args: { path: "forbidden.txt", content: "must not write" } },
        { id: "later-write", name: "write_file", args: { path: "also-forbidden.txt", content: "no" } },
      ]),
    ]);
    try {
      const result = await runAgent({
        session: emptySession({ id }),
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => {},
        authorizeTool: async () => false,
      });
      expect(result.lastError).toContain("用户拒绝了远端操作");
      expect(existsSync(join(root, "forbidden.txt"))).toBe(false);
      expect(existsSync(join(root, "also-forbidden.txt"))).toBe(false);
      const trace = readDebugTrace(id);
      expect(trace.spans.some((span) => span.status === "running")).toBe(false);
      expect(trace.spans.some((span) => span.kind === "approval" && (span.status === "cancelled" || span.status === "error"))).toBe(true);
    } finally {
      await mock.close();
    }
  });
  it("leaves an unconfirmed plan pending when the model asks for a destination", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-agent-pending-"));
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [{
        id: "plan", name: "update_plan", args: { steps: [
          { title: "核对位置", status: "done" },
          { title: "等待用户选择工作区", status: "running" },
        ] },
      }]),
      (_raw, res) => sse(res, { choices: [{ delta: { content: "目标在工作区外，请调整工作区后继续。" } }] }),
    ]);
    try {
      const events: AgentEvent[] = [];
      const next = await runAgent({
        session: emptySession(), settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal, emit: (event) => { events.push(event); },
      });
      expect(next.status).toBe("idle");
      expect(next.artifacts).toEqual([]);
      expect(next.steps.map((step) => step.status)).toEqual(["done", "pending"]);
      expect(events.filter((event) => event.type === "steps").at(-1)).toMatchObject({
        steps: [{ status: "done" }, { status: "pending" }],
      });
    } finally { await mock.close(); }
  });

  it("runs a DeepSeek-style parallel tool loop and writes an artifact summary", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-agent-run-"));
    writeFileSync(join(workspaceRoot, "messy.txt"), "todo: file me");
    const mock = await startScriptedLlm([
      (_raw, res) => {
        toolDelta(res, [
          {
            id: "call_search",
            name: "search_files",
            args: { query: "todo", path: "." },
          },
          {
            id: "call_write",
            name: "write_file",
            args: { path: "reports/summary.md", content: "# 报告\n\n已整理 messy.txt\n" },
          },
        ]);
      },
      (_raw, res) => {
        sse(res, {
          choices: [{ delta: { content: "已搜索工作区并写入 reports/summary.md，请在产物面板查看。" } }],
        });
      },
    ]);

    try {
      const events: AgentEvent["type"][] = [];
      const next = await runAgent({
        session: emptySession(),
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e.type),
      });

      expect(readFileSync(join(workspaceRoot, "reports/summary.md"), "utf8")).toContain("报告");
      expect(next.artifacts.some((a) => a.path === "reports/summary.md" && a.action === "created")).toBe(
        true,
      );
      expect(events.filter((t) => t === "tool_start")).toHaveLength(2);
      expect(events).toContain("artifact");
      expect(events).toContain("done");
      expect(next.messages.some((m) => m.role === "assistant" && m.content.includes("summary.md"))).toBe(
        true,
      );
    } finally {
      await mock.close();
    }
  });

  it("recovers from a failed tool call and still delivers", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-agent-rec-"));
    const mock = await startScriptedLlm([
      (_raw, res) => {
        toolDelta(res, [
          { id: "call_bad", name: "read_file", args: { path: "does-not-exist.md" } },
        ]);
      },
      (_raw, res) => {
        toolDelta(res, [
          {
            id: "call_ok",
            name: "write_file",
            args: { path: "RECOVERED.md", content: "recovered\n" },
          },
        ]);
      },
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "先前读取失败，已改为新建 RECOVERED.md。" } }] });
      },
    ]);

    try {
      const next = await runAgent({
        session: emptySession({
          messages: [
            {
              id: "u1",
              role: "user",
              content: "Read missing then write a file",
              createdAt: new Date().toISOString(),
            },
          ],
        }),
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(readFileSync(join(workspaceRoot, "RECOVERED.md"), "utf8")).toContain("recovered");
      expect(next.messages.some((m) => m.role === "tool" && m.toolOk === false)).toBe(true);
      expect(next.messages.some((m) => m.role === "tool" && m.toolOk === true)).toBe(true);
      expect(next.status).toBe("idle");
    } finally {
      await mock.close();
    }
  });

  it("stops a running turn when aborted", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-agent-ab-"));
    const hung = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Stay open until the client aborts; do not complete the stream.
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve({
          url: `http://127.0.0.1:${addr.port}/v1`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
    const controller = new AbortController();
    const pending = runAgent({
      session: emptySession(),
      settings: pigSettings(workspaceRoot, { llmBaseUrl: hung.url }),
      signal: controller.signal,
      emit: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    const next = await pending;
    await hung.close();
    expect(next.status).toBe("idle");
    expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(true);
  });
});

describe("debug model request", () => {
  it("records the posted request body and leaves a workspace file tool unlabeled as seatbelt", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-debug-request-"));
    writeFileSync(join(root, "README.md"), "hello");
    const id = "ses_debug_request_" + Date.now();
    dropDebugSession(id);
    setDebugContent(id, true);
    const seen: Array<Record<string, unknown>> = [];
    const mock = await startScriptedLlm([
      (raw, res) => {
        seen.push(JSON.parse(raw) as Record<string, unknown>);
        sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "read-1", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } }] }, finish_reason: null }] });
        sse(res, { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
      },
      (raw, res) => {
        seen.push(JSON.parse(raw) as Record<string, unknown>);
        sse(res, { choices: [{ delta: { content: "INDEPENDENT_RESPONSE_CANARY" }, finish_reason: null }] });
        sse(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
      },
    ]);
    try {
      await runAgent({
        session: emptySession({
          id,
          messages: [{ id: "u1", role: "user", content: "INDEPENDENT_PROMPT_CANARY", createdAt: new Date().toISOString() }],
        }),
        settings: pigSettings(root, { llmBaseUrl: mock.url, llmModel: "independent-mock" }),
        signal: new AbortController().signal,
        emit: () => {},
      });
      const models = readDebugTrace(id).spans.filter((span) => span.kind === "model");
      const posted = seen[0];
      const recorded = models[0]?.detail?.request as { body?: { stream?: boolean; messages?: unknown; max_tokens?: unknown } } | undefined;
      expect(recorded?.body?.stream).toBe(true);
      expect(recorded?.body?.messages).toEqual(posted?.messages);
      expect(JSON.stringify(models)).toContain("INDEPENDENT_PROMPT_CANARY");
      expect(JSON.stringify(models)).toContain("INDEPENDENT_RESPONSE_CANARY");
      expect(JSON.stringify(models)).toContain('"stop"');
      expect(JSON.stringify(models)).toContain('"prompt_tokens":100');
      const fileTool = readDebugTrace(id).spans.find((span) => span.name === "read_file");
      expect(fileTool?.detail?.sandboxEffective).toBe("workspace");
      expect(fileTool?.status).not.toBe("running");
    } finally {
      await mock.close();
    }
  });
});

describe("read order and retained context", () => {
  it("returns independent reads in call order and applies a later edit only after the earlier write", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-order-"));
    writeFileSync(join(root, "a.txt"), "AAA");
    writeFileSync(join(root, "b.txt"), "BBB");
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [
        { id: "read-a", name: "read_file", args: { path: "a.txt" } },
        { id: "read-b", name: "read_file", args: { path: "b.txt" } },
      ]),
      (_raw, res) => toolDelta(res, [
        { id: "write-order", name: "write_file", args: { path: "order.txt", content: "first" } },
        { id: "edit-order", name: "edit_file", args: { path: "order.txt", old_string: "first", new_string: "second" } },
      ]),
      (_raw, res) => sse(res, { choices: [{ delta: { content: "完成" } }] }),
    ]);
    try {
      const result = await runAgent({
        session: emptySession({ id: "ses_order_" + Date.now() }),
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => {},
      });
      const tools = result.messages.filter((message) => message.role === "tool");
      expect(tools.map((message) => message.toolCallId)).toEqual(["read-a", "read-b", "write-order", "edit-order"]);
      expect(tools[0]?.content).toContain("AAA");
      expect(tools[1]?.content).toContain("BBB");
      expect(readFileSync(join(root, "order.txt"), "utf8")).toBe("second");
      expect(tools[3]?.toolOk).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("keeps the goal, constraint, approval, and todo after old tool output is trimmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-history-"));
    const fat = "NOISE ".repeat(4000);
    const now = new Date().toISOString();
    const messages: Session["messages"] = [
      { id: "goal", role: "user", content: "目标：交付周报。约束：不要改动锁文件。", createdAt: now },
      {
        id: "plan",
        role: "assistant",
        content: "",
        createdAt: now,
        toolCalls: [{ id: "plan-call", name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "核对标题", status: "pending" }] }) }],
      },
      { id: "approved", role: "tool", content: "已批准写入 report.md", toolCallId: "plan-call", createdAt: now },
    ];
    for (let i = 0; i < 8; i += 1) {
      messages.push({ id: `noise-a-${i}`, role: "assistant", content: "继续", createdAt: now });
      messages.push({ id: `noise-t-${i}`, role: "tool", content: fat, toolCallId: `noise-${i}`, createdAt: now });
    }
    let sent = "";
    const mock = await startScriptedLlm([
      (raw, res) => {
        sent = raw;
        sse(res, { choices: [{ delta: { content: "仍记得任务" } }] });
      },
    ]);
    try {
      await runAgent({
        session: emptySession({ id: "ses_history_" + Date.now(), messages }),
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => {},
      });
      expect(sent).toContain("交付周报");
      expect(sent).toContain("不要改动锁文件");
      expect(sent).toContain("核对标题");
      expect(sent).toContain("已批准写入 report.md");
      expect((sent.match(/NOISE /g) ?? []).length).toBeLessThan(4000 * 6);
    } finally {
      await mock.close();
    }
  });

  it("records a rejected read without an unhandled rejection and still returns the earlier read", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-read-fail-"));
    writeFileSync(join(root, "a.txt"), "AAA");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [
        { id: "read-ok", name: "read_file", args: { path: "a.txt" } },
        { id: "read-secret", name: "read_file", args: { path: ".env" } },
      ]),
      (_raw, res) => sse(res, { choices: [{ delta: { content: "已处理失败" } }] }),
    ]);
    try {
      const result = await runAgent({
        session: emptySession({ id: "ses_read_fail_" + Date.now() }),
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => {},
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const tools = result.messages.filter((message) => message.role === "tool");
      expect(tools.map((message) => message.toolCallId)).toEqual(["read-ok", "read-secret"]);
      expect(tools[0]?.content).toContain("AAA");
      expect(tools[1]?.toolOk).toBe(false);
      expect(tools[1]?.content).toContain("Refusing to read a secret file");
      expect(tools[1]?.content).not.toContain("SECRET=1");
      expect(rejections).toEqual([]);
      const span = readDebugTrace(result.id).spans.find((item) => item.id === "read-ok");
      expect(span?.durationMs).toBe(tools[0]?.toolDurationMs);
    } finally {
      process.off("unhandledRejection", onRejection);
      await mock.close();
    }
  });

  it("does not start a fourth read after the batch is cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-read-cancel-"));
    writeFileSync(join(root, "a.txt"), "AAA");
    writeFileSync(join(root, "b.txt"), "BBB");
    writeFileSync(join(root, "c.txt"), "CCC");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const controller = new AbortController();
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [
        { id: "read-a", name: "read_file", args: { path: "a.txt" } },
        { id: "read-b", name: "read_file", args: { path: "b.txt" } },
        { id: "read-c", name: "read_file", args: { path: "c.txt" } },
        { id: "read-secret", name: "read_file", args: { path: ".env" } },
      ]),
    ]);
    try {
      const result = await runAgent({
        session: emptySession({ id: "ses_read_cancel_" + Date.now() }),
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: controller.signal,
        emit: (event) => {
          if (event.type === "tool_start" && event.id === "read-a") controller.abort();
        },
      });
      const text = result.messages.map((message) => message.content).join("\n");
      expect(text).not.toContain("Refusing to read a secret file");
      expect(text).not.toContain("SECRET=1");
      expect(result.messages.some((message) => message.toolCallId === "read-secret")).toBe(false);
      expect(result.messages.some((message) => message.content.includes("已停止"))).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("keeps a bounded note and does not send an unpaired tool message", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-pair-"));
    const now = new Date().toISOString();
    const messages: Session["messages"] = [
      { id: "goal", role: "user", content: "目标：交付周报。约束：不要改动锁文件。", createdAt: now },
      {
        id: "plan",
        role: "assistant",
        content: "",
        createdAt: now,
        toolCalls: [
          { id: "plan-call", name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "核对标题", status: "pending" }] }) },
          { id: "write-call", name: "write_file", arguments: JSON.stringify({ path: "report.md", content: "周报" }) },
        ],
      },
      { id: "planned", role: "tool", content: "计划已更新", toolCallId: "plan-call", createdAt: now },
      { id: "approved", role: "tool", content: "已批准写入 report.md", toolCallId: "write-call", createdAt: now },
      { id: "orphan", role: "tool", content: "已批准孤立不应该作为工具消息", toolCallId: "missing-call", createdAt: now },
    ];
    for (let i = 0; i < 6; i += 1) {
      messages.push({ id: `fat-${i}`, role: "user", content: `填充 ${"NOISE ".repeat(4000)}`, createdAt: now });
    }
    let sent = "";
    const mock = await startScriptedLlm([
      (raw, res) => {
        sent = raw;
        sse(res, { choices: [{ delta: { content: "仍记得任务" } }] });
      },
    ]);
    try {
      await runAgent({
        session: emptySession({ id: "ses_pair_" + Date.now(), messages }),
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => {},
      });
      const body = JSON.parse(sent) as { messages: Array<{ role: string; content?: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> };
      const rows = body.messages.filter((message) => message.role !== "system");
      const pending: string[] = [];
      for (const message of rows) {
        if (message.role === "assistant" && message.tool_calls?.length) {
          expect(pending).toEqual([]);
          pending.push(...message.tool_calls.map((call) => call.id));
        } else if (message.role === "tool") {
          expect(pending.shift()).toBe(message.tool_call_id);
        } else {
          expect(pending).toEqual([]);
        }
      }
      expect(pending).toEqual([]);
      expect(sent).toContain("交付周报");
      expect(sent).toContain("不要改动锁文件");
      expect(sent).toContain("核对标题");
      expect(sent).toContain("已批准写入 report.md");
      expect(rows.some((message) => message.role === "tool" && message.content?.includes("已批准孤立"))).toBe(false);
      const kept = rows.reduce((sum, message) => sum + (message.content?.length ?? 0) + JSON.stringify(message.tool_calls ?? []).length, 0);
      expect(kept).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    } finally {
      await mock.close();
    }
  });
});

describe("cancelled checkpoints", () => {
  it("does not replay the next write after the turn is cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-cancel-replay-"));
    const session = emptySession({ id: "ses_cancel_replay_" + Date.now(), deliveryMode: true });
    const controller = new AbortController();
    const mock = await startScriptedLlm([
      (_raw, res) => toolDelta(res, [
        { id: "write-a", name: "write_file", args: { path: "finished.txt", content: "done" } },
        { id: "write-b", name: "write_file", args: { path: "must-not-replay.txt", content: "later" } },
      ]),
    ]);
    try {
      await runAgent({
        session,
        settings: pigSettings(root, { llmBaseUrl: mock.url }),
        signal: controller.signal,
        emit: (event) => {
          if (event.type === "tool_end" && event.id === "write-a") controller.abort();
        },
      });
    } finally {
      await mock.close();
    }
    expect(readFileSync(join(root, "finished.txt"), "utf8")).toBe("done");
    expect(existsSync(join(root, "must-not-replay.txt"))).toBe(false);
    let replayed = 0;
    const replay = await startScriptedLlm([
      (_raw, res) => {
        replayed += 1;
        sse(res, { choices: [{ delta: { content: "不应该重放" } }] });
      },
    ]);
    try {
      await expect(runAgent({
        session,
        settings: pigSettings(root, { llmBaseUrl: replay.url }),
        signal: new AbortController().signal,
        emit: () => {},
      })).rejects.toThrow("本轮已拒绝或取消，请发送新的指令后再执行。");
      expect(replayed).toBe(0);
      expect(existsSync(join(root, "must-not-replay.txt"))).toBe(false);
    } finally {
      await replay.close();
    }
  });
});

describe("deliverableSummary", () => {
  it("groups created and modified paths", () => {
    const text = deliverableSummary(
      emptySession({
        artifacts: [
          { path: "a.md", action: "created", updatedAt: new Date().toISOString() },
          { path: "b.md", action: "modified", updatedAt: new Date().toISOString() },
        ],
      }),
      "完成。",
    );
    expect(text).toContain("新建：a.md");
    expect(text).toContain("修改：b.md");
  });
});

describe("settings type smoke", () => {
  it("sends an explicit Chinese default to the model while preserving requested translations and raw logs", async () => {
    let sent = "";
    const llm = await startScriptedLlm([(raw, res) => {
      sent = JSON.parse(raw).messages.find((m: {role: string}) => m.role === "system").content;
      sse(res, {choices: [{delta: {content: "你好，我可以帮你处理任务。"}}]});
    }]);
    try {
      const result = await runAgent({session: emptySession(), settings: pigSettings(mkdtempSync(join(tmpdir(), "pig-language-")), {llmBaseUrl: llm.url}), signal: new AbortController().signal, emit: () => {}});
      expect(sent).toContain("默认使用简体中文");
      expect(sent).toContain("明确要求其他语言");
      expect(sent).toContain("代码、命令、路径和原始日志保留原文");
      expect(result.messages.at(-1)?.content).toContain("你好");
    } finally { await llm.close(); }
  });
  it("accepts DeepSeek-shaped settings", () => {
    const settings: Settings = pigSettings("/tmp", {
      llmBaseUrl: "https://api.deepseek.com/v1",
    });
    expect(settings.llmModel).toBe("deepseek-chat");
    expect(settings.runtime).toBe("pig");
    expect(settings.codexNetworkAccess).toBe(false);
  });
});
