import type { Hono } from "hono";
import { z } from "zod";
import {
  createMemory,
  createSessionRecap,
  deleteMemory,
  getMemory,
  listMemory,
  updateMemory,
} from "../store/memory.ts";
import { getSession } from "../store/sessions.ts";

const kindSchema = z.enum(["pin", "recap"]);

const createSchema = z.object({
  kind: kindSchema.optional(),
  text: z.string().min(1).max(8_000),
  tags: z.array(z.string().max(40)).max(12).optional(),
  sessionId: z.string().max(80).nullable().optional(),
  projectId: z.string().max(80).nullable().optional(),
  expiresAt: z.string().max(40).nullable().optional(),
});

const patchSchema = z.object({
  kind: kindSchema.optional(),
  text: z.string().min(1).max(8_000).optional(),
  tags: z.array(z.string().max(40)).max(12).nullable().optional(),
  sessionId: z.string().max(80).nullable().optional(),
  projectId: z.string().max(80).nullable().optional(),
  expiresAt: z.string().max(40).nullable().optional(),
  revokedAt: z.string().max(40).nullable().optional(),
});

function fail(err: unknown): { error: string; status: 400 } {
  return { error: err instanceof Error ? err.message : String(err), status: 400 };
}

export function registerMemoryRoutes(app: Hono): void {
  app.get("/api/memory", async (c) => {
    const kindRaw = c.req.query("kind");
    const kind = kindRaw === "pin" || kindRaw === "recap" ? kindRaw : undefined;
    const sessionId = c.req.query("sessionId")?.trim() || undefined;
    const projectId = c.req.query("projectId")?.trim() || undefined;
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit !== undefined && rawLimit !== "") {
      const n = Number(rawLimit);
      if (Number.isFinite(n)) limit = n;
    }
    return c.json({ notes: await listMemory({ kind, sessionId, projectId, limit }) });
  });

  app.post("/api/memory", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "text is required" }, 400);
    try {
      const note = await createMemory(parsed.data);
      return c.json(note, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/memory/:id", async (c) => {
    const note = await getMemory(c.req.param("id"));
    if (!note) return c.json({ error: "Memory note not found" }, 404);
    return c.json(note);
  });

  app.patch("/api/memory/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid memory patch" }, 400);
    try {
      const note = await updateMemory(c.req.param("id"), parsed.data);
      if (!note) return c.json({ error: "Memory note not found" }, 404);
      return c.json(note);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.delete("/api/memory/:id", async (c) => {
    const ok = await deleteMemory(c.req.param("id"));
    if (!ok) return c.json({ error: "Memory note not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/recap", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const note = await createSessionRecap(session);
      return c.json(note, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });
}
