import {
  defaultTariff,
  reserveCost,
  priceUsage,
  parseUsage,
} from "./billing.ts";
import { registerEcosystemPluginRoutes } from "./ecosystem-plugins.ts";
import { registerMcpRoutes } from "./mcp-servers.ts";
import {
  registerAttachmentRoutes,
  resolveAttachments,
  bindAttachments,
} from "./attachments.ts";
import { loadProjectFiles } from "./project-files.ts";
import { executionPolicy } from "./execution-policy.ts";
import {
  registerCapabilityRoutes,
  resolveCapabilityContext,
  resolveSkillSnapshots,
} from "./capabilities.ts";
import {
  registerUserDataRoutes,
  loadUserSettings,
  buildUserContext,
} from "./user-data.ts";
import {
  registerWebAuthRoutes,
  authenticateWebOrBearer,
  getRequestCredential,
} from "./web-auth.ts";
import { sharedProjectContext } from "./conversation-state.ts";
import { registerClusterRoutes, sweepRuns } from "./cluster.ts";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerResourceRoutes } from "./resources.ts";
import { registerPlatformRoutes, decryptSecret } from "./platform.ts";
import { registerConversationRoutes } from "./conversations.ts";
import { registerFileEditRoutes, loadFileOverrides } from "./file-edits.ts";
import { registerCollaborationRoutes } from "./collaboration.ts";
import { registerApprovalRoutes } from "./approvals.ts";
import {
  presentDebugTrace,
  closeTerminalDebugTrace,
  type DebugTraceView,
} from "@pig-agent/contracts";
import { inputSchema } from "./input.ts";
import { registerScheduleRoutes, tickSchedules } from "./schedules.ts";
import type { CloudEnv } from "./types.ts";
import { db, hash, migrate, terminal } from "./db.ts";
type Principal = { id: string; role: string; name: string };
const app = new Hono<CloudEnv>();
const credentialSchema = z.object({ token: z.string().min(1).max(200) });
const finishSchema = credentialSchema
  .extend({
    submissionId: z.string().uuid().optional(),
    kind: z.literal("result").optional(),
    ok: z.boolean(),
    error: z.string().max(5000).optional(),
    snapshot: z.unknown().optional(),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(4096),
          content: z.string().max(200000),
        }),
      )
      .max(100)
      .refine(
        (files) =>
          files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <=
          2 * 1024 * 1024,
      )
      .optional(),
  })
  .strict();
