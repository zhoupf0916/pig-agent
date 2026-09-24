import type { Hono } from "hono";
import { z } from "zod";
import { complete } from "../agent/openai.ts";
import { saveUserSkill } from "../agent/skills.ts";
import { loadSettings } from "../store/settings.ts";

export const skillDraftSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  displayName: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().min(1).max(2_000),
  body: z.string().trim().min(1).max(20_000),
});
export const expertDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2_000),
  instruction: z.string().trim().min(1).max(20_000),
});
export function parseResourceDraft(kind: "expert" | "skill", content: string) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return (kind === "expert" ? expertDraftSchema : skillDraftSchema).parse(JSON.parse(text));
}

export function registerResourceDraftRoutes(app: Hono): void {
  app.post("/api/resource-drafts", async c => {
    const input = z.object({ kind: z.enum(["expert", "skill"]), prompt: z.string().trim().min(2).max(4_000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return c.json({ error: "请用 2–4000 字描述你需要的专家或技能" }, 400);
    const settings = await loadSettings();
    const kind = input.data.kind;
    try {
      const result = await complete(settings, [
        { id: "draft-system", createdAt: new Date().toISOString(), role: "system", content: `根据用户描述起草可复用的${kind === "expert" ? "专家指令" : "技能操作指南"}。只输出 JSON，不调用工具、不执行任务。字段为 ${kind === "expert" ? "name, description, instruction" : "name, displayName, description, body"}，全部字符串。${kind === "skill" ? "name 必须为 1–80 位小写英文数字连字符标识。displayName 是给用户看的中文名，不超过40字。" : "name 简洁易读，不超过120字符。"} description 不超过2000字符；正文不超过20000字符。使用用户语言，正文包含适用场景、工作步骤、输入缺失时的处理、交付与验证标准。不得声称具备不存在的工具或绕过审批、权限、数据边界。` },
        { id: "draft-user", createdAt: new Date().toISOString(), role: "user", content: input.data.prompt },
      ], { allowTools: false, signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90_000)]), maxOutputTokens: 4_000 });
      return c.json({ draft: parseResourceDraft(kind, result.content), model: settings.llmModel });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "模型返回的草稿格式不完整，请重试或手动创建" }, 502);
      // Provider errors may contain credentials in upstream response bodies; do not echo them.
      return c.json({ error: "草稿生成失败或超时，请检查设置中的模型连接后重试。已有输入已保留。" }, 502);
    }
  });
  app.post("/api/skills", async c => {
    const input = skillDraftSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!input.success) return c.json({ error: "请检查技能标识、简介与正文" }, 400);
    try { return c.json(await saveUserSkill(input.data), 201); }
    catch { return c.json({ error: "无法保存技能：请确认标识没有重复且本地数据目录可写" }, 409); }
  });
}
