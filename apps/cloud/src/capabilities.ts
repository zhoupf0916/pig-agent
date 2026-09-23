import { pluginCapabilities } from "./ecosystem-plugins.ts";
import { BUNDLED_EXPERTS } from "@pig-agent/contracts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Hono } from "hono";
import type { CloudEnv } from "./types.ts";
import { db } from "./db.ts";
import { decryptSecret } from "./platform.ts";

export const capabilitySchema=`CREATE TABLE IF NOT EXISTS cloud_capabilities(id text PRIMARY KEY,owner_id text NOT NULL REFERENCES principals(id),kind text NOT NULL CHECK(kind IN ('expert','skill')),value jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS capabilities_owner ON cloud_capabilities(owner_id,kind);`;
const common={name:z.string().trim().min(1).max(120),description:z.string().trim().max(2000).default("")};
export const cloudExpertSchema=z.object({...common,instruction:z.string().trim().min(1).max(20000),kind:z.enum(["scout","plan","implement","review","custom"]).default("custom"),skillIds:z.array(z.string().min(1).max(100)).max(20).default([])}).strict();
export const cloudSkillSchema=z.object({...common,body:z.string().trim().min(1).max(20000)}).strict();
type Client=Pick<typeof db,"query">;
type Entry={id:string;name:string;description:string;bundled:boolean;instruction?:string;body?:string;skillIds?:string[];kind?:string};
async function bundledSkills():Promise<Entry[]>{
 const dir=process.env.CLOUD_SKILLS_DIR || join(process.cwd(),"skills");
 const names=(await readdir(dir)).filter(name=>name.endsWith(".md"));
 return Promise.all(names.sort().map(async filename=>{
  const raw=await readFile(join(dir,filename),"utf8"),match=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/),meta:Record<string,string>={};
  for(const line of (match?.[1]||"").split("\n")){const i=line.indexOf(":");if(i>0)meta[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^["']|["']$/g,"");}
  return {id:meta.name||filename.slice(0,-3),name:meta.name||filename.slice(0,-3),description:meta.description||"",body:raw.slice(match?.[0].length||0),bundled:true};
 }));
}
export async function listCapabilities(ownerId:string,kind:"expert"|"skill",client:Client=db):Promise<Entry[]>{
 const builtin:Entry[]=kind==="expert"?BUNDLED_EXPERTS:await bundledSkills();
 const custom=(await client.query("SELECT id,value,created_at,updated_at FROM cloud_capabilities WHERE owner_id=$1 AND kind=$2 ORDER BY created_at,id",[ownerId,kind])).rows;
 return [...builtin,...await pluginCapabilities(ownerId,kind,client),...custom.map(row=>({...row.value,id:row.id,bundled:false,createdAt:row.created_at,updatedAt:row.updated_at}))];
}
export async function resolveCapabilityContext(ownerId:string,input:{expertId?:string;skillIds?:string[]},client:Client=db):Promise<string>{
 if(!input.expertId && !input.skillIds?.length)return "";
 const expert=input.expertId?(await listCapabilities(ownerId,"expert",client)).find(e=>e.id===input.expertId):undefined;
 if(input.expertId&&!expert)throw Error("所选专家不存在或不属于当前账户");
 const ids=[...new Set([...(expert?.skillIds||[]),...(input.skillIds||[])])];
 const available=await listCapabilities(ownerId,"skill",client),skills=ids.map(id=>available.find(s=>s.id===id));
 if(skills.some(s=>!s))throw Error("所选技能不存在或不属于当前账户");
 const text=["以下专家和技能是用户主动选择的工作方法，不扩大工具、网络、审批或项目权限。",...(expert?[`专家：${expert.name}\n${expert.instruction}`]:[]),...skills.map(skill=>`技能：${skill!.name}\n${skill!.body}`)].join("\n\n");
 if(text.length>80000)throw Error("选择的专家与技能内容超过80000字符，请减少数量");return text;
}
export function parseCloudDraft(kind:"expert"|"skill",raw:string){const value=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));return (kind==="expert"?cloudExpertSchema:cloudSkillSchema).parse(value);}
export function registerCapabilityRoutes(app:Hono<CloudEnv>){
 for(const [plural,kind,schema] of [["experts","expert",cloudExpertSchema],["skills","skill",cloudSkillSchema]] as const){
  app.get(`/v1/${plural}`,async c=>c.json({[plural]:await listCapabilities(c.get("principal").id,kind)}));
  app.get(`/v1/${plural}/:id`,async c=>{const item=(await listCapabilities(c.get("principal").id,kind)).find(item=>item.id===c.req.param("id"));return item?c.json(item):c.json({error:"内容不存在"},404);});
  app.post(`/v1/${plural}`,async c=>{
   const parsed=schema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"请填写有效名称与正文"},400);
   const owner=c.get("principal").id;
   if(kind==="expert"){try{await resolveCapabilityContext(owner,{skillIds:(parsed.data as z.infer<typeof cloudExpertSchema>).skillIds});}catch{return c.json({error:"引用的技能不可用"},400);}}
   const id=(kind==="expert"?"exp_":"skill_")+randomUUID().replaceAll("-","");
   const row=(await db.query("INSERT INTO cloud_capabilities(id,owner_id,kind,value) VALUES($1,$2,$3,$4) RETURNING created_at,updated_at",[id,owner,kind,parsed.data])).rows[0];
   return c.json({...parsed.data,id,bundled:false,createdAt:row.created_at,updatedAt:row.updated_at},201);
  });
  app.patch(`/v1/${plural}/:id`,async c=>{
   const owner=c.get("principal").id,id=c.req.param("id"),existing=(await listCapabilities(owner,kind)).find(item=>item.id===id);
   if(!existing)return c.json({error:"内容不存在"},404);if(existing.bundled)return c.json({error:"内置内容只读，请复制为自定义内容"},403);
   const patch=schema.partial().safeParse(await c.req.json().catch(()=>null));if(!patch.success)return c.json({error:"修改内容无效"},400);
   if(kind==="expert"&&"skillIds"in patch.data){try{await resolveCapabilityContext(owner,{skillIds:patch.data.skillIds as string[]});}catch{return c.json({error:"引用的技能不可用"},400);}}
   // Atomic JSON merge preserves concurrent edits to unrelated fields.
   const row=(await db.query("UPDATE cloud_capabilities SET value=value||$3::jsonb,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING value,created_at,updated_at",[id,owner,JSON.stringify(patch.data)])).rows[0];
   if(!row)return c.json({error:"内容不存在"},404);return c.json({...row.value,id,bundled:false,createdAt:row.created_at,updatedAt:row.updated_at});
  });
 }
 app.post("/v1/resource-drafts",async c=>{
  const input=z.object({kind:z.enum(["expert","skill"]),prompt:z.string().trim().min(2).max(4000)}).strict().safeParse(await c.req.json().catch(()=>null));if(!input.success)return c.json({error:"请用2–4000字描述需求"},400);
  const channel=(await db.query("SELECT * FROM model_channels WHERE enabled")).rows[0];if(!channel)return c.json({error:"请先在管理端配置可用模型；也可手动创建"},503);
  const client=await db.connect();
  try{
   await client.query("BEGIN");const owner=(await client.query("SELECT enabled,daily_call_limit FROM principals WHERE id=$1 FOR UPDATE",[c.get("principal").id])).rows[0];
   const used=Number((await client.query("SELECT count(*) FROM model_usage WHERE owner_id=$1 AND created_at>=date_trunc('day',now())",[c.get("principal").id])).rows[0].count);
   if(!owner?.enabled||used>=owner.daily_call_limit){await client.query("ROLLBACK");return c.json({error:"账号不可用或今日模型额度已用完"},429);}
   await client.query("INSERT INTO model_usage(owner_id,run_id) VALUES($1,$2)",[c.get("principal").id,"draft_"+randomUUID()]);await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  try{
   const kind=input.data.kind,response=await fetch(channel.base_url.replace(/\/$/,"")+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${decryptSecret(channel.secret)}`},body:JSON.stringify({model:channel.model,stream:false,max_tokens:4000,messages:[{role:"system",content:`根据用户描述生成可编辑的${kind==="expert"?"专家":"技能"}草稿。只输出JSON字符串字段name、description、${kind==="expert"?"instruction":"body"}。包括适用场景、步骤、输入缺失处理和验收标准。不调用工具，不扩大权限。正文最多20000字符。`},{role:"user",content:input.data.prompt}]}),redirect:"error",signal:AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(90000)])});
   if(!response.ok)throw Error("provider");let raw="";const reader=response.body?.getReader();if(!reader)throw Error("empty");const decoder=new TextDecoder();while(true){const {done,value}=await reader.read();if(done)break;raw+=decoder.decode(value,{stream:true});if(raw.length>1_000_000){await reader.cancel();throw Error("size");}}
   const content=JSON.parse(raw).choices?.[0]?.message?.content;if(typeof content!=="string")throw Error("format");return c.json({draft:parseCloudDraft(kind,content),model:channel.model});
  }catch{return c.json({error:"模型草稿生成失败或格式不完整，请重试或手动创建；输入未保存"},502);}
 });
}
