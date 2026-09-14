import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { complete, toOpenAiMessages } from "./openai.ts";

function collect(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function startFallbackServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await collect(req);
    const body = JSON.parse(raw) as { parallel_tool_calls?: boolean; stream?: boolean };
    if (body.parallel_tool_calls) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unknown field parallel_tool_calls" } }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_a",
                    function: { name: "list_dir" },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"."}' } }] } }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.statusCode = 500;
    res.end("nope");
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

const mock = await startFallbackServer();

afterAll(async () => {
  await mock.close();
});

describe("OpenAI-compatible client", () => {
  it("maps tool results for DeepSeek-style Chat Completions", () => {
    const rows = toOpenAiMessages([
      { id: "s", role: "system", content: "sys", createdAt: "" },
      {
        id: "a",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "list_dir", arguments: "{}" }],
        createdAt: "",
      },
      { id: "t", role: "tool", content: "ok", toolCallId: "c1", createdAt: "" },
    ]);
    expect(rows[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "list_dir" } }],
    });
    expect(rows[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("retries without parallel_tool_calls and stitches streamed tool args", async () => {
    const result = await complete(
      { llmBaseUrl: mock.url, llmApiKey: "x", llmModel: "deepseek-chat" },
      [{ id: "u", role: "user", content: "hi", createdAt: new Date().toISOString() }],
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("list_dir");
    expect(result.toolCalls[0]?.arguments).toBe('{"path":"."}');
  });
});
