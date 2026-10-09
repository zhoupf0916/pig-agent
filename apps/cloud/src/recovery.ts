import { z } from "zod";
import type { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
import { db, hash } from "./db.ts";
import { inputSchema } from "./input.ts";
import { MAX_PRESTART_ATTEMPTS, backoffSql } from "./queue.ts";
import { queueDeadLetters, queueRetries } from "./observability.ts";
export function recoveryDisposition(r: { state: string; phase: string | null; recoveries: number; expiredDeadline: boolean }) {
  if (r.state === "cancelling") return "cancelled";
  return !r.expiredDeadline && r.phase === "safe" && r.recoveries < 2 ? "queued" : "failed";
}
// Requeue conditions, evaluated on the old row inside UPDATE … SET:
// - resume from a safe checkpoint (at most twice), or
// - the attempt never started (still preparing, no started_at): no tool can have run, so retry with backoff.
const RESUME = "checkpoint_phase='safe' AND checkpoint IS NOT NULL AND recovery_count<2";
const PRESTART = `state='preparing' AND started_at IS NULL AND attempt_count<${MAX_PRESTART_ATTEMPTS - 1}`;
const REQUEUE = `state!='cancelling' AND deadline_at>now() AND ((${RESUME}) OR (${PRESTART}))`;
/**
 * Atomic compare/update fences the expired attempt; original deadline and model quota survive.
 * Requeued runs wait an exponential backoff (next_attempt_at); interrupted runs that cannot be retried
 * safely fail and are dead-lettered for an operator. Callers append the WHERE condition.
 */
export const recoverInterruptedSql = `UPDATE runs SET
 state=CASE WHEN state='cancelling' THEN 'cancelled' WHEN ${REQUEUE} THEN 'queued' ELSE 'failed' END,
 error=CASE WHEN ${REQUEUE} THEN NULL WHEN state!='cancelling' AND started_at IS NULL THEN '执行节点多次未能启动任务，已转入死信，管理员可在后台重放' ELSE '执行中断；当前步骤结果可能不确定，请核验后重新提交（不自动重放工具或审批）' END,
 recovery_count=recovery_count+CASE WHEN ${REQUEUE} AND (${RESUME}) THEN 1 ELSE 0 END,
 attempt_count=attempt_count+CASE WHEN state!='cancelling' THEN 1 ELSE 0 END,
 next_attempt_at=CASE WHEN ${REQUEUE} THEN ${backoffSql} ELSE NULL END,
 last_error_class=CASE WHEN state='cancelling' THEN 'cancelled' WHEN started_at IS NULL THEN 'prestart' WHEN ${REQUEUE} THEN 'worker_lost' ELSE 'interrupted' END,
 dead_lettered_at=CASE WHEN state!='cancelling' AND NOT (${REQUEUE}) THEN now() ELSE dead_lettered_at END,
 attempt_token=NULL,lease_until=NULL,updated_at=now()
 WHERE state IN ('preparing','running','cancelling') AND `;
export const recoverReturning = " RETURNING state,last_error_class,dead_lettered_at IS NOT NULL AND state='failed' AS dead";

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ state: string; last_error_class: string; dead: boolean }> }> };
/** Runs recovery for `where` and records retry / dead-letter metrics. */
export async function recoverInterrupted(client: Queryable, where: string, params: unknown[] = []) {
  const { rows } = await client.query(recoverInterruptedSql + where + recoverReturning, params);
  for (const row of rows) {
    if (row.state === "queued") queueRetries.inc({ class: row.last_error_class });
    else if (row.dead) queueDeadLetters.inc({ class: row.last_error_class });
  }
  return rows;
}
const message = z.object({ id: z.string().max(120), role: z.enum(["user", "assistant", "tool"]), content: z.string().max(500000), createdAt: z.string().max(40),
  toolCallId: z.string().max(120).optional(), toolCalls: z.array(z.object({ id: z.string().max(120), name: z.string().max(160), arguments: z.string().max(200000) })).max(100).optional(),
  synthetic: z.enum(["context-compact", "attachment"]).optional(),
});
const checkpointSchema = z.object({ messages: z.array(message).max(4000), snapshot: inputSchema.shape.workspace.unwrap().shape.snapshot.unwrap().refine(s => !s.truncated, "Incomplete snapshot") });
export function registerRecoveryRoutes(app: Hono<CloudEnv>) {
  app.post("/internal/checkpoint", async c => {
    const parsed = z.discriminatedUnion("phase", [
      z.object({ token: z.string().min(1).max(200), phase: z.literal("unsafe") }).strict(),
      z.object({ token: z.string().min(1).max(200), phase: z.literal("safe"), checkpoint: checkpointSchema }).strict(),
    ]).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid or incomplete checkpoint" }, 400);
    const body = parsed.data;
    const result = await db.query(`UPDATE runs SET checkpoint_phase=$2,checkpoint=CASE WHEN $2='safe' THEN $3::jsonb ELSE checkpoint END WHERE attempt_token=$1 AND state IN ('running','preparing') AND lease_until>now() AND deadline_at>now() AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true)) RETURNING id`, [hash(body.token), body.phase, body.phase === "safe" ? JSON.stringify(body.checkpoint) : null]);
    return result.rowCount ? c.json({ ok: true }) : c.json({ error: "Attempt expired; execution must stop" }, 409);
  });
}
