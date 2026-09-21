import type { Hono } from "hono";
import { DEFAULT_SEARCH_LIMIT, searchLocal } from "../store/search.ts";

export function registerSearchRoutes(app: Hono): void {
  app.get("/api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const rawLimit = c.req.query("limit");
    let limit = DEFAULT_SEARCH_LIMIT;
    if (rawLimit !== undefined && rawLimit !== "") {
      const n = Number(rawLimit);
      if (Number.isFinite(n)) limit = n;
    }
    return c.json(await searchLocal(q, { limit }));
  });
}
