import { cronToPlan, describePlan, localLeaseDecision, planToCron, type SchedulePlan, SchedulePlanError } from "@pig-agent/contracts";
import { executionPolicy } from "./execution-policy.ts";
import { loadUserSettings, buildUserContext } from "./user-data.ts";
import type { Hono } from "hono";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import type { CloudEnv } from "./types.ts";
import { InvalidScheduleError, missedFire, nextFire } from "./schedule-time.ts";

const planSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("hourly") }).strict(),
  z.object({ kind: z.literal("daily"), time: z.string() }).strict(),
  z.object({ kind: z.literal("weekdays"), time: z.string(), days: z.array(z.number().int().min(0).max(6)).max(7) }).strict(),
  z.object({ kind: z.literal("custom"), cron: z.string().max(80) }).strict(),
]);
const schema = z.object({
  requireApproval: z.boolean().optional(),
  networkPolicy: z.enum(["ask","blocked"]).optional(),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
  enabled: z.boolean().default(true),
  schedule: z.string().trim().max(80).nullable().optional(),
  plan: planSchema.optional(),
  timezone: z.string().min(1).max(80).default("Asia/Shanghai"),
  misfirePolicy: z.enum(["skip", "once"]).default("skip"),
  executionTarget: z.enum(["cloud", "local", "remote"]).optional().transform((value) => value === "remote" ? "cloud" as const : value),
  engine: z.literal("pig").optional(),
  runtime: z.enum(["cloud", "pig"]).optional(),
});
type Row = {
  id: string;
  owner_id: string;
  name: string;
  input: { prompt: string; messages: unknown[]; requireApproval?: boolean; networkPolicy?: "ask"|"blocked"; plan?: SchedulePlan; executionTarget?: "cloud" | "local" };
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
function compiledSchedule(input: { plan?: SchedulePlan; schedule?: string | null }): { cron: string | null; plan: SchedulePlan } {
  if (input.plan) return { cron: planToCron(input.plan), plan: input.plan };
  const cron = input.schedule ?? null;
  return { cron, plan: cronToPlan(cron) };
}
const view = (r: Row) => ({
  id: r.id,
  name: r.name,
  prompt: r.input.prompt,
  requireApproval: r.input.requireApproval ?? true,
  networkPolicy: r.input.networkPolicy ?? "ask",
  enabled: r.enabled,
  schedule: r.cron,
  plan: r.input.plan ?? cronToPlan(r.cron),
  scheduleLabel: describePlan(r.input.plan ?? cronToPlan(r.cron)),
  timezone: r.timezone,
  misfirePolicy: r.misfire,
  executionTarget: r.input.executionTarget === "local" ? "local" : "cloud",
  engine: "pig",
  runtime: r.input.executionTarget === "local" ? "pig" : "cloud",
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
  await c.query("SELECT pg_advisory_xact_lock(71839023)");
  const queue = (
    await c.query(
      "SELECT (SELECT count(*) FROM runs WHERE state='queued') >= COALESCE((SELECT (value->>'queueLimit')::int FROM platform_settings WHERE key='executionPolicy'),200) AS full",
    )
  ).rows[0];
  if (queue.full) return "全局等待队列已满，已跳过本次触发";
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
    [
      id,
      row.owner_id,
      {
        ...row.input,
        privateMemoryContext: await buildUserContext(
          row.owner_id,
          undefined,
          c,
        ),
      },
      key,
      row.id,
    ],
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
      const local = row.input.executionTarget === "local";
      const reason = missedFire(instant, now, row.misfire)
        ? "错过计划时间，按策略跳过"
        : local
          ? null
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
      } else if (local) {
        await c.query(
          "UPDATE schedule_firings SET outcome='waiting_device' WHERE schedule_id=$1 AND scheduled_at=$2",
          [row.id, instant],
        );
        await c.query("UPDATE schedules SET last_error=NULL WHERE id=$1", [row.id]);
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
    let compiled: { cron: string | null; plan: SchedulePlan };
    try {
      compiled = compiledSchedule(p);
      next = nextFire(compiled.cron, p.timezone, new Date());
    } catch (error) {
      const message = error instanceof SchedulePlanError || error instanceof InvalidScheduleError ? error.message : "执行计划或时区无效";
      return c.json({ error: message }, 400);
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
      const defaults = await loadUserSettings(c.get("principal").id, client);
      return (
        await client.query(
          "INSERT INTO schedules(id,owner_id,request_key,name,input,cron,timezone,enabled,misfire,next_fire_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            `ratm_${randomUUID().replaceAll("-", "")}`,
            c.get("principal").id,
            key,
            p.name,
            {
              prompt: p.prompt,
              messages: [],
              plan: compiled.plan,
              executionTarget: p.executionTarget ?? "cloud",
              ...executionPolicy(p,defaults),
            },
            compiled.cron,
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
      (p.requireApproval !== undefined && result.input.requireApproval !== p.requireApproval) ||
      (p.networkPolicy !== undefined && result.input.networkPolicy !== p.networkPolicy) ||
      result.cron !== compiled.cron ||
      (result.input.executionTarget ?? "cloud") !== (p.executionTarget ?? "cloud") ||
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
        const compiled = compiledSchedule({ plan: parsed.data.plan ?? p.plan, schedule: parsed.data.schedule ?? p.schedule });
        const changed =
          compiled.cron !== old.cron ||
          p.timezone !== old.timezone ||
          p.enabled !== old.enabled;
        const next = changed
          ? p.enabled
            ? nextFire(compiled.cron, p.timezone, new Date())
            : null
          : old.next_fire_at;
        nextFire(compiled.cron, p.timezone, new Date());
        return (
          await client.query(
            "UPDATE schedules SET name=$2,input=$3,cron=$4,timezone=$5,enabled=$6,misfire=$7,next_fire_at=$8,updated_at=now() WHERE id=$1 RETURNING *",
            [
              old.id,
              p.name,
              { ...old.input, prompt: p.prompt, plan: compiled.plan, executionTarget: parsed.data.executionTarget ?? (old.input.executionTarget === "local" ? "local" : "cloud"), requireApproval:p.requireApproval, networkPolicy:p.networkPolicy },
              compiled.cron,
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
      if (row.input.executionTarget === "local") {
        const requestKey = `manual:${key}`;
        const inserted = await client.query(
          "INSERT INTO schedule_firings(schedule_id,scheduled_at,outcome,request_key) VALUES($1,now(),'waiting_device',$2) ON CONFLICT (schedule_id, request_key) WHERE request_key IS NOT NULL DO NOTHING RETURNING scheduled_at",
          [row.id, requestKey],
        );
        if (!inserted.rowCount) {
          const existing = await client.query(
            "SELECT scheduled_at FROM schedule_firings WHERE schedule_id=$1 AND request_key=$2",
            [row.id, requestKey],
          );
          if (!existing.rowCount) return { error: "无法排队到设备", status: 409 as const };
        }
        await client.query("UPDATE schedules SET last_error=NULL,updated_at=now() WHERE id=$1", [row.id]);
        return { local: true as const };
      }
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
      : "local" in result
        ? c.json({ executionTarget: "local", accepted: true }, 202)
        : c.json({ remoteRunId: result.id }, 202);
  });
  app.get("/v1/schedule-deliveries", async (c) => {
    const rows = await db.query(
      "SELECT s.id,s.name,s.input->>'prompt' AS prompt,f.scheduled_at,f.outcome,f.device_id,f.lease_until FROM schedule_firings f JOIN schedules s ON s.id=f.schedule_id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND coalesce(s.input->>'executionTarget','cloud')='local' AND (f.outcome='waiting_device' OR (f.outcome='leased' AND f.lease_until<=now())) ORDER BY f.scheduled_at LIMIT 20",
      [c.get("principal").id],
    );
    return c.json({
      deliveries: rows.rows.map((row) => ({
        scheduleId: row.id,
        name: row.name,
        prompt: row.prompt,
        scheduledAt: row.scheduled_at,
      })),
    });
  });
  app.post("/v1/schedules/:id/claim-device", async (c) => {
    const body = z.object({ deviceId: z.string().trim().min(1).max(80), scheduledAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "时间无效") }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "设备领取参数无效" }, 400);
    const row = await transaction(c.get("principal").id, async (client) => {
      const firing = (await client.query(
        "SELECT f.outcome,f.device_id,f.lease_until,s.input->>'prompt' AS prompt,s.name FROM schedule_firings f JOIN schedules s ON s.id=f.schedule_id WHERE f.schedule_id=$1 AND s.owner_id=$2 AND s.deleted_at IS NULL AND f.scheduled_at=$3 FOR UPDATE OF f",
        [c.req.param("id"), c.get("principal").id, body.data.scheduledAt],
      )).rows[0];
      if (!firing) return null;
      const decision = localLeaseDecision({
        outcome: firing.outcome,
        deviceId: firing.device_id,
        leaseUntil: firing.lease_until ? new Date(firing.lease_until).getTime() : null,
        now: Date.now(),
        device: body.data.deviceId,
      });
      if (decision === "busy") return { busy: true as const };
      if (decision === "take") {
        await client.query(
          "UPDATE schedule_firings SET outcome='leased',device_id=$3,lease_until=now()+interval '2 minutes' WHERE schedule_id=$1 AND scheduled_at=$2",
          [c.req.param("id"), body.data.scheduledAt, body.data.deviceId],
        );
      }
      return { prompt: firing.prompt as string, name: firing.name as string };
    });
    if (!row) return c.json({ error: "没有可领取的执行" }, 404);
    if ("busy" in row) return c.json({ error: "已有其他设备在执行" }, 409);
    return c.json({ scheduleId: c.req.param("id"), prompt: row.prompt, name: row.name, scheduledAt: body.data.scheduledAt });
  });
  app.post("/v1/schedules/:id/device-result", async (c) => {
    const body = z.object({ deviceId: z.string().trim().min(1).max(80), scheduledAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "时间无效"), ok: z.boolean(), error: z.string().max(500).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "执行结果无效" }, 400);
    const updated = await db.query(
      "UPDATE schedule_firings f SET outcome=$4 FROM schedules s WHERE f.schedule_id=s.id AND f.schedule_id=$1 AND s.owner_id=$2 AND f.scheduled_at=$3 AND f.outcome='leased' AND f.device_id=$5 RETURNING f.schedule_id",
      [c.req.param("id"), c.get("principal").id, body.data.scheduledAt, body.data.ok ? "done" : (body.data.error || "设备执行失败"), body.data.deviceId],
    );
    if (!updated.rowCount) return c.json({ error: "执行结果无法记入" }, 409);
    if (!body.data.ok) await db.query("UPDATE schedules SET last_error=$2 WHERE id=$1 AND owner_id=$3", [c.req.param("id"), body.data.error || "设备执行失败", c.get("principal").id]);
    return c.json({ ok: true });
  });
}
