import { attachmentIdsSchema, resolveAttachments, bindAttachments } from "./attachments.ts";
import { loadUserSettings, buildUserContext } from "./user-data.ts";
import { resolveCapabilityContext } from "./capabilities.ts";
import { getRequestCredential } from "./web-auth.ts";
import { streamSSE } from "hono/streaming";
import { conversationFor, conversationSnapshot } from "./conversation-state.ts";
import { modelHistory } from "./transcript.ts";
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, hash, terminal } from "./db.ts";
import type { CloudEnv } from "./types.ts";

const followSchema = z
  .object({ prompt: z.string().trim().min(1).max(32000), attachmentIds: attachmentIdsSchema })
  .strict();
export function registerConversationRoutes(app: Hono<CloudEnv>) {
  app.get("/v1/conversations", async (c) =>
    c.json({
      conversations: (
        await db.query(
          `SELECT c.*, r.id AS last_run_id,r.state FROM conversations c
     LEFT JOIN LATERAL (SELECT id,state FROM runs WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) r ON true
     WHERE CASE WHEN c.project_id IS NULL THEN c.owner_id=$1 ELSE project_access(c.project_id,$1,false) END ORDER BY c.updated_at DESC LIMIT 100`,
          [c.get("principal").id],
        )
      ).rows,
    }),
  );
  app.get("/v1/conversations/:id", async (c) => {
    const p = c.get("principal");
    const conversation = await conversationFor(c.req.param("id"),p);
    if (!conversation) return c.json({error:"会话不存在"},404);
    return c.json(await conversationSnapshot(conversation));
  });
  app.get("/v1/conversations/:id/events", async c => {
    const id=c.req.param("id");
    if (!await conversationFor(id,c.get("principal"))) return c.json({error:"会话不存在"},404);
    let after=Number(c.req.query("after") || c.req.header("Last-Event-ID") || 0);
    if (!Number.isSafeInteger(after) || after<0) return c.json({error:"Invalid cursor"},400);
    const supplied=getRequestCredential(c);
    const credential=hash(supplied.token);
    c.header("Cache-Control","no-cache, no-transform");
    c.header("X-Accel-Buffering","no");
    return streamSSE(c,async stream=>{
      let revision="",heartbeat=0;
      while (!stream.aborted) {
        // Re-read identity, session validity and project membership on every poll.
        const principal=(await db.query(`SELECT id,role FROM principals WHERE id=$1 AND enabled AND (($3 AND token_hash=$2) OR id IN (SELECT owner_id FROM auth_sessions WHERE token_hash=$2 AND expires_at>now()))`,[c.get("principal").id,credential,supplied.source === "bearer"])).rows[0];
        const conversation=principal && await conversationFor(id,principal);
        if (!conversation) { await stream.writeSSE({data:JSON.stringify({type:"access_revoked"})}); break; }
        const stamp=(await db.query(`SELECT r.id,r.state,r.error,r.updated_at,(SELECT count(*) FROM workspace_versions WHERE run_id=r.id) AS versions,
          (SELECT max(seq) FROM events WHERE run_id=r.id AND event->>'type' IN ('done','approval')) AS terminal_event FROM runs r WHERE conversation_id=$1 ORDER BY r.created_at,r.id`,[id])).rows;
        const next=JSON.stringify([conversation,stamp]);
        if(next!==revision){
          await stream.writeSSE({data:JSON.stringify({type:"conversation_snapshot",...await conversationSnapshot(conversation)})});
          revision=next;
        }
        const events=(await db.query(`SELECT e.seq,e.run_id,e.event FROM events e JOIN runs r ON r.id=e.run_id WHERE r.conversation_id=$1 AND e.seq>$2 ORDER BY e.seq LIMIT 200`,[id,after])).rows;
        for(const row of events){
          await stream.writeSSE({id:String(row.seq),data:JSON.stringify({type:"run_event",runId:row.run_id,seq:Number(row.seq),event:row.event})});
          after=Number(row.seq);
        }
        if(Date.now()-heartbeat>10000){await stream.writeSSE({event:"heartbeat",data:"{}"});heartbeat=Date.now();}
        // A conversation remains subscribed through idle time and subsequent turns.
        if(events.length<200) await stream.sleep(events.length ? 100 : 500);
      }
    });
  });
  app.get("/v1/conversations/:id/workspace/:run", async (c) => {
    const p = c.get("principal");
    const version = (
      await db.query(
        `SELECT v.snapshot FROM workspace_versions v JOIN conversations c ON c.id=v.conversation_id WHERE c.id=$1 AND v.run_id=$2 AND ($4 OR CASE WHEN c.project_id IS NULL THEN c.owner_id=$3 ELSE project_access(c.project_id,$3,false) END)`,
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
        await client.query(
          "SELECT * FROM runs WHERE id=$1 AND CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,true) END",
          [c.req.param("id"), p.id],
        )
      ).rows[0];
      if (!parent) {
        await client.query("ROLLBACK");
        return c.json({ error: "任务不存在" }, 404);
      }
      const old = (
        await client.query(
          "SELECT id,state,parent_run_id,input->>'prompt' AS prompt,input->'attachmentIds' AS attachment_ids FROM runs WHERE owner_id=$1 AND request_key=$2",
          [p.id, key],
        )
      ).rows[0];
      if (old) {
        await client.query("ROLLBACK");
        if (
          old.parent_run_id !== parent.id ||
          old.prompt !== parsed.data.prompt ||
          JSON.stringify(old.attachment_ids || []) !== JSON.stringify(parsed.data.attachmentIds || [])
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
          "INSERT INTO conversations(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)",
          [
            conversationId,
            p.id,
            parent.input.prompt.slice(0, 100),
            parent.project_id || null,
          ],
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
      // A new participant never inherits somebody else's automatic execution consent.
      if (parent.owner_id !== p.id) {
        const defaults=await loadUserSettings(p.id,client);
        input.requireApproval=defaults.requireApproval;
        input.networkPolicy=defaults.networkPolicy;
      }
      delete input.files;
      delete input.attachments;
      input.attachmentIds=parsed.data.attachmentIds;
      try {
        const added=await resolveAttachments(p.id,parsed.data.attachmentIds,client);
        const existing=Array.isArray(parent.input.attachments) ? parent.input.attachments : [];
        input.attachments=[...existing.filter((a: {id:string})=>!added.some(b=>b.id===a.id)),...added];
        if(input.attachments.reduce((sum:number,a:{size:number})=>sum+a.size,0)>8*1024*1024) throw Error("此会话附件累计超过 8 MiB，请新建会话处理更多附件");
      } catch(error) {await client.query("ROLLBACK");return c.json({error:(error as Error).message},400);}
      delete input.requestInput;
      if(parent.owner_id !== p.id) { delete input.expertId; delete input.skillIds; }
      if (input.projectId && (await client.query("SELECT space_id FROM shared_projects WHERE id=$1",[input.projectId])).rows[0]?.space_id) input.requireApproval = true;
      try { input.capabilityContext=parent.owner_id===p.id && parent.input.capabilityContext ? parent.input.capabilityContext : await resolveCapabilityContext(p.id,input,client); }
      catch(e) { await client.query("ROLLBACK");return c.json({error:(e as Error).message},400); }
      input.privateMemoryContext=await buildUserContext(p.id,input.projectId,client);
      if (checkpoint) { input.workspace = { snapshot: checkpoint.snapshot }; delete input.projectFiles; }
      const id = "run_" + randomUUID().replaceAll("-", "");
      await client.query(
        "INSERT INTO runs(id,owner_id,input,request_key,conversation_id,parent_run_id) VALUES($1,$2,$3,$4,$5,$6)",
        [id, p.id, input, key, conversationId, parent.id],
      );
      await bindAttachments(id,input.attachments.map((a:{id:string})=>a.id),client);
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
