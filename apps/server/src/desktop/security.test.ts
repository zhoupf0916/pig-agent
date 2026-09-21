import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { desktopAuth } from "./security.ts";
describe("desktop API boundary", () => {
  const app = new Hono();
  app.use("*", desktopAuth(Buffer.from("test-token")));
  app.get("*", (c) => c.json({ ok: true }));
  it("rejects unauthenticated local clients including static asset requests", async () => {
    for (const path of ["/api/settings", "/index.html"])
      expect((await app.request(path)).status).toBe(401);
    expect(
      (
        await app.request("/api/settings", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });
  it("accepts the desktop proxy and rejects foreign origins", async () => {
    const headers = { Authorization: "Bearer test-token" };
    const response = await app.request("/api/settings", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'self'",
    );
    expect(
      (
        await app.request("/api/settings", {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
});
