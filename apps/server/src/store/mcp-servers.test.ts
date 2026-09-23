import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { createApp } from "../app.ts";
import { setDesktopSecrets, type DesktopSecrets } from "./desktop-secrets.ts";
import { invokeApprovedMcp, requireMcpTarget } from "./mcp-servers.ts";
import { saveSettings } from "./settings.ts";

afterEach(() => setDesktopSecrets(undefined));

function vault() {
  let stored: DesktopSecrets = { llmApiKey: "model-key", cloudToken: "", codexApiKey: "", mcpSecrets: {} };
  setDesktopSecrets({ read: async () => stored, write: async (value) => { stored = value; } });
  return { read: () => stored };
}

describe("local MCP configuration", () => {
  it("stores the credential only in the vault and keeps it when settings are saved", async () => {
    const secret = "synthetic-mcp-redaction-canary";
    const saved = vault();
    const app = createApp();
    const created = await app.request("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "本地", url: "http://127.0.0.1:9/mcp", secret }) });
    expect(created.status).toBe(201);
    const body = await created.json() as { servers: Array<{ secretConfigured: boolean }> };
    expect(body.servers[0]?.secretConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(secret);
    const disk = await readFile(join(DATA_DIR, "mcp-servers.json"), "utf8");
    expect(disk).not.toContain(secret);
    expect(Object.values(saved.read().mcpSecrets ?? {})).toContain(secret);
    await saveSettings({ llmModel: "another-model" });
    expect(Object.values(saved.read().mcpSecrets ?? {})).toContain(secret);
    const listed = await app.request("/api/mcp/servers");
    expect(await listed.text()).not.toContain(secret);
  });

  it("does not call a server after its URL changes or it is disabled", async () => {
    let calls = 0;
    const server = createServer(async (req, res) => {
      calls += 1;
      if (req.method === "DELETE") { res.writeHead(204).end(); return; }
      if (req.method === "GET") { res.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const message = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local", version: "0" } }
        : { content: [{ type: "text", text: "once" }] };
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "local" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    vault();
    const app = createApp();
    let id = "";
    try {
      const created = await app.request("/api/mcp/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "本地", url: `http://127.0.0.1:${address.port}/mcp`, enabled: true }) });
      id = ((await created.json()) as { servers: Array<{ id: string }> }).servers.at(-1)?.id || "";
      if (!id) throw new Error("missing id");
      const tool = `mcp__${id}__echo`;
      const target = await requireMcpTarget(tool);
      expect(await invokeApprovedMcp(tool, { text: "hi" }, target)).toContain("once");
      const called = calls;
      await app.request(`/api/mcp/servers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "http://127.0.0.1:9/mcp" }) });
      await expect(invokeApprovedMcp(tool, { text: "hi" }, target)).rejects.toThrow(/配置已变化|未调用/);
      await app.request(`/api/mcp/servers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, enabled: false }) });
      await expect(invokeApprovedMcp(tool, { text: "hi" }, { ...target, url: `http://127.0.0.1:${address.port}/mcp` })).rejects.toThrow(/停用|未调用/);
      expect(calls).toBe(called);
    } finally {
      if (id) await app.request(`/api/mcp/servers/${id}`, { method: "DELETE" });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
