import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({
  count: 0,
  buckets: new Map<string, number>(),
  queries: [] as string[],
  account: { id: "member1", role: "member", name: "Member" },
  valid: true,
  sessionHash: "",
  invite: vi.fn(),
}));
vi.mock("./db.ts", () => {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    state.queries.push(sql);
    if (sql.startsWith("INSERT INTO auth_rate_limits")) {
      const key = String(values?.[0]);
      const count = (state.buckets.get(key) ?? 0) + Number(values?.[2]);
      state.buckets.set(key, count);
      return { rows: [{ count }], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM auth_rate_limits WHERE bucket")) {
      state.buckets.delete(String(values?.[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id,role,name"))
      return {
        rows: state.valid ? [state.account] : [],
        rowCount: state.valid ? 1 : 0,
      };
    if (sql.startsWith("INSERT INTO auth_sessions"))
      state.sessionHash = String(values?.[2]);
    return { rows: [], rowCount: 0 };
  });
  return {
    hash: (v: string) => createHash("sha256").update(v).digest("hex"),
    db: { query, connect: async () => ({ query, release() {} }) },
  };
});
vi.mock("./platform.ts", () => ({ acceptInvitation: state.invite }));
import {
  authenticateWebOrBearer,
  getRequestCredential,
  registerWebAuthRoutes,
} from "./web-auth.ts";
import type { CloudEnv } from "./types.ts";
function app() {
  const app = new Hono<CloudEnv>();
  registerWebAuthRoutes(app);
  app.use("/v1/*", authenticateWebOrBearer);
  app.get("/v1/me", (c) => c.json(c.get("principal")));
  app.post("/v1/test", (c) => c.json(getRequestCredential(c)));
  return app;
}
const origin = "https://pig.example";
const request = (
  application: ReturnType<typeof app>,
  path: string,
  data: unknown,
  headers: Record<string, string> = {},
) =>
  application.request(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
beforeEach(() => {
  state.count = 0;
  state.buckets.clear();
  process.env.TRUST_PROXY_HEADER = "x-forwarded-for";
  state.queries = [];
  state.valid = true;
  state.sessionHash = "";
  state.invite.mockReset();
  delete process.env.WEB_PUBLIC_ORIGIN;
});
describe("cloud web authentication", () => {
  it("issues a distinct HttpOnly secure session without returning credentials", async () => {
    const response = await request(app(), "/auth/web/login", {
      token: "existing-token",
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=43200");
    const raw = cookie.match(/pig_web_session=([^;]+)/)![1]!;
    expect(raw).not.toBe("existing-token");
    expect(state.sessionHash).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect(await response.json()).toEqual({
      account: state.account,
      expiresInSeconds: 43200,
    });
  });
  it("rejects malformed JSON and invalid tokens without creating a session", async () => {
    const application = app();
    const malformed = await application.request(origin + "/auth/web/login", {
      method: "POST",
      headers: { Origin: origin },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    state.valid = false;
    expect(
      (await request(application, "/auth/web/login", { token: "bad" })).status,
    ).toBe(401);
    expect(state.sessionHash).toBe("");
    expect(state.queries).toContain("ROLLBACK");
  });
  it("requires same-origin cookie writes and rejects login CSRF while preserving bearer clients", async () => {
    const application = app();
    expect(
      (
        await request(
          application,
          "/auth/web/login",
          { token: "x" },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          application,
          "/v1/test",
          {},
          { Cookie: "pig_web_session=session", Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await application.request(origin + "/v1/test", {
          method: "POST",
          headers: { Cookie: "pig_web_session=session" },
        })
      ).status,
    ).toBe(403);
    const bearer = await application.request(origin + "/v1/test", {
      method: "POST",
      headers: {
        Authorization: "Bearer desktop",
        Cookie: "pig_web_session=session",
      },
    });
    expect(await bearer.json()).toEqual({ token: "desktop", source: "bearer" });
    expect(
      (
        await application.request(origin + "/v1/me", {
          headers: {
            Authorization: "Basic bad",
            Cookie: "pig_web_session=session",
          },
        })
      ).status,
    ).toBe(401);
  });
  it("uses session-only lookup for cookies and rejects disabled or expired credentials", async () => {
    const application = app();
    expect(
      (
        await application.request(origin + "/v1/me", {
          headers: { Cookie: "pig_web_session=session" },
        })
      ).status,
    ).toBe(200);
    const lookup = state.queries.find((q) =>
      q.startsWith("SELECT id,role,name"),
    )!;
    expect(lookup).not.toContain("token_hash=$1 OR");
    expect(lookup).toContain("enabled");
    expect(lookup).toContain("expires_at>now()");
    state.valid = false;
    expect(
      (
        await application.request(origin + "/v1/me", {
          headers: { Cookie: "pig_web_session=session" },
        })
      ).status,
    ).toBe(401);
  });
  it("throttles per client IP without locking out other clients, and still allows logout", async () => {
    const application = app();
    const from = (ip: string) => ({ "X-Forwarded-For": ip });
    for (let i = 0; i < 30; i++)
      expect((await request(application, "/auth/web/login", { token: "x" }, from("198.51.100.7"))).status).toBe(200);
    const limited = await request(application, "/auth/web/login", { token: "x" }, from("198.51.100.7"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await request(application, "/auth/web/login", { token: "x" }, from("203.0.113.9"))).status).toBe(200);
    const logout = await request(
      application,
      "/auth/web/logout",
      {},
      { ...from("198.51.100.7"), Cookie: "pig_web_session=opaque", Authorization: "Bearer preserve-me" },
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(state.queries.at(-1)).toContain("DELETE FROM auth_sessions");
  });
  it("regression: many distributed senders cannot exhaust a shared login budget", async () => {
    const application = app();
    state.valid = false;
    for (let i = 0; i < 300; i++)
      expect(
        (await request(application, "/auth/web/login", { token: "bad" }, { "X-Forwarded-For": `198.51.${i >> 8}.${i & 255}` })).status,
      ).toBe(401);
    state.valid = true;
    expect(
      (await request(application, "/auth/web/login", { token: "x" }, { "X-Forwarded-For": "203.0.113.50" })).status,
    ).toBe(200);
  });
  it("blocks repeated token failures from one IP", async () => {
    const application = app();
    state.valid = false;
    const ip = { "X-Forwarded-For": "198.51.100.20" };
    for (let i = 0; i < 10; i++)
      expect((await request(application, "/auth/web/login", { token: "bad" }, ip)).status).toBe(401);
    state.valid = true;
    const blocked = await request(application, "/auth/web/login", { token: "x" }, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
  });
  it("limits password failures per account+IP and per account, not per everyone", async () => {
    const application = app();
    const login = (ip: string, username = "alice") =>
      request(application, "/auth/web/login", { username, password: "wrong-password" }, { "X-Forwarded-For": ip });
    for (let i = 0; i < 5; i++) expect((await login("198.51.100.30")).status).toBe(401);
    expect((await login("198.51.100.30")).status).toBe(429);
    expect((await login("198.51.100.31")).status).toBe(401);
    expect((await login("198.51.100.30", "bob")).status).toBe(401);
    for (let i = 0; i < 44; i++) await login(`203.0.113.${i + 1}`);
    expect((await login("203.0.113.200")).status).toBe(429);
    expect((await login("203.0.113.200", "bob")).status).toBe(401);
  }, 30_000);
  it("ignores spoofable proxy headers unless explicitly trusted", async () => {
    delete process.env.TRUST_PROXY_HEADER;
    const application = app();
    for (let i = 0; i < 30; i++)
      await request(application, "/auth/web/login", { token: "x" }, { "X-Forwarded-For": `198.51.100.${i}` });
    expect(
      (await request(application, "/auth/web/login", { token: "x" }, { "X-Forwarded-For": "203.0.113.77" })).status,
    ).toBe(429);
  });
  it("accepts invites through the existing transaction helper with a 12-hour cookie", async () => {
    state.invite.mockResolvedValue({
      status: 201,
      token: "new-secret",
      account: { id: "member1", name: "Member" },
    });
    const response = await request(app(), "/auth/web/invite", {
      invite: "a".repeat(32),
    });
    expect(response.status).toBe(201);
    expect(state.invite).toHaveBeenCalledWith("a".repeat(32), 12);
    expect(JSON.stringify(await response.json())).not.toContain("new-secret");
    state.invite.mockResolvedValue({
      status: 401,
      error: "邀请已失效或已使用",
    });
    const repeated = await request(app(), "/auth/web/invite", {
      invite: "a".repeat(32),
    });
    expect(repeated.status).toBe(401);
    expect(repeated.headers.get("set-cookie")).toBeNull();
  });
  it("honors explicit public HTTPS origin and does not trust arbitrary forwarded headers", async () => {
    process.env.WEB_PUBLIC_ORIGIN = origin;
    const application = app();
    const response = await application.request(
      "http://internal:8890/auth/web/login",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token: "x" }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
    delete process.env.WEB_PUBLIC_ORIGIN;
    expect(
      (
        await application.request("http://internal:8890/auth/web/login", {
          method: "POST",
          headers: {
            Origin: origin,
            "X-Forwarded-Host": "pig.example",
            "X-Forwarded-Proto": "https",
          },
          body: JSON.stringify({ token: "x" }),
        })
      ).status,
    ).toBe(403);
  });
});
