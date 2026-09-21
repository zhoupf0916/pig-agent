import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, hash, migrate, terminal } from "./db.ts";
type Principal = { id: string; role: string; name: string };
const app = new Hono<{ Variables: { principal: Principal } }>();
app.use("*", bodyLimit({ maxSize: 7 * 1024 * 1024 }));
app.onError((err, c) => {
  console.error(err.name);
  return c.json({ error: "服务请求失败，请查看节点日志" }, 500);
});
app.get("/health", async (c) => {
  await db.query("SELECT 1");
  return c.json({ ok: true, modelMode: process.env.MODEL_MODE || "mock" });
});
app.use("/v1/*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  const found = await db.query(
    "SELECT id,role,name FROM principals WHERE token_hash=$1",
    [hash(token)],
  );
  if (!found.rowCount)
    return c.json({ error: "请填写有效的本地访问令牌" }, 401);
  c.set("principal", found.rows[0]);
  await next();
});
app.use("/internal/*", async (c, next) => {
  if (
    !process.env.WORKER_TOKEN ||
    c.req.header("Authorization") !== `Bearer ${process.env.WORKER_TOKEN}`
  )
    return c.json({ error: "Unauthorized" }, 401);
  await next();
});
const inputSchema = z.object({
  prompt: z.string().trim().min(1).max(32000),
  sessionId: z.string().max(100).optional(),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[^/\\]+$/)
          .refine(
            (p) =>
              !p.startsWith(".") &&
              !/[\x00-\x1f]/.test(p) &&
              !/^id_(rsa|dsa|ed25519)$/i.test(p) &&
              !/\.(pem|key|p12|pfx)$/i.test(p),
            "Sensitive filename",
          ),
        content: z.string().max(200000),
      }),
    )
    .max(20)
    .optional(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        content: z.string().max(80000),
        createdAt: z.string(),
      }),
    )
    .max(40)
    .default([]),
  model: z.string().max(100).optional(),
  workspace: z
    .object({
      snapshot: z
        .object({
          encoding: z.literal("tar.gz"),
          data: z.string().max(6 * 1024 * 1024),
          files: z.array(z.string()).max(400),
          skipped: z.array(z.string()).default([]),
          byteSize: z.number().max(4 * 1024 * 1024),
          truncated: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
async function runFor(id: string, p: Principal) {
  return (
    await db.query(
      "SELECT id,owner_id,state,error,created_at,updated_at,worker_id,model_calls,input->>'prompt' AS prompt FROM runs WHERE id=$1 AND (owner_id=$2 OR $3)",
      [id, p.id, p.role === "admin"],
    )
  ).rows[0];
}
app.get("/v1/me", (c) => c.json(c.get("principal")));
app.get("/v1/runs", async (c) =>
  c.json({
    runs: (
      await db.query(
        "SELECT id,state,error,created_at,updated_at,owner_id,model_calls,input->>'prompt' AS prompt FROM runs WHERE owner_id=$1 OR $2 ORDER BY created_at DESC LIMIT 100",
        [c.get("principal").id, c.get("principal").role === "admin"],
      )
    ).rows,
  }),
);
app.post("/v1/runs", async (c) => {
  const parsed = inputSchema.safeParse(await c.req.json());
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
    if (key) {
      const old = await client.query(
        "SELECT id,state,input FROM runs WHERE owner_id=$1 AND request_key=$2",
        [p.id, key],
      );
      if (old.rowCount) {
        await client.query("COMMIT");
        if (!isDeepStrictEqual(old.rows[0].input, parsed.data))
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
    const id = "run_" + randomUUID().replaceAll("-", "");
    await client.query(
      "INSERT INTO runs(id,owner_id,input,request_key) VALUES($1,$2,$3,$4)",
      [id, p.id, parsed.data, key],
    );
    await client.query(
      "INSERT INTO audit(actor,action,run_id) VALUES($1,$2,$3)",
      [p.id, "create", id],
    );
    await client.query("COMMIT");
    return c.json({ id, status: "queued" }, 201);
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
app.post("/v1/runs/:id/follow-ups", async (c) => {
  if (!(await runFor(c.req.param("id"), c.get("principal"))))
    return c.json({ error: "Not found" }, 404);
  return c.json({ error: "此版本使用新快照创建下一轮" }, 410);
});
app.post("/v1/runs/:id/abort", async (c) => {
  const id = c.req.param("id"),
    p = c.get("principal");
  if (!(await runFor(id, p))) return c.json({ error: "Not found" }, 404);
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
    while (!stream.aborted) {
      const rows = await db.query(
        "SELECT seq,event FROM events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT 200",
        [id, after],
      );
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
      await stream.writeSSE({ event: "heartbeat", data: "{}" });
      await stream.sleep(700);
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
    workers: (
      await db.query(
        "SELECT id,seen_at,seen_at>now()-interval '15 seconds' AS online FROM workers",
      )
    ).rows,
    counts: (
      await db.query("SELECT state,count(*)::int FROM runs GROUP BY state")
    ).rows,
    audit: (await db.query("SELECT * FROM audit ORDER BY id DESC LIMIT 50"))
      .rows,
    modelMode: process.env.MODEL_MODE || "mock",
  });
});
// Worker credentials never go to an execution container.
app.post("/internal/claim", async (c) => {
  const { workerId } = await c.req.json();
  if (typeof workerId !== "string" || workerId.length > 100)
    return c.json({ error: "Invalid worker" }, 400);
  await db.query(
    "INSERT INTO workers(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET seen_at=now()",
    [workerId],
  );
  const token = randomUUID() + randomUUID();
  const r = await db.query(
    "UPDATE runs SET state='preparing',worker_id=$1,attempt_token=$2,lease_until=now()+interval '20 seconds',updated_at=now() WHERE id=(SELECT id FROM runs WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id",
    [workerId, hash(token)],
  );
  return c.json(r.rowCount ? { id: r.rows[0].id, token } : null);
});
app.post("/internal/runs/:id/heartbeat", async (c) => {
  const { token } = await c.req.json();
  await db.query(
    "UPDATE workers SET seen_at=now() WHERE id=(SELECT worker_id FROM runs WHERE id=$1 AND attempt_token=$2)",
    [c.req.param("id"), hash(String(token))],
  );
  const r = await db.query(
    "UPDATE runs SET lease_until=now()+interval '20 seconds',updated_at=now() WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND state IN ('preparing','running','cancelling') RETURNING state",
    [c.req.param("id"), hash(String(token))],
  );
  return c.json({ state: r.rows[0]?.state || "expired" });
});
app.post("/internal/runs/:id/start", async (c) => {
  const { token } = await c.req.json();
  await db.query(
    "UPDATE runs SET state='running' WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND state='preparing'",
    [c.req.param("id"), hash(String(token))],
  );
  return c.json({ ok: true });
});
app.post("/internal/runs/:id/finish", async (c) => {
  const body = await c.req.json();
  const id = c.req.param("id");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      "SELECT state,lease_until FROM runs WHERE id=$1 AND attempt_token=$2 FOR UPDATE",
      [id, hash(String(body.token))],
    );
    if (
      !r.rowCount ||
      terminal(r.rows[0].state) ||
      new Date(r.rows[0].lease_until).getTime() < Date.now()
    ) {
      await client.query("ROLLBACK");
      return c.json({ error: "Lease expired" }, 409);
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
    if (state === "succeeded" && Array.isArray(body.files)) {
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
    await client.query("COMMIT");
    return c.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
});
app.post("/internal/runs/:id/event", async (c) => {
  const { token, event } = await c.req.json();
  const r = await db.query(
    "INSERT INTO events(run_id,event) SELECT id,$3 FROM runs WHERE id=$1 AND attempt_token=$2 AND lease_until>now() AND state IN ('preparing','running') RETURNING seq",
    [c.req.param("id"), hash(String(token)), event],
  );
  return c.json({ ok: !!r.rowCount });
});
app.post("/internal/authorize", async (c) => {
  const { token, reserve } = await c.req.json();
  const r = await db.query(
    "SELECT id,input,model_calls FROM runs WHERE attempt_token=$1 AND state IN ('preparing','running') AND lease_until>now()",
    [hash(String(token))],
  );
  if (!r.rowCount) return c.json({ error: "Run credential expired" }, 401);
  if (reserve) {
    const used = await db.query(
      "UPDATE runs SET model_calls=model_calls+1 WHERE id=$1 AND model_calls<24 RETURNING id",
      [r.rows[0].id],
    );
    if (!used.rowCount) return c.json({ error: "模型调用次数已达上限" }, 429);
  }
  return c.json({ id: r.rows[0].id, input: r.rows[0].input });
});
app.get(
  "/admin/*",
  serveStatic({
    root: "/app/admin",
    rewriteRequestPath: (p) => p.replace(/^\/admin\/?/, "/") || "/index.html",
  }),
);
app.get("/assets/*", serveStatic({ root: "/app/web" }));
app.get("/cloud", serveStatic({ path: "/app/web/index.html" }));
app.get("/", (c) => c.redirect("/cloud"));
await migrate();
setInterval(
  () =>
    void db
      .query(
        "UPDATE runs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'failed' END,error='执行节点失联；为避免重复副作用，请核验后重新提交',attempt_token=NULL,updated_at=now() WHERE state IN ('preparing','running','cancelling') AND lease_until<now()",
      )
      .catch(() => console.error("Lease sweep unavailable")),
  5000,
).unref();
serve({ fetch: app.fetch, port: 8890 });
