// U3 queue reliability: owner-first claim selection, side-effect-free retries with backoff, dead letters.
// The claim still runs under the short global claim lock (cluster.ts); this module makes each claim
// O(owners · log n) instead of sorting the whole queue, so the lock is held for a few milliseconds.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { PoolClient } from "pg";
import { db } from "./db.ts";
import type { CloudEnv } from "./types.ts";

/** Attempts (including the first) for runs that never started executing. */
export const MAX_PRESTART_ATTEMPTS = 3;
const BACKOFF_BASE_SECONDS = 10;
const BACKOFF_CAP_SECONDS = 300;

/** Exponential backoff with ±20 % jitter: 10 s, 20 s, 40 s … capped at 5 min. */
export function backoffSeconds(previousAttempts: number, random = Math.random) {
  const base = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, previousAttempts));
  return Math.round(base * (0.8 + random() * 0.4));
}
/** SQL twin of backoffSeconds over the row's attempt_count (old value inside UPDATE … SET). */
export const backoffSql = `now()+make_interval(secs=>least(${BACKOFF_CAP_SECONDS},${BACKOFF_BASE_SECONDS}*power(2,greatest(attempt_count,0)))*(0.8+random()*0.4))`;

export type ErrorClass = "prestart" | "worker_lost" | "interrupted" | "model_unavailable" | "task" | "cancelled";

/**
 * Classifies a failed execution. Only failures that provably happened before any tool could run are
 * retried automatically; anything that may have had side effects is failed and, if it is an
 * infrastructure problem rather than the task itself, dead-lettered for an operator.
 */
export function classifyFailure(input: { started: boolean; error?: string | null }): { errorClass: ErrorClass; retry: boolean; deadLetter: boolean } {
  if (!input.started) return { errorClass: "prestart", retry: true, deadLetter: true };
  const error = String(input.error || "");
  // An HTTP status only counts with HTTP/upstream context, so "超过 500 次调用" stays a task failure.
  const status = /(?:HTTP|status|状态码?|upstream|上游|returned|responded)\D{0,12}\b(?:429|5\d\d)\b|\((?:429|5\d\d)\)/i;
  if (status.test(error) || /rate.?limit|overloaded|Cannot reach LLM|模型网关暂时(无法|不可用)|模型服务暂时不可用|所有模型通道/i.test(error))
    return { errorClass: "model_unavailable", retry: false, deadLetter: true };
  return { errorClass: "task", retry: false, deadLetter: false };
}

export interface ClaimLimits {
  userConcurrency: number;
  projectConcurrency: number;
}
const ACTIVE = "state IN ('preparing','running','cancelling') AND lease_until>now()";

/**
 * Owners that have queued runs, are enabled and are under their concurrency limit, in fair order:
 * least recently served first, then by their oldest queued run. A recursive loose index scan over
 * runs_queued_owner finds distinct owners without reading every queued run.
 */
export const eligibleOwnersSql = `
WITH RECURSIVE owners(owner_id) AS (
  (SELECT owner_id FROM runs WHERE state='queued' ORDER BY owner_id LIMIT 1)
  UNION ALL
  SELECT (SELECT r.owner_id FROM runs r WHERE r.state='queued' AND r.owner_id>o.owner_id ORDER BY r.owner_id LIMIT 1)
  FROM owners o WHERE o.owner_id IS NOT NULL
)
SELECT o.owner_id FROM owners o
JOIN principals p ON p.id=o.owner_id AND p.enabled
LEFT JOIN dispatch_owners d ON d.owner_id=o.owner_id
WHERE o.owner_id IS NOT NULL
  AND (SELECT count(*) FROM runs a WHERE a.owner_id=o.owner_id AND a.${ACTIVE})<$1
ORDER BY d.last_claimed_at NULLS FIRST,
  (SELECT min(q.created_at) FROM runs q WHERE q.owner_id=o.owner_id AND q.state='queued'),
  o.owner_id
LIMIT $2`;

/** The owner's oldest claimable run (profile, project access and limit, retry delay), locked. */
export const ownerCandidateSql = `
SELECT r.id,r.execution_profile,r.owner_id,r.created_at FROM runs r
WHERE r.owner_id=$1 AND r.state='queued'
  AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now())
  AND r.execution_profile IN (SELECT jsonb_array_elements_text($2::jsonb))
  AND (r.project_id IS NULL OR (project_access(r.project_id,r.owner_id,true)
    AND (SELECT count(*) FROM runs a WHERE a.project_id=r.project_id AND a.${ACTIVE})<$3))
ORDER BY r.created_at,r.id
LIMIT 1 FOR UPDATE OF r SKIP LOCKED`;

/** Previous single-statement selection, kept behind QUEUE_CLAIM=legacy for instant rollback. */
export const legacyCandidateSql = `SELECT r.id,r.execution_profile,r.owner_id,r.created_at FROM runs r JOIN principals p ON p.id=r.owner_id LEFT JOIN dispatch_owners d ON d.owner_id=r.owner_id WHERE r.state='queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now()) AND p.enabled AND r.execution_profile IN (SELECT jsonb_array_elements_text($1::jsonb)) AND (r.project_id IS NULL OR project_access(r.project_id,r.owner_id,true)) AND (SELECT count(*) FROM runs a WHERE a.owner_id=r.owner_id AND a.${ACTIVE})<$2 AND (r.project_id IS NULL OR (SELECT count(*) FROM runs a WHERE a.project_id=r.project_id AND a.${ACTIVE})<$3) ORDER BY d.last_claimed_at NULLS FIRST,r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`;

