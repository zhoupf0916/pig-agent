import type { Hono } from "hono";
import { z } from "zod";
import { createMcpServer, deleteMcpServer, listMcpServers, testMcpServer, updateMcpServer } from "../store/mcp-servers.ts";

const fields = {
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(500),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(500).max(120_000),
  secret: z.string().max(4000),
  clearSecret: z.boolean(),
};

export function registerMcpRoutes(app: Hono) {
  app.get("/api/mcp/servers", async (c) => {
    try { return c.json({ servers: await listMcpServers() }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "MCP 配置无法读取" }, 500); }
  });
  app.post("/api/mcp/servers", async (c) => {
    const parsed = z.object({ name: fields.name, url: fields.url, enabled: fields.enabled.optional(), timeoutMs: fields.timeoutMs.optional(), secret: fields.secret.optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "请填写 MCP 名称、地址和超时" }, 400);
    try { return c.json({ servers: await createMcpServer(parsed.data) }, 201); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "MCP 服务保存失败" }, 400); }
  });
  app.patch("/api/mcp/servers/:id", async (c) => {
    const parsed = z.object({ name: fields.name.optional(), url: fields.url.optional(), enabled: fields.enabled.optional(), timeoutMs: fields.timeoutMs.optional(), secret: fields.secret.optional(), clearSecret: fields.clearSecret.optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "MCP 修改无效" }, 400);
    try { return c.json({ servers: await updateMcpServer(c.req.param("id"), parsed.data) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "MCP 修改失败" }, 400); }
  });
  app.delete("/api/mcp/servers/:id", async (c) => c.json({ servers: await deleteMcpServer(c.req.param("id")) }));
  app.post("/api/mcp/servers/:id/test", async (c) => {
    try { return c.json({ tools: await testMcpServer(c.req.param("id"), c.req.raw.signal) }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "MCP 连接失败" }, 400); }
  });
}
