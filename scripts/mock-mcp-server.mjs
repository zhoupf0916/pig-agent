/** Local acceptance fixture only. No filesystem tools, production data, or real model calls. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
const sessions = new Set(),
  calls = [],
  contexts = [];
let mutations = 0,
  cancelled = 0,
  modelCalls = 0;
const token = process.env.MCP_FIXTURE_TOKEN || "synthetic-local-fixture";
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (path === "/health") return json(200, { ok: true, fixture: true });
  if (path === "/state")
    return json(200, {
      mutations,
      cancelled,
      calls,
      contexts,
      modelCalls,
      sessions: sessions.size,
    });
  if (path === "/redirect") {
    res.writeHead(307, {
      location: "http://169.254.169.254/latest/meta-data/",
    });
    res.end();
    return;
  }
  if (!["/mcp", "/mcp-open", "/v1/chat/completions"].includes(path))
    return json(404, { error: "fixture endpoint not found" });
  if (path === "/mcp" && req.headers.authorization !== `Bearer ${token}`)
    return json(401, { error: "fixture authentication required" });
  if (req.method === "GET") return json(405, { error: "method" });
  if (req.method === "DELETE") {
    sessions.delete(req.headers["mcp-session-id"]);
    res.writeHead(204).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000)
      return json(413, { error: "request too large" });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (path === "/v1/chat/completions") {
    modelCalls++;
    const messages = body.messages || [];
    const latestUser = messages.findLastIndex((m) => m.role === "user");
    const userText = messages[latestUser]?.content || "";
    const target = String(userText).match(
      /\[MCP_ACCEPTANCE:(echo|write_marker|slow)\]/,
    )?.[1];
    const toolResults = messages
      .slice(latestUser + 1)
      .filter((m) => m.role === "tool");
    const selected = (body.tools || []).find((t) =>
      t.function?.name?.endsWith("__" + target),
    );
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content || "")
      .join("\n");
    contexts.push({
      reviewSkill: system.includes("代码审查清单"),
      reviewExpert: system.includes("质量审查"),
    });
    const call =
      target && selected && !toolResults.length
        ? {
            id: "fixture-" + randomUUID(),
            type: "function",
            function: {
              name: selected.function.name,
              arguments: JSON.stringify(
                target === "write_marker"
                  ? { marker: "MCP_RUNTIME_PROOF", path: "acceptance.txt" }
                  : target === "slow"
                    ? { delayMs: 15000 }
                    : { text: "MCP_RUNTIME_PROOF" },
              ),
            },
          }
        : null;
    const content = call
      ? null
      : target
        ? selected
          ? "MCP fixture completed. Actual tool result: " +
            String(toolResults.at(-1)?.content || "no tool result")
          : "MCP tool unavailable"
        : "Context fixture completed.";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = call
        ? { tool_calls: [{ index: 0, ...call }] }
        : { content };
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    return json(200, {
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(call ? { tool_calls: [call] } : {}),
          },
          finish_reason: call ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  }
  let sid = req.headers["mcp-session-id"];
  const result = (value) =>
    json(
      200,
      { jsonrpc: "2.0", id: body.id, result: value },
      { "mcp-session-id": sid },
    );
  if (body.method === "initialize") {
    sid = randomUUID();
    sessions.add(sid);
    return result({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pig-acceptance-fixture", version: "1.0.0" },
    });
  }
  if (!sessions.has(sid)) return json(404, { error: "unknown session" });
  if (body.id === undefined) {
    if (body.method === "notifications/cancelled") cancelled++;
    res.writeHead(202).end();
    return;
  }
  if (body.method === "tools/list")
    return result({
      tools: [
        {
          name: "echo",
          description: "Return supplied fixture text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "write_marker",
          description:
            "Increment a synthetic counter. The deliberately untrusted readOnlyHint must not skip approval.",
          inputSchema: {
            type: "object",
            properties: {
              marker: { type: "string" },
              path: { type: "string" },
            },
            required: ["marker"],
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "slow",
          description: "Wait so cancellation and timeout can be verified.",
          inputSchema: {
            type: "object",
            properties: {
              delayMs: { type: "integer", minimum: 1, maximum: 60000 },
            },
          },
        },
      ],
    });
  if (body.method === "tools/call") {
    const name = body.params?.name;
    calls.push({
      name,
      args: body.params?.arguments,
      at: new Date().toISOString(),
    });
    if (name === "write_marker") mutations++;
    if (name === "slow") {
      const delay = Math.max(
        1,
        Math.min(60000, Number(body.params?.arguments?.delayMs) || 15000),
      );
      await new Promise((resolve) => {
        let done = false;
        const finish = (aborted) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (aborted) cancelled++;
          resolve();
        };
        const timer = setTimeout(() => finish(false), delay);
        res.once("close", () => finish(true));
      });
      if (res.destroyed) return;
    }
    return result({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            source: "independent-mcp-fixture",
            name,
            arguments: body.params?.arguments,
            mutations,
          }),
        },
      ],
    });
  }
  return json(200, {
    jsonrpc: "2.0",
    id: body.id,
    error: { code: -32601, message: "Unknown method" },
  });
});
server.listen(
  Number(process.env.PORT || 9910),
  process.env.HOST || "127.0.0.1",
  () => console.log("Local MCP acceptance fixture ready"),
);
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close();
});
