import { reconcileRemoteSession, isRemoteActive } from "./control-plane/run-state.ts";
import { planeJson } from "./control-plane/client.ts";
import { registerRemoteRoutes } from "./routes/remote.ts";
import { registerConnectionTest } from "./routes/connection-test.ts";
import { registerWorkbenchRoutes } from "./routes/workbench.ts";
import { loadWorkbench } from "./store/workbench.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { resolveInWorkspace } from "./agent/sandbox.ts";
import { listSkills } from "./agent/skills.ts";
import { applyTeamRunStop } from "./agent/team-run.ts";
import {
  hasRetryableUserGoal,
  rewindToLastUserGoal,
} from "./agent/local-errors.ts";
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
import { clearAutomationLastSessionId } from "./store/automations.ts";
import { clearInboxSessionRefs } from "./store/inbox.ts";
import { clearMemoryRefs } from "./store/memory.ts";
import { clearProjectSessionRefs, recordSessionBound } from "./store/projects.ts";
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
  codexApiKey: z.string().optional(),
  codexBaseUrl: z.string().url().refine(value => /^https?:\/\//.test(value), "HTTP(S) URL required").optional(),
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
  clientMessageId: z.string().uuid().optional(),
});

const teamRunSchema = z.object({
  action: z.enum(["start", "continue", "stop"]).default("start"),
  content: z.string().min(1).max(20_000).optional(),
  clientMessageId: z.string().uuid().optional(),
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

  registerWorkbenchRoutes(app);
  registerConnectionTest(app);

  app.get("/api/health", (c) => c.json({ ok: true, name: "pig-agent" }));

  app.post("/api/settings/codex/use-pig-key", async c => {
    const settings = await loadSettings();
    if (!settings.llmApiKey) return c.json({ error: "尚未配置 Pig 密钥。" }, 400);
    try {
      if (new URL(settings.llmBaseUrl).origin !== new URL(settings.codexBaseUrl || "https://api.deepseek.com/").origin) return c.json({ error: "两个运行时的提供商地址不同，请单独填写 Codex 密钥。" }, 400);
    } catch { return c.json({ error: "请先保存有效的模型接口地址。" }, 400); }
    return c.json(publicSettings(await saveSettings({ codexApiKey: settings.llmApiKey })));
  });

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
  registerRemoteRoutes(app);
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
    const defaults = await loadSettings();
    // Retain the legacy stub only when explicitly chosen in global settings.
    if (defaults.runtime !== "cloud" || defaults.cloudMode === "remote") {
      session.executionTarget = defaults.runtime === "cloud" ? "remote" : "local";
      session.engine = defaults.runtime === "codex" ? "codex" : "pig";
      await saveSession(session);
    }
    if (projectId) await recordSessionBound(projectId, session.id);
    return c.json(session, 201);
  });

  app.get("/api/sessions/:id", async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.remoteState && session.remoteRunId && !runningTurns.has(session.id)) {
      try { await reconcileRemoteSession(session); await saveSession(session); }
      catch { session.lastError = "控制面暂不可用，远端状态未确认"; }
    }
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
      executionTarget?: "local" | "remote";
      engine?: "pig" | "codex";
    };
    if (body.executionTarget !== undefined || body.engine !== undefined) {
      if (runningTurns.has(session.id) || session.status === "running") return c.json({error:"运行期间不能切换执行配置"},409);
      if (session.remoteState && isRemoteActive(session.remoteState)) {
        try {await reconcileRemoteSession(session);} catch {return c.json({error:"先恢复控制面连接并确认远端运行已结束"},409);}
        if (isRemoteActive(session.remoteState)) return c.json({error:"远端仍在运行，不能切换执行配置"},409);
      }
      const target = body.executionTarget ?? session.executionTarget ?? "local";
      const engine = body.engine ?? session.engine ?? "pig";
      if (!["local","remote"].includes(target) || !["pig","codex"].includes(engine) || (target === "remote" && engine !== "pig")) return c.json({error:"当前远端仅支持 Pig 引擎"},400);
      if (target !== session.executionTarget) {delete session.remoteRunId;delete session.remoteState;delete session.remoteRetry;}
      session.executionTarget = target;
      session.engine = engine;
    }
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
    await clearMemoryRefs("sessionId", c.req.param("id"));
    await clearAutomationLastSessionId(c.req.param("id"));
    await clearInboxSessionRefs(c.req.param("id"));
    await clearProjectSessionRefs(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    const before = await getSession(id);
    if (before?.remoteState && before.remoteRunId && !runningTurns.has(id)) {
      try {
        await planeJson(`/v1/runs/${encodeURIComponent(before.remoteRunId)}/abort`,{method:"POST"});
        await reconcileRemoteSession(before); await saveSession(before);
        return c.json({ok:true,running:isRemoteActive(before.remoteState)});
      } catch { return c.json({error:"控制面未确认停止，请从远端运行记录核验"},502); }
    }
    const controller = runningTurns.get(id);
    controller?.abort();
    await waitForTurnRelease(id);
    const session = await getSession(id);
    if (session && session.status === "running" && !session.remoteState && !runningTurns.has(id)) {
      await applyTeamRunStop(session);
      const latest = (await getSession(id)) ?? session;
      if (latest.status === "running") {
        latest.status = "idle";
        latest.lastError = undefined;
        latest.remoteRetry = undefined;
        latest.localRetry = undefined;
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
      if (session.status === "running") return c.json({error:"远端任务仍在执行，请先查看或取消该运行"},409);
    }
    if (!hasRetryableUserGoal(session)) {
      session.localRetry = "unavailable";
      session.lastError = session.lastError ?? "无法重试本轮。没有可重试的用户目标。";
      await saveSession(session);
      return c.json({ error: "没有可重试的消息。", localRetry: "unavailable" }, 400);
    }

    const pigDelivery = (await loadSettings()).runtime === "pig";
    if (pigDelivery) session.deliveryMode = true;
    // Pig resumes checkpoints; other runtimes retain their existing retry protocol.
    if (!session.remoteRetry && !pigDelivery) {
      rewindToLastUserGoal(session);
    }

    if (pigDelivery) {
      const settings = await loadSettings();
      const state = await loadWorkbench(id, settings.workspaceRoot);
      if (state.operations.some((op) => op.status === "pending" || op.status === "applying" || op.status === "error")) return c.json({ error: "请先处理待批准或待核对的操作。" }, 409);
      const answered = new Set(session.messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
      for (const message of [...session.messages]) for (const call of message.toolCalls ?? []) if (!answered.has(call.id)) {
        const op = state.operations.find((item) => item.callId === call.id);
        session.messages.push({ id: `recovered_${call.id}`, role: "tool", toolCallId: call.id, toolOk: op?.status === "applied", content: op?.output ?? "执行被中断，结果未知；先检查磁盘，不要直接重放修改或命令。", createdAt: new Date().toISOString() });
      }
    }
    session.status = "running";
    session.lastError = undefined;
    session.remoteRetry = undefined;
    session.localRetry = undefined;
    await saveSession(session);

    return streamSSE(c, async (stream) => {
      const onEvent = async (event: import("./types.ts").AgentEvent, seq: number) => {
        await stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        }).catch(() => undefined); // A detached client must not interrupt execution or persistence.
      };
      await runSessionTurn(session, { onEvent, teamAction: session.teamRun ? "continue" : undefined });
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
      if (session.status === "running") return c.json({error:"远端任务仍在执行，请先查看或取消该运行"},409);
    }
    const parsed = messageSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Message content is required" }, 400);
    }

    if (parsed.data.clientMessageId && session.messages.some((m) => m.id === parsed.data.clientMessageId)) {
      return c.json({ error: "这条消息已接收，请查看会话结果，不要重复发送。" }, 409);
    }
    session.deliveryMode = true;
    const userMsg = prepareUserMessage(session, parsed.data.content, parsed.data.clientMessageId);
    await saveSession(session);

    return streamSSE(c, async (stream) => {
      const onEvent = async (event: import("./types.ts").AgentEvent, seq: number) => {
        await stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        }).catch(() => undefined); // A detached client must not interrupt execution or persistence.
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
    const { action, content, clientMessageId } = parsed.data;

    if (action === "stop" && (session.remoteState || session.executionTarget === "remote")) {
      return c.json({error:"远端任务请使用取消运行接口"},409);
    }
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
      if (session.status === "running") return c.json({error:"远端任务仍在执行，请先查看或取消该运行"},409);
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
        if (clientMessageId && session.messages.some((m) => m.id === clientMessageId)) {
          return c.json({ error: "这条消息已接收，请查看会话结果，不要重复发送。" }, 409);
        }
        prepareUserMessage(session, prompt, clientMessageId);
        await saveSession(session);
      } else if (!session.messages.some((m) => m.role === "user" && !m.content.startsWith("[harness]"))) {
        return c.json({ error: "Message content is required to start a team run." }, 400);
      } else {
        session.status = "running";
        session.lastError = undefined;
        session.localRetry = undefined;
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
        }).catch(() => undefined); // A detached client must not interrupt execution or persistence.
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
