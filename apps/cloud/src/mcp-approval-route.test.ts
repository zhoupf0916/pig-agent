import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
const state = vi.hoisted(() => ({
  query: vi.fn(),
  server: true,
  saved: null as unknown,
}));
vi.mock("./db.ts", () => ({
  db: {
    query: state.query,
    connect: async () => ({ query: state.query, release() {} }),
  },
  hash: (v: string) => v,
}));
import { registerApprovalRoutes } from "./approvals.ts";
function app() {
  const a = new Hono<CloudEnv>();
  a.use("*", async (c, next) => {
    c.set("principal", { id: "alice", name: "Alice", role: "member" });
    await next();
  });
  registerApprovalRoutes(a, async () => true);
  return a;
}
beforeEach(() => {
  state.server = true;
  state.saved = null;
  state.query
    .mockReset()
    .mockImplementation(async (sql: string, args: unknown[] = []) => {
      if (sql.includes("FROM runs WHERE attempt_token"))
        return {
          rows: [
            {
              id: "run",
              owner_id: "alice",
              input: { requireApproval: false, networkPolicy: "ask" },
            },
          ],
        };
      if (sql.includes("FROM mcp_servers"))
        return {
          rows: state.server
            ? [
                {
                  id: "m_aaaaaaaaaaaaaaaa",
                  name: "External fixture",
                  url: "https://mcp.example/mcp",
                  credential_version: 1,
                },
              ]
            : [],
        };
      if (sql.startsWith("INSERT INTO approvals")) {
        state.saved = args[5];
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
});
const input = {
  token: "synthetic",
  callId: "call",
  tool: "mcp__m_aaaaaaaaaaaaaaaa__write_marker",
  args: { marker: "probe" },
};
describe("cloud MCP approval creation", () => {
  it("requires and creates an approval even when ordinary sandbox tools run automatically", async () => {
    const response = await app().request("/internal/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    expect(state.saved).toMatchObject({
      serverName: "External fixture",
      url: "https://mcp.example/mcp",
      credentialVersion: 1,
    });
  });
  it("does not approve an unavailable MCP connection", async () => {
    state.server = false;
    const response = await app().request("/internal/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(403);
    expect(state.saved).toBeNull();
  });
});
