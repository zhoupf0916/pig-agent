import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  listRemoteTools: vi.fn(),
  callRemoteTool: vi.fn(),
}));
vi.mock("./db.ts", () => ({ db: mocks, hash: (value: string) => value }));
vi.mock("./platform.ts", () => ({
  encryptSecret: (value: string) => `enc:${value}`,
  decryptSecret: (value: string) => value.slice(4),
}));
vi.mock("./mcp-http.ts", () => ({
  assertCloudMcpUrl: (value: string) => new URL(value),
  listRemoteTools: mocks.listRemoteTools,
  callRemoteTool: mocks.callRemoteTool,
}));
import { registerMcpRoutes } from "./mcp-servers.ts";
import type { CloudEnv } from "./types.ts";

function appFor(id: string, role = "member") {
  const app = new Hono<CloudEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id, name: id, role });
    await next();
  });
  registerMcpRoutes(app);
  return app;
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.connect.mockReset();
  mocks.listRemoteTools.mockReset();
  mocks.callRemoteTool.mockReset();
});

describe("cloud MCP ownership", () => {
  it("preserves a concurrently changed endpoint when only changing the timeout", async () => {
    let endpoint = "https://old.example/mcp";
    mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.startsWith("SELECT id,url")) {
        const old = endpoint;
        endpoint = "https://new.example/mcp";
        return { rows: [{ id: "m_aaaaaaaaaaaaaaaa", url: old }] };
      }
      if (sql.startsWith("UPDATE mcp_servers")) {
        if (args[3] !== null) endpoint = String(args[3]);
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: "m_aaaaaaaaaaaaaaaa",
            name: "Fixture",
            url: endpoint,
            enabled: false,
            timeout_ms: 5000,
            secret: null,
          },
        ],
      };
    });
    const response = await appFor("alice").request(
      "/v1/mcp/servers/m_aaaaaaaaaaaaaaaa",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutMs: 5000 }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      servers: [{ url: "https://new.example/mcp" }],
    });
  });
  it("keeps another user's servers and the credential out of the response", async () => {
    const secret = "synthetic-mcp-redaction-canary";
    mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
      if (String(sql).includes("INSERT")) return { rows: [] };
      return {
        rows:
          args[0] === "alice"
            ? [
                {
                  id: "m_aaaaaaaaaaaaaaaa",
                  name: "Alice",
                  url: "https://8.8.8.8/mcp",
                  enabled: false,
                  timeout_ms: 15000,
                  secret: `enc:${secret}`,
                },
              ]
            : [],
      };
    });
    const created = await appFor("alice").request("/v1/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Alice",
        url: "https://8.8.8.8/mcp",
        secret,
      }),
    });
    expect(created.status).toBe(201);
    const text = await created.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("enc:");
    const bob = await appFor("bob").request("/v1/mcp/servers");
    expect(await bob.json()).toEqual({ servers: [] });
    expect(mocks.query.mock.calls.some((call) => call[1]?.[0] === "bob")).toBe(
      true,
    );
  });

  it("does not call MCP when the approval was not consumed or was already used", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("FROM runs"))
        return { rows: [{ id: "run", owner_id: "alice" }] };
      if (String(sql).includes("FROM approvals")) return { rows: [] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    const response = await appFor("alice").request("/internal/mcp/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "run-token",
        callId: "call-1",
        tool: "mcp__m_aaaaaaaaaaaaaaaa__echo",
        args: { text: "hi" },
        url: "https://8.8.8.8/mcp",
        credentialVersion: 1,
      }),
    });
    expect(response.status).toBe(403);
    expect(mocks.callRemoteTool).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });
});
