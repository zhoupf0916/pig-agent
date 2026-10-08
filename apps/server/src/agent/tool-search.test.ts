import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session, Settings } from "../types.ts";
import { runAgent } from "./runtime.ts";
import { runToolSearch, searchTools, selectMcpTools } from "./tool-search.ts";

process.env.PIG_COMPACTION = "off";
const def = (server: string, name: string, description: string, props: string[] = []) => ({ type: "function" as const, function: { name: `mcp__${server}__${name}`, description, parameters: { type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) } } });
const catalog = [
  def("gh", "create_issue", "Create a new issue in a GitHub repository", ["owner", "repo", "title", "body"]),
  def("gh", "list_pull_requests", "List pull requests", ["owner", "repo"]),
  def("gh", "merge_pull_request", "Merge a pull request", ["owner", "repo", "pull_number"]),
  def("cal", "list_events", "列出日历中的日程安排", ["from", "to"]),
  def("cal", "create_event", "在日历中新建日程", ["title", "start"]),
  ...Array.from({ length: 12 }, (_, i) => def("misc", `noop_${i}`, `Unrelated utility number ${i}`)),
];

describe("tool search", () => {
  it("ranks tools by intent (English plurals and Chinese)", () => {
    expect(searchTools(catalog, "open a github issue", 2)[0]!.function.name).toBe("mcp__gh__create_issue");
    expect(searchTools(catalog, "merge pull requests", 1)[0]!.function.name).toBe("mcp__gh__merge_pull_request");
    expect(searchTools(catalog, "查看日历日程", 2).map((t) => t.function.name)).toContain("mcp__cal__list_events");
    expect(searchTools(catalog, "zzzz")).toEqual([]);
  });
  it("hides schemas above the threshold and keeps activations sticky and sorted", () => {
    expect(selectMcpTools(catalog.slice(0, 3), [], 12)).toEqual({ tools: catalog.slice(0, 3), searchEnabled: false });
    const sel = selectMcpTools(catalog, ["mcp__cal__list_events"], 12);
    expect(sel.searchEnabled).toBe(true);
    expect(sel.tools.map((t) => t.function.name)).toEqual(["mcp__cal__list_events"]);
    const r = runToolSearch(catalog, { query: "create issue", limit: 1 }, ["mcp__cal__list_events"]);
    expect(r.activated).toEqual(["mcp__cal__list_events", "mcp__gh__create_issue"]);
    expect(r.output).toContain("mcp__gh__create_issue(owner, repo, title, body)");
  });
  it("lets the model discover and then call an MCP tool inside the agent loop", async () => {
    const bodies: any[] = [];
    const server = createServer((req, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const b = JSON.parse(Buffer.concat(chunks).toString("utf8")); bodies.push(b);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const tools = b.messages.filter((m: any) => m.role === "tool").length;
        const call = (id: string, name: string, args: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
        if (tools === 0) call("c1", "search_tools", { query: "create a github issue" });
        else if (tools === 1) call("c2", "mcp__gh__create_issue", { owner: "o", repo: "r", title: "t" });
        else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "已创建" } }] })}\n\n`);
        res.write("data: [DONE]\n\n"); res.end();
      });
    });
    const url = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)));
    const invoked: string[] = [];
    const session = { id: "ses_ts", title: "t", createdAt: "", updatedAt: "", status: "idle", messages: [{ id: "u", role: "user", content: "帮我提个 issue", createdAt: "" }], steps: [], artifacts: [] } as Session;
    const settings = { llmBaseUrl: url, llmApiKey: "t", llmModel: "m", workspaceRoot: mkdtempSync(join(tmpdir(), "pig-ts-")), runtime: "pig", codexBinaryPath: "", codexModel: "", codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub" } as Settings;
    const out = await runAgent({ session, settings, signal: new AbortController().signal, emit: () => {}, memoryPins: [], mcpTools: catalog,
      authorizeTool: async () => true, mcpInvoke: async ({ name }) => { invoked.push(name); return "ok #42"; } });
    server.close();
    const names = (b: any) => (b.tools ?? []).map((t: any) => t.function.name);
    expect(names(bodies[0])).toContain("search_tools");
    expect(names(bodies[0]).some((n: string) => n.startsWith("mcp__"))).toBe(false);
    expect(names(bodies[1])).toContain("mcp__gh__create_issue");
    expect(names(bodies[1]).filter((n: string) => n.startsWith("mcp__")).length).toBeLessThan(catalog.length / 3);
    expect(invoked).toEqual(["mcp__gh__create_issue"]);
    expect(out.activatedTools).toContain("mcp__gh__create_issue");
    expect(JSON.stringify(bodies[1].messages)).toMatch(/已激活 \d 个工具/);
    expect(out.messages.at(-1)?.content).toBe("已创建");
  });
});