app.use("*", bodyLimit({ maxSize: 7 * 1024 * 1024 }));
app.onError((err, c) => {
  if ("code" in err && err.code === "P0429")
    return c.json({ error: "任务队列已满，请稍后再试" }, 429);
  if ("code" in err && err.code === "42501")
    return c.json({ error: "没有共享项目的编辑权限" }, 403);
  console.error(err.name);
  return c.json({ error: "服务请求失败，请查看节点日志" }, 500);
});
app.get("/health", async (c) => {
  await db.query("SELECT 1");
  return c.json({
    ok: true,
    modelMode: (await db.query("SELECT id FROM model_channels WHERE enabled"))
      .rowCount
      ? "provider"
      : process.env.MODEL_MODE || "mock",
  });
});
registerWebAuthRoutes(app);
app.use("/v1/*", authenticateWebOrBearer);
app.use("/internal/*", async (c, next) => {
  if (
    !process.env.WORKER_TOKEN ||
    c.req.header("Authorization") !== `Bearer ${process.env.WORKER_TOKEN}`
  )
    return c.json({ error: "Unauthorized" }, 401);
  await next();
});
async function runFor(id: string, p: Principal, writing = false) {
  return (
    await db.query(
      "SELECT id,project_id,conversation_id,parent_run_id,owner_id,state,error,created_at,updated_at,worker_id,model_calls,coalesce((input->>'requireApproval')::boolean,true) AS require_approval,coalesce(input->>'networkPolicy','ask') AS network_policy,'container' AS sandbox,CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,true) END AS can_write,input->>'prompt' AS prompt FROM runs WHERE id=$1 AND ($3 OR CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,$4) END)",
      [id, p.id, p.role === "admin", writing],
    )
  ).rows[0];
}
registerPlatformRoutes(app);
registerClusterRoutes(app);
registerResourceRoutes(app);
registerScheduleRoutes(app);
registerConversationRoutes(app);
registerFileEditRoutes(app);
registerCollaborationRoutes(app);
registerCapabilityRoutes(app);
registerEcosystemPluginRoutes(app);
registerMcpRoutes(app);
registerUserDataRoutes(app);
registerAttachmentRoutes(app);
registerApprovalRoutes(app, runFor);
app.get("/v1/me", (c) => c.json(c.get("principal")));
app.get("/v1/runs", async (c) =>
  c.json({
    runs: (
      await db.query(
        "SELECT id,project_id,state,error,created_at,updated_at,owner_id,model_calls,input->>'prompt' AS prompt FROM runs WHERE $2 OR CASE WHEN project_id IS NULL THEN owner_id=$1 ELSE project_access(project_id,$1,false) END ORDER BY created_at DESC LIMIT 100",
        [c.get("principal").id, c.get("principal").role === "admin"],
      )
    ).rows,
  }),
);
app.post("/v1/runs", async (c) => {
  const rawInput = await c.req.json().catch(() => null);
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success)
    return c.json({ error: "任务参数无效或超出大小限制" }, 400);
  if (parsed.data.workspace?.snapshot?.truncated)
    return c.json({ error: "工作区快照被截断，请缩小范围后提交" }, 400);
  const p = c.get("principal"),
    key = c.req.header("Idempotency-Key") || null;
  if (key && key.length > 120)
    return c.json({ error: "Invalid idempotency key" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      p.id,
    ]);
    if (
      parsed.data.projectId &&
      !(
        await client.query("SELECT project_access($1,$2,true) AS allowed", [
          parsed.data.projectId,
          p.id,
        ])
      ).rows[0].allowed
    ) {
      await client.query("ROLLBACK");
      return c.json({ error: "没有共享项目的编辑权限" }, 403);
    }
    if (key) {
      const old = await client.query(
        "SELECT id,state,input FROM runs WHERE owner_id=$1 AND request_key=$2",
        [p.id, key],
      );
      if (old.rowCount) {
        await client.query("COMMIT");
        const {
          projectContext: _context,
          capabilityContext: _capabilities,
          privateMemoryContext: _memory,
          requestInput,
          ...originalInput
        } = old.rows[0].input;
        if (
          !isDeepStrictEqual(
            requestInput || { networkPolicy: "ask", ...originalInput },
            parsed.data,
          )
        )
          return c.json({ error: "请求标识已用于其他任务" }, 409);
        return c.json({ id: old.rows[0].id, status: old.rows[0].state });
      }
    }
    const active = await client.query(
      "SELECT count(*) FROM runs WHERE owner_id=$1 AND state IN ('queued','preparing','running','cancelling')",
      [p.id],
    );
    if (Number(active.rows[0].count) >= 5) {
      await client.query("ROLLBACK");
      return c.json({ error: "最多保留 5 个待执行或运行中的任务" }, 429);
    }
    const defaults = await loadUserSettings(p.id, client);
    const sharedProject = parsed.data.projectId
      ? Boolean(
          (
            await client.query(
              "SELECT space_id FROM shared_projects WHERE id=$1",
              [parsed.data.projectId],
            )
          ).rows[0]?.space_id,
        )
      : false;
    const effectiveInput = {
      ...parsed.data,
      ...executionPolicy(rawInput, defaults, { sharedProject }),
    };
    let capabilityContext: string;
    try {
      capabilityContext = await resolveCapabilityContext(
        p.id,
        effectiveInput,
        client,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      return c.json({ error: (e as Error).message }, 400);
    }
    const privateMemoryContext = await buildUserContext(
      p.id,
      effectiveInput.projectId,
      client,
    );
    const id = "run_" + randomUUID().replaceAll("-", "");
    let attachments;
    try {
      attachments = await resolveAttachments(
        p.id,
        parsed.data.attachmentIds,
        client,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      return c.json({ error: (error as Error).message }, 400);
    }
    const conversationId = "conv_" + randomUUID().replaceAll("-", "");
    await client.query(
      "INSERT INTO conversations(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)",
      [
        conversationId,
        p.id,
        parsed.data.prompt.slice(0, 100),
        parsed.data.projectId || null,
      ],
    );
    await client.query(
      "INSERT INTO runs(id,owner_id,input,request_key,conversation_id) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        p.id,
        {
          ...effectiveInput,
          attachments,
          projectFiles: effectiveInput.workspace?.snapshot
            ? []
            : await loadProjectFiles(effectiveInput.projectId, p.id, client),
          requestInput: parsed.data,
          capabilityContext,
          skillSnapshots: await resolveSkillSnapshots(p.id, effectiveInput, client),
          fileOverrides: await loadFileOverrides(conversationId, client),
          privateMemoryContext,
          projectContext: await sharedProjectContext(
            parsed.data.projectId,
            p.id,
            client,
          ),
        },
        key,
        conversationId,
      ],
    );
    await client.query(
      "INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$3)",
      [p.id, "create", id],
    );
    await bindAttachments(id, parsed.data.attachmentIds, client);
    await client.query("COMMIT");
    return c.json({ id, status: "queued", conversationId }, 201);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});
