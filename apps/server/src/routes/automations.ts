import type { Automation } from "../types.ts";
import { planeFetch, planeJson } from "../control-plane/client.ts";
import { loadSettings } from "../store/settings.ts";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  AutomationBusyError,
  AutomationNotFoundError,
  runAutomation,
} from "../automations/run.ts";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
} from "../store/automations.ts";

const runtimeSchema = z.enum(["pig", "codex", "cloud"]);
const optionalId = z.string().max(80).nullable().optional();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(20_000),
  enabled: z.boolean().optional(),
  schedule: z.string().max(80).nullable().optional(),
  expertId: optionalId,
  expertTeamId: optionalId,
  projectId: optionalId,
  runtime: runtimeSchema.optional(),
  executionTarget: z.enum(["local", "remote"]).optional(),
  engine: z.enum(["pig", "codex"]).optional(),
  timezone: z.string().max(80).optional(),
  misfirePolicy: z.enum(["skip", "once"]).optional(),
  skillIds: z.array(z.string().min(1).max(80)).max(20).optional(),
  saveArtifactsToProject: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  prompt: z.string().min(1).max(20_000).optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().max(80).nullable().optional(),
  expertId: optionalId,
  expertTeamId: optionalId,
  projectId: optionalId,
  runtime: runtimeSchema.optional(),
  executionTarget: z.enum(["local", "remote"]).optional(),
  engine: z.enum(["pig", "codex"]).optional(),
  timezone: z.string().max(80).optional(),
  misfirePolicy: z.enum(["skip", "once"]).optional(),
  skillIds: z.array(z.string().min(1).max(80)).max(20).optional(),
  saveArtifactsToProject: z.boolean().optional(),
});

function fail(err: unknown): { error: string; status: 400 } {
  return {
    error: err instanceof Error ? err.message : String(err),
    status: 400,
  };
}

export function registerAutomationRoutes(app: Hono): void {
  app.use("/api/automations/:id/*", async (c, next) => {
    if (!/^[a-zA-Z0-9_-]{2,80}$/.test(c.req.param("id") || ""))
      return c.json({ error: "Invalid automation id" }, 400);
    await next();
  });
  app.use("/api/automations/:id", async (c, next) => {
    if (!/^[a-zA-Z0-9_-]{2,80}$/.test(c.req.param("id") || ""))
      return c.json({ error: "Invalid automation id" }, 400);
    await next();
  });
  app.get("/api/automations", async (c) => {
    const local = (await listAutomations()).filter((a) => !a.remoteScheduleId);
    const settings = await loadSettings();
    if (!settings.cloudBaseUrl || !settings.cloudToken)
      return c.json({ automations: local });
    try {
      const remote = await planeJson<{ automations: Automation[] }>(
        "/v1/schedules",
      );
      return c.json({ automations: [...remote.automations, ...local] });
    } catch {
      return c.json({
        automations: local,
        remoteError: "远端计划暂不可用，请检查控制面连接；远端定时调度不受影响",
      });
    }
  });

  app.post("/api/automations", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: "name and prompt are required" }, 400);
    try {
      if (
        parsed.data.executionTarget === "remote" ||
        parsed.data.runtime === "cloud"
      ) {
        const {
          saveArtifactsToProject,
          projectId,
          expertId,
          expertTeamId,
          ...input
        } = parsed.data;
        if (saveArtifactsToProject || projectId || expertId || expertTeamId)
          return c.json({ error: "远端计划暂不支持本地项目/专家绑定" }, 400);
        const response = await planeFetch("/v1/schedules", {
          method: "POST",
          headers: {
            "Idempotency-Key": c.req.header("Idempotency-Key") || randomUUID(),
          },
          body: JSON.stringify({
            ...input,
            executionTarget: "remote",
            runtime: "cloud",
            engine: input.engine || "pig",
          }),
        });
        return response;
      }
      const automation = await createAutomation({
        ...parsed.data,
        runtime: parsed.data.engine || parsed.data.runtime,
      });
      return c.json(automation, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/automations/:id", async (c) => {
    if (c.req.param("id").startsWith("ratm_")) {
      try {
        return await planeFetch(`/v1/schedules/${c.req.param("id")}`);
      } catch {
        return c.json({ error: "控制面不可用" }, 502);
      }
    }
    const automation = await getAutomation(c.req.param("id"));
    if (!automation) return c.json({ error: "Automation not found" }, 404);
    return c.json(automation);
  });

  app.patch("/api/automations/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: "Invalid automation patch" }, 400);
    try {
      if (c.req.param("id").startsWith("ratm_"))
        return await planeFetch(`/v1/schedules/${c.req.param("id")}`, {
          method: "PATCH",
          body: JSON.stringify(parsed.data),
        });
      if (
        parsed.data.runtime === "cloud" ||
        parsed.data.executionTarget === "remote"
      )
        return c.json({ error: "请使用迁入控制面操作，或新建远端计划" }, 400);
      const automation = await updateAutomation(c.req.param("id"), {
        ...parsed.data,
        runtime: parsed.data.engine || parsed.data.runtime,
      });
      if (!automation) return c.json({ error: "Automation not found" }, 404);
      return c.json(automation);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.delete("/api/automations/:id", async (c) => {
    if (c.req.param("id").startsWith("ratm_")) {
      try {
        return await planeFetch(`/v1/schedules/${c.req.param("id")}`, {
          method: "DELETE",
        });
      } catch {
        return c.json({ error: "控制面不可用，删除未确认" }, 502);
      }
    }
    const ok = await deleteAutomation(c.req.param("id"));
    if (!ok) return c.json({ error: "Automation not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/automations/:id/migrate", async (c) => {
    const row = await getAutomation(c.req.param("id"));
    if (!row) return c.json({ error: "Automation not found" }, 404);
    if (row.runtime !== "cloud" && !row.remoteScheduleId)
      return c.json(
        { error: "仅旧 Cloud 自动化需要迁移，本地计划请另建远端计划" },
        400,
      );
    if (
      row.expertId ||
      row.expertTeamId ||
      row.projectId ||
      row.saveArtifactsToProject
    )
      return c.json(
        { error: "迁移前请解除本地项目/专家绑定，并将必要上下文写入提示词" },
        400,
      );
    try {
      const remote = row.remoteScheduleId
        ? await planeJson<Automation>(`/v1/schedules/${row.remoteScheduleId}`)
        : await planeJson<Automation>("/v1/schedules", {
            method: "POST",
            headers: { "Idempotency-Key": `migrate:${row.id}` },
            body: JSON.stringify({
              name: row.name,
              prompt: row.prompt,
              schedule: row.schedule,
              enabled: row.enabled,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          });
      await updateAutomation(row.id, {
        remoteScheduleId: remote.id,
        enabled: false,
      });
      return c.json(remote);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "迁移失败" },
        502,
      );
    }
  });

  app.post("/api/automations/:id/run", async (c) => {
    try {
      if (c.req.param("id").startsWith("ratm_"))
        return await planeFetch(`/v1/schedules/${c.req.param("id")}/run`, {
          method: "POST",
          headers: {
            "Idempotency-Key": c.req.header("Idempotency-Key") || randomUUID(),
          },
        });
      const result = await runAutomation(c.req.param("id"));
      return c.json(result, 202);
    } catch (err) {
      if (err instanceof AutomationNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      if (err instanceof AutomationBusyError) {
        return c.json({ error: err.message }, 409);
      }
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });
}
