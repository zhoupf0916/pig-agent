import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
}));
vi.mock("./db.ts", () => ({
  db: {
    query: async (sql: string, args: unknown[] = []) => {
      const key = String(args[0]) + ":" + String(args[1]);
      if (sql.startsWith("INSERT INTO cloud_plugins")) {
        if (state.rows.has(key)) return { rows: [] };
        const row = {
          manifest: args[2],
          enabled: false,
          installed_at: new Date().toISOString(),
        };
        state.rows.set(key, row);
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT manifest"))
        return {
          rows: [...state.rows]
            .filter(([key]) => key.startsWith(String(args[0]) + ":"))
            .map(([, value]) => value),
        };
      if (sql.startsWith("UPDATE cloud_plugins")) {
        const row = state.rows.get(key);
        if (!row) return { rows: [] };
        row.enabled = args[2];
        return { rows: [row] };
      }
      if (sql.startsWith("DELETE FROM cloud_plugins")) {
        const row = state.rows.get(key);
        if (!row || row.enabled) return { rows: [] };
        state.rows.delete(key);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  },
}));
import {
  registerEcosystemPluginRoutes,
  pluginCapabilities,
} from "./ecosystem-plugins.ts";
function app(owner: string) {
  const a = new Hono<CloudEnv>();
  a.use("*", async (c, next) => {
    c.set("principal", { id: owner, name: owner, role: "member" });
    await next();
  });
  registerEcosystemPluginRoutes(a);
  return a;
}
function send(a: Hono<CloudEnv>, path: string, method = "GET", body?: unknown) {
  return a.request("/v1/plugins" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeEach(() => state.rows.clear());
describe("cloud extension ownership and activation", () => {
  it("installs only in the caller account and never overwrites a duplicate installation", async () => {
    const a = app("alice"),
      b = app("bob");
    expect((await send(a, "/catalog/coding-quality", "POST")).status).toBe(201);
    expect(await (await send(b, "")).json()).toEqual({ plugins: [] });
    expect((await send(a, "/catalog/coding-quality", "POST")).status).toBe(409);
    expect(
      (await send(b, "/coding-quality", "PATCH", { enabled: true })).status,
    ).toBe(404);
    expect((await send(b, "/coding-quality", "DELETE")).status).toBe(404);
    expect(await pluginCapabilities("alice", "expert")).toEqual([]);
  });
  it("resolves namespaced experts and their skills only while the owner has enabled the plugin", async () => {
    const a = app("alice");
    await send(a, "/catalog/coding-quality", "POST");
    expect(
      (await send(a, "/coding-quality", "PATCH", { enabled: true })).status,
    ).toBe(200);
    expect(await pluginCapabilities("alice", "expert")).toEqual([
      expect.objectContaining({
        id: "plugin_coding-quality_quality-reviewer",
        skillIds: ["plugin_coding-quality_review-checklist"],
        bundled: true,
      }),
    ]);
    expect(await pluginCapabilities("bob", "skill")).toEqual([]);
    expect((await send(a, "/coding-quality", "DELETE")).status).toBe(409);
    await send(a, "/coding-quality", "PATCH", { enabled: false });
    expect(await pluginCapabilities("alice", "skill")).toEqual([]);
    expect((await send(a, "/coding-quality", "DELETE")).status).toBe(200);
    expect(await (await send(a, "")).json()).toEqual({ plugins: [] });
  });
  it("rejects foreign owner fields and unknown catalog entries", async () => {
    const a = app("alice");
    expect((await send(a, "/catalog/missing", "POST")).status).toBe(404);
    expect(
      (
        await send(a, "/coding-quality", "PATCH", {
          enabled: true,
          owner_id: "bob",
        })
      ).status,
    ).toBe(400);
  });
});