app.get("/v1/runs/:id", async (c) => {
  const r = await runFor(c.req.param("id"), c.get("principal"));
  return r ? c.json(r) : c.json({ error: "任务不存在" }, 404);
});
app.post("/v1/runs/:id/abort", async (c) => {
  const id = c.req.param("id"),
    p = c.get("principal");
  if (!(await runFor(id, p, true))) return c.json({ error: "Not found" }, 404);
  await db.query(
    "UPDATE runs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,updated_at=now() WHERE id=$1 AND state IN ('queued','preparing','running')",
    [id],
  );
  await db.query("INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$3)", [
    p.id,
    "cancel",
    id,
  ]);
  return c.json({ ok: true });
});
app.get("/v1/runs/:id/eventlog", async (c) => {
  if (!(await runFor(c.req.param("id"), c.get("principal"))))
    return c.json({ error: "Not found" }, 404);
  return c.json({
    events: (
      await db.query(
        "SELECT seq,event FROM (SELECT seq,event FROM events WHERE run_id=$1 ORDER BY seq DESC LIMIT 200) recent ORDER BY seq",
        [c.req.param("id")],
      )
    ).rows,
  });
});
app.get("/v1/runs/:id/debug", async (c) => {
  const id = c.req.param("id");
  const run = await runFor(id, c.get("principal"));
  if (!run) return c.json({ error: "任务不存在" }, 404);
  const row = (
    await db.query(
      "SELECT event->'trace' AS trace FROM events WHERE run_id=$1 AND event->>'type'='debug_trace' ORDER BY seq DESC LIMIT 1",
      [id],
    )
  ).rows[0] as { trace?: unknown } | undefined;
  const allowed =
    (
      await db.query(
        "SELECT coalesce((input->>'debugContent')::boolean, false) AS debug_content FROM runs WHERE id=$1",
        [id],
      )
    ).rows[0]?.debug_content === true;
  const empty: DebugTraceView = {
    sessionId: id,
    contentEnabled: false,
    spans: [],
    dropped: 0,
  };
  const trace = row?.trace;
  if (
    !trace ||
    typeof trace !== "object" ||
    !Array.isArray((trace as DebugTraceView).spans)
  )
    return c.json(empty);
  const view = trace as DebugTraceView;
  return c.json(
    presentDebugTrace(
      closeTerminalDebugTrace(
        {
          sessionId: view.sessionId || id,
          contentEnabled: view.contentEnabled === true,
          spans: view.spans,
          dropped: view.dropped ?? 0,
        },
        String(run.state),
      ),
      allowed,
    ),
  );
});
app.get("/v1/runs/:id/events", async (c) => {
  const id = c.req.param("id");
  if (!(await runFor(id, c.get("principal"))))
    return c.json({ error: "Not found" }, 404);
  let after = Number(
    c.req.query("after") || c.req.header("Last-Event-ID") || 0,
  );
  if (!Number.isSafeInteger(after) || after < 0)
    return c.json({ error: "Invalid cursor" }, 400);
  return streamSSE(c, async (stream) => {
    let lastActivity = Date.now();
    let lastHeartbeat = 0;
    while (!stream.aborted) {
      const credential = getRequestCredential(c);
      const fresh = (
        await db.query(
          credential.source === "cookie"
            ? "SELECT id,role,name FROM principals WHERE id=$1 AND enabled AND id IN (SELECT owner_id FROM auth_sessions WHERE token_hash=$2 AND expires_at>now())"
            : "SELECT id,role,name FROM principals WHERE id=$1 AND enabled AND (token_hash=$2 OR id IN (SELECT owner_id FROM auth_sessions WHERE token_hash=$2 AND expires_at>now()))",
          [c.get("principal").id, hash(credential.token)],
        )
      ).rows[0];
      if (!fresh || !(await runFor(id, fresh))) break;
      const rows = await db.query(
        "SELECT seq,event FROM events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 200",
        [id, after],
      );
      if (rows.rowCount) lastActivity = Date.now();
      for (const r of rows.rows) {
        await stream.writeSSE({
          id: String(r.seq),
          data: JSON.stringify(r.event),
        });
        after = Number(r.seq);
      }
      const r = (
        await db.query("SELECT state,error FROM runs WHERE id=$1", [id])
      ).rows[0];
      if (terminal(r.state) && rows.rowCount === 0) {
        if (r.state === "failed")
          await stream.writeSSE({
            data: JSON.stringify({
              type: "error",
              message: r.error || "容器执行失败",
            }),
          });
        await stream.writeSSE({
          data: JSON.stringify({
            type: "status",
            status: r.state === "failed" ? "error" : "idle",
          }),
        });
        break;
      }
      if (Date.now() - lastHeartbeat >= 10000) {
        await stream.writeSSE({ event: "heartbeat", data: "{}" });
        lastHeartbeat = Date.now();
      }
      // Drain catch-up pages immediately; keep active text responsive without
      // polling idle queues at token cadence. Durable sequence IDs remain authoritative.
      if ((rows.rowCount || 0) < 200)
        await stream.sleep(Date.now() - lastActivity < 2500 ? 100 : 700);
    }
  });
});
app.get("/v1/runs/:id/artifacts", async (c) => {
  if (!(await runFor(c.req.param("id"), c.get("principal"))))
    return c.json({ error: "Not found" }, 404);
  return c.json({
    artifacts: (
      await db.query(
        "SELECT id,path,length(content) AS size FROM artifacts WHERE run_id=$1",
        [c.req.param("id")],
      )
    ).rows,
  });
});
app.get("/v1/runs/:id/artifacts/:artifact", async (c) => {
  if (!(await runFor(c.req.param("id"), c.get("principal"))))
    return c.json({ error: "Not found" }, 404);
  const r = (
    await db.query(
      "SELECT path,content FROM artifacts WHERE run_id=$1 AND id=$2",
      [c.req.param("id"), c.req.param("artifact")],
    )
  ).rows[0];
  if (!r) return c.json({ error: "Not found" }, 404);
  c.header(
    "Content-Disposition",
    "attachment; filename*=UTF-8''" +
      encodeURIComponent(r.path.split("/").pop()),
  );
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(r.content, 200, {
    "Content-Type": "text/plain; charset=utf-8",
  });
});
app.get("/v1/admin/overview", async (c) => {
  if (c.get("principal").role !== "admin")
    return c.json({ error: "需要管理员权限" }, 403);
  return c.json({
    schedules: (
      await db.query(
        "SELECT id,owner_id,name,cron,timezone,enabled,next_fire_at,last_run_id,last_error FROM schedules WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100",
      )
    ).rows,
    workers: (
      await db.query(
        "SELECT id,seen_at,enabled,capacity,reported_capacity,instance_id,profiles,draining,last_claimed_at,(SELECT count(*)::int FROM runs WHERE worker_id=workers.id AND state IN ('preparing','running','cancelling') AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now())) AS active,seen_at>now()-interval '15 seconds' AS online FROM workers",
      )
    ).rows,
    counts: (
      await db.query("SELECT state,count(*)::int FROM runs GROUP BY state")
    ).rows,
    audit: (await db.query("SELECT * FROM audit ORDER BY id DESC LIMIT 50"))
      .rows,
    modelMode: (await db.query("SELECT id FROM model_channels WHERE enabled"))
      .rowCount
      ? "provider"
      : process.env.MODEL_MODE || "mock",
  });
});
app.patch("/v1/admin/workers/:id", async (c) => {
  const p = c.get("principal");
  if (p.role !== "admin") return c.json({ error: "需要管理员权限" }, 403);
  const parsed = z
    .object({
      enabled: z.boolean().optional(),
      capacity: z.number().int().min(1).max(16).optional(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "节点并发须为 1–16" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "UPDATE workers SET enabled=coalesce($2,enabled),capacity=coalesce($3,capacity) WHERE id=$1 RETURNING id,enabled,capacity",
      [c.req.param("id"), parsed.data.enabled, parsed.data.capacity],
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return c.json({ error: "节点不存在" }, 404);
    }
    await client.query("INSERT INTO audit(actor,action) VALUES($1,$2)", [
      p.id,
      `worker:${c.req.param("id")}:${JSON.stringify(parsed.data)}`,
    ]);
    await client.query("COMMIT");
    return c.json(r.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});
// Worker credentials never go to an execution container.
app.post("/internal/runs/:id/heartbeat", async (c) => {
  const parsed = credentialSchema
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid run credential" }, 400);
  const { token } = parsed.data;
  await db.query(
    "UPDATE workers SET seen_at=now() WHERE id=(SELECT worker_id FROM runs WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()))",
    [c.req.param("id"), hash(String(token))],
  );
  const r = await db.query(
    "UPDATE runs SET lease_until=least(now()+interval '20 seconds',coalesce(deadline_at,now()+interval '20 seconds')),updated_at=now() WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND state IN ('preparing','running','cancelling') RETURNING state,deadline_at",
    [c.req.param("id"), hash(String(token))],
  );
  return c.json({
    state: r.rows[0]?.state || "expired",
    deadlineAt: r.rows[0]?.deadline_at ?? null,
  });
});
app.post("/internal/runs/:id/start", async (c) => {
  const parsed = credentialSchema
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid run credential" }, 400);
  const { token } = parsed.data;
  const result = await db.query(
    "UPDATE runs SET state='running' WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND state IN ('preparing','running') AND (deadline_at IS NULL OR deadline_at>now()) RETURNING id",
    [c.req.param("id"), hash(String(token))],
  );
  return result.rowCount
    ? c.json({ ok: true })
    : c.json({ error: "Run credential expired or already started" }, 409);
});
app.post("/internal/runs/:id/finish", async (c) => {
  const parsed = finishSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: "Invalid execution result" }, 400);
  const body = parsed.data;
  const id = c.req.param("id");
  const tokenHash = hash(body.token);
  const payloadHash = hash(JSON.stringify(body));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Lock the run first, including terminal runs, so completion replay and cancellation serialize.
    await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [id]);
    const receipt = (
      await client.query("SELECT * FROM run_completions WHERE run_id=$1", [id])
    ).rows[0];
    if (receipt) {
      await client.query("ROLLBACK");
      return receipt.token_hash === tokenHash &&
        receipt.payload_hash === payloadHash &&
        receipt.submission_id === (body.submissionId || "legacy")
        ? c.json({ ok: true, state: receipt.state, replayed: true })
        : c.json({ error: "Completion conflicts with accepted result" }, 409);
    }
    const r = await client.query(
      "SELECT state,conversation_id,coalesce(lease_until<=now(),true) OR coalesce(deadline_at<=now(),false) AS expired FROM runs WHERE id=$1 AND attempt_token=$2 FOR UPDATE",
      [id, hash(String(body.token))],
    );
    if (!r.rowCount || terminal(r.rows[0].state) || r.rows[0].expired) {
      await client.query("ROLLBACK");
      return c.json({ error: "Lease expired" }, 409);
    }
    const checkpoint = inputSchema.shape.workspace.safeParse({
      snapshot: body.snapshot,
    });
    if (
      body.ok &&
      r.rows[0].conversation_id &&
      (!checkpoint.success ||
        !checkpoint.data?.snapshot ||
        checkpoint.data.snapshot.truncated)
    ) {
      body.ok = false;
      body.error =
        "工作区超出快照限制或检查点未保存；可下载已保存成果，不能无损继续下一轮";
    }
    const state =
      r.rows[0].state === "cancelling"
        ? "cancelled"
        : body.ok
          ? "succeeded"
          : "failed";
    await client.query(
      "UPDATE runs SET state=$2,error=$3,attempt_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [
        id,
        state,
        body.ok ? null : String(body.error || "容器执行失败").slice(0, 500),
      ],
    );
    const snapshot = inputSchema.shape.workspace.safeParse({
      snapshot: body.snapshot,
    });
    if (
      r.rows[0].conversation_id &&
      snapshot.success &&
      snapshot.data?.snapshot &&
      !snapshot.data.snapshot.truncated
    ) {
      await client.query(
        "INSERT INTO workspace_versions(run_id,conversation_id,snapshot) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, r.rows[0].conversation_id, snapshot.data.snapshot],
      );
      await client.query(
        "UPDATE conversations SET updated_at=now() WHERE id=$1",
        [r.rows[0].conversation_id],
      );
    }
    if (Array.isArray(body.files)) {
      for (const f of body.files.slice(0, 100)) {
        if (
          typeof f.path === "string" &&
          typeof f.content === "string" &&
          f.content.length <= 200000
        )
          await client.query("INSERT INTO artifacts VALUES($1,$2,$3,$4)", [
            randomUUID(),
            id,
            f.path,
            f.content,
          ]);
      }
    }
    await client.query(
      "INSERT INTO run_completions(run_id,submission_id,token_hash,payload_hash,state) VALUES($1,$2,$3,$4,$5)",
      [id, body.submissionId || "legacy", tokenHash, payloadHash, state],
    );
    await client.query("COMMIT");
    return c.json({ ok: true, state });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});
