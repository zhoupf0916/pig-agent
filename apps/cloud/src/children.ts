// F7 parallel subtasks (map-reduce). The parent calls spawn_parallel: the control plane records a child
// group, the parent saves a safe checkpoint and ends its attempt as 'waiting' (freeing its Runner slot),
// and children run as ordinary queued runs under the same owner, limits and budget. When every child is
// final, the results are appended to the parent's checkpoint as the tool result and the parent is
// requeued; it resumes from that checkpoint like a recovered run.
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db, hash } from "./db.ts";
import { checkSchema, extractJson, validate, type Schema } from "./json-schema-lite.ts";
import { profiles } from "./resources.ts";
import type { CloudEnv } from "./types.ts";

export const PARALLEL_TOOL = "spawn_parallel";
export const MAX_ITEMS = 20;
const MAX_ATTEMPTS = 2; // one automatic retry when the answer does not match the output schema
const GROUP_TIMEOUT_MINUTES = 30;
const ITEM_OUTPUT_CHARS = 1500;
const SUMMARY_CHARS = 24000;
const SNAPSHOT_SHARE_BYTES = 2 * 1024 * 1024;

export const spawnSchema = z
  .object({
    token: z.string().min(1).max(200),
    callId: z.string().min(1).max(120),
    items: z.array(z.string().trim().min(1).max(2000)).min(1).max(MAX_ITEMS),
    instruction: z.string().trim().min(1).max(4000),
    outputSchema: z.record(z.unknown()).optional(),
    maxParallel: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export function childPrompt(g: { instruction: string; output_schema: Schema | null }, item: string, index: number, total: number, feedback?: string) {
  const lines = [
    "[PARALLEL_CHILD] 你是并行子任务执行者，只负责下面这一项，独立完成后直接给出结果；不要询问用户，不要处理其他项。",
    `总任务说明：${g.instruction}`,
    `本项（第 ${index + 1}/${total} 项）：${item}`,
    g.output_schema
      ? `输出要求：最终回答只包含一个 JSON 值，必须符合以下 JSON Schema，不要输出任何其他文字：\n${JSON.stringify(g.output_schema)}`
      : "输出要求：用简洁的中文直接给出本项结果。",
  ];
  if (feedback) lines.push(`上一次的回答不符合要求（${feedback}），请修正后重新回答。`);
  return lines.join("\n");
}

/** The tool result injected into the parent: per-item outcome, truncated; full results go to an artifact. */
export function summarize(callId: string, items: Array<{ idx: number; item: string; state: string; output: unknown; output_text: string | null; error: string | null }>, note?: string) {
  const ok = items.filter((i) => i.state === "succeeded").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const cancelled = items.filter((i) => i.state === "cancelled").length;
  const head = `并行子任务完成：成功 ${ok}/${items.length}${failed ? `，失败 ${failed}` : ""}${cancelled ? `，取消 ${cancelled}` : ""}。${note ? note + "。" : ""}完整结果已保存为成果文件 parallel/${callId}.json。`;
  const parts = [head];
  let used = head.length;
  for (const i of items) {
    const body = i.state === "succeeded"
      ? (i.output !== null && i.output !== undefined ? JSON.stringify(i.output) : (i.output_text ?? "")).slice(0, ITEM_OUTPUT_CHARS)
      : `${i.state === "cancelled" ? "已取消" : "失败"}：${(i.error ?? "未知原因").slice(0, 300)}`;
    const line = `[${i.idx + 1}] ${i.item.slice(0, 200)} → ${body}`;
    if (used + line.length > SUMMARY_CHARS) { parts.push(`……其余 ${items.length - parts.length + 1} 项见成果文件`); break; }
    parts.push(line); used += line.length;
  }
  return parts.join("\n");
}

const readable = "($3 OR CASE WHEN r.project_id IS NULL THEN r.owner_id=$2 ELSE project_access(r.project_id,$2,false) END)";
const writable = "CASE WHEN r.project_id IS NULL THEN r.owner_id=$2 ELSE project_access(r.project_id,$2,true) END";

async function startChild(client: PoolClient, parent: { id: string; owner_id: string; input: Record<string, unknown>; checkpoint: { snapshot?: { byteSize?: number } } | null }, g: { call_id: string; instruction: string; output_schema: Schema | null }, child: { idx: number; item: string; attempts: number }, total: number, feedback?: string) {
  const id = "run_" + randomUUID().replaceAll("-", "");
  const snapshot = parent.checkpoint?.snapshot;
  const input = {
    prompt: childPrompt(g, child.item, child.idx, total, feedback),
    messages: [],
    requireApproval: false,
    networkPolicy: "blocked",
    projectId: parent.input.projectId,
    projectContext: parent.input.projectContext,
    capabilityContext: parent.input.capabilityContext,
    ...(snapshot && Number(snapshot.byteSize ?? Infinity) <= SNAPSHOT_SHARE_BYTES ? { workspace: { snapshot } } : {}),
    childOf: { parentRunId: parent.id, callId: g.call_id, index: child.idx },
  };
  await client.query("SAVEPOINT child");
  try {
    await client.query("INSERT INTO runs(id,owner_id,input) VALUES($1,$2,$3)", [id, parent.owner_id, input]);
  } catch (error) {
    // Queue full (P0429) or the owner lost access: leave the item pending, the reconciler retries.
    await client.query("ROLLBACK TO SAVEPOINT child");
    if (String((error as { code?: string }).code) === "P0429") return false;
    throw error;
  }
  await client.query("RELEASE SAVEPOINT child");
  await client.query(
    "UPDATE run_children SET child_run_id=$4,state='running',attempts=attempts+1,error=NULL,updated_at=now() WHERE parent_run_id=$1 AND call_id=$2 AND idx=$3",
    [parent.id, g.call_id, child.idx, id],
  );
  return true;
}

const cancelSql = "UPDATE runs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,updated_at=now() WHERE id=ANY($1::text[]) AND state IN ('queued','preparing','running')";

/** Advances one group: collects finished children, enforces budget/deadline, starts pending ones, resumes the parent. */
export async function advanceGroup(parentRunId: string, callId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const g = (await client.query("SELECT * FROM run_child_groups WHERE parent_run_id=$1 AND call_id=$2 FOR UPDATE", [parentRunId, callId])).rows[0];
    if (!g || g.state !== "running") { await client.query("COMMIT"); return "idle"; }
    const parent = (await client.query("SELECT id,owner_id,state,input,checkpoint,checkpoint_phase,execution_profile FROM runs WHERE id=$1 FOR UPDATE", [parentRunId])).rows[0];
    const children = (await client.query(
      "SELECT c.*,r.state AS run_state,r.error AS run_error,coalesce(r.model_calls,0) AS run_calls FROM run_children c LEFT JOIN runs r ON r.id=c.child_run_id WHERE c.parent_run_id=$1 AND c.call_id=$2 ORDER BY c.idx FOR UPDATE OF c",
      [parentRunId, callId],
    )).rows;
    const activeIds = () => children.filter((c) => c.state === "running").map((c) => c.child_run_id as string);
    if (!parent || ["succeeded", "failed", "cancelled"].includes(parent.state)) {
      await client.query(cancelSql, [activeIds()]);
      await client.query("UPDATE run_children SET state='cancelled',error='父任务已结束',updated_at=now() WHERE parent_run_id=$1 AND call_id=$2 AND state IN ('pending','running')", [parentRunId, callId]);
      await client.query("UPDATE run_child_groups SET state='cancelled',completed_at=now() WHERE parent_run_id=$1 AND call_id=$2", [parentRunId, callId]);
      await client.query("COMMIT");
      return "cancelled";
    }
    if (parent.state !== "waiting") { await client.query("COMMIT"); return "parent-running"; }
    const total = children.length;
    // 1. collect finished children
    for (const c of children.filter((c) => c.state === "running" && ["succeeded", "failed", "cancelled"].includes(c.run_state))) {
      let state = c.run_state === "succeeded" ? "succeeded" : c.run_state === "cancelled" ? "cancelled" : "failed";
      let error: string | null = state === "succeeded" ? null : String(c.run_error || "子任务失败").slice(0, 500);
      let output: unknown = null;
      const text = state === "succeeded"
        ? String((await client.query(
            "SELECT event->'message'->>'content' AS t FROM events WHERE run_id=$1 AND event->>'type'='message' AND event->'message'->>'role'='assistant' AND length(event->'message'->>'content')>0 ORDER BY seq DESC LIMIT 1",
            [c.child_run_id],
          )).rows[0]?.t ?? "")
        : null;
      if (state === "succeeded" && g.output_schema) {
        const parsed = extractJson(text ?? "");
        const errors = parsed.ok ? validate(g.output_schema, parsed.value) : [parsed.error];
        if (errors.length) {
          state = "failed";
          error = "输出不符合 JSON Schema：" + errors.slice(0, 3).join("；");
        } else output = parsed.ok ? parsed.value : null;
      }
      c.model_calls = Number(c.model_calls) + Number(c.run_calls);
      if (state === "failed" && error?.startsWith("输出不符合") && c.attempts < MAX_ATTEMPTS) {
        // One automatic retry with the validation errors as feedback.
        await client.query("UPDATE run_children SET model_calls=$4,updated_at=now() WHERE parent_run_id=$1 AND call_id=$2 AND idx=$3", [parentRunId, callId, c.idx, c.model_calls]);
        if (await startChild(client, parent, g, c, total, error)) { c.state = "running"; continue; }
      }
      await client.query(
        "UPDATE run_children SET state=$4,output=$5,output_text=$6,error=$7,model_calls=$8,updated_at=now() WHERE parent_run_id=$1 AND call_id=$2 AND idx=$3",
        [parentRunId, callId, c.idx, state, output === null ? null : JSON.stringify(output), text?.slice(0, 20000) ?? null, error, c.model_calls],
      );
      Object.assign(c, { state, output, output_text: text, error });
    }
    // 2. budget and deadline
    const spent = children.reduce((n, c) => n + Number(c.model_calls) + (c.state === "running" ? Number(c.run_calls) : 0), 0);
    const expired = new Date(g.deadline_at).getTime() <= Date.now();
    let note: string | undefined;
    if (spent >= g.max_model_calls || expired) {
      note = expired ? `已超过 ${GROUP_TIMEOUT_MINUTES} 分钟期限，未完成的子任务已取消` : `子任务模型调用达到上限 ${g.max_model_calls} 次，未完成的子任务已取消`;
      await client.query(cancelSql, [activeIds()]);
      for (const c of children.filter((c) => c.state === "pending" || c.state === "running")) {
        await client.query("UPDATE run_children SET state='cancelled',error=$4,updated_at=now() WHERE parent_run_id=$1 AND call_id=$2 AND idx=$3", [parentRunId, callId, c.idx, note]);
        Object.assign(c, { state: "cancelled", error: note });
      }
    }
    // 3. start pending children up to max_parallel
    let running = children.filter((c) => c.state === "running").length;
    for (const c of children.filter((c) => c.state === "pending")) {
      if (running >= g.max_parallel) break;
      if (!(await startChild(client, parent, g, c, total))) break;
      c.state = "running"; running++;
    }
    // 4. all final: resume the parent
    if (children.every((c) => ["succeeded", "failed", "cancelled"].includes(c.state))) {
      const summary = summarize(callId, children, note);
      const toolMessage = { id: "msg_" + randomUUID().replaceAll("-", ""), role: "tool", content: summary, toolCallId: callId, createdAt: new Date().toISOString() };
      const checkpoint = parent.checkpoint ?? { messages: [] };
      checkpoint.messages = [...(checkpoint.messages ?? []), toolMessage];
      const resources = profiles[parent.execution_profile as keyof typeof profiles] ?? profiles.standard;
      await client.query(
        "INSERT INTO artifacts(id,run_id,path,content) VALUES($1,$2,$3,$4)",
        [randomUUID(), parentRunId, `parallel/${callId}.json`, JSON.stringify(children.map((c) => ({ index: c.idx + 1, item: c.item, state: c.state, output: c.output ?? null, text: c.output ? undefined : c.output_text ?? undefined, error: c.error ?? undefined, attempts: c.attempts })), null, 2).slice(0, 200000)],
      );
      const ok = children.some((c) => c.state === "succeeded");
      for (const [suffix, event] of [
        ["end", { type: "tool_end", id: callId, name: PARALLEL_TOOL, ok, output: summary, durationMs: Date.now() - new Date(g.created_at).getTime() }],
        ["msg", { type: "message", message: { ...toolMessage, toolOk: ok } }],
      ] as const)
        await client.query("INSERT INTO events(run_id,event,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [parentRunId, event, `children:${callId}:${suffix}`]);
      await client.query(
        "UPDATE runs SET state='queued',checkpoint=$2,checkpoint_phase='safe',resumed_at=now(),next_attempt_at=NULL,deadline_at=now()+make_interval(secs=>$3),updated_at=now() WHERE id=$1",
        [parentRunId, checkpoint, resources.timeoutSeconds + 30],
      );
      await client.query("UPDATE run_child_groups SET state='completed',completed_at=now(),summary=$3 WHERE parent_run_id=$1 AND call_id=$2", [parentRunId, callId, summary]);
      await client.query("COMMIT");
      return "resumed";
    }
    await client.query("COMMIT");
    return "waiting";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Every open group; cheap (few open groups) and run every few seconds plus after child completions. */
export async function advanceOpenGroups() {
  const groups = (await db.query("SELECT parent_run_id,call_id FROM run_child_groups WHERE state='running' ORDER BY created_at LIMIT 50")).rows;
  for (const g of groups) await advanceGroup(g.parent_run_id, g.call_id).catch((error) => console.error("Parallel group advance failed", (error as Error).name));
}
/** After a child run finishes: advance its group right away. */
export async function advanceForChild(childRunId: string) {
  const g = (await db.query("SELECT parent_run_id,call_id FROM run_children WHERE child_run_id=$1", [childRunId])).rows[0];
  if (g) await advanceGroup(g.parent_run_id, g.call_id);
}

/**
 * Called from /finish when the runner reports { waiting: { callId } }: the parent must have saved a safe
 * checkpoint and registered this group. Moves the parent to 'waiting' (no completion receipt; the resumed
 * attempt completes the run) and starts the first children in the same transaction.
 */
export async function enterWaiting(client: PoolClient, runId: string, callId: string) {
  const parent = (await client.query("SELECT id,owner_id,input,checkpoint,checkpoint_phase FROM runs WHERE id=$1", [runId])).rows[0];
  const g = (await client.query("SELECT * FROM run_child_groups WHERE parent_run_id=$1 AND call_id=$2 AND state='running'", [runId, callId])).rows[0];
  if (!g || parent?.checkpoint_phase !== "safe" || !parent.checkpoint) return false;
  await client.query("UPDATE runs SET state='waiting',attempt_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [runId]);
  const children = (await client.query("SELECT idx,item,attempts FROM run_children WHERE parent_run_id=$1 AND call_id=$2 AND state='pending' ORDER BY idx LIMIT $3", [runId, callId, g.max_parallel])).rows;
  const total = (await client.query("SELECT count(*)::int n FROM run_children WHERE parent_run_id=$1 AND call_id=$2", [runId, callId])).rows[0].n;
  for (const c of children) if (!(await startChild(client, parent, g, c, total))) break;
  return true;
}

export function registerChildrenRoutes(app: Hono<CloudEnv>) {
  // Runner (through the gateway): register the group before yielding. Idempotent per (run, callId).
  app.post("/internal/children", async (c) => {
    const body = spawnSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "并行子任务参数无效：" + body.error.issues.map((i) => i.path.join(".") + " " + i.message).slice(0, 3).join("；") }, 400);
    const { token, callId, items, instruction, outputSchema, maxParallel } = body.data;
    const run = (await db.query("SELECT id,input FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now()", [hash(token)])).rows[0];
    if (!run) return c.json({ error: "运行已失效" }, 401);
    if (run.input?.childOf) return c.json({ error: "子任务不能再创建并行子任务" }, 400);
    if (outputSchema) {
      const problem = checkSchema(outputSchema);
      if (problem) return c.json({ error: "output_schema 无效：" + problem }, 400);
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query(
        "INSERT INTO run_child_groups(parent_run_id,call_id,instruction,output_schema,max_parallel,max_model_calls,deadline_at) VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(mins=>$7)) ON CONFLICT DO NOTHING",
        [run.id, callId, instruction, outputSchema ?? null, maxParallel ?? 3, Math.min(500, items.length * 12), GROUP_TIMEOUT_MINUTES],
      );
      if (created.rowCount)
        for (const [idx, item] of items.entries())
          await client.query("INSERT INTO run_children(parent_run_id,call_id,idx,item) VALUES($1,$2,$3,$4)", [run.id, callId, idx, item]);
      await client.query("COMMIT");
      return c.json({ ok: true, items: items.length, yield: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  app.get("/v1/runs/:id/children", async (c) => {
    const p = c.get("principal");
    const run = (await db.query(`SELECT r.id FROM runs r WHERE r.id=$1 AND ${readable}`, [c.req.param("id"), p.id, p.role === "admin"])).rows[0];
    if (!run) return c.json({ error: "Not found" }, 404);
    const groups = (await db.query("SELECT call_id,instruction,state,max_parallel,created_at,completed_at,deadline_at FROM run_child_groups WHERE parent_run_id=$1 ORDER BY created_at", [run.id])).rows;
    const items = (await db.query(
      "SELECT c.call_id,c.idx,c.item,c.state,c.attempts,c.child_run_id,c.error,c.model_calls,left(coalesce(c.output::text,c.output_text),300) AS preview,r.state AS run_state FROM run_children c LEFT JOIN runs r ON r.id=c.child_run_id WHERE c.parent_run_id=$1 ORDER BY c.call_id,c.idx",
      [run.id],
    )).rows;
    // Token usage of every child attempt (settled model calls), for cost and cache-hit visibility.
    const usage = (await db.query(
      `SELECT c.call_id,c.idx,coalesce(sum((u.token_usage->>'input')::bigint),0)::bigint AS input,coalesce(sum((u.token_usage->>'cached')::bigint),0)::bigint AS cached,coalesce(sum((u.token_usage->>'output')::bigint),0)::bigint AS output
       FROM run_children c JOIN runs r ON r.input->'childOf'->>'parentRunId'=c.parent_run_id AND r.input->'childOf'->>'callId'=c.call_id AND (r.input->'childOf'->>'index')::int=c.idx
       JOIN model_usage u ON u.run_id=r.id WHERE c.parent_run_id=$1 GROUP BY 1,2`,
      [run.id],
    )).rows;
    const tokens = (callId: string, idx?: number) => {
      const rows = usage.filter((u) => u.call_id === callId && (idx === undefined || u.idx === idx));
      return { input: rows.reduce((n, u) => n + Number(u.input), 0), cached: rows.reduce((n, u) => n + Number(u.cached), 0), output: rows.reduce((n, u) => n + Number(u.output), 0) };
    };
    return c.json({ groups: groups.map((g) => ({ ...g, tokens: tokens(g.call_id), items: items.filter((i) => i.call_id === g.call_id).map(({ call_id: _, ...i }) => ({ ...i, tokens: tokens(g.call_id, i.idx) })) })) });
  });
  // Retry one failed or cancelled item while the group is still open.
  app.post("/v1/runs/:id/children/:callId/:idx/retry", async (c) => {
    const p = c.get("principal");
    const run = (await db.query(`SELECT r.id FROM runs r WHERE r.id=$1 AND ${writable} AND r.state='waiting'`, [c.req.param("id"), p.id])).rows[0];
    if (!run) return c.json({ error: "只能在父任务等待子任务时重试" }, 409);
    const r = await db.query(
      "UPDATE run_children c SET state='pending',error=NULL,attempts=0,updated_at=now() FROM run_child_groups g WHERE g.parent_run_id=c.parent_run_id AND g.call_id=c.call_id AND g.state='running' AND c.parent_run_id=$1 AND c.call_id=$2 AND c.idx=$3 AND c.state IN ('failed','cancelled') RETURNING c.idx",
      [run.id, c.req.param("callId"), Number(c.req.param("idx"))],
    );
    if (!r.rowCount) return c.json({ error: "该子任务不能重试" }, 409);
    void advanceGroup(run.id, c.req.param("callId")).catch(() => {});
    return c.json({ ok: true });
  });
}
