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
});

function fail(err: unknown): { error: string; status: 400 } {
  return { error: err instanceof Error ? err.message : String(err), status: 400 };
}

export function registerAutomationRoutes(app: Hono): void {
  app.get("/api/automations", async (c) => {
    return c.json({ automations: await listAutomations() });
  });

  app.post("/api/automations", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "name and prompt are required" }, 400);
    try {
      const automation = await createAutomation(parsed.data);
      return c.json(automation, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/automations/:id", async (c) => {
    const automation = await getAutomation(c.req.param("id"));
    if (!automation) return c.json({ error: "Automation not found" }, 404);
    return c.json(automation);
  });

  app.patch("/api/automations/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid automation patch" }, 400);
    try {
      const automation = await updateAutomation(c.req.param("id"), parsed.data);
      if (!automation) return c.json({ error: "Automation not found" }, 404);
      return c.json(automation);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.delete("/api/automations/:id", async (c) => {
    const ok = await deleteAutomation(c.req.param("id"));
    if (!ok) return c.json({ error: "Automation not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/automations/:id/run", async (c) => {
    try {
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
