import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerRemoteRoutes } from "./remote.ts";
import { loadSettings, saveSettings } from "../store/settings.ts";
afterEach(() => vi.unstubAllGlobals());
describe("remote auth HTTP bridge", () => {
  it("revokes late cloud login and never restores credentials after concurrent logout", async () => {
    await saveSettings({
      cloudBaseUrl: "http://127.0.0.1:8892",
      cloudToken: "old-session",
    });
    const app = new Hono();
    registerRemoteRoutes(app);
    let release!: (r: Response) => void, started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const delayed = new Promise<Response>((r) => (release = r));
    const revoked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/login")) {
          started();
          return delayed;
        }
        revoked.push(new Headers(init.headers).get("cookie") || "");
        return Response.json({ ok: true });
      }),
    );
    const login = app.request("/api/remote/auth/web/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "member", password: "test-password" }),
    });
    await ready;
    const logout = app.request("/api/remote/auth/web/logout", {
      method: "POST",
      body: "{}",
    });
    await new Promise((r) => setTimeout(r, 0));
    const opaque = "a".repeat(64);
    release(
      Response.json(
        { account: { id: "member" } },
        {
          headers: {
            "set-cookie": `pig_web_session=${opaque}; HttpOnly; SameSite=Strict`,
          },
        },
      ),
    );
    const response = await login;
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(opaque);
    expect((await logout).status).toBe(200);
    expect((await loadSettings()).cloudToken).toBe("");
    expect(revoked).toContain("pig_web_session=" + opaque);
    expect(revoked).toContain("pig_web_session=old-session");
  });
  it("clears local connection credentials even when control plane logout is offline", async () => {
    await saveSettings({
      cloudBaseUrl: "http://127.0.0.1:8892",
      cloudToken: "old-session",
    });
    const app = new Hono();
    registerRemoteRoutes(app);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Error("offline");
      }),
    );
    expect(
      (
        await app.request("/api/remote/auth/web/logout", {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(502);
    expect((await loadSettings()).cloudToken).toBe("");
  });
});
