import {loadWorkbench,saveWorkbench} from "../store/workbench.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, Session, Settings } from "../types.ts";
import { deliverableSummary, runAgent, ToolAuthorizationDenied } from "./runtime.ts";

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
  it("accepts DeepSeek-shaped settings", () => {
    const settings: Settings = pigSettings("/tmp", {
      llmBaseUrl: "https://api.deepseek.com/v1",
    });
    expect(settings.llmModel).toBe("deepseek-chat");
    expect(settings.runtime).toBe("pig");
    expect(settings.codexNetworkAccess).toBe(false);
  });
});
