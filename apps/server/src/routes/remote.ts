import type { Hono } from "hono";
import { newId, nowIso } from "../util.ts";
import {
  loadWorkbench,
  saveWorkbench,
  stageOperation,
} from "../store/workbench.ts";
import { createSession } from "../store/sessions.ts";
import { loadSettings, normalizeCloudBaseUrl } from "../store/settings.ts";
import { createHash } from "node:crypto";
import { planeJson } from "../control-plane/client.ts";
import { getSession, saveSession } from "../store/sessions.ts";
import { reconcileRemoteSession } from "../control-plane/run-state.ts";
import type { Session } from "../types.ts";
import { planeFetch, createPlaneClient } from "../control-plane/client.ts";

/** Narrow same-origin bridge for the shared Web/Electron UI; no arbitrary URL proxy. */
export function registerRemoteRoutes(app: Hono): void {
  app.post("/api/remote/stage-artifacts/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^run_[a-zA-Z0-9]+$/.test(id))
      return c.json({ error: "运行标识无效" }, 400);
    try {
      const settings = await loadSettings();
      const plane = createPlaneClient(settings);
      const run = await plane.json<{ state: string }>(`/v1/runs/${id}`);
      if (!["succeeded", "failed", "cancelled"].includes(run.state))
        return c.json({ error: "请等待远端运行结束" }, 409);
      const { artifacts } = await plane.json<{
        artifacts: Array<{ id: string; path: string; size: number }>;
      }>(`/v1/runs/${id}/artifacts`);
      if (!artifacts.length || artifacts.length > 100)
        return c.json({ error: "没有可导入的文本成果" }, 400);
      const files = [];
      for (const artifact of artifacts) {
        if (!/^[a-zA-Z0-9_-]+$/.test(artifact.id))
          throw Error("Invalid artifact");
        const r = await plane.fetch(`/v1/runs/${id}/artifacts/${artifact.id}`);
        if (!r.ok) throw Error("Artifact unavailable");
        const content = await r.text();
        if (content.length > 200000) throw Error("Artifact too large");
        files.push({ path: artifact.path, content });
      }
      const session = await createSession();
      session.executionTarget = "local";
      session.engine = "pig";
      session.deliveryMode = true;
      session.title = "审阅远端成果 · " + id.slice(-8);
      session.messages.push({
        id: newId("msg"),
        role: "assistant",
        content: `已从远端运行 ${id} 提取 ${files.length} 份成果，生成独立的本机变更单。请核对下方文件差异和目标工作区；批准之前不会写入本机。远端快照保持不变。`,
        createdAt: nowIso(),
      });
      const state = await loadWorkbench(session.id, settings.workspaceRoot);
      state.policy.review = true;
      state.policy.shell = "host";
      for (let i = 0; i < files.length; i++)
        await stageOperation(state, `${id}:${i}`, "write_file", files[i]!);
      await saveWorkbench(session.id, state);
      await saveSession(session);
      return c.json({ id: session.id, count: files.length });
    } catch {
      return c.json({ error: "无法生成导入变更单；本地文件未被修改" }, 502);
    }
  });
  app.post("/api/remote/accept-invite", async (c) => {
    const body = await c.req.json();
    if (
      typeof body.baseUrl !== "string" ||
      typeof body.invite !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.invite)
    )
      return c.json({ error: "邀请码或地址无效" }, 400);
    try {
      const base = normalizeCloudBaseUrl(body.baseUrl);
      const url = new URL(base);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return c.json({ error: "控制面地址无效" }, 400);
      const r = await fetch(base + "/auth/accept-invite", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite: body.invite }),
        signal: AbortSignal.timeout(15000),
      });
      c.header("Cache-Control", "no-store");
      return new Response(r.body, {
        status: r.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return c.json({ error: "控制面无法连接" }, 502);
    }
  });
  app.post("/api/remote/import/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^conv_[a-zA-Z0-9]+$/.test(id))
      return c.json({ error: "会话标识无效" }, 400);
    try {
      const data = await planeJson<{
        conversation: {
          id: string;
          title: string;
          created_at: string;
          owner_id: string;
        };
        runs: Array<{ id: string }>;
      }>(`/v1/conversations/${id}`);
      const latest = data.runs.at(-1);
      if (!latest) return c.json({ error: "会话没有运行记录" }, 409);
      const localId =
        "ses_remote_" +
        createHash("sha256")
          .update(data.conversation.owner_id + ":" + id)
          .digest("hex")
          .slice(0, 24);
      const cached = await getSession(localId);
      const session: Session = cached || {
        id: localId,
        title: data.conversation.title,
        createdAt: data.conversation.created_at,
        updatedAt: new Date().toISOString(),
        status: "idle",
        messages: [],
        steps: [],
        artifacts: [],
      };
      session.executionTarget = "remote";
      session.engine = "pig";
      session.remoteRunId = latest.id;
      await reconcileRemoteSession(session);
      await saveSession(session);
      return c.json({ id: localId });
    } catch {
      return c.json({ error: "无法恢复控制面会话，请检查连接和账号" }, 502);
    }
  });
  app.all("/api/remote/*", async (c) => {
    const path = c.req.path.slice("/api/remote".length);
    const allowed =
      (c.req.method === "GET" &&
        /^\/v1\/runs\/[a-zA-Z0-9_-]+\/approvals$/.test(path)) ||
      (c.req.method === "POST" &&
        /^\/v1\/runs\/[a-zA-Z0-9_-]+\/approvals\/[a-zA-Z0-9_-]+\/decision$/.test(
          path,
        )) ||
      (c.req.method === "GET" &&
        /^\/v1\/(spaces(?:\/[a-zA-Z0-9_-]+\/members)?|shared-projects(?:\/[a-zA-Z0-9_-]+\/runs)?)$/.test(
          path,
        )) ||
      (c.req.method === "POST" &&
        /^\/v1\/(spaces(?:\/join|\/[a-zA-Z0-9_-]+\/invitations)?|shared-projects)$/.test(
          path,
        )) ||
      (["PATCH", "DELETE"].includes(c.req.method) &&
        /^\/v1\/spaces\/[a-zA-Z0-9_-]+\/members\/[a-zA-Z0-9_-]+$/.test(path)) ||
      (c.req.method === "GET" &&
        /^\/v1\/conversations(?:\/[a-zA-Z0-9_-]+(?:\/workspace\/[a-zA-Z0-9_-]+)?)?$/.test(
          path,
        )) ||
      (c.req.method === "GET" &&
        /^\/(health|v1\/runs(?:\/[a-zA-Z0-9_-]+(?:\/events|\/eventlog|\/artifacts(?:\/[a-zA-Z0-9_-]+)?)?)?|v1\/schedules\/[a-zA-Z0-9_-]+\/history)$/.test(
          path,
        )) ||
      (c.req.method === "POST" &&
        /^\/v1\/runs(?:\/[a-zA-Z0-9_-]+\/abort)?$/.test(path));
    if (!allowed)
      return c.json({ error: "Unsupported control-plane operation" }, 404);
    try {
      const headers: Record<string, string> = {};
      const key = c.req.header("Idempotency-Key");
      if (key) headers["Idempotency-Key"] = key;
      const after = c.req.query("after");
      const response = await planeFetch(
        path + (after ? `?after=${encodeURIComponent(after)}` : ""),
        {
          method: c.req.method,
          headers,
          body: ["POST", "PATCH"].includes(c.req.method)
            ? await c.req.text()
            : undefined,
          // Dropping a stream only unsubscribes. Explicit POST abort cancels a run.
          signal: path.endsWith("/events") ? c.req.raw.signal : undefined,
        },
      );
      const outgoing = new Headers();
      for (const name of [
        "content-type",
        "content-disposition",
        "cache-control",
        "x-content-type-options",
      ])
        if (response.headers.has(name))
          outgoing.set(name, response.headers.get(name)!);
      return new Response(response.body, {
        status: response.status,
        headers: outgoing,
      });
    } catch {
      return c.json(
        {
          error:
            "无法连接控制面，请检查地址、令牌和服务状态；远端任务不会因此停止",
        },
        502,
      );
    }
  });
}
