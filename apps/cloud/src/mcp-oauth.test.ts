import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { resetOAuthCacheForTests } from "@pig-agent/contracts/mcp-oauth";
import { callRemoteTool, listRemoteTools } from "./mcp-http.ts";

afterEach(() => { resetOAuthCacheForTests(); delete process.env.MCP_ENDPOINT_ALLOWLIST; });

/** Loopback server acting as both MCP resource server and OAuth authorization server. */
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
      if (basic !== "cloud-client:cloud-secret-canary" || form.get("grant_type") !== "client_credentials") return void res.writeHead(401).end();
      log.push(`resource=${form.get("resource")}`);
      const token = `cloud-tok-${++issued}`; valid.add(token);
      if (opts.revokeFirst && issued === 1) valid.delete(token);
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 600 }));
    }
    if (req.method === "DELETE") return void res.writeHead(200).end();
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!valid.has(auth)) return void res.writeHead(401).end();
    const body = JSON.parse(raw || "{}");
    if (body.id === undefined) return void res.writeHead(202).end();
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "f", version: "0" } }
      : body.method === "tools/list" ? { tools: [{ name: "whoami", description: "who", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: `token=${auth}` }] };
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // Admin fixture: the MCP endpoint and its OAuth metadata/token endpoints are allowlisted exactly.
  const allow = () => { process.env.MCP_ENDPOINT_ALLOWLIST = [`${base}/mcp`, `${base}/.well-known/oauth-protected-resource`, `${base}/.well-known/oauth-authorization-server`, `${base}/token`].join(","); };
  return { base, url: `${base}/mcp`, log, allow, issued: () => issued, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const secret = JSON.stringify({ type: "oauth_client_credentials", clientId: "cloud-client", clientSecret: "cloud-secret-canary" });

describe("cloud MCP OAuth client_credentials", () => {
  it("discovers the token endpoint through the tenant egress fetch, caches the token and redacts it", async () => {
    const f = await fixture();
    f.allow();
    try {
      const cfg = { id: "o", name: "OAuth", url: f.url, timeoutMs: 5000, secret, role: "admin" };
      expect((await listRemoteTools(cfg)).map((t) => t.name)).toEqual(["whoami"]);
      const out = await callRemoteTool(cfg, "whoami", {});
      expect(out).not.toContain("cloud-tok-1");
      expect(out).toContain("token=");
      expect(f.issued()).toBe(1);
      expect(f.log).toContain(`resource=${f.url}`);
    } finally { await f.close(); }
  });
  it("refreshes once on 401 with a revoked cached token", async () => {
    const f = await fixture({ revokeFirst: true });
    f.allow();
    try {
      expect(await listRemoteTools({ id: "o", name: "OAuth", url: f.url, timeoutMs: 5000, secret, role: "admin" })).toHaveLength(1);
      expect(f.issued()).toBe(2);
    } finally { await f.close(); }
  });
  it("applies tenant egress policy to token endpoints and never leaks the client secret", async () => {
    const f = await fixture();
    try {
      // Ordinary tenant: discovery to a loopback origin is refused before any request is sent.
      const err = await listRemoteTools({ id: "o", name: "OAuth", url: "https://8.8.8.8/mcp", timeoutMs: 2000, role: "member",
        secret: JSON.stringify({ type: "oauth_client_credentials", clientId: "cloud-client", clientSecret: "cloud-secret-canary", tokenUrl: `${f.base}/token` }) }).catch((e: Error) => e);
      expect(String(err)).toContain("MCP 目标地址被拒绝");
      expect(String(err)).not.toContain("cloud-secret-canary");
      expect(f.log).toEqual([]);
    } finally { await f.close(); }
  });
});
