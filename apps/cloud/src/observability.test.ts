import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({ firing: new Set<string>(), queries: [] as string[], locked: true }));
vi.mock("./db.ts", () => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push(sql);
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: state.locked }] };
    if (sql.startsWith("SELECT rule FROM alerts")) return { rows: [...state.firing].map((rule) => ({ rule })) };
    if (sql.startsWith("INSERT INTO alerts")) {
      const rule = String(params[0]);
      if (state.firing.has(rule)) return { rowCount: 0, rows: [] };
      state.firing.add(rule);
      return { rowCount: 1, rows: [{ id: 1 }] };
    }
    if (sql.startsWith("UPDATE alerts SET state='resolved'")) {
      const had = state.firing.delete(String(params[0]));
      return { rowCount: had ? 1 : 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  const db = { query, connect: async () => ({ query, release() {} }), totalCount: 0, idleCount: 0, waitingCount: 0 };
  return { db, POOL_MAX: 10 };
});

const { shouldRecord, registerObservabilityRoutes } = await import("./observability.ts");
const { evaluate, registerAlertRoutes } = await import("./alerts.ts");

describe("span sampling", () => {
  it("always keeps 5xx, never noise, sampled parents and slow non-streaming requests", () => {
    expect(shouldRecord({ route: "/internal/claim", status: 503, seconds: 0, sampledParent: false })).toBe(true);
    expect(shouldRecord({ route: "/internal/runs/:id/heartbeat", status: 200, seconds: 9, sampledParent: true })).toBe(false);
    expect(shouldRecord({ route: "/internal/runs/:id/finish", status: 200, seconds: 0.01, sampledParent: true })).toBe(true);
    expect(shouldRecord({ route: "/v1/runs", status: 200, seconds: 0.01, sampledParent: false })).toBe(false);
    expect(shouldRecord({ route: "/v1/runs", status: 200, seconds: 3, sampledParent: false })).toBe(true);
    expect(shouldRecord({ route: "/v1/runs/:id/events", status: 200, seconds: 60, sampledParent: false })).toBe(false);
  });
});

describe("admin routes", () => {
  it("require the admin role", async () => {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("principal", { id: "u1", role: c.req.header("x-role") ?? "member" }); await next(); });
    registerObservabilityRoutes(app, async () => undefined);
    registerAlertRoutes(app);
    for (const [method, path] of [["GET", "/v1/admin/metrics"], ["GET", "/v1/admin/traces"], ["GET", "/v1/admin/alerts"], ["POST", "/v1/admin/alerts/test"]] as const)
      expect((await app.request(path, { method })).status, path).toBe(403);
    const metrics = await app.request("/v1/admin/metrics", { headers: { "x-role": "admin" } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("# TYPE pig_http_requests_total counter");
    expect((await app.request("/v1/runs/run_x/trace")).status).toBe(404);
  });
});

describe("alert evaluation", () => {
  beforeEach(() => {
    state.firing.clear();
    state.queries.length = 0;
    state.locked = true;
  });
  const rule = (id: string, forS: number, firing: { value: boolean }) => ({ id, severity: "critical" as const, forS, description: id, check: async () => ({ firing: firing.value, value: 1, summary: id }) });

  it("fires after the hold time, announces to webhooks, then resolves", async () => {
    const cond = { value: true };
    const list = [rule("held", 60, cond)];
    expect(await evaluate(1_000_000, list)).toEqual([]);
    expect((await evaluate(1_030_000, list)).length).toBe(0);
    const fired = await evaluate(1_061_000, list);
    expect(fired.map((t) => [t.rule.id, t.state])).toEqual([["held", "firing"]]);
    expect(state.queries.some((q) => q.includes("pig_webhook_enqueue"))).toBe(true);
    expect(await evaluate(1_090_000, list)).toEqual([]);
    cond.value = false;
    expect((await evaluate(1_120_000, list)).map((t) => t.state)).toEqual(["resolved"]);
  });
  it("skips failing checks and does nothing without the lock", async () => {
    const broken = { id: "broken", severity: "warning" as const, forS: 0, description: "", check: async () => { throw new Error("db down"); } };
    expect(await evaluate(Date.now(), [broken])).toEqual([]);
    state.locked = false;
    expect(await evaluate(Date.now(), [rule("x", 0, { value: true })])).toEqual([]);
  });
});
