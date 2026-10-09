import type { Hono } from "hono";
import { db } from "../db.ts";
import type { CloudEnv } from "../types.ts";
import { feishuStatus } from "./client-status.ts";
import { createBindCode, feishuEnabled } from "./service.ts";

export function registerFeishuRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/feishu", async (c) => {
    const p = c.get("principal");
    const bound = await db.query("SELECT created_at FROM feishu_bindings WHERE principal_id=$1", [p.id]);
    return c.json({
      enabled: feishuEnabled(),
      connected: feishuStatus.connected,
      botName: feishuStatus.botName ?? null,
      bound: !!bound.rowCount,
      boundAt: bound.rows[0]?.created_at ?? null,
      ...(p.role === "admin" ? { lastEventAt: feishuStatus.lastEventAt ?? null, lastError: feishuStatus.lastError ?? null } : {}),
    });
  });
  app.post("/v1/feishu/bind-code", async (c) => {
    if (!feishuEnabled()) return c.json({ error: "飞书机器人未启用" }, 404);
    return c.json(await createBindCode(c.get("principal").id), 201);
  });
  app.delete("/v1/feishu/binding", async (c) => {
    const p = c.get("principal");
    await db.query("DELETE FROM feishu_bindings WHERE principal_id=$1", [p.id]);
    await db.query("DELETE FROM feishu_chats WHERE principal_id=$1", [p.id]);
    return c.json({ ok: true });
  });
}
