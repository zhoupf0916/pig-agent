import { describe, expect, it } from "vitest";
import { cacheable, cacheName, staleCaches, strategyFor } from "./sw-policy";

const origin = "https://pig.example";
const get = (path: string, mode = "cors") => ({ method: "GET", mode, url: origin + path });

describe("service worker caching policy", () => {
  it("caches the shell, hashed assets and icons", () => {
    expect(strategyFor(get("/", "navigate"), origin)).toBe("shell");
    expect(strategyFor(get("/?x=1", "navigate"), origin)).toBe("shell");
    expect(strategyFor(get("/assets/index-abc123.js"), origin)).toBe("asset");
    expect(strategyFor(get("/icons/icon-192.png"), origin)).toBe("static");
    expect(strategyFor(get("/manifest.webmanifest"), origin)).toBe("static");
  });
  it("never caches API, auth, admin, streaming or the worker script itself", () => {
    for (const path of [
      "/v1/conversations",
      "/v1/conversations/c1/events?after=0",
      "/v1/attachments/a1",
      "/auth/web/login",
      "/internal/mcp/tools",
      "/admin/",
      "/admin/app.js",
      "/api/deployment",
      "/api-docs",
      "/debug/runs",
      "/openapi.json",
      "/health",
      "/.well-known/agent-card.json",
      "/sw.js",
    ])
      expect(strategyFor(get(path), origin), path).toBe("bypass");
    expect(strategyFor(get("/debug/runs", "navigate"), origin)).toBe("bypass");
    expect(strategyFor(get("/admin/", "navigate"), origin)).toBe("bypass");
  });
  it("ignores writes and other origins", () => {
    expect(strategyFor({ method: "POST", mode: "cors", url: origin + "/assets/x.js" }, origin)).toBe("bypass");
    expect(strategyFor(get("/assets/x.js"), "https://other.example")).toBe("bypass");
    expect(strategyFor({ method: "GET", mode: "cors", url: "not a url" }, origin)).toBe("bypass");
  });
  it("cleans only its own caches from older builds", () => {
    expect(staleCaches(["pig-shell-old", cacheName("new"), "someone-else"], "new")).toEqual(["pig-shell-old"]);
  });
  it("stores only complete same-origin successes without no-store", () => {
    const headers = (value: string | null) => ({ get: () => value });
    expect(cacheable({ ok: true, status: 200, type: "basic", headers: headers(null) })).toBe(true);
    expect(cacheable({ ok: true, status: 206, type: "basic", headers: headers(null) })).toBe(false);
    expect(cacheable({ ok: true, status: 200, type: "opaque", headers: headers(null) })).toBe(false);
    expect(cacheable({ ok: true, status: 200, type: "basic", headers: headers("no-store") })).toBe(false);
    expect(cacheable({ ok: false, status: 500, type: "basic", headers: headers(null) })).toBe(false);
  });
});
