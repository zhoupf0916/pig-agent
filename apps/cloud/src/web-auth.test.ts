import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({
  count: 0,
  queries: [] as string[],
  account: { id: "member1", role: "member", name: "Member" },
  valid: true,
  sessionHash: "",
  invite: vi.fn(),
}));
vi.mock("./db.ts", () => {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    state.queries.push(sql);
    if (sql.includes("webAuthRate"))
      return { rows: [{ count: ++state.count }], rowCount: 1 };
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
  it("shares throttling across app instances and allows logout even when login is throttled", async () => {
    state.count = 119;
    expect(
      (await request(app(), "/auth/web/login", { token: "x" })).status,
    ).toBe(200);
    const limited = await request(app(), "/auth/web/login", { token: "x" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const logout = await request(
      app(),
      "/auth/web/logout",
      {},
      { Cookie: "pig_web_session=opaque", Authorization: "Bearer preserve-me" },
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(state.queries.at(-1)).toContain("DELETE FROM auth_sessions");
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