app.post("/internal/runs/:id/event", async (c) => {
  const parsed = credentialSchema
    .extend({
      event: z
        .object({ type: z.string().min(1) })
        .passthrough()
        .refine((e) => JSON.stringify(e).length <= 512000),
      eventId: z.string().min(1).max(160).optional(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid execution event" }, 400);
  const { token, event, eventId } = parsed.data;
  if (
    eventId !== undefined &&
    (typeof eventId !== "string" || !eventId.length || eventId.length > 160)
  )
    return c.json({ error: "Invalid event id" }, 400);
  const r = await db.query(
    "INSERT INTO events(run_id,event,event_id) SELECT id,$3,$4 FROM runs WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND state IN ('preparing','running') ON CONFLICT(run_id,event_id) WHERE event_id IS NOT NULL DO UPDATE SET event_id=EXCLUDED.event_id RETURNING seq",
    [c.req.param("id"), hash(String(token)), event, eventId || null],
  );
  return r.rowCount
    ? c.json({ ok: true, seq: r.rows[0].seq })
    : c.json({ error: "Run credential expired" }, 409);
});
app.post("/internal/authorize", async (c) => {
  const parsed = credentialSchema
    .extend({
      reserve: z.boolean().optional(),
      modelRequest: z.record(z.unknown()).optional(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid authorization" }, 400);
  const { token, reserve, modelRequest } = parsed.data;
  const r = await db.query(
    "SELECT id,input,model_calls FROM runs WHERE attempt_token=$1 AND state IN ('preparing','running') AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true))",
    [hash(String(token))],
  );
  if (!r.rowCount) return c.json({ error: "Run credential expired" }, 401);
  if (reserve) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const run = (
        await client.query("SELECT owner_id FROM runs WHERE id=$1", [
          r.rows[0].id,
        ])
      ).rows[0];
      const account = (
        await client.query(
          "SELECT enabled,daily_call_limit FROM principals WHERE id=$1 FOR UPDATE",
          [run.owner_id],
        )
      ).rows[0];
      const usage = (
        await client.query(
          "SELECT count(*) FROM model_usage WHERE owner_id=$1 AND created_at>=date_trunc('day',now())",
          [run.owner_id],
        )
      ).rows[0];
      if (!account.enabled || Number(usage.count) >= account.daily_call_limit) {
        await client.query("ROLLBACK");
        return c.json({ error: "账号已禁用或当日模型预算不足" }, 429);
      }
      const used = await client.query(
        "UPDATE runs SET model_calls=model_calls+1 WHERE id=$1 AND model_calls<24 AND attempt_token=$2 AND lease_until>now() AND (deadline_at IS NULL OR deadline_at>now()) AND state IN ('preparing','running') AND EXISTS(SELECT 1 FROM principals p WHERE p.id=runs.owner_id AND p.enabled) AND EXISTS(SELECT 1 FROM workers w WHERE w.id=runs.worker_id AND w.enabled) AND (project_id IS NULL OR project_access(project_id,owner_id,true)) RETURNING id",
        [r.rows[0].id, hash(String(token))],
      );
      if (!used.rowCount) {
        await client.query("ROLLBACK");
        return c.json({ error: "模型调用次数已达上限或运行已结束" }, 429);
      }
      const channel = (
        await client.query("SELECT * FROM model_channels WHERE enabled")
      ).rows[0];
      const tariff = channel?.tariff || defaultTariff;
      const amount =
        channel || process.env.MODEL_MODE === "provider"
          ? reserveCost(modelRequest || {}, 4096, tariff)
          : 0;
      let billingId;
      try {
        billingId = (
          await client.query("SELECT reserve_model_budget($1,$2,$3,$4) AS id", [
            run.owner_id,
            r.rows[0].id,
            amount,
            tariff,
          ])
        ).rows[0].id;
      } catch (error) {
        await client.query("ROLLBACK");
        if (String(error).includes("额度不足"))
          return c.json({ error: "模型额度不足，请联系管理员增加预算" }, 429);
        throw error;
      }
      const provider = channel
        ? {
            baseUrl: channel.base_url,
            model: channel.model,
            apiKey: decryptSecret(channel.secret),
          }
        : undefined;
      await client.query("COMMIT");
      return c.json({ id: r.rows[0].id, provider, billingId });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return c.json({ id: r.rows[0].id, input: r.rows[0].input });
});
// Trusted gateway only: settlement is idempotent, independent of run lease expiry.
app.post("/internal/model-settle", async (c) => {
  const body = await c.req.json();
  if (!/^\d+$/.test(String(body.billingId)))
    return c.json({ error: "Invalid billing id" }, 400);
  const usage = parseUsage(body.usage);
  if (!usage)
    return c.json({ error: "Missing usage; reservation retained" }, 400);
  const row = (
    await db.query("SELECT tariff FROM model_usage WHERE id=$1", [
      body.billingId,
    ])
  ).rows[0];
  if (!row?.tariff) return c.json({ error: "Unknown billing call" }, 404);
  await db.query(
    "UPDATE model_usage SET charged_micros=$2,token_usage=$3,settled_at=now() WHERE id=$1 AND settled_at IS NULL",
    [body.billingId, priceUsage(usage, row.tariff), usage],
  );
  return c.json({ ok: true });
});
app.get(
  "/admin/*",
  serveStatic({
    root: "/app/admin",
    rewriteRequestPath: (p) => p.replace(/^\/admin\/?/, "/") || "/index.html",
  }),
);
app.get("/assets/*", serveStatic({ root: "/app/web" }));
app.get("/debug/runs", serveStatic({ path: "/app/web/index.html" }));
app.get("/cloud", (c) => c.redirect("/debug/runs"));
app.get("/api/deployment", (c) => c.json({ surface: "cloud" }));
// The public browser surface has no local filesystem or local execution APIs.
app.all("/api/*", (c) => c.json({ error: "云端 Web 不提供本机执行接口" }, 404));
app.get("/", serveStatic({ path: "/app/web/index.html" }));
await migrate();
let scheduling = false;
const scheduleTimer = setInterval(async () => {
  if (scheduling) return;
  scheduling = true;
  try {
    await tickSchedules();
  } catch {
    console.error("Schedule tick unavailable");
  } finally {
    scheduling = false;
  }
}, 1000);
scheduleTimer.unref();
setInterval(
  () => void sweepRuns().catch(() => console.error("Lease sweep unavailable")),
  5000,
).unref();
serve({ fetch: app.fetch, port: 8890 });
