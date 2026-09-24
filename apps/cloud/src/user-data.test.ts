import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
const state = vi.hoisted(() => ({
  settings: null as Record<string, unknown> | null,
  project: null as { owner_id: string; space_id: string | null } | null,
  count: 0,
  memories: null as Array<Record<string, unknown>> | null,
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
    if (sql.startsWith("SELECT id, content, source"))
      return { rows: state.memories ?? [{ id: "m1", content: "Private note for " + args[0], source: "user", scope: "personal", stability: "stable" }] };
    if (sql.startsWith("SELECT id,content,") && sql.includes("FROM user_memories")) {
      const columns = sql.slice(7, sql.indexOf(" FROM")).split(",").map(v => v.trim());
      return { rows: (state.memories ?? []).filter(m => m.owner_id === args[0]).map(m => Object.fromEntries(columns.map(key => [key, m[key]]))) };
    }
    if (sql.startsWith("UPDATE user_memories SET revoked_at")) {
      const note = state.memories?.find(m => m.id === args[0] && m.owner_id === args[1] && !m.revoked_at);
      if (note) note.revoked_at = new Date().toISOString();
      return { rows: note ? [{ id: note.id }] : [], rowCount: note ? 1 : 0 };
    }
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
  state.memories = null;
  state.queries = [];
});
describe("cloud user data", () => {
  it("returns expiry and revocation metadata so users can inspect memory freshness", async () => {
    state.memories = [{ id: "m1", owner_id: "alice", content: "偏好", source: "user", scope: "personal", stability: "stable", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", expires_at: "2026-03-01T00:00:00Z", revoked_at: "2026-02-02T00:00:00Z" }];
    const response = await app().request("/v1/memory");
    expect(response.status).toBe(200);
    const result = await response.json() as { memories: Array<Record<string, unknown>> };
    expect(result.memories[0]).toMatchObject({ source: "user", scope: "personal", expires_at: "2026-03-01T00:00:00Z", revoked_at: "2026-02-02T00:00:00Z" });
  });
  it("revokes only the signed-in user's memory and excludes it from the next context", async () => {
    state.memories = [{ id: "own", owner_id: "alice", content: "撤回内容", source: "user", scope: "personal", stability: "stable" }, { id: "other", owner_id: "bob", content: "其他账号", source: "user" }];
    const a = app();
    expect((await a.request("/v1/memory/other/revoke", { method: "POST" })).status).toBe(404);
    expect(state.memories[1]?.revoked_at).toBeUndefined();
    expect((await a.request("/v1/memory/own/revoke", { method: "POST" })).status).toBe(200);
    expect(await buildUserContext("alice")).not.toContain("撤回内容");
  });
  it("does not reinterpret agent-generated memory as a user-confirmed preference", async () => {
    state.memories = [{ id: "auto", content: "未经确认的推断", source: "agent", scope: "personal", stability: "stable" }];
    expect(await buildUserContext("alice")).not.toContain("未经确认的推断");
  });
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
    state.settings = { memoryEnabled: true };
    state.memories = [
      { id: "old", content: "过期偏好", source: "user", scope: "personal", stability: "stable", expires_at: "2000-01-01T00:00:00.000Z" },
      { id: "gone", content: "已撤回偏好", source: "user", scope: "personal", stability: "stable", revoked_at: "2026-09-24T00:00:00.000Z" },
      { id: "bad", content: "坏日期", source: "user", scope: "personal", stability: "stable", expires_at: "invalid-date" },
    ];
    expect(await buildUserContext("alice")).toBe("");
    state.memories = null;
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
