import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { CloudEnv } from "./types.ts";
import { db, hash } from "./db.ts";
import { profiles } from "./resources.ts";
export const executionPolicySchema = z
  .object({
    globalConcurrency: z.number().int().min(1).max(128),
    userConcurrency: z.number().int().min(1).max(5),
    projectConcurrency: z.number().int().min(1).max(64),
    queueLimit: z.number().int().min(1).max(10000),
    queueTimeoutSeconds: z.number().int().min(30).max(86400),
  })
  .strict();
export const defaultExecutionPolicy = {
  globalConcurrency: 8,
  userConcurrency: 2,
  projectConcurrency: 4,
  queueLimit: 200,
  queueTimeoutSeconds: 3600,
};
export const workerIdentitySchema = z.object({
  workerId: z.string().min(1).max(100),
  instanceId: z.string().uuid(),
});
async function policy(client: PoolClient) {
  const result = await client.query(
    "SELECT value FROM platform_settings WHERE key='executionPolicy'",
  );
  return executionPolicySchema.parse(
    result.rows[0]?.value || defaultExecutionPolicy,
  );
}
const active =
  "state IN ('preparing','running','cancelling') AND lease_until>now()";
export async function sweepRuns() {
  await db.query(
    `UPDATE runs r SET state='failed',error='任务创建者已停用或失去共享项目执行权限',updated_at=now() WHERE state='queued' AND (NOT EXISTS(SELECT 1 FROM principals p WHERE p.id=r.owner_id AND p.enabled) OR (r.project_id IS NOT NULL AND NOT project_access(r.project_id,r.owner_id,true)))`,
  );
  await db.query(
    `UPDATE runs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'failed' END,error=CASE WHEN deadline_at<now() THEN '执行超时；请核验已有副作用后重新提交' ELSE '执行节点失联；为避免重复副作用，请核验后重新提交' END,attempt_token=NULL,lease_until=NULL,updated_at=now() WHERE state IN ('preparing','running','cancelling') AND (lease_until<now() OR deadline_at<now())`,
  );
  await db.query(
    `UPDATE runs SET state='failed',error='等待执行资源超时，请检查 Runner 容量后重试',updated_at=now() WHERE state='queued' AND created_at<now()-make_interval(secs=>COALESCE((SELECT (value->>'queueTimeoutSeconds')::int FROM platform_settings WHERE key='executionPolicy'),3600))`,
  );
}
export function registerClusterRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/admin/execution-policy", async (c) =>
    c.json(
      (
        await db.query(
          "SELECT value FROM platform_settings WHERE key='executionPolicy'",
        )
      ).rows[0]?.value || defaultExecutionPolicy,
    ),
  );
  app.put("/v1/admin/execution-policy", async (c) => {
    const parsed = executionPolicySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: "执行策略无效", details: parsed.error.flatten() },
        400,
      );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71839022)");
      await client.query("SELECT pg_advisory_xact_lock(71839023)");
      await client.query(
        "INSERT INTO platform_settings(key,value) VALUES('executionPolicy',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
        [JSON.stringify(parsed.data)],
      );
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
        c.get("principal").id,
        "execution-policy:" + JSON.stringify(parsed.data),
      ]);
      await client.query("COMMIT");
      return c.json(parsed.data);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/internal/workers/register", async (c) => {
    const parsed = workerIdentitySchema
      .extend({
        capacity: z.number().int().min(1).max(16),
        profiles: z
          .array(z.enum(["compact", "standard", "large"]))
          .min(1)
          .max(3),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Invalid worker registration" }, 400);
    const {
      workerId,
      instanceId,
      capacity,
      profiles: capabilities,
    } = parsed.data;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71839022)");
      const old = (
        await client.query(
          "SELECT instance_id FROM workers WHERE id=$1 FOR UPDATE",
          [workerId],
        )
      ).rows[0];
      if (old && old.instance_id !== instanceId)
        await client.query(
          `UPDATE runs SET state='failed',error='执行节点已重启；为避免重复副作用，请核验后重新提交',attempt_token=NULL,lease_until=NULL,updated_at=now() WHERE worker_id=$1 AND state IN ('preparing','running','cancelling')`,
          [workerId],
        );
      await client.query(
        `INSERT INTO workers(id,instance_id,reported_capacity,capacity,profiles) VALUES($1,$2,$3,$3,$4) ON CONFLICT(id) DO UPDATE SET instance_id=$2,reported_capacity=$3,profiles=$4,seen_at=now(),draining=false`,
        [workerId, instanceId, capacity, JSON.stringify(capabilities)],
      );
      await client.query("COMMIT");
      return c.json({ ok: true });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/internal/workers/heartbeat", async (c) => {
    const parsed = workerIdentitySchema
      .extend({ draining: z.boolean().optional() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid heartbeat" }, 400);
    const { workerId, instanceId, draining } = parsed.data;
    const result = await db.query(
      "UPDATE workers SET seen_at=now(),draining=coalesce($3,draining) WHERE id=$1 AND instance_id=$2 RETURNING enabled,capacity,reported_capacity,draining",
      [workerId, instanceId, draining],
    );
    return result.rowCount
      ? c.json(result.rows[0])
      : c.json({ error: "Worker generation expired" }, 409);
  });
  app.post("/internal/claim", async (c) => {
    const parsed = z
      .object({
        workerId: z.string().min(1).max(100),
        instanceId: z.string().uuid().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid worker" }, 400);
    const { workerId, instanceId } = parsed.data;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(71839022)");
      if (!instanceId)
        await client.query(
          "INSERT INTO workers(id) VALUES($1) ON CONFLICT(id) DO NOTHING",
          [workerId],
        );
      const worker = (
        await client.query("SELECT * FROM workers WHERE id=$1 FOR UPDATE", [
          workerId,
        ])
      ).rows[0];
      if (!worker || (worker.instance_id || undefined) !== instanceId) {
        await client.query("ROLLBACK");
        return c.json({ error: "Worker generation expired" }, 409);
      }
      await client.query("UPDATE workers SET seen_at=now() WHERE id=$1", [
        workerId,
      ]);
      const limits = await policy(client);
      const counts = (
        await client.query(
          `SELECT count(*)::int AS total,count(*) FILTER(WHERE worker_id=$1)::int AS worker FROM runs WHERE ${active}`,
          [workerId],
        )
      ).rows[0];
      if (
        !worker.enabled ||
        worker.draining ||
        counts.worker >= Math.min(worker.capacity, worker.reported_capacity) ||
        counts.total >= limits.globalConcurrency
      ) {
        await client.query("COMMIT");
        return c.json(null);
      }
      // The short, database-wide claim lock makes every aggregate limit authoritative across control instances.
      const candidate = (
        await client.query(
          `SELECT r.id,r.execution_profile,r.owner_id FROM runs r JOIN principals p ON p.id=r.owner_id LEFT JOIN dispatch_owners d ON d.owner_id=r.owner_id WHERE r.state='queued' AND p.enabled AND r.execution_profile IN (SELECT jsonb_array_elements_text($1::jsonb)) AND (r.project_id IS NULL OR project_access(r.project_id,r.owner_id,true)) AND (SELECT count(*) FROM runs a WHERE a.owner_id=r.owner_id AND a.${active})<$2 AND (r.project_id IS NULL OR (SELECT count(*) FROM runs a WHERE a.project_id=r.project_id AND a.${active})<$3) ORDER BY d.last_claimed_at NULLS FIRST,r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
          [
            JSON.stringify(worker.profiles),
            limits.userConcurrency,
            limits.projectConcurrency,
          ],
        )
      ).rows[0];
      if (!candidate) {
        await client.query("COMMIT");
        return c.json(null);
      }
      const resources =
        profiles[candidate.execution_profile as keyof typeof profiles] ||
        profiles.standard;
      const token = randomUUID() + randomUUID();
      await client.query(
        "UPDATE runs SET state='preparing',worker_id=$2,attempt_token=$3,lease_until=now()+interval '20 seconds',deadline_at=now()+make_interval(secs=>$4),updated_at=now() WHERE id=$1",
        [candidate.id, workerId, hash(token), resources.timeoutSeconds + 30],
      );
      await client.query(
        "INSERT INTO dispatch_owners(owner_id,last_claimed_at) VALUES($1,now()) ON CONFLICT(owner_id) DO UPDATE SET last_claimed_at=now()",
        [candidate.owner_id],
      );
      await client.query(
        "UPDATE workers SET last_claimed_at=now() WHERE id=$1",
        [workerId],
      );
      await client.query(
        "INSERT INTO execution_attempts(id,run_id,worker_id,resources) VALUES($1,$2,$3,$4)",
        [randomUUID(), candidate.id, workerId, resources],
      );
      await client.query("COMMIT");
      return c.json({ id: candidate.id, token, resources });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
}
