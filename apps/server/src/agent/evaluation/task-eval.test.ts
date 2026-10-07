import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { mockReply } from "../../dev/mock-scenarios.ts";
import { taskCases } from "./task-cases.ts";
import { markdownTable, runTaskCase, summarize } from "./task-eval.ts";

process.env.PIG_COMPACTION = "off";
describe("task eval harness (offline mock model)", () => {
  it("runs cases end to end and reports grades and metrics", async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const reply = mockReply(JSON.parse(Buffer.concat(chunks).toString("utf8")).messages, "");
        const delta = reply.toolCalls?.length ? { tool_calls: reply.toolCalls.map((c, index) => ({ index, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : { content: reply.content };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 50 } })}\n\ndata: [DONE]\n\n`); res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const settings = { llmBaseUrl: url, llmApiKey: "t", llmModel: "mock", runtime: "pig", codexBinaryPath: "", codexModel: "", codexNetworkAccess: false, cloudBaseUrl: "", cloudToken: "", cloudMode: "local-stub" } as never;
    const cases = taskCases().filter((c) => ["list-and-summarize", "write-file"].includes(c.id));
    const results = [];
    for (const c of cases) results.push(await runTaskCase(c, settings));
    server.close();
    const list = results.find((r) => r.id === "list-and-summarize")!;
    expect(list.pass).toBe(true);
    expect(list.toolCalls).toBeGreaterThan(0);
    expect(list.modelCalls).toBe(2);
    const write = results.find((r) => r.id === "write-file")!;
    expect(write.pass).toBe(false); // mock writes "hello from mock LLM": grader must catch it
    const s = summarize(results);
    expect(s.passRate).toBe(0.5);
    expect(markdownTable(results)).toContain("| write-file | ❌");
  });
});