export type Candidate = { id: string; execution_profile: string; owner_id: string; created_at: Date };

/** Owners inspected per claim; each step is an index probe, and the first claimable owner wins. */
const OWNER_SCAN = 256;

export function claimMode(env = process.env.QUEUE_CLAIM) {
  return env === "legacy" ? "legacy" : "fair";
}

export async function selectCandidate(client: PoolClient, profiles: unknown, limits: ClaimLimits, mode = claimMode()): Promise<Candidate | undefined> {
  const profileJson = JSON.stringify(profiles);
  if (mode === "legacy")
    return (await client.query(legacyCandidateSql, [profileJson, limits.userConcurrency, limits.projectConcurrency])).rows[0];
  // Named statements: each pooled connection plans these once.
  const owners = (await client.query({ name: "pig_claim_owners", text: eligibleOwnersSql, values: [limits.userConcurrency, OWNER_SCAN] })).rows as Array<{ owner_id: string }>;
  for (const { owner_id } of owners) {
    const candidate = (await client.query({ name: "pig_claim_owner_run", text: ownerCandidateSql, values: [owner_id, profileJson, limits.projectConcurrency] })).rows[0];
    if (candidate) return candidate;
  }
  return undefined;
}

// ---- admin: queue status, dead letters, replay ---------------------------------------------------------


const deadLetterWhere = "r.dead_lettered_at IS NOT NULL AND r.replayed_as IS NULL AND r.state='failed'";

export function registerQueueRoutes(app: Hono<CloudEnv>) {
  const admin = (c: { get(key: "principal"): { role: string } }) => c.get("principal").role === "admin";
  app.get("/v1/admin/queue", async (c) => {
    if (!admin(c)) return c.json({ error: "需要管理员权限" }, 403);
    const row = (
      await db.query(
        `SELECT count(*) FILTER (WHERE r.state='queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=now()))::int AS ready,
                count(*) FILTER (WHERE r.state='queued' AND r.next_attempt_at>now())::int AS delayed,
                count(*) FILTER (WHERE r.state IN ('preparing','running','cancelling'))::int AS active,
                count(*) FILTER (WHERE ${deadLetterWhere})::int AS dead_letters,
                coalesce(extract(epoch FROM now()-min(r.created_at) FILTER (WHERE r.state='queued')),0)::int AS oldest_queued_seconds
         FROM runs r WHERE r.state IN ('queued','preparing','running','cancelling') OR r.dead_lettered_at IS NOT NULL`,
      )
    ).rows[0];
    const classes = (
      await db.query(`SELECT r.last_error_class AS class,count(*)::int AS n FROM runs r WHERE ${deadLetterWhere} GROUP BY 1 ORDER BY 2 DESC`)
    ).rows;
    return c.json({ claimMode: claimMode(), ...row, deadLetterClasses: classes });
  });
  app.get("/v1/admin/queue/dead-letters", async (c) => {
    if (!admin(c)) return c.json({ error: "需要管理员权限" }, 403);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
    const rows = (
      await db.query(
        `SELECT r.id,r.owner_id,p.name AS owner_name,r.project_id,r.conversation_id,r.last_error_class,r.error,r.attempt_count,r.recovery_count,r.created_at,r.dead_lettered_at,left(r.input->>'prompt',120) AS prompt
         FROM runs r JOIN principals p ON p.id=r.owner_id WHERE ${deadLetterWhere} ORDER BY r.dead_lettered_at DESC LIMIT $1`,
        [limit],
      )
    ).rows;
    return c.json({ deadLetters: rows });
  });
  // Replay creates a new run from the same input (same conversation and owner); the original stays as an
  // auditable failed run and leaves the dead-letter list. Tools may run again, so this is an operator action.
  app.post("/v1/admin/queue/dead-letters/:id/replay", async (c) => {
    if (!admin(c)) return c.json({ error: "需要管理员权限" }, 403);
    const id = c.req.param("id");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const run = (
        await client.query(
          `SELECT r.id,r.owner_id,r.input,r.conversation_id,r.schedule_id FROM runs r JOIN principals p ON p.id=r.owner_id AND p.enabled WHERE r.id=$1 AND ${deadLetterWhere} FOR UPDATE OF r`,
          [id],
        )
      ).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return c.json({ error: "死信不存在、已重放或账号已停用" }, 404);
      }
      const next = "run_" + randomUUID().replaceAll("-", "");
      await client.query(
        "INSERT INTO runs(id,owner_id,input,conversation_id,parent_run_id,schedule_id) VALUES($1,$2,$3,$4,$5,$6)",
        [next, run.owner_id, run.input, run.conversation_id, run.id, run.schedule_id],
      );
      await client.query("UPDATE runs SET replayed_as=$2 WHERE id=$1", [run.id, next]);
      await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [c.get("principal").id, `queue:replay:${run.id}->${next}`]);
      await client.query("COMMIT");
      return c.json({ ok: true, id: next, replayOf: run.id }, 201);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
