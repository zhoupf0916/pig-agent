import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
const state = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  project: null as { owner_id: string; space_id: string | null } | null,
  count: 0,
  queries: [] as { sql: string; args: unknown[] }[],
}));
vi.mock("./db.ts", () => {
  const query = async (sql: string, args: unknown[] = []) => {
    state.queries.push({ sql, args });
    if (sql.startsWith("SELECT value FROM user_settings"))
      return {
        rows: state.settings ? [{ value: state.settings }] : [],
        rowCount: state.settings ? 1 : 0,
      };
    if (sql.startsWith("INSERT INTO user_settings"))
      state.settings = args[1] as Record<string, unknown>;
    if (sql.startsWith("SELECT owner_id,space_id"))
      return { rows: state.project ? [state.project] : [] };
    if (sql.startsWith("SELECT content FROM user_memories"))
      return { rows: [{ content: "Private note for " + args[0] }] };
    if (sql.startsWith("SELECT count(*) FROM user_memories"))
      return { rows: [{ count: state.count }] };
    return { rows: [], rowCount: 0 };
  };
  return { db: { query, connect: async () => ({ query, release() {} }) } };
});
import {
  buildUserContext,
  loadUserSettings,
  registerUserDataRoutes,
} from "./user-data.ts";
function app() {
  const app = new Hono<CloudEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "alice", name: "Alice", role: "member" });
    await next();
  });
  registerUserDataRoutes(app);
  return app;
}
beforeEach(() => {
  state.settings = null;
  state.project = null;
  state.count = 0;
  state.queries = [];
});
describe("cloud user data", () => {
  it("defaults new clients to sandbox auto-run and persists only editable settings per authenticated owner", async () => {
    expect(await loadUserSettings("alice")).toMatchObject({
      configured: false,
      requireApproval: false,
      memoryEnabled: true,
      networkPolicy: "ask",
    });
    const a = app();
    const save = await a.request("/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ networkPolicy: "blocked", memoryEnabled: false }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      configured: true,
      networkPolicy: "blocked",
      sandbox: "container",
    });
    expect(await loadUserSettings("alice")).toMatchObject({
      configured: true,
      memoryEnabled: false,
    });
    expect(
      state.queries.find((q) => q.sql.startsWith("INSERT INTO user_settings"))
        ?.args[0],
    ).toBe("alice");
    expect(
      (
        await a.request("/v1/settings", {
          method: "PUT",
          body: JSON.stringify({ sandbox: "host", owner_id: "bob" }),
        })
      ).status,
    ).toBe(400);
  });
  it("saves timezone and default run target, and renames only the signed-in account", async () => {
    const a = app();
    const save = await a.request("/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timezone: "Asia/Tokyo",
        defaultRunTarget: "local",
        displayName: "小猪",
      }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      timezone: "Asia/Tokyo",
      defaultRunTarget: "local",
      name: "小猪",
    });
    const rename = state.queries.find((q) => q.sql.startsWith("UPDATE principals"));
    expect(rename?.args).toEqual(["小猪", "alice"]);
    expect((await a.request("/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: "Not/AZone" }),
    })).status).toBe(400);
  });
  it("never includes private memory in collaborative projects or another owner personal project", async () => {
    expect(await buildUserContext("alice")).toContain("Private note for alice");
    state.project = { owner_id: "alice", space_id: "space-team" };
    expect(await buildUserContext("alice", "project-team")).toBe("");
    state.project = { owner_id: "bob", space_id: null };
    expect(await buildUserContext("alice", "project-bob")).toBe("");
    state.project = { owner_id: "alice", space_id: null };
    expect(await buildUserContext("alice", "project-alice")).toContain(
      "Private note for alice",
    );
    state.settings = { memoryEnabled: false };
    expect(await buildUserContext("alice")).toBe("");
  });
  it("bounds memory capacity and deletes only current owner records", async () => {
    const a = app();
    state.count = 50;
    expect(
      (
        await a.request("/v1/memory", {
          method: "POST",
          body: JSON.stringify({ content: "note" }),
        })
      ).status,
    ).toBe(429);
    expect(
      state.queries.some((q) => q.sql.startsWith("INSERT INTO user_memories")),
    ).toBe(false);
    expect(
      (await a.request("/v1/memory/bob-secret", { method: "DELETE" })).status,
    ).toBe(404);
    const deletion = state.queries.find((q) =>
      q.sql.startsWith("DELETE FROM user_memories"),
    )!;
    expect(deletion.sql).toContain("owner_id=$2");
    expect(deletion.args).toEqual(["bob-secret", "alice"]);
  });
  it("search binds literal input and applies accessible-conversation predicates, not admin bypass", async () => {
    const a = app();
    expect((await a.request("/v1/search?q=%20")).status).toBe(400);
    expect((await a.request("/v1/search?q=secret%25")).status).toBe(200);
    const search = state.queries.find((q) =>
      q.sql.includes("WITH accessible"),
    )!;
    expect(search.args).toEqual(["alice", "secret%"]);
    expect(search.sql).toContain("project_access(c.project_id,$1,false)");
    expect(search.sql).toContain("c.owner_id=$1");
    expect(search.sql).not.toContain("secret%");
  });
});
