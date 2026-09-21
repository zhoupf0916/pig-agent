import type { Hono } from "hono";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import type { CloudEnv } from "./types.ts";
import { InvalidScheduleError, missedFire, nextFire } from "./schedule-time.ts";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
  enabled: z.boolean().default(true),
  schedule: z.string().trim().max(80).nullable().default(null),
  timezone: z.string().min(1).max(80).default("Asia/Shanghai"),
  misfirePolicy: z.enum(["skip", "once"]).default("skip"),
  executionTarget: z.literal("remote").optional(),
  engine: z.literal("pig").optional(),
  runtime: z.literal("cloud").optional(),
});
type Row = {
  id: string;
  owner_id: string;
  name: string;
  input: { prompt: string; messages: unknown[] };
  enabled: boolean;
  cron: string | null;
  timezone: string;
  misfire: string;
  next_fire_at: Date | null;
  last_run_id: string | null;
  last_run_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};
const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  prompt: r.input.prompt,
  enabled: r.enabled,
  schedule: r.cron,
  timezone: r.timezone,
  misfirePolicy: r.misfire,
  executionTarget: "remote",
  engine: "pig",
  runtime: "cloud",
  nextFireAt: r.next_fire_at?.toISOString(),
  lastRemoteRunId: r.last_run_id,
  lastRunAt: r.last_run_at?.toISOString(),
  lastError: r.last_error,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
