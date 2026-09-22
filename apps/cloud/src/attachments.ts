import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import { db } from "./db.ts";
import type { CloudEnv } from "./types.ts";
import { ATTACHMENT_LIMIT, parseAttachment } from "./attachment-parser.ts";
export const attachmentSchema = `
CREATE TABLE IF NOT EXISTS attachments(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES principals(id),name text NOT NULL,mime text NOT NULL,kind text NOT NULL,size integer NOT NULL,data bytea NOT NULL,text_content text,warning text,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS attachments_owner_idx ON attachments(owner_id,created_at);
CREATE TABLE IF NOT EXISTS run_attachments(run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,attachment_id text NOT NULL REFERENCES attachments(id),PRIMARY KEY(run_id,attachment_id));
`;
export const attachmentIdsSchema = z.array(z.string().regex(/^att_[a-f0-9]{32}$/)).max(10).refine(ids => new Set(ids).size === ids.length,"附件重复").optional();
const uploadSchema = z.object({ name: z.string().min(1).max(180).refine(name => !/[\/\\\x00-\x1f]/.test(name) && !name.startsWith('.') && !/^(id_(rsa|dsa|ed25519)|credentials|secrets?)(\.|$)/i.test(name) && !/\.(pem|key|p12|pfx)$/i.test(name),"文件名无效或属于敏感配置"), contentType: z.string().max(160).optional(), data: z.string().min(4).max(Math.ceil(ATTACHMENT_LIMIT/3)*4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict();
function metadata(row: any) { return { id: row.id, name: row.name, size: row.size, mime: row.mime, contentType: row.mime, kind: row.kind, status: "ready", warning: row.warning || undefined, extractedChars: row.text_content?.length || 0, workspacePath: `attachments/${row.id}-${row.name}`, createdAt: row.created_at }; }
export async function resolveAttachments(owner: string, ids: string[] | undefined, client: Pick<typeof db,"query"> = db) {
  if (!ids?.length) return [];
  const rows = (await client.query("SELECT * FROM attachments WHERE owner_id=$1 AND id=ANY($2::text[]) FOR SHARE",[owner,ids])).rows;
  if (rows.length !== ids.length) throw Error("附件不存在或不属于当前账号，请重新上传");
  if (rows.reduce((sum,row)=>sum+row.size,0)>8*1024*1024) throw Error("单条消息附件总大小不能超过 8 MiB");
  return ids.map(id => { const row=rows.find(row=>row.id===id)!;return {...metadata(row),data:Buffer.from(row.data).toString("base64"),text:row.text_content || undefined}; });
}
export async function bindAttachments(runId: string, ids: string[] | undefined, client: Pick<typeof db,"query"> = db) { for(const id of ids || []) await client.query("INSERT INTO run_attachments(run_id,attachment_id) VALUES($1,$2)",[runId,id]); }
export function registerAttachmentRoutes(app: Hono<CloudEnv>) {
  app.post("/v1/attachments", async c => {
    const parsed=uploadSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success) return c.json({error:"附件参数无效；文件最多 4 MiB，请勿上传密钥或隐藏配置文件"},400);
    const data=Buffer.from(parsed.data.data,"base64");
    if(data.toString("base64")!==parsed.data.data) return c.json({error:"附件编码无效"},400);
    let content;try {content=await parseAttachment(parsed.data.name,data);} catch(error) {return c.json({error:(error as Error).message},400);}
    const owner=c.get("principal").id,client=await db.connect();
    try {
      await client.query("BEGIN");await client.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE",[owner]);
      const total=(await client.query("SELECT coalesce(sum(size),0)::bigint AS size,count(*)::int AS count FROM attachments WHERE owner_id=$1",[owner])).rows[0];
      if(Number(total.size)+data.length>100*1024*1024 || total.count>=200) {await client.query("ROLLBACK");return c.json({error:"附件存储已达 100 MiB 或 200 个上限，请删除未使用的附件"},429);}
      const row=(await client.query("INSERT INTO attachments(id,owner_id,name,mime,kind,size,data,text_content,warning) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",["att_"+randomUUID().replaceAll("-",""),owner,parsed.data.name,content.mime,content.kind,data.length,data,content.text||null,content.warning||null])).rows[0];
      await client.query("COMMIT");return c.json({attachment:metadata(row)},201);
    } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
  });
  app.get("/v1/attachments",async c=>c.json({attachments:(await db.query("SELECT id,name,mime,kind,size,warning,created_at,length(text_content) AS extracted_chars FROM attachments WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200",[c.get("principal").id])).rows.map(row=>({...metadata(row),extractedChars:row.extracted_chars||0}))}));
  app.get("/v1/runs/:id/attachments",async c=>{
    const allowed=(await db.query("SELECT id FROM runs WHERE id=$1 AND CASE WHEN project_id IS NULL THEN owner_id=$2 ELSE project_access(project_id,$2,false) END",[c.req.param("id"),c.get("principal").id])).rowCount;
    if(!allowed)return c.json({error:"任务不存在"},404);
    return c.json({attachments:(await db.query("SELECT a.id,a.name,a.mime,a.kind,a.size,a.warning,a.created_at FROM attachments a JOIN run_attachments ra ON ra.attachment_id=a.id WHERE ra.run_id=$1 ORDER BY a.created_at",[c.req.param("id")])).rows.map(metadata)});
  });
  app.get("/v1/attachments/:id/download",async c=>{
    const row=(await db.query(`SELECT a.* FROM attachments a WHERE a.id=$1 AND (a.owner_id=$2 OR EXISTS(SELECT 1 FROM run_attachments ra JOIN runs r ON r.id=ra.run_id WHERE ra.attachment_id=a.id AND CASE WHEN r.project_id IS NULL THEN r.owner_id=$2 ELSE project_access(r.project_id,$2,false) END))`,[c.req.param("id"),c.get("principal").id])).rows[0];
    if(!row)return c.json({error:"附件不存在"},404);
    c.header("Content-Type",row.mime);c.header("X-Content-Type-Options","nosniff");c.header("Cache-Control","private, no-store");c.header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    return c.body(new Uint8Array(row.data));
  });
  app.delete("/v1/attachments/:id",async c=>{
    try {
      const result=await db.query("DELETE FROM attachments WHERE id=$1 AND owner_id=$2 AND NOT EXISTS(SELECT 1 FROM run_attachments WHERE attachment_id=$1) RETURNING id",[c.req.param("id"),c.get("principal").id]);
      return result.rowCount ? c.json({ok:true}) : c.json({error:"附件不存在或已用于任务，不能删除"},409);
    } catch(error) {
      if ((error as {code?:string}).code === "23503") return c.json({error:"附件刚被任务引用，不能删除"},409);
      throw error;
    }
  });
}
