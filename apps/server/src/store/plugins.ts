import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, ensureDir } from "../config.ts";
import { atomicWriteJson } from "../util.ts";
import type { Expert, Skill } from "../types.ts";

const id = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/);
const skillSchema = z.object({ id, name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(2000), body: z.string().trim().min(1).max(20000) }).strict();
export const pluginSchema = z.object({
  format: z.literal("pig-plugin-v1"), id, name: z.string().trim().min(1).max(100), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(2000),
  skills: z.array(skillSchema).max(20).default([]),
  experts: z.array(z.object({ id, name: z.string().trim().min(1).max(100), description: z.string().max(2000), instruction: z.string().trim().min(1).max(20000), skillIds: z.array(id).max(20).default([]) }).strict()).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  if (!value.skills.length && !value.experts.length) ctx.addIssue({code:"custom", message:"插件必须包含技能或专家"});
  for (const list of [value.skills, value.experts]) if (new Set(list.map(x=>x.id)).size !== list.length) ctx.addIssue({code:"custom",message:"插件内 ID 不能重复"});
  const ids = new Set(value.skills.map(x=>x.id));
  if (value.experts.some(e=>e.skillIds.some(s=>!ids.has(s)))) ctx.addIssue({code:"custom",message:"专家引用了不存在的插件技能"});
});
export type PluginManifest = z.infer<typeof pluginSchema>;
type Installed = { manifest: PluginManifest; enabled: boolean; installedAt: string };
const file = join(DATA_DIR,"plugins.json");
let queue: Promise<unknown> = Promise.resolve();
export async function listPlugins(): Promise<Installed[]> {
  try { return z.array(z.object({manifest:pluginSchema,enabled:z.boolean(),installedAt:z.string()})).parse(JSON.parse(await readFile(file,"utf8"))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw Error("插件配置无法读取，请恢复 plugins.json 后重试"); }
}
export function changePlugins(change: (items:Installed[])=>Installed[]): Promise<Installed[]> {
  const task=queue.then(async()=>{const next=change(await listPlugins());ensureDir(DATA_DIR);await atomicWriteJson(file,next);return next;});
  queue=task.catch(()=>{});return task;
}
export async function installPlugin(raw: unknown) {
  const manifest=pluginSchema.parse(raw);
  return changePlugins(items=>{if(items.some(x=>x.manifest.id===manifest.id)) throw Error("同名插件已安装；请先移除旧版本再导入");return [...items,{manifest,enabled:false,installedAt:new Date().toISOString()}];});
}
export async function pluginSkills(): Promise<Skill[]> {
  return (await listPlugins()).filter(p=>p.enabled).flatMap(p=>p.manifest.skills.map(s=>({name:`plugin_${p.manifest.id}_${s.id}`,description:`${s.name} · ${s.description}`,filename:`plugin_${p.manifest.id}_${s.id}.md`,body:s.body})));
}
export async function pluginExperts(): Promise<Expert[]> {
  return (await listPlugins()).filter(p=>p.enabled).flatMap(p=>p.manifest.experts.map(e=>({id:`plugin_${p.manifest.id}_${e.id}`,name:e.name,description:`${p.manifest.name} · ${e.description}`,instruction:e.instruction,kind:"custom" as const,skillIds:e.skillIds.map(id=>`plugin_${p.manifest.id}_${id}`),bundled:true,createdAt:p.installedAt,updatedAt:p.installedAt})));
}
