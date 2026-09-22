import { networkRequestSchema } from "./network-fetch.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
import { db, hash } from "./db.ts";
type Access = (
  id: string,
  p: CloudEnv["Variables"]["principal"],
  writing?: boolean,
) => Promise<any>;
const schema = z
  .object({
    token: z.string().max(200),
    callId: z.string().min(1).max(200),
    tool: z.enum([
      "write_file",
      "edit_file",
      "apply_patch",
      "delete_file",
      "move_file",
      "run_shell",
      "http_fetch",
    ]),
    args: z
      .record(z.unknown())
      .refine((v) => JSON.stringify(v).length <= 64000),
  })
  .strict();
export function registerApprovalRoutes(app: Hono<CloudEnv>, access: Access) {
  app.get("/v1/runs/:id/approvals", async (c) => {
    if (!(await access(c.req.param("id"), c.get("principal"))))
      return c.json({ error: "任务不存在" }, 404);
    return c.json({
      approvals: (
        await db.query(
          "SELECT a.id,a.call_id,a.tool,a.args,CASE WHEN a.state='pending' AND (r.state NOT IN ('running','preparing') OR r.lease_until<=now() OR r.deadline_at<=now()) THEN 'expired' ELSE a.state END AS state,a.created_at,a.decided_at,a.decided_by FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.run_id=$1 ORDER BY a.created_at",
          [c.req.param("id")],
        )
      ).rows,
    });
  });
  app.post("/v1/runs/:id/approvals/:approval/decision", async (c) => {
    if (!(await access(c.req.param("id"), c.get("principal"), true)))
      return c.json({ error: "需要任务编辑权限" }, 403);
    const body = z
      .object({ decision: z.enum(["approve", "reject"]) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "审批决定无效" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const run = (
        await client.query(
          "SELECT state,coalesce(lease_until<=now(),true) OR coalesce(deadline_at<=now(),false) AS expired FROM runs WHERE id=$1 FOR UPDATE",
          [c.req.param("id")],
        )
      ).rows[0];
      if (
        !run ||
        !["running", "preparing"].includes(run.state) ||
        run.expired
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "运行已结束，不能再批准旧操作" }, 409);
      }
      const state = body.data.decision === "approve" ? "approved" : "rejected";
      const r = await client.query(
        "UPDATE approvals SET state=$3,decided_by=$4,decided_at=now() WHERE id=$1 AND run_id=$2 AND state='pending' RETURNING id,execution_remaining_ms",
        [
          c.req.param("approval"),
          c.req.param("id"),
          state,
          c.get("principal").id,
        ],
      );
      if (!r.rowCount) {
        await client.query("ROLLBACK");
        return c.json({ error: "审批已处理或不存在" }, 409);
      }
      if (r.rows[0].execution_remaining_ms != null) await client.query(
        "UPDATE runs SET deadline_at=now()+($2::double precision * interval '1 millisecond') WHERE id=$1",
        [c.req.param("id"), Number(r.rows[0].execution_remaining_ms)],
      );
      await client.query(
        "INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$3)",
        [
          c.get("principal").id,
          "approval:" + state + ":" + c.req.param("approval"),
          c.req.param("id"),
        ],
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
  app.post("/internal/approvals", async (c) => {
    const body = schema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "审批请求无效" }, 400);
    if (
      body.data.tool === "http_fetch" &&
      !networkRequestSchema.safeParse(body.data.args).success
    )
      return c.json({ error: "网络请求必须绑定有效 HTTPS GET 地址" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const run = (
        await client.query(
          "SELECT id,input FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true)) FOR UPDATE",
          [hash(body.data.token)],
        )
      ).rows[0];
      if (
        !run ||
        (body.data.tool === "http_fetch"
          ? run.input.networkPolicy === "blocked"
          : !run.input.requireApproval)
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "运行未获审批权限或已失效" }, 401);
      }
      const old = (
        await client.query(
          "SELECT * FROM approvals WHERE run_id=$1 AND call_id=$2",
          [run.id, body.data.callId],
        )
      ).rows[0];
      if (old) {
        await client.query("ROLLBACK");
        if (
          old.tool !== body.data.tool ||
          !isDeepStrictEqual(old.args, body.data.args)
        )
          return c.json({ error: "同一工具调用的参数已改变" }, 409);
        return c.json({ id: old.id, state: old.state });
      }
      const pending = await client.query("SELECT id FROM approvals WHERE run_id=$1 AND state='pending' LIMIT 1", [run.id]);
      if (pending.rowCount) {
        await client.query("ROLLBACK");
        return c.json({ error: "请先处理当前审批，一次只能审批一项。" }, 409);
      }
      const id = "approval_" + randomUUID().replaceAll("-", "");
      await client.query(
        "INSERT INTO approvals(id,run_id,call_id,tool,args) VALUES($1,$2,$3,$4,$5)",
        [id, run.id, body.data.callId, body.data.tool, body.data.args],
      );
      await client.query(
        "UPDATE approvals SET execution_remaining_ms=(SELECT greatest(1,ceil(extract(epoch FROM(deadline_at-now()))*1000))::bigint FROM runs WHERE id=$2) WHERE id=$1",
        [id, run.id],
      );
      // Pause the execution budget while preserving the same attempt and lease fences.
      await client.query("UPDATE runs SET deadline_at=now()+interval '30 minutes',lease_until=now()+interval '20 seconds' WHERE id=$1", [run.id]);
      await client.query(
        "INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$3)",
        [run.id, "approval:requested:" + id, run.id],
      );
      await client.query("COMMIT");
      return c.json({ id, state: "pending" }, 201);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/internal/approvals/:id/poll", async (c) => {
    const body = z
      .object({
        token: z.string().max(200),
        requestId: z.string().uuid().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "无效令牌" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const run = (
        await client.query(
          "SELECT id FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true)) FOR UPDATE",
          [hash(body.data.token)],
        )
      ).rows[0];
      if (!run) {
        await client.query("ROLLBACK");
        return c.json({ error: "运行已失效" }, 401);
      }
      const approval = (
        await client.query(
          "SELECT state,receipt_id,tool FROM approvals WHERE id=$1 AND run_id=$2 FOR UPDATE",
          [c.req.param("id"), run.id],
        )
      ).rows[0];
      if (!approval) {
        await client.query("ROLLBACK");
        return c.json({ error: "审批不存在" }, 404);
      }
      if (approval.state === "approved" && approval.tool !== "http_fetch")
        await client.query(
          "UPDATE approvals SET state='consumed',receipt_id=$2 WHERE id=$1",
          [c.req.param("id"), body.data.requestId || null],
        );
      await client.query("COMMIT");
      return c.json({
        state:
          approval.state === "consumed" &&
          body.data.requestId &&
          approval.receipt_id === body.data.requestId
            ? "approved"
            : approval.state,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
  app.post("/internal/network/claim", async (c) => {
    const body = z
      .object({
        token: z.string().max(200),
        callId: z.string().min(1).max(200),
        request: networkRequestSchema,
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "无效网络请求" }, 400);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const run = (
        await client.query(
          "SELECT id,input FROM runs WHERE attempt_token=$1 AND state='running' AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true)) FOR UPDATE",
          [hash(body.data.token)],
        )
      ).rows[0];
      if (!run || run.input.networkPolicy === "blocked") {
        await client.query("ROLLBACK");
        return c.json({ error: "运行未获网络权限或已失效" }, 403);
      }
      const approval = (
        await client.query(
          "SELECT id,state,args FROM approvals WHERE run_id=$1 AND call_id=$2 AND tool='http_fetch' FOR UPDATE",
          [run.id, body.data.callId],
        )
      ).rows[0];
      if (
        !approval ||
        approval.state !== "approved" ||
        !isDeepStrictEqual(approval.args, body.data.request)
      ) {
        await client.query("ROLLBACK");
        return c.json({ error: "单次网络授权不存在、已用完或地址不匹配" }, 403);
      }
      await client.query("UPDATE approvals SET state='consumed' WHERE id=$1", [
        approval.id,
      ]);
      await client.query(
        "INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$1)",
        [run.id, "network:get:" + approval.id],
      );
      await client.query("COMMIT");
      return c.json({ request: body.data.request });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
