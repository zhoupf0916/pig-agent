import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session, Settings } from "../types.ts";
import { runAgent } from "./runtime.ts";

process.env.PIG_COMPACTION = "off";
type Handler = (body: any, res: ServerResponse) => void;
function scripted(route: Handler) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); bodies.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" }); route(body, res); res.write("data: [DONE]\n\n"); res.end();
    });
  });
  return new Promise<{ url: string; bodies: any[]; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies, close: () => server.close() });
  }));
}
const sse = (res: ServerResponse, delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const calls = (res: ServerResponse, list: Array<[string, string, unknown]>) => sse(res, { tool_calls: list.map(([id, name, args], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) });
const isSub = (b: any) => String(b.messages[0]?.content).includes("只读子 Agent");
const hasTool = (b: any) => b.messages.some((m: any) => m.role === "tool");

describe("spawn_subagent", () => {
  it("runs read-only sub-agents in parallel with fresh context and returns only their reports", async () => {
    const root = mkdtempSync(join(tmpdir(), "pig-sub-"));
    writeFileSync(join(root, "a.txt"), "SECRET_A_CONTENT");
    writeFileSync(join(root, "b.txt"), "SECRET_B_CONTENT");
    const llm = await scripted((b, res) => {
      if (isSub(b)) {
        const file = String(b.messages[1].content).includes("a.txt") ? "a.txt" : "b.txt";
        // sub-agent must only be offered read-only tools
        if (b.tools) expect(b.tools.map((t: any) => t.function.name).sort()).toEqual(["list_dir", "list_skills", "load_skill", "read_file", "search_files"]);
        if (!hasTool(b)) return calls(res, [[`r_${file}`, "write_file", { path: "x", content: "no" }], [`q_${file}`, "read_file", { path: file }]]);
        return sse(res, { content: `报告:${file} 已读` });
      }
      if (!hasTool(b)) return calls(res, [["s1", "spawn_subagent", { task: "读 a.txt", name: "A" }], ["s2", "spawn_subagent", { task: "读 b.txt", name: "B" }]]);
      return sse(res, { content: "汇总完成" });
    });
    const session = { id: "ses_sub", title: "t", createdAt: "", updatedAt: "", status: "idle", messages: [{ id: "u", role: "user", content: "调查两个文件", createdAt: "" }], steps: [], artifacts: [] } as Session;
    const settings = { llmBaseUrl: llm.url, llmApiKey: "t", llmModel: "m", workspaceRoot: root, runtime: "pig", codexBinaryPath: "", codexModel: "", codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub" } as Settings;
    const out = await runAgent({ session, settings, signal: new AbortController().signal, emit: () => {}, memoryPins: [] });
    llm.close();
    const parentBodies = llm.bodies.filter((b) => !isSub(b));
    expect(parentBodies[0].tools.some((t: any) => t.function.name === "spawn_subagent")).toBe(true);
    const parentFinal = JSON.stringify(parentBodies.at(-1).messages);
    expect(parentFinal).toContain("报告:a.txt 已读");
    expect(parentFinal).toContain("报告:b.txt 已读");
    expect(parentFinal).not.toContain("SECRET_A_CONTENT"); // raw tool output stays in the sub-agent
    const subBodies = llm.bodies.filter(isSub);
    expect(JSON.stringify(subBodies)).toContain("只能使用只读工具，write_file 未执行");
    expect(subBodies.every((b) => !JSON.stringify(b.messages).includes("调查两个文件"))).toBe(true); // fresh context
    expect(out.messages.at(-1)?.content).toBe("汇总完成");
  });
});
