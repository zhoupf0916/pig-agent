import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { resolveInWorkspace } from "./agent/sandbox.ts";
import { listSkills } from "./agent/skills.ts";
import { applyTeamRunStop } from "./agent/team-run.ts";
import {
  prepareUserMessage,
  releaseStaleRunningSession,
  runningTurns,
  runSessionTurn,
  waitForTurnRelease,
} from "./agent/turn.ts";
import { getExpertTeam } from "./store/experts.ts";
import { hasResumableMember, shouldRunSequentialTeam } from "./store/team-run-state.ts";
import { WEB_ORIGIN } from "./config.ts";
import { registerArtifactRoutes } from "./routes/artifacts.ts";
import { registerAutomationRoutes } from "./routes/automations.ts";
import { registerExpertRoutes } from "./routes/experts.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerMemoryRoutes } from "./routes/memory.ts";
import { registerSearchRoutes } from "./routes/search.ts";
import { registerSyncRoutes } from "./routes/sync.ts";
import { publishPersistedEvent } from "./store/events.ts";
import { recordSessionBound } from "./store/projects.ts";
import { deleteSession, createSession, getSession, listSessions, saveSession } from "./store/sessions.ts";
import { loadSettings, publicSettings, saveSettings } from "./store/settings.ts";
import type { Session } from "./types.ts";
import { buildTree, readWorkspaceText } from "./workspace.ts";

const settingsSchema = z.object({
  llmBaseUrl: z.string().min(1).optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
  runtime: z.enum(["pig", "codex", "cloud"]).optional(),
  codexBinaryPath: z.string().optional(),
  codexModel: z.string().min(1).optional(),
  codexNetworkAccess: z.boolean().optional(),
  cloudBaseUrl: z.string().optional(),
  cloudToken: z.string().optional(),
  cloudMode: z.enum(["local-stub", "remote"]).optional(),
  cloudRepoUrl: z.string().optional(),
  cloudRepoRef: z.string().optional(),
});

const messageSchema = z.object({
  content: z.string().min(1).max(20_000),
});

const teamRunSchema = z.object({
  action: z.enum(["start", "continue", "stop"]).default("start"),
  content: z.string().min(1).max(20_000).optional(),
});

