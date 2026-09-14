/**
 * Tiny OpenAI-compatible mock for offline demos and smoke tests.
 * Start with: pnpm mock:llm
 * Then set LLM Base URL to http://127.0.0.1:8788/v1
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 8788);

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function collect(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-local", object: "model" }] }));
    return;
  }

  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const raw = await collect(req);
  let messages: Array<{ role?: string; content?: unknown; tool_calls?: unknown }> = [];
  try {
    messages = (JSON.parse(raw) as { messages?: typeof messages }).messages ?? [];
  } catch {
    messages = [];
  }

  const hasToolResult = messages.some((m) => m.role === "tool");
  res.writeHead(200, { "Content-Type": "text/event-stream" });

  if (!hasToolResult) {
    writeSse(res, {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_plan",
                function: {
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [
                      { title: "查看工作区", status: "done" },
                      { title: "撰写摘要 README", status: "running" },
                    ],
                  }),
                },
              },
              {
                index: 1,
                id: "call_write",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "README.md",
                    content: [
                      "# Demo workspace",
                      "",
                      "This README was written by the local mock LLM so you can review an artifact without Ollama.",
                      "",
                      "## Layout",
                      "- `notes/` meeting notes and todos",
                      "- `drafts/` unfinished ideas",
                      "- `scattered-log.txt` leftover log",
                      "",
                      "Ask a real model (Ollama / OpenAI-compatible) for a richer rewrite.",
                      "",
                    ].join("\n"),
                  }),
                },
              },
            ],
          },
        },
      ],
    });
  } else {
    const text =
      "已更新 `README.md`。请在右侧「产物」中打开预览，确认工作区摘要是否符合预期。";
    writeSse(res, { choices: [{ delta: { content: text } }] });
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock OpenAI-compatible LLM  http://127.0.0.1:${PORT}/v1`);
});
