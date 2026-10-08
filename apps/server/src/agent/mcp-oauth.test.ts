import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { callMcpTool, listMcpTools } from "./mcp-client.ts";
import { parseOAuthSecret, resetOAuthCacheForTests, resolveBearer } from "./mcp-oauth.ts";

afterEach(() => resetOAuthCacheForTests());

/** One loopback server playing both MCP resource server and OAuth authorization server. */
async function fixture(opts: { revokeFirst?: boolean } = {}) {
  const log: string[] = [];
  let issued = 0;
  const valid = new Set<string>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    log.push(`${req.method} ${req.url}`);
    if (req.url === "/.well-known/oauth-protected-resource") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [`${base}/`] }));
    if (req.url === "/.well-known/oauth-authorization-server") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: base, token_endpoint: `${base}/token` }));
    if (req.url === "/token") {
      const form = new URLSearchParams(raw);
      const basic = Buffer.from(String(req.headers.authorization).replace(/^Basic /, ""), "base64").toString();
      if (basic !== "cid:csecret-canary" || form.get("grant_type") !== "client_credentials") return void res.writeHead(401).end();
      log.push(`scope=${form.get("scope")} resource=${form.get("resource")}`);
      const token = `tok-${++issued}`; valid.add(token);
      if (opts.revokeFirst && issued === 1) valid.delete(token);
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 }));
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!valid.has(auth)) return void res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end();
    const body = JSON.parse(raw || "{}");
    if (body.id === undefined) return void res.writeHead(202).end();
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "f", version: "0" } }
      : body.method === "tools/list" ? { tools: [{ name: "whoami", description: "who", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: `token=${auth}` }] };
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  return { url, log, issued: () => issued, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const secret = JSON.stringify({ type: "oauth_client_credentials", clientId: "cid", clientSecret: "csecret-canary", scope: "tools:read" });

describe("MCP OAuth client_credentials", () => {
  it("parses only well-formed descriptors; plain strings stay static bearer tokens", async () => {
    expect(parseOAuthSecret("plain-token")).toBeNull();
    expect(parseOAuthSecret('{"type":"oauth_client_credentials","clientId":"a"}')).toBeNull();
    expect(parseOAuthSecret(secret)?.scope).toBe("tools:read");
    expect(await resolveBearer("https://x/mcp", "plain-token", async () => { throw new Error("no fetch"); })).toBe("plain-token");
  });
  it("discovers the token endpoint, caches the token and redacts it from output", async () => {
    const f = await fixture();
    try {
      const cfg = { id: "o", name: "OAuth", url: f.url, timeoutMs: 5000, secret };
      expect((await listMcpTools(cfg, { allowLoopback: true })).map((t) => t.name)).toEqual(["whoami"]);
      const out = await callMcpTool(cfg, "whoami", {}, { allowLoopback: true });
      expect(out).not.toContain("tok-1");
      expect(out).toContain("[redacted]");
      expect(f.issued()).toBe(1); // cached across connections
      expect(f.log).toContain("GET /.well-known/oauth-protected-resource");
      expect(f.log.some((l) => l === `scope=tools:read resource=${f.url}`)).toBe(true);
    } finally { await f.close(); }
  });
  it("refreshes once when the cached token is rejected with 401", async () => {
    const f = await fixture({ revokeFirst: true });
    try {
      const tools = await listMcpTools({ id: "o", name: "OAuth", url: f.url, timeoutMs: 5000, secret }, { allowLoopback: true });
      expect(tools).toHaveLength(1);
      expect(f.issued()).toBe(2);
    } finally { await f.close(); }
  });
  it("never leaks the client secret in errors", async () => {
    const f = await fixture();
    try {
      const bad = JSON.stringify({ type: "oauth_client_credentials", clientId: "cid", clientSecret: "wrong-canary", tokenUrl: f.url.replace("/mcp", "/token") });
      const err = await listMcpTools({ id: "o", name: "OAuth", url: f.url, timeoutMs: 5000, secret: bad }, { allowLoopback: true }).catch((e: Error) => e);
      expect(String(err)).toContain("获取 MCP 访问令牌失败（HTTP 401）");
      expect(String(err)).not.toContain("wrong-canary");
    } finally { await f.close(); }
  });
});
