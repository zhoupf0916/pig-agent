import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { CloudEnv } from "./types.ts";

const state = vi.hoisted(() => ({
  shared: true,
  queries: [] as { sql: string; args: unknown[] }[],
}));
vi.mock("./db.ts", () => ({
  hash: (value: string) => value,
  db: {
    query: async (sql: string, args: unknown[] = []) => {
      state.queries.push({ sql, args });
      if (sql.startsWith("UPDATE shared_projects")) {
        return state.shared
          ? { rowCount: 1, rows: [{ id: args[0] }] }
          : { rowCount: 0, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));
import { registerCollaborationRoutes } from "./collaboration.ts";

function app() {
  const app = new Hono<CloudEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "alice", name: "Alice", role: "member" });
    await next();
  });
  registerCollaborationRoutes(app);
  return app;
}

describe("sharing a personal project", () => {
  beforeEach(() => {
    state.shared = true;
    state.queries = [];
  });
  it("moves the owner's personal project into an organization they administer", async () => {
    const response = await app().request("/v1/projects/project_abc/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId: "space_1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "project_abc", spaceId: "space_1" });
    const update = state.queries.find((query) => query.sql.startsWith("UPDATE shared_projects"));
    expect(update?.sql).toContain("space_id IS NULL");
    expect(update?.sql).toContain("m.role='admin'");
    expect(update?.args).toEqual(["project_abc", "alice", "space_1"]);
  });
  it("rejects sharing when the project is not a personal project owned by an organization admin", async () => {
    state.shared = false;
    const response = await app().request("/v1/projects/project_abc/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId: "space_1" }),
    });
    expect(response.status).toBe(404);
  });
});
