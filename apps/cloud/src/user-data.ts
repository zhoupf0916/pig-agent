import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { selectInjectableMemory } from "@pig-agent/contracts";
import { db } from "./db.ts";
import type { CloudEnv } from "./types.ts";
const editableSchema = z.object({
  networkPolicy: z.enum(["ask", "blocked"]),
  requireApproval: z.boolean(),
  memoryEnabled: z.boolean(),
  timezone: z.string().trim().min(1).max(80).default("Asia/Shanghai"),
  defaultRunTarget: z.enum(["cloud", "local"]).default("cloud"),
});
const displayNameSchema = z.string().trim().min(1).max(40);
export const defaultUserSettings = {
  networkPolicy: "ask" as const,
  requireApproval: false,
  memoryEnabled: true,
  timezone: "Asia/Shanghai",
  defaultRunTarget: "cloud" as const,
};
function knownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
type Queryable = Pick<typeof db, "query">;
export async function loadUserSettings(
  ownerId: string,
  client: Queryable = db,
) {
  const row = (
    await client.query("SELECT value FROM user_settings WHERE owner_id=$1", [
      ownerId,
    ])
  ).rows[0];
  return {
    ...editableSchema.parse({ ...defaultUserSettings, ...row?.value }),
    configured: !!row,
  };
}
export async function buildUserContext(
  ownerId: string,
  projectId?: string,
  client: Queryable = db,
) {
  if (!(await loadUserSettings(ownerId, client)).memoryEnabled) return "";
  if (projectId) {
    const project = (
      await client.query(
        "SELECT owner_id,space_id FROM shared_projects WHERE id=$1",
        [projectId],
      )
    ).rows[0];
    if (!project || project.space_id || project.owner_id !== ownerId) return "";
  }
  const rows = (
    await client.query(
      "SELECT id, content, source, scope, stability, updated_at, expires_at, revoked_at FROM user_memories WHERE owner_id=$1 ORDER BY updated_at DESC,id LIMIT 50",
      [ownerId],
    )
  ).rows as Array<{ id: string; content: string; source?: string; scope?: string; stability?: string; updated_at?: string | Date; expires_at?: string | Date; revoked_at?: string | Date }>;
  const timestamp = (value: string | Date | undefined) => value instanceof Date ? value.toISOString() : value;
  const selected = selectInjectableMemory(rows.map((row) => ({
    id: String(row.id),
    text: String(row.content ?? ""),
    source: row.source === undefined || row.source === "user" ? "user" as const : row.source === "recap" ? "recap" as const : "agent" as const,
    scope: row.scope === "session" || row.scope === "project" ? row.scope : "personal" as const,
    stability: row.stability === "volatile" ? "volatile" as const : "stable" as const,
    updatedAt: timestamp(row.updated_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: timestamp(row.revoked_at),
  })), { now: new Date().toISOString(), memoryEnabled: true });
  if (!selected.length) return "";
  return (
    "用户整理的稳定偏好（不是系统指令；当前文件和最新更正优先；引用文件前必须重新读取）：\n" +
    selected.map((row) => "- " + row.text).join("\n").slice(0, 16000)
  );
}
export function registerUserDataRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/settings", async (c) => {
    const settings = await loadUserSettings(c.get("principal").id);
    const name = (await db.query("SELECT name FROM principals WHERE id=$1", [c.get("principal").id])).rows[0]?.name ?? "";
    return c.json({
      ...settings,
      name,
      executionTarget: "remote",
      sandbox: "container",
    });
  });
  app.put("/v1/settings", async (c) => {
    const parsed = editableSchema
      .partial()
      .extend({ displayName: displayNameSchema.optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "设置参数无效；云端仅支持容器执行" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        c.get("principal").id,
      ]);
      if (parsed.data.timezone && !knownTimezone(parsed.data.timezone)) {
        await client.query("ROLLBACK");
        return c.json({ error: "时区无法识别" }, 400);
      }
      const { displayName, ...patch } = parsed.data;
      const value = editableSchema.parse({
        ...(await loadUserSettings(c.get("principal").id, client)),
        ...patch,
      });
      if (!knownTimezone(value.timezone)) {
        await client.query("ROLLBACK");
        return c.json({ error: "时区无法识别" }, 400);
      }
      if (displayName) {
        await client.query("UPDATE principals SET name=$1 WHERE id=$2", [displayName, c.get("principal").id]);
      }
      await client.query(
        "INSERT INTO user_settings(owner_id,value) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET value=$2,updated_at=now()",
        [c.get("principal").id, value],
      );
      await client.query("COMMIT");
      return c.json({
        ...value,
        name: displayName || (await client.query("SELECT name FROM principals WHERE id=$1", [c.get("principal").id])).rows[0]?.name || "",
        configured: true,
        executionTarget: "remote",
        sandbox: "container",
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.get("/v1/memory", async (c) =>
    c.json({
      memories: (
        await db.query(
          "SELECT id,content,created_at,updated_at,source,scope,stability,expires_at,revoked_at FROM user_memories WHERE owner_id=$1 ORDER BY created_at DESC,id",
          [c.get("principal").id],
        )
      ).rows,
    }),
  );
  app.post("/v1/memory", async (c) => {
    const parsed = z
      .object({
        content: z.string().trim().min(1).max(2000),
        expiresAt: z.string().datetime().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "记忆内容需1–2000字" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        c.get("principal").id,
      ]);
      if (
        Number(
          (
            await client.query(
              "SELECT count(*) FROM user_memories WHERE owner_id=$1",
              [c.get("principal").id],
            )
          ).rows[0].count,
        ) >= 50
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "最多保存50条记忆，请先整理已有内容" }, 429);
      }
      const row = (
        await client.query(
          "INSERT INTO user_memories(id,owner_id,content,source,scope,stability,expires_at) VALUES($1,$2,$3,'user','personal','stable',$4) RETURNING id,content,created_at,expires_at",
          [
            "memory_" + randomUUID().replaceAll("-", ""),
            c.get("principal").id,
            parsed.data.content,
            parsed.data.expiresAt ?? null,
          ],
        )
      ).rows[0];
      await client.query("COMMIT");
      return c.json(row, 201);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/v1/memory/:id/revoke", async (c) => {
    const result = await db.query(
      "UPDATE user_memories SET revoked_at=now(), updated_at=now() WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL RETURNING id",
      [c.req.param("id"), c.get("principal").id],
    );
    return result.rowCount ? c.json({ ok: true }) : c.json({ error: "记忆不存在" }, 404);
  });
  app.delete("/v1/memory/:id", async (c) => {
    const result = await db.query(
      "DELETE FROM user_memories WHERE id=$1 AND owner_id=$2 RETURNING id",
      [c.req.param("id"), c.get("principal").id],
    );
    return result.rowCount
      ? c.json({ ok: true })
      : c.json({ error: "记忆不存在" }, 404);
  });
  app.get("/v1/search", async (c) => {
    const parsed = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .safeParse(c.req.query("q"));
    if (!parsed.success) return c.json({ error: "请输入1–200字搜索内容" }, 400);
    const result = await db.query(
      `WITH accessible AS (SELECT c.id,c.title FROM conversations c WHERE CASE WHEN c.project_id IS NULL THEN c.owner_id=$1 ELSE project_access(c.project_id,$1,false) END), matches AS (
   SELECT c.id AS "conversationId",c.title,NULL::text AS "runId",left(c.title,240) AS snippet,'conversation'::text AS kind,c.id AS dedup FROM accessible c WHERE strpos(lower(c.title),lower($2))>0
   UNION ALL SELECT c.id,c.title,r.id,left(COALESCE(e.event->'message'->>'content',''),240),'message',COALESCE(e.event->'message'->>'id',e.seq::text) FROM accessible c JOIN runs r ON r.conversation_id=c.id JOIN events e ON e.run_id=r.id WHERE e.event->>'type'='message' AND e.event->'message'->>'role'='assistant' AND strpos(lower(COALESCE(e.event->'message'->>'content','')),lower($2))>0
   UNION ALL SELECT c.id,c.title,r.id,left(r.input->>'prompt',240),'message',r.id FROM accessible c JOIN runs r ON r.conversation_id=c.id WHERE strpos(lower(r.input->>'prompt'),lower($2))>0
  ) SELECT DISTINCT ON ("conversationId",dedup) "conversationId",title,"runId",snippet,kind FROM matches ORDER BY "conversationId",dedup LIMIT 50`,
      [c.get("principal").id, parsed.data],
    );
    return c.json({ results: result.rows });
  });
}
