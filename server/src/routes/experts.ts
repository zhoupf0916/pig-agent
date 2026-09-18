import type { Hono } from "hono";
import { z } from "zod";
import {
  createExpert,
  createExpertTeam,
  deleteExpert,
  deleteExpertTeam,
  getExpert,
  getExpertTeam,
  listExpertTeams,
  listExperts,
  updateExpert,
  updateExpertTeam,
} from "../store/experts.ts";
import { clearAutomationPins } from "../store/automations.ts";
import { getSession, listSessions, saveSession } from "../store/sessions.ts";

const kindSchema = z.enum(["scout", "plan", "implement", "review", "custom"]);
const modeSchema = z.enum(["chain", "parallel"]);

const createExpertSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  instruction: z.string().min(1).max(20_000),
  kind: kindSchema.optional(),
  skillIds: z.array(z.string().min(1).max(80)).max(20).optional(),
});

const patchExpertSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  instruction: z.string().min(1).max(20_000).optional(),
  kind: kindSchema.optional(),
  skillIds: z.array(z.string().min(1).max(80)).max(20).optional(),
});

const createTeamSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  mode: modeSchema.optional(),
  expertIds: z.array(z.string().min(1).max(80)).min(1).max(12),
});

const patchTeamSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  mode: modeSchema.optional(),
  expertIds: z.array(z.string().min(1).max(80)).min(1).max(12).optional(),
});

function fail(err: unknown): { error: string; status: 400 } {
  return { error: err instanceof Error ? err.message : String(err), status: 400 };
}

export function registerExpertRoutes(app: Hono): void {
  app.get("/api/experts", async (c) => {
    return c.json({ experts: await listExperts() });
  });

  app.post("/api/experts", async (c) => {
    const parsed = createExpertSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "name and instruction are required" }, 400);
    try {
      const expert = await createExpert(parsed.data);
      return c.json(expert, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/experts/:id", async (c) => {
    const expert = await getExpert(c.req.param("id"));
    if (!expert) return c.json({ error: "Expert not found" }, 404);
    return c.json(expert);
  });

  app.patch("/api/experts/:id", async (c) => {
    const parsed = patchExpertSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid expert patch" }, 400);
    const expert = await updateExpert(c.req.param("id"), parsed.data);
    if (!expert) return c.json({ error: "Expert not found" }, 404);
    return c.json(expert);
  });

  app.delete("/api/experts/:id", async (c) => {
    const id = c.req.param("id");
    const result = await deleteExpert(id);
    if (result === "missing") return c.json({ error: "Expert not found" }, 404);
    if (result === "bundled") return c.json({ error: "Bundled experts cannot be deleted" }, 400);
    const sessions = await listSessions();
    for (const summary of sessions) {
      if (summary.expertId !== id) continue;
      const session = await getSession(summary.id);
      if (!session) continue;
      delete session.expertId;
      await saveSession(session);
    }
    await clearAutomationPins("expertId", id);
    return c.json({ ok: true });
  });

  app.get("/api/expert-teams", async (c) => {
    return c.json({ teams: await listExpertTeams() });
  });

  app.post("/api/expert-teams", async (c) => {
    const parsed = createTeamSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "name and expertIds are required" }, 400);
    try {
      const team = await createExpertTeam(parsed.data);
      return c.json(team, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/expert-teams/:id", async (c) => {
    const team = await getExpertTeam(c.req.param("id"));
    if (!team) return c.json({ error: "Expert team not found" }, 404);
    return c.json(team);
  });

  app.patch("/api/expert-teams/:id", async (c) => {
    const parsed = patchTeamSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid team patch" }, 400);
    const team = await updateExpertTeam(c.req.param("id"), parsed.data);
    if (!team) return c.json({ error: "Expert team not found" }, 404);
    return c.json(team);
  });

  app.delete("/api/expert-teams/:id", async (c) => {
    const id = c.req.param("id");
    const result = await deleteExpertTeam(id);
    if (result === "missing") return c.json({ error: "Expert team not found" }, 404);
    if (result === "bundled") return c.json({ error: "Bundled expert teams cannot be deleted" }, 400);
    const sessions = await listSessions();
    for (const summary of sessions) {
      if (summary.expertTeamId !== id) continue;
      const session = await getSession(summary.id);
      if (!session) continue;
      delete session.expertTeamId;
      delete session.teamRun;
      await saveSession(session);
    }
    await clearAutomationPins("expertTeamId", id);
    return c.json({ ok: true });
  });
}
