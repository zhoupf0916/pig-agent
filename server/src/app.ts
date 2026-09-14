import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { resolveInWorkspace } from "./agent/sandbox.ts";
import { runAgent } from "./agent/runtime.ts";
import { listSkills } from "./agent/skills.ts";
import { WEB_ORIGIN } from "./config.ts";
import { deleteSession, createSession, getSession, listSessions, saveSession } from "./store/sessions.ts";
import { loadSettings, publicSettings, saveSettings } from "./store/settings.ts";
import type { AgentEvent, ChatMessage, Session } from "./types.ts";
import { newId, nowIso, truncate } from "./util.ts";
import { buildTree, readWorkspaceText } from "./workspace.ts";

const running = new Map<string, AbortController>();

const settingsSchema = z.object({
  llmBaseUrl: z.string().min(1).optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
});

const messageSchema = z.object({
  content: z.string().min(1).max(20_000),
});

export function createApp(): Hono {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: [WEB_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true, name: "pig-agent" }));

  app.get("/api/settings", async (c) => {
    const settings = await loadSettings();
    return c.json(publicSettings(settings));
  });

  app.put("/api/settings", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const settings = await saveSettings(parsed.data);
    return c.json(publicSettings(settings));
  });

  app.get("/api/skills", async (c) => c.json({ skills: await listSkills() }));

  app.get("/api/sessions", async (c) => c.json({ sessions: await listSessions() }));

  app.post("/api/sessions", async (c) => {
    const session = await createSession();
    return c.json(session, 201);
  });

  app.get("/api/sessions/:id", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  app.delete("/api/sessions/:id", async (c) => {
    running.get(c.req.param("id"))?.abort();
    running.delete(c.req.param("id"));
    const ok = await deleteSession(c.req.param("id"));
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    running.get(id)?.abort();
    running.delete(id);
    const session = await getSession(id);
    if (session && session.status === "running") {
      session.status = "idle";
      await saveSession(session);
    }
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.status === "running") {
      return c.json({ error: "Session is already running" }, 409);
    }
    const parsed = messageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Message content is required" }, 400);
    }

    const userMsg: ChatMessage = {
      id: newId("msg"),
      role: "user",
      content: parsed.data.content.trim(),
      createdAt: nowIso(),
    };
    session.messages.push(userMsg);
    if (session.title === "新任务" || session.messages.filter((m) => m.role === "user").length === 1) {
      session.title = truncate(userMsg.content, 36);
    }
    session.status = "running";
    await saveSession(session);

    const settings = await loadSettings();
    const controller = new AbortController();
    running.set(id, controller);

    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const emit = (event: AgentEvent) => {
        writes = writes.then(() =>
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          }),
        );
      };

      try {
        emit({ type: "message", message: userMsg });
        const next = await runAgent({
          session,
          settings,
          signal: controller.signal,
          emit,
        });
        await writes;
        await saveSession(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.status = "error";
        session.lastError = message;
        await saveSession(session);
        await emit({ type: "error", message });
        await emit({ type: "done", session });
      } finally {
        running.delete(id);
      }
    });
  });

  app.get("/api/workspace/tree", async (c) => {
    const settings = await loadSettings();
    try {
      const tree = await buildTree(settings.workspaceRoot);
      return c.json({ root: settings.workspaceRoot, tree });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/workspace/file", async (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "path is required" }, 400);
    const settings = await loadSettings();
    try {
      const file = await readWorkspaceText(settings.workspaceRoot, rel);
      return c.json(file);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Used by tests / operators to confirm sandbox rejects escapes without an LLM.
  app.post("/api/workspace/resolve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const settings = await loadSettings();
    try {
      const abs = resolveInWorkspace(settings.workspaceRoot, String(body.path ?? ""));
      return c.json({ ok: true, path: abs });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}

export type { Session };