async function transaction<T>(
  owner: string,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Same lock order as interactive run admission: quotas cannot be raced.
    await c.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [owner]);
    const result = await work(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function admission(c: PoolClient, row: Row): Promise<string | null> {
  const active = await c.query(
    "SELECT schedule_id FROM runs WHERE owner_id=$1 AND state IN ('queued','preparing','running','cancelling')",
    [row.owner_id],
  );
  if (active.rows.some((r) => r.schedule_id === row.id))
    return "上一轮尚未结束，已跳过本次触发";
  if (active.rowCount! >= 5) return "账号待执行任务已达上限，已跳过本次触发";
  return null;
}
async function enqueue(c: PoolClient, row: Row, key: string): Promise<string> {
  const id = `run_${randomUUID().replaceAll("-", "")}`;
  await c.query(
    "INSERT INTO runs(id,owner_id,input,request_key,schedule_id) VALUES($1,$2,$3,$4,$5)",
    [id, row.owner_id, row.input, key, row.id],
  );
  await c.query(
    "UPDATE schedules SET last_run_id=$2,last_run_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",
    [row.id, id],
  );
  await c.query("INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$3)", [
    row.owner_id,
    `schedule:${row.id}`,
    id,
  ]);
  return id;
}

/** Durable one-fire claim. Multiple schedulers serialize on owner then schedule. */
export async function tickSchedules(now = new Date()): Promise<void> {
  const due = await db.query(
    "SELECT id,owner_id FROM schedules WHERE enabled AND deleted_at IS NULL AND next_fire_at<=$1 ORDER BY next_fire_at LIMIT 100",
    [now],
  );
  for (const candidate of due.rows) {
    await transaction(candidate.owner_id, async (c) => {
      const row: Row | undefined = (
        await c.query(
          "SELECT * FROM schedules WHERE id=$1 AND enabled AND deleted_at IS NULL AND next_fire_at<=$2 FOR UPDATE",
          [candidate.id, now],
        )
      ).rows[0];
      if (!row?.next_fire_at) return;
      const instant = row.next_fire_at;
      const next = nextFire(row.cron, row.timezone, now);
      const claimed = await c.query(
        "INSERT INTO schedule_firings(schedule_id,scheduled_at,outcome) VALUES($1,$2,'claimed') ON CONFLICT DO NOTHING RETURNING schedule_id",
        [row.id, instant],
      );
      await c.query(
        "UPDATE schedules SET next_fire_at=$2,updated_at=now() WHERE id=$1",
        [row.id, next],
      );
      if (!claimed.rowCount) return;
      const reason = missedFire(instant, now, row.misfire)
        ? "错过计划时间，按策略跳过"
        : await admission(c, row);
      if (reason) {
        await c.query("UPDATE schedules SET last_error=$2 WHERE id=$1", [
          row.id,
          reason,
        ]);
        await c.query(
          "UPDATE schedule_firings SET outcome=$3 WHERE schedule_id=$1 AND scheduled_at=$2",
          [row.id, instant, reason],
        );
      } else {
        const id = await enqueue(
          c,
          row,
          `schedule:${row.id}:${instant.toISOString()}`,
        );
        await c.query(
          "UPDATE schedule_firings SET outcome='queued',run_id=$3 WHERE schedule_id=$1 AND scheduled_at=$2",
          [row.id, instant, id],
        );
      }
    });
  }
}
export function registerScheduleRoutes(app: Hono<CloudEnv>): void {
  app.get("/v1/schedules", async (c) =>
    c.json({
      automations: (
        await db.query(
          "SELECT * FROM schedules WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC",
          [c.get("principal").id],
        )
      ).rows.map(view),
    }),
  );
  app.post("/v1/schedules", async (c) => {
    const parsed = schema
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json(
        {
          error:
            "远端计划参数无效，仅支持 Pig；本地项目和专家需先转为任务提示词",
        },
        400,
      );
    const p = parsed.data;
    let next: Date | null;
    try {
      next = nextFire(p.schedule, p.timezone, new Date());
    } catch {
      return c.json(
        { error: "cron 或时区无效（日期与星期不能同时限定）" },
        400,
      );
    }
    const key = c.req.header("Idempotency-Key");
    if (!key || key.length > 100)
      return c.json({ error: "需要有效的 Idempotency-Key" }, 400);
    const result = await transaction(c.get("principal").id, async (client) => {
      const old = (
        await client.query(
          "SELECT * FROM schedules WHERE owner_id=$1 AND request_key=$2",
          [c.get("principal").id, key],
        )
      ).rows[0];
      if (old) return old;
      const count = await client.query(
        "SELECT count(*) FROM schedules WHERE owner_id=$1 AND deleted_at IS NULL",
        [c.get("principal").id],
      );
      if (Number(count.rows[0].count) >= 100) return null;
      return (
        await client.query(
          "INSERT INTO schedules(id,owner_id,request_key,name,input,cron,timezone,enabled,misfire,next_fire_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            `ratm_${randomUUID().replaceAll("-", "")}`,
            c.get("principal").id,
            key,
            p.name,
            { prompt: p.prompt, messages: [] },
            p.schedule,
            p.timezone,
            p.enabled,
            p.misfirePolicy,
            p.enabled ? next : null,
          ],
        )
      ).rows[0];
    });
    if (!result) return c.json({ error: "最多保留 100 个远端计划" }, 429);
    if (
      result.deleted_at ||
      result.name !== p.name ||
      result.input.prompt !== p.prompt ||
      result.cron !== p.schedule ||
      result.timezone !== p.timezone ||
      result.misfire !== p.misfirePolicy ||
      result.enabled !== p.enabled
    )
      return c.json({ error: "请求标识已用于其他计划" }, 409);
    return c.json(view(result), 201);
  });
  app.get("/v1/schedules/:id", async (c) => {
    const row = (
      await db.query(
        "SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
        [c.req.param("id"), c.get("principal").id],
      )
    ).rows[0];
    return row ? c.json(view(row)) : c.json({ error: "计划不存在" }, 404);
  });
  app.patch("/v1/schedules/:id", async (c) => {
    const parsed = schema
      .partial()
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "计划参数无效" }, 400);
    try {
      const row = await transaction(c.get("principal").id, async (client) => {
        const old = (
          await client.query(
            "SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE",
            [c.req.param("id"), c.get("principal").id],
          )
        ).rows[0];
        if (!old) return null;
        const p = { ...view(old), ...parsed.data };
        const changed =
          p.schedule !== old.cron ||
          p.timezone !== old.timezone ||
          p.enabled !== old.enabled;
        const next = changed
          ? p.enabled
            ? nextFire(p.schedule, p.timezone, new Date())
            : null
          : old.next_fire_at;
        nextFire(p.schedule, p.timezone, new Date());
        return (
          await client.query(
            "UPDATE schedules SET name=$2,input=$3,cron=$4,timezone=$5,enabled=$6,misfire=$7,next_fire_at=$8,updated_at=now() WHERE id=$1 RETURNING *",
            [
              old.id,
              p.name,
              { ...old.input, prompt: p.prompt },
              p.schedule,
              p.timezone,
              p.enabled,
              p.misfirePolicy,
              next,
            ],
          )
        ).rows[0];
      });
      return row ? c.json(view(row)) : c.json({ error: "计划不存在" }, 404);
    } catch (e) {
      if (e instanceof InvalidScheduleError)
        return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.delete("/v1/schedules/:id", async (c) => {
    const row = await transaction(c.get("principal").id, (client) =>
      client.query(
        "UPDATE schedules SET deleted_at=now(),enabled=false,next_fire_at=NULL WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL RETURNING id",
        [c.req.param("id"), c.get("principal").id],
      ),
    );
    return row.rowCount
      ? c.json({ ok: true })
      : c.json({ error: "计划不存在" }, 404);
  });
  app.get("/v1/schedules/:id/history", async (c) => {
    const found = await db.query(
      "SELECT id FROM schedules WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
      [c.req.param("id"), c.get("principal").id],
    );
    if (!found.rowCount) return c.json({ error: "计划不存在" }, 404);
    return c.json({
      firings: (
        await db.query(
          "SELECT * FROM schedule_firings WHERE schedule_id=$1 ORDER BY scheduled_at DESC LIMIT 50",
          [c.req.param("id")],
        )
      ).rows,
      runs: (
        await db.query(
          "SELECT id,state,error,created_at,input->>'prompt' AS prompt,model_calls FROM runs WHERE schedule_id=$1 ORDER BY created_at DESC LIMIT 50",
          [c.req.param("id")],
        )
      ).rows,
    });
  });
  app.post("/v1/schedules/:id/run", async (c) => {
    const key = c.req.header("Idempotency-Key");
    if (!key || key.length > 100)
      return c.json({ error: "需要有效的 Idempotency-Key" }, 400);
    const result = await transaction(c.get("principal").id, async (client) => {
      const row = (
        await client.query(
          "SELECT * FROM schedules WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [c.req.param("id"), c.get("principal").id],
        )
      ).rows[0];
      if (!row) return { error: "计划不存在", status: 404 as const };
      const requestKey = `manual:${row.id}:${key}`;
      const old = (
        await client.query(
          "SELECT id FROM runs WHERE owner_id=$1 AND request_key=$2",
          [row.owner_id, requestKey],
        )
      ).rows[0];
      if (old) return { id: old.id };
      const reason = await admission(client, row);
      if (reason) return { error: reason, status: 409 as const };
      return { id: await enqueue(client, row, requestKey) };
    });
    return "error" in result
      ? c.json({ error: result.error }, result.status)
      : c.json({ remoteRunId: result.id }, 202);
  });
}
