import type { Hono } from "hono";
import { z } from "zod";
import type { CloudEnv } from "./types.ts";
import { db } from "./db.ts";
export const profiles = {
  compact: { memoryMiB: 256, cpu: 0.5, pids: 64, timeoutSeconds: 120 },
  standard: { memoryMiB: 512, cpu: 1, pids: 128, timeoutSeconds: 240 },
  large: { memoryMiB: 1024, cpu: 2, pids: 256, timeoutSeconds: 600 },
} as const;
export function registerResourceRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/admin/resources", async (c) =>
    c.json({
      profiles,
      selected:
        (
          await db.query(
            "SELECT value FROM platform_settings WHERE key='executionProfile'",
          )
        ).rows[0]?.value || "standard",
      image: "pig-agent-runner:local",
    }),
  );
  app.put("/v1/admin/resources", async (c) => {
    const body = z
      .object({ profile: z.enum(["compact", "standard", "large"]) })
      .strict()
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "资源规格无效" }, 400);
    await db.query(
      "INSERT INTO platform_settings(key,value) VALUES('executionProfile',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(body.data.profile)],
    );
    await db.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
      c.get("principal").id,
      "execution-profile:" + body.data.profile,
    ]);
    return c.json({ ok: true });
  });
  app.get("/v1/runs/:id/attempts", async (c) => {
    const p = c.get("principal");
    const run = (
      await db.query(
        "SELECT id FROM runs WHERE id=$1 AND ($3 OR CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,false) END)",
        [c.req.param("id"), p.id, p.role === "admin"],
      )
    ).rows[0];
    if (!run) return c.json({ error: "任务不存在" }, 404);
    return c.json({
      attempts: (
        await db.query(
          `SELECT a.id,a.worker_id,a.resources,a.created_at,r.state,r.error,r.lease_until,r.updated_at FROM execution_attempts a JOIN runs r ON r.id=a.run_id WHERE a.run_id=$1 ORDER BY a.created_at`,
          [run.id],
        )
      ).rows,
    });
  });
}
