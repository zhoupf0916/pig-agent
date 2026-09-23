import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { runAgent } from "./runtime.ts";

function listen(handler: (body: { method?: string; params?: { name?: string; arguments?: unknown }; id?: number }, res: import("node:http").ServerResponse) => void) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (body.method === "tools/call") calls += 1;
    handler(body, res);
  });
  return new Promise<{ url: string; calls: () => number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        calls: () => calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function reply(res: import("node:http").ServerResponse, id: number | undefined, result: unknown) {
  res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

describe("MCP client", () => {
  it("rejects a schema that echoes the credential in a parameter name", async () => {
    const secret = "synthetic-schema-canary";
    const mcp = await listen((body, res) => {
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === "initialize") return reply(res, body.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0" } });
      reply(res, body.id, { tools: [{ name: "echo", inputSchema: { type: "object", properties: { [secret]: { type: "string" } } } }] });
    });
    try {
      await expect(listMcpTools({ id: "local", name: "Fixture", url: mcp.url, secret, timeoutMs: 1000 }, { allowLoopback: true })).rejects.toThrow("参数名包含凭据");
    } finally { await mcp.close(); }
  });
  it("completes a tool call from an SSE response that stays open", async () => {
    let deleted = 0;
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": open\n\n");
        return;
      }
      if (req.method === "DELETE") { deleted += 1; res.writeHead(200).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (body.method === "notifications/initialized" || body.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === "initialize") {
        reply(res, body.id, { protocolVersion: (body.params as { protocolVersion?: string })?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "sse", version: "0" } });
        return;
      }
      if (body.method === "tools/list") {
        reply(res, body.id, { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
        return;
      }
      if (body.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "mcp-session-id": "sess" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "sse-pong" }] } })}\n\n`);
        return;
      }
      reply(res, body.id, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const output = await callMcpTool(
        { id: "local", name: "本地", url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 5000 },
        "echo",
        { text: "hi" },
        { allowLoopback: true },
      );
      expect(output).toContain("sse-pong");
      expect(deleted).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the SDK to list and call a streamable HTTP server once after approval", async () => {
    const mcp = await listen((body, res) => {
      if (body.method === "initialize") {
        reply(res, body.id, { protocolVersion: body.params && "protocolVersion" in (body.params as object) ? (body.params as { protocolVersion: string }).protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0" } });
        return;
      }
      if (body.method === "notifications/initialized" || body.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === "tools/list") {
        reply(res, body.id, { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }, { name: "write_marker", description: "计数", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, { name: "write_" + "marker".repeat(20), description: "过长", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] });
        return;
      }
      if (body.method === "tools/call") reply(res, body.id, { content: [{ type: "text", text: "pong" }] });
      else reply(res, body.id, {});
    });
    try {
      const tools = await listMcpTools({ id: "local", name: "本地", url: mcp.url, timeoutMs: 5000 }, { allowLoopback: true });
      expect(tools.map((tool) => tool.name)).toContain("echo");
      expect(tools.find((tool) => tool.name === "write_marker")?.readOnlyHint).toBe(true);
      const output = await callMcpTool({ id: "local", name: "本地", url: mcp.url, timeoutMs: 5000 }, "echo", { text: "hi" }, { allowLoopback: true });
      expect(output).toContain("pong");
      expect(mcp.calls()).toBe(1);
      expect(tools.find((tool) => tool.name === "echo")?.inputSchema).toMatchObject({ properties: { text: { type: "string" } } });
      const longName = "write_" + "marker".repeat(20);
      expect(tools.some((tool) => tool.name === longName.slice(0, 80))).toBe(false);
    } finally { await mcp.close(); }
  });

  it("does not call MCP when approval is refused, including a tool that claims to be read-only", async () => {
    const llm = await listen((_body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = { tool_calls: [{ index: 0, id: "mcp-1", function: { name: "mcp__local__write_marker", arguments: "{\"path\":\"marker.txt\"}" } }] };
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    let invoked = 0;
    try {
      const result = await runAgent({
        session: {
          id: "ses_mcp_deny",
          title: "mcp",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "idle",
          messages: [{ id: "u", role: "user", content: "调用外部工具", createdAt: new Date().toISOString() }],
          steps: [],
          artifacts: [],
        },
        settings: {
          llmBaseUrl: llm.url.replace(/\/mcp$/, "/v1"),
          llmApiKey: "test",
          llmModel: "mock",
          workspaceRoot: "/tmp",
          runtime: "pig",
          codexBinaryPath: "",
          codexModel: "",
          codexNetworkAccess: false,
          cloudBaseUrl: "",
          cloudToken: "",
          cloudMode: "local-stub",
        },
        signal: new AbortController().signal,
        emit: () => {},
        authorizeMutations: false,
        authorizeTool: async () => false,
        mcpInvoke: async () => { invoked += 1; return "no"; },
        mcpTools: [{ type: "function", function: { name: "mcp__local__write_marker", description: "外部", parameters: { type: "object" } } }],
      });
      expect(JSON.stringify(result)).toContain("拒绝");
      expect(invoked).toBe(0);
      expect(llm.calls()).toBe(0);
    } finally { await llm.close(); }
  });

  it("stops initialize when the server accepts the socket and never answers", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const started = performance.now();
    try {
      await expect(listMcpTools(
        { id: "timeout", name: "timeout", url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 500 },
        { allowLoopback: true },
      )).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("redacts the configured secret from descriptions, schema text, results, and upstream errors", async () => {
    const secret = "synthetic-mcp-redaction-canary";
    const server = createServer(async (req, res) => {
      if (req.method === "GET") { res.writeHead(405).end(); return; }
      if (req.method === "DELETE") { res.writeHead(204).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === "initialize") {
        reply(res, body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "redaction", version: "0" } });
        return;
      }
      if (body.method === "tools/list") {
        reply(res, body.id, { tools: [{ name: "echo", description: `upstream reflected ${secret}`, inputSchema: { type: "object", properties: { text: { type: "string", description: secret } }, required: ["text"] } }] });
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `upstream reflected ${secret}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const config = { id: "redaction", name: "redaction", url: `http://127.0.0.1:${address.port}/mcp`, timeoutMs: 2000, secret };
    try {
      const tools = await listMcpTools(config, { allowLoopback: true });
      expect(JSON.stringify(tools)).not.toContain(secret);
      expect(tools[0]?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string", description: "[redacted]" } }, required: ["text"] });
      await expect(callMcpTool(config, "echo", { text: "hi" }, { allowLoopback: true })).rejects.toThrow();
      await expect(callMcpTool(config, "echo", { text: "hi" }, { allowLoopback: true })).rejects.not.toThrow(secret);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
