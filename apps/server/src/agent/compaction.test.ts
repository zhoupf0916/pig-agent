import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, Session, Settings } from "../types.ts";
import { buildCompactionRequest, COMPACTION_SECTIONS, compactedView, selectCompactionCut } from "./compaction.ts";
import { runAgent } from "./runtime.ts";

const now = new Date().toISOString();
const m = (id: string, role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, content, createdAt: now, ...extra });

describe("compaction helpers", () => {
  const history = [
    m("u1", "user", "整理报告"), m("a1", "assistant", "", { toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] }),
    m("t1", "tool", "x".repeat(500), { toolCallId: "c1" }), m("a2", "assistant", "完成第一步"),
    m("u2", "user", "继续"), m("a3", "assistant", "", { toolCalls: [{ id: "c2", name: "read_file", arguments: "{}" }] }),
    m("t2", "tool", "y".repeat(500), { toolCallId: "c2" }),
  ];
  it("never splits a tool call from its results", () => {
    const cut = selectCompactionCut(history, 300);
    expect(cut).toBe("u2");
    expect(selectCompactionCut(history, 100000)).toBeUndefined();
  });
  it("view replaces folded messages with the summary and re-includes the current request", () => {
    const view = compactedView(history, { summary: "## 目标\n整理报告", through: "a3", createdAt: now, count: 1 });
    expect(view.map((x) => x.id)).toEqual(["context-compact", "u2", "t2"]);
    expect(view[0]!.content).toContain("整理报告");
    expect(compactedView(history, { summary: "s", through: "missing", createdAt: now, count: 1 })).toBe(history);
  });
  it("asks for the fixed sections and carries the previous summary", () => {
    const req = buildCompactionRequest(history.slice(0, 4), "旧摘要");
    for (const s of COMPACTION_SECTIONS) expect(req[0]!.content).toContain(`## ${s}`);
    expect(req[1]!.content).toContain("旧摘要");
  });
});

function scripted(handlers: Array<(body: any, res: ServerResponse) => void>) {
  const bodies: any[] = [];
  let i = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); bodies.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      handlers[Math.min(i++, handlers.length - 1)]!(body, res);
      res.write("data: [DONE]\n\n"); res.end();
    });
  });
  return new Promise<{ url: string; bodies: any[]; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}/v1`, bodies, close: () => server.close() });
  }));
}
const say = (res: ServerResponse, text: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const callTool = (res: ServerResponse, id: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "list_dir", arguments: "{\"path\":\".\"}" } }] } }] })}\n\n`);
const settings = (url: string): Settings => ({ llmBaseUrl: url, llmApiKey: "t", llmModel: "m", workspaceRoot: mkdtempSync(join(tmpdir(), "pig-compact-")), runtime: "pig", codexBinaryPath: "", codexModel: "", codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub" } as Settings);
const session = (messages: ChatMessage[]): Session => ({ id: `ses_compact_${Math.random().toString(36).slice(2)}`, title: "t", createdAt: now, updatedAt: now, status: "idle", messages, steps: [], artifacts: [] } as Session);

describe("runAgent compaction + max turns", () => {
  it("compacts long history with one LLM summary call before the next model request", async () => {
    const llm = await scripted([(_b, res) => say(res, "## 目标\n旧任务摘要OK"), (_b, res) => say(res, "最终回复")]);
    const old: ChatMessage[] = [];
    for (let k = 0; k < 6; k++) old.push(m(`ou${k}`, "user", `旧请求${k} ` + "长".repeat(800)), m(`oa${k}`, "assistant", `旧回答${k} ` + "答".repeat(800)));
    const s = session([...old, m("now", "user", "现在的问题")]);
    const out = await runAgent({ session: s, settings: settings(llm.url), signal: new AbortController().signal, emit: () => {}, memoryPins: [], compactAtChars: 4000 });
    llm.close();
    expect(llm.bodies).toHaveLength(2);
    expect(llm.bodies[0].tools).toBeUndefined();
    expect(JSON.stringify(llm.bodies[0].messages)).toContain("旧请求0");
    const second = JSON.stringify(llm.bodies[1].messages);
    expect(second).toContain("旧任务摘要OK");
    expect(second).not.toContain("旧请求0");
    expect(second).toContain("现在的问题");
    expect(out.contextCompaction?.count).toBe(1);
    expect(out.contextCompaction?.through).toBe("ou5");
    expect(out.messages.some((x) => x.id === "ou0")).toBe(true); // transcript kept intact
  });
  it("honours a configurable maxTurns", async () => {
    let n = 0;
    const llm = await scripted([(_b, res) => callTool(res, `c${n++}`)]);
    const s = session([m("u", "user", "一直列目录")]);
    const out = await runAgent({ session: s, settings: settings(llm.url), signal: new AbortController().signal, emit: () => {}, memoryPins: [], maxTurns: 2, compactAtChars: 0 });
    llm.close();
    expect(llm.bodies).toHaveLength(2);
    expect(out.messages.at(-1)?.content).toContain("最大工具步数");
  });
});
