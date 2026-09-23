import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
const state = vi.hoisted(() => ({
  shared: false,
  blocked: false,
  enabled: true,
  lease: true,
  used: false,
  query: vi.fn(),
  connect: vi.fn(),
  call: vi.fn(),
  list: vi.fn(),
}));
vi.mock("./db.ts", () => ({
  db: { query: state.query, connect: state.connect },
  hash: (v: string) => v,
}));
vi.mock("./platform.ts", () => ({
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
}));
vi.mock("./mcp-http.ts", () => ({
  assertCloudMcpUrl: (v: string) => new URL(v),
  callRemoteTool: state.call,
  listRemoteTools: state.list,
}));
import { registerMcpRoutes } from "./mcp-servers.ts";
const tool = "mcp__m_aaaaaaaaaaaaaaaa__echo";
function app() {
  const a = new Hono<CloudEnv>();
  a.use("*", async (c, next) => {
    c.set("principal", { id: "alice", name: "Alice", role: "member" });
    await next();
  });
  registerMcpRoutes(a);
  return a;
}
const args = { marker: "acceptance", path: "output.txt" };
function invoke() {
  return app().request("/internal/mcp/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "synthetic-run-token",
      callId: "call-1",
      tool,
      args,
      url: "https://mcp.example/mcp",
      credentialVersion: 1,
    }),
  });
}
beforeEach(() => {
  state.shared = false;
  state.blocked = false;
  state.enabled = true;
  state.lease = true;
  state.used = false;
  state.call.mockReset().mockResolvedValue("proof");
  state.list.mockReset().mockResolvedValue([]);
  state.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("FROM runs"))
      return {
        rows: state.lease
          ? [
              {
                id: "run",
                owner_id: "alice",
                enabled: state.enabled,
                space_id: state.shared ? "shared-space" : null,
                input: {
                  networkPolicy: state.blocked ? "blocked" : "ask",
                  projectId: state.shared ? "project-shared" : undefined,
                },
              },
            ]
          : [],
      };
    if (sql.includes("FROM principals"))
      return { rows: [{ role: "member", enabled: state.enabled }] };
    if (sql.includes("FROM projects"))
      return { rows: [{ space_id: state.shared ? "shared-space" : null }] };
    if (sql.includes("FROM approvals"))
      return {
        rows: [
          {
            id: "approval",
            state: "consumed",
            mcp_target: {
              serverId: "m_aaaaaaaaaaaaaaaa",
              serverName: "fixture",
              url: "https://mcp.example/mcp",
              credentialVersion: 1,
            },
            args: { path: "output.txt", marker: "acceptance" },
          },
        ],
      };
    if (sql.includes("INSERT INTO mcp_invocations")) {
      if (state.used) return { rows: [] };
      state.used = true;
      return { rows: [{ approval_id: "approval" }] };
    }
    if (sql.includes("FROM mcp_servers"))
      return {
        rows: [
          {
            id: "m_aaaaaaaaaaaaaaaa",
            name: "fixture",
            url: "https://mcp.example/mcp",
            timeout_ms: 1000,
            secret: null,
            role: "member",
            enabled: true,
            credential_version: 1,
          },
        ],
      };
    return { rows: [] };
  });
  state.connect
    .mockReset()
    .mockResolvedValue({ query: state.query, release: vi.fn() });
});
describe("MCP independent approval boundary regression", () => {
  it("accepts identical approved arguments despite PostgreSQL JSONB key order", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(state.call).toHaveBeenCalledOnce();
  });
  it("does not attach a callers private connector to a shared project task", async () => {
    state.shared = true;
    const response = await app().request("/internal/mcp/tools", {
      method: "POST",
      body: JSON.stringify({ token: "synthetic-run-token" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tools: [], targets: [] });
    expect(state.list).not.toHaveBeenCalled();
  });
  it("blocks invocation from a shared project even with a consumed approval", async () => {
    state.shared = true;
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(state.call).not.toHaveBeenCalled();
  });
  it("rejects a disabled account before discovering external tools", async () => {
    state.enabled = false;
    const response = await app().request("/internal/mcp/tools", {
      method: "POST",
      body: JSON.stringify({ token: "synthetic-run-token" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(403);
    expect(state.list).not.toHaveBeenCalled();
  });
  it("does not discover connectors when the task forbids network access", async () => {
    state.blocked = true;
    const response = await app().request("/internal/mcp/tools", {
      method: "POST",
      body: JSON.stringify({ token: "synthetic-run-token" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(await response.json()).toMatchObject({ tools: [], targets: [] });
    expect(state.list).not.toHaveBeenCalled();
  });
  it("aborts an in-flight external call after its run loses authorization", async () => {
    state.call.mockImplementation(
      async (_server, _tool, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Error("cancelled")), {
            once: true,
          });
        }),
    );
    const pending = invoke();
    const timer = setTimeout(() => {
      state.lease = false;
    }, 50);
    try {
      const response = await Promise.race([
        pending,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1600)),
      ]);
      expect(response?.status).toBe(502);
      expect(state.call).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(timer);
    }
  });
});
