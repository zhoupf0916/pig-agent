import { conversationTranscript, modelHistory } from "./transcript.ts";
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, terminal } from "./db.ts";
import type { CloudEnv } from "./types.ts";

const followSchema = z
  .object({ prompt: z.string().trim().min(1).max(32000) })
  .strict();
export function registerConversationRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/conversations", async (c) =>
    c.json({
      conversations: (
        await db.query(
          `SELECT c.*, r.id AS last_run_id,r.state FROM conversations c
     LEFT JOIN LATERAL (SELECT id,state FROM runs WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) r ON true
     WHERE c.owner_id=$1 ORDER BY c.updated_at DESC LIMIT 100`,
          [c.get("principal").id],
        )
      ).rows,
    }),
  );
  app.get("/v1/conversations/:id", async (c) => {
    const p = c.get("principal");
    const conversation = (
      await db.query(
        "SELECT * FROM conversations WHERE id=$1 AND (owner_id=$2 OR $3)",
        [c.req.param("id"), p.id, p.role === "admin"],
      )
    ).rows[0];
    if (!conversation) return c.json({ error: "会话不存在" }, 404);
    const runs = (
      await db.query(
        "SELECT id,parent_run_id,state,error,input,input->>'prompt' AS prompt,created_at FROM runs WHERE conversation_id=$1 ORDER BY created_at",
        [conversation.id],
      )
    ).rows;
    const history = (
      await db.query(
        `SELECT run_id,event->'session'->'messages' AS messages FROM events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id=$1) AND event->>'type'='done' ORDER BY seq`,
        [conversation.id],
      )
    ).rows;
    const messages = conversationTranscript(runs, history);
    const versions = (
      await db.query(
        "SELECT run_id,created_at,snapshot-'data' AS manifest FROM workspace_versions WHERE conversation_id=$1 ORDER BY created_at DESC",
        [conversation.id],
      )
    ).rows;
    return c.json({
      conversation,
      runs: runs.map(({ input, ...run }) => run),
      messages,
      versions,
    });
  });
  app.get("/v1/conversations/:id/workspace/:run", async (c) => {
    const p = c.get("principal");
    const version = (
      await db.query(
        `SELECT v.snapshot FROM workspace_versions v JOIN conversations c ON c.id=v.conversation_id WHERE c.id=$1 AND v.run_id=$2 AND (c.owner_id=$3 OR $4)`,
        [c.req.param("id"), c.req.param("run"), p.id, p.role === "admin"],
      )
    ).rows[0];
    if (!version) return c.json({ error: "工作区版本不存在" }, 404);
    c.header("Content-Disposition", 'attachment; filename="workspace.tar.gz"');
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(
      new Uint8Array(Buffer.from(version.snapshot.data, "base64")),
      200,
      { "Content-Type": "application/gzip" },
    );
  });
  app.post("/v1/runs/:id/follow-ups", async (c) => {
    const parsed = followSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "跟进消息无效" }, 400);
    const key = c.req.header("Idempotency-Key");
    if (!key || key.length > 120)
      return c.json({ error: "需要有效的请求标识" }, 400);
    const p = c.get("principal"),
      client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        p.id,
      ]);
      const parent = (
        await client.query("SELECT * FROM runs WHERE id=$1 AND owner_id=$2", [
          c.req.param("id"),
          p.id,
        ])
      ).rows[0];
      if (!parent) {
        await client.query("ROLLBACK");
        return c.json({ error: "任务不存在" }, 404);
      }
      const old = (
        await client.query(
          "SELECT id,state,parent_run_id,input->>'prompt' AS prompt FROM runs WHERE owner_id=$1 AND request_key=$2",
          [p.id, key],
        )
      ).rows[0];
      if (old) {
        await client.query("ROLLBACK");
        if (
          old.parent_run_id !== parent.id ||
          old.prompt !== parsed.data.prompt
        )
          return c.json({ error: "请求标识已用于其他任务" }, 409);
        return c.json({ id: old.id, status: old.state });
      }
      if (!terminal(parent.state)) {
        await client.query("ROLLBACK");
        return c.json({ error: "上一轮仍在执行" }, 409);
      }
      // Upgrade pre-conversation runs in place; old clients need not re-upload files.
      const conversationId =
        parent.conversation_id || "conv_" + randomUUID().replaceAll("-", "");
      if (!parent.conversation_id) {
        await client.query(
          "INSERT INTO conversations(id,owner_id,title) VALUES($1,$2,$3)",
          [conversationId, p.id, parent.input.prompt.slice(0, 100)],
        );
        await client.query("UPDATE runs SET conversation_id=$2 WHERE id=$1", [
          parent.id,
          conversationId,
        ]);
      }
      await client.query(
        "SELECT id FROM conversations WHERE id=$1 FOR UPDATE",
        [conversationId],
      );
      const latest = (
        await client.query(
          "SELECT id FROM runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1",
          [conversationId],
        )
      ).rows[0];
      if (latest.id !== parent.id) {
        await client.query("ROLLBACK");
        return c.json({ error: "会话已有更新，请刷新后继续" }, 409);
      }
      const active = (
        await client.query(
          "SELECT count(*) FROM runs WHERE owner_id=$1 AND state IN ('queued','preparing','running','cancelling')",
          [p.id],
        )
      ).rows[0];
      if (Number(active.count) >= 5) {
        await client.query("ROLLBACK");
        return c.json({ error: "运行数量已达上限" }, 429);
      }
      const checkpoint = (
        await client.query(
          "SELECT snapshot FROM workspace_versions WHERE run_id=$1",
          [parent.id],
        )
      ).rows[0];
      if (
        parent.conversation_id &&
        !checkpoint &&
        (parent.state !== "cancelled" || parent.worker_id)
      ) {
        await client.query("ROLLBACK");
        return c.json(
          {
            error: "上一轮没有完整工作区检查点，请核验后新建会话，避免丢失修改",
          },
          409,
        );
      }
      const last = (
        await client.query(
          "SELECT event->'session'->'messages' AS messages FROM events WHERE run_id=$1 AND event->>'type'='done' ORDER BY seq DESC LIMIT 1",
          [parent.id],
        )
      ).rows[0];
      const input = {
        ...parent.input,
        prompt: parsed.data.prompt,
        messages: modelHistory(
          last?.messages || parent.input.messages || [],
        ).slice(-40),
      };
      delete input.files;
      if (checkpoint) input.workspace = { snapshot: checkpoint.snapshot };
      const id = "run_" + randomUUID().replaceAll("-", "");
      await client.query(
        "INSERT INTO runs(id,owner_id,input,request_key,conversation_id,parent_run_id) VALUES($1,$2,$3,$4,$5,$6)",
        [id, p.id, input, key, conversationId, parent.id],
      );
      await client.query(
        "UPDATE conversations SET updated_at=now() WHERE id=$1",
        [conversationId],
      );
      await client.query(
        "INSERT INTO audit(actor,action,run_id) VALUES($1,'follow-up',$2)",
        [p.id, id],
      );
      await client.query("COMMIT");
      return c.json({ id, status: "queued", conversationId }, 201);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
}
