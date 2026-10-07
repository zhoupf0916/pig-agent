/**
 * Tiny OpenAI-compatible mock for offline demos and smoke tests.
 * Start with: pnpm mock:llm
 * Then set LLM Base URL to http://127.0.0.1:8788/v1
 * Scenarios (see mock-scenarios.ts): routed by the user message, or force with
 * MOCK_LLM_SCENARIO=readme|list|write|shell|read|chat|fail or a "[mock:name]" tag.
 */
import { mockReply } from "./mock-scenarios.ts";
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

  const reply = mockReply(messages);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (reply.toolCalls?.length) {
    writeSse(res, { choices: [{ delta: { tool_calls: reply.toolCalls.map((call, index) => ({ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } }] });
  } else {
    writeSse(res, { choices: [{ delta: { content: reply.content ?? "" } }] });
  }
  writeSse(res, { choices: [{ delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(JSON.stringify(reply).length / 4) } });

  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock OpenAI-compatible LLM  http://127.0.0.1:${PORT}/v1`);
});