export function createApp(): Hono {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: [WEB_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
      exposeHeaders: ["Last-Event-ID"],
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
    try {
      const settings = await saveSettings(parsed.data);
      return c.json(publicSettings(settings));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.get("/api/skills", async (c) => c.json({ skills: await listSkills() }));

  registerProjectRoutes(app);
  registerExpertRoutes(app);
  registerAutomationRoutes(app);
  registerArtifactRoutes(app);
  registerSearchRoutes(app);
  registerMemoryRoutes(app);
  registerSyncRoutes(app);

  app.get("/api/sessions", async (c) => c.json({ sessions: await listSessions() }));

  app.post("/api/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      expertId?: string;
      expertTeamId?: string;
    };
    const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;
    const expertId = typeof body.expertId === "string" && body.expertId.trim() ? body.expertId.trim() : undefined;
    const expertTeamId =
      typeof body.expertTeamId === "string" && body.expertTeamId.trim() ? body.expertTeamId.trim() : undefined;
    const session = await createSession({ projectId, expertId, expertTeamId });
    if (projectId) await recordSessionBound(projectId, session.id);
    return c.json(session, 201);
  });

  app.get("/api/sessions/:id", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  app.patch("/api/sessions/:id", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string | null;
      expertId?: string | null;
      expertTeamId?: string | null;
      title?: string;
    };
    if (typeof body.title === "string" && body.title.trim()) {
      session.title = body.title.trim();
    }
    if (body.projectId === null) {
      delete session.projectId;
    } else if (typeof body.projectId === "string") {
      const id = body.projectId.trim();
      if (id) {
        session.projectId = id;
        await recordSessionBound(id, session.id);
      } else {
        delete session.projectId;
      }
    }
    if (body.expertId === null) {
      delete session.expertId;
    } else if (typeof body.expertId === "string") {
      const id = body.expertId.trim();
      if (id) session.expertId = id;
      else delete session.expertId;
    }
    if (body.expertTeamId === null) {
      delete session.expertTeamId;
      delete session.teamRun;
    } else if (typeof body.expertTeamId === "string") {
      const id = body.expertTeamId.trim();
      if (id) session.expertTeamId = id;
      else {
        delete session.expertTeamId;
        delete session.teamRun;
      }
    }
    await saveSession(session);
    return c.json(session);
  });

  app.delete("/api/sessions/:id", async (c) => {
    runningTurns.get(c.req.param("id"))?.abort();
    runningTurns.delete(c.req.param("id"));
    const ok = await deleteSession(c.req.param("id"));
    if (!ok) return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    const controller = runningTurns.get(id);
    controller?.abort();
    await waitForTurnRelease(id);
    const session = await getSession(id);
    if (session && session.status === "running" && !runningTurns.has(id)) {
      await applyTeamRunStop(session);
      const latest = (await getSession(id)) ?? session;
      if (latest.status === "running") {
        latest.status = "idle";
        latest.lastError = undefined;
        latest.remoteRetry = undefined;
        await saveSession(latest);
      }
    }
    return c.json({ ok: true, running: Boolean(controller) });
  });

  app.post("/api/sessions/:id/retry", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (runningTurns.has(id)) {
      return c.json({ error: "会话仍在运行。请先停止后再重试。" }, 409);
    }
    if (session.status === "running") {
      await releaseStaleRunningSession(session);
    }
    if (!session.messages.some((m) => m.role === "user" && !m.content.startsWith("[harness]"))) {
      return c.json({ error: "没有可重试的消息。" }, 400);
    }

    session.status = "running";
    session.lastError = undefined;
    session.remoteRetry = undefined;
    await saveSession(session);

    return streamSSE(c, async (stream) => {
      const onEvent = async (event: import("./types.ts").AgentEvent, seq: number) => {
        await stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        });
      };
      await runSessionTurn(session, { onEvent });
    });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (runningTurns.has(id)) {
      return c.json({ error: "会话仍在运行。请先停止后再发送。" }, 409);
    }
    if (session.status === "running") {
      await releaseStaleRunningSession(session);
    }
    const parsed = messageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Message content is required" }, 400);
    }

    const userMsg = prepareUserMessage(session, parsed.data.content);
    await saveSession(session);

    return streamSSE(c, async (stream) => {
      const onEvent = async (event: import("./types.ts").AgentEvent, seq: number) => {
        await stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        });
      };
      const first = await publishPersistedEvent(id, { type: "message", message: userMsg });
      await onEvent(first.event, first.seq);
      await runSessionTurn(session, { onEvent });
    });
  });

  app.post("/api/sessions/:id/team-run", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const parsed = teamRunSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid team-run body" }, 400);
    }
    const { action, content } = parsed.data;

    if (action === "stop") {
      const controller = runningTurns.get(id);
      controller?.abort();
      await waitForTurnRelease(id);
      const latest = (await getSession(id)) ?? session;
      await applyTeamRunStop(latest);
      return c.json({ ok: true, running: Boolean(controller), session: latest });
    }

    if (runningTurns.has(id)) {
      return c.json({ error: "会话仍在运行。请先停止后再发送。" }, 409);
    }
    if (session.status === "running") {
      await releaseStaleRunningSession(session);
    }
    if (session.expertId) {
      return c.json(
        { error: "A pinned expertId overrides the team; unbind the expert to run the chain." },
        400,
      );
    }
    const team = session.expertTeamId ? await getExpertTeam(session.expertTeamId) : null;
    if (!shouldRunSequentialTeam(session, team)) {
      return c.json(
        { error: "Pin a chain expert team (mode=chain) to run members sequentially." },
        400,
      );
    }

    if (action === "continue") {
      if (!hasResumableMember(session.teamRun)) {
        return c.json(
          { error: "没有可继续的小队成员（需要未完成、出错或已取消的成员）。" },
          400,
        );
      }
    } else {
      const prompt = content?.trim();
      if (prompt) {
        prepareUserMessage(session, prompt);
        await saveSession(session);
      } else if (!session.messages.some((m) => m.role === "user" && !m.content.startsWith("[harness]"))) {
        return c.json({ error: "Message content is required to start a team run." }, 400);
      } else {
        session.status = "running";
        session.lastError = undefined;
        await saveSession(session);
      }
    }

    const startedUser = session.messages.filter((m) => m.role === "user").at(-1);

    return streamSSE(c, async (stream) => {
      const onEvent = async (event: import("./types.ts").AgentEvent, seq: number) => {
        await stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        });
      };
      if (action === "start" && startedUser && content?.trim()) {
        const first = await publishPersistedEvent(id, { type: "message", message: startedUser });
        await onEvent(first.event, first.seq);
      }
      await runSessionTurn(session, { onEvent, teamAction: action });
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
