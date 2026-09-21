import type { Hono } from "hono";
import { planeFetch } from "../control-plane/client.ts";

/** Narrow same-origin bridge for the shared Web/Electron UI; no arbitrary URL proxy. */
export function registerRemoteRoutes(app: Hono): void {
  app.all("/api/remote/*", async (c) => {
    const path = c.req.path.slice("/api/remote".length);
    const allowed =
      (c.req.method === "GET" &&
        /^\/(health|v1\/runs(?:\/[a-zA-Z0-9_-]+(?:\/events|\/eventlog|\/artifacts(?:\/[a-zA-Z0-9_-]+)?)?)?|v1\/schedules\/[a-zA-Z0-9_-]+\/history)$/.test(
          path,
        )) ||
      (c.req.method === "POST" &&
        /^\/v1\/runs(?:\/[a-zA-Z0-9_-]+\/abort)?$/.test(path));
    if (!allowed)
      return c.json({ error: "Unsupported control-plane operation" }, 404);
    try {
      const headers: Record<string, string> = {};
      const key = c.req.header("Idempotency-Key");
      if (key) headers["Idempotency-Key"] = key;
      const after = c.req.query("after");
      const response = await planeFetch(
        path + (after ? `?after=${encodeURIComponent(after)}` : ""),
        {
          method: c.req.method,
          headers,
          body: c.req.method === "POST" ? await c.req.text() : undefined,
          // Dropping a stream only unsubscribes. Explicit POST abort cancels a run.
          signal: path.endsWith("/events") ? c.req.raw.signal : undefined,
        },
      );
      const outgoing = new Headers();
      for (const name of [
        "content-type",
        "content-disposition",
        "cache-control",
        "x-content-type-options",
      ])
        if (response.headers.has(name))
          outgoing.set(name, response.headers.get(name)!);
      return new Response(response.body, {
        status: response.status,
        headers: outgoing,
      });
    } catch {
      return c.json(
        {
          error:
            "无法连接控制面，请检查地址、令牌和服务状态；远端任务不会因此停止",
        },
        502,
      );
    }
  });
}
