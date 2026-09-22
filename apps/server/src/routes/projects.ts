import { mutateProjectWorkspace } from "../store/projects.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  acceptInboxInvite,
  acceptProjectInvite,
  addAsset,
  addProjectMessage,
  createHandoff,
  createProject,
  createTodo,
  declineInboxInvite,
  deleteProject,
  deleteTodo,
  getProject,
  inviteMember,
  listProjects,
  ProjectInviteError,
  recordSessionBound,
  removeProjectMember,
  revokeProjectInvite,
  updateProject,
  updateTodo,
} from "../store/projects.ts";
import {
  ArtifactSaveError,
  recentSavableArtifactPaths,
  saveAllSessionArtifactsToProject,
} from "../store/artifacts-to-project.ts";
import {
  buildAssetPreview,
  contentDisposition,
  findProjectAsset,
  readAssetBytes,
} from "../store/asset-preview.ts";
import { clearAutomationPins } from "../store/automations.ts";
import { listInbox, markInboxRead, removeInboxItemsForProject } from "../store/inbox.ts";
import { clearMemoryRefs } from "../store/memory.ts";
import { createSession, getSession, listSessions, saveSession } from "../store/sessions.ts";

import { loadSettings } from "../store/settings.ts";

const createSchema = z.object({
  workspaceRoot: z.string().max(4096).optional(),
  name: z.string().min(1).max(120),
  instruction: z.string().max(20_000).optional(),
});

const patchSchema = z.object({
  workspaceRoot: z.string().max(4096).optional(),
  name: z.string().min(1).max(120).optional(),
  instruction: z.string().max(20_000).optional(),
});

const todoCreateSchema = z.object({
  title: z.string().min(1).max(240),
  status: z.enum(["todo", "doing", "done"]).optional(),
  sessionId: z.string().optional(),
});

const todoPatchSchema = z.object({
  title: z.string().min(1).max(240).optional(),
  status: z.enum(["todo", "doing", "done"]).optional(),
  sessionId: z.string().nullable().optional(),
});

const messageSchema = z.object({
  body: z.string().min(1).max(8_000),
});

const inviteSchema = z.object({
  displayName: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
});

const redeemSchema = z.object({
  token: z.string().min(1).max(120),
});

const handoffSchema = z.object({
  sessionId: z.string().min(1),
  note: z.string().max(4_000).optional(),
  artifactPaths: z.array(z.string().min(1).max(500)).max(20).optional(),
  attachRecentArtifacts: z.boolean().optional(),
});

const assetSchema = z.object({
  filename: z.string().min(1).max(240),
  content: z.string().max(2_000_000).optional(),
  contentBase64: z.string().max(2_800_000).optional(),
  mimeType: z.string().max(120).optional(),
});

function fail(err: unknown): { error: string; status: 400 | 404 | 409 } {
  if (err instanceof ProjectInviteError) return { error: err.message, status: err.status };
  return { error: err instanceof Error ? err.message : String(err), status: 400 };
}

export function registerProjectRoutes(app: Hono): void {
  app.get("/api/projects", async (c) => {
    return c.json({ projects: await listProjects() });
  });

  app.post("/api/projects", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "name is required" }, 400);
    try { const project = await createProject(parsed.data); return c.json(project, 201); }
    catch (err) { const e = fail(err); return c.json({error:e.error},e.status); }
  });

  app.get("/api/projects/:id", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const sessions = (await listSessions()).filter((s) => s.projectId === project.id);
    return c.json({ ...project, effectiveWorkspaceRoot: project.workspaceRoot || (await loadSettings()).workspaceRoot, sessions });
  });

  app.patch("/api/projects/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid project patch" }, 400);
    let project;
    try { project = await updateProject(c.req.param("id"), parsed.data); }
    catch (err) { const e = fail(err); return c.json({error:e.error},e.status); }
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json(project);
  });

  app.delete("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await deleteProject(id);
    if (!ok) return c.json({ error: "Project not found" }, 404);
    const sessions = await listSessions();
    for (const summary of sessions) {
      if (summary.projectId !== id) continue;
      const session = await getSession(summary.id);
      if (!session) continue;
      delete session.projectId;
      await saveSession(session);
    }
    await clearAutomationPins("projectId", id);
    await clearMemoryRefs("projectId", id);
    await removeInboxItemsForProject(id);
    return c.json({ ok: true });
  });

  app.post("/api/projects/:id/workspaces", async c => {
    const parsed = z.object({path:z.string().min(1).max(4096),name:z.string().trim().min(1).max(120).optional(),setDefault:z.boolean().optional()}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"工作区参数无效"},400);
    try { const project = await mutateProjectWorkspace(c.req.param("id"),undefined,parsed.data); return project ? c.json(project,201) : c.json({error:"项目不存在"},404); }
    catch(err) {const e=fail(err);return c.json({error:e.error},e.status);}
  });
  app.patch("/api/projects/:id/workspaces/:workspaceId", async c => {
    const parsed = z.object({path:z.string().min(1).max(4096).optional(),name:z.string().trim().min(1).max(120).optional(),setDefault:z.boolean().optional()}).strict().safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:"工作区参数无效"},400);
    try { const project = await mutateProjectWorkspace(c.req.param("id"),c.req.param("workspaceId"),parsed.data); return project ? c.json(project) : c.json({error:"项目不存在"},404); }
    catch(err) {const e=fail(err);return c.json({error:e.error},e.status);}
  });
  app.delete("/api/projects/:id/workspaces/:workspaceId", async c => {
    try { const project = await mutateProjectWorkspace(c.req.param("id"),c.req.param("workspaceId"),{},true); return project ? c.json(project) : c.json({error:"项目不存在"},404); }
    catch(err) {const e=fail(err);return c.json({error:e.error},e.status);}
  });

  app.get("/api/projects/:id/members", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const pendingInvites = project.invites.filter((i) => i.status === "pending");
    return c.json({
      members: project.members,
      invites: project.invites,
      pendingInvites,
      inviteToken: pendingInvites.at(-1)?.token ?? project.inviteToken,
    });
  });

  app.post("/api/projects/:id/members", async (c) => {
    const parsed = inviteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid invite" }, 400);
    const result = await inviteMember(c.req.param("id"), parsed.data);
    if (!result) return c.json({ error: "Project not found" }, 404);
    return c.json({
      inviteToken: result.inviteToken,
      invite: result.invite,
      members: result.project.members,
      invites: result.project.invites,
      inboxItem: result.inboxItem,
    }, 201);
  });

  app.delete("/api/projects/:id/members/:memberId", async (c) => {
    try {
      const project = await removeProjectMember(c.req.param("id"), c.req.param("memberId"));
      if (!project) return c.json({ error: "Project not found" }, 404);
      return c.json({ members: project.members });
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.post("/api/projects/:id/invites/redeem", async (c) => {
    const parsed = redeemSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "请粘贴邀请令牌" }, 400);
    try {
      const result = await acceptProjectInvite(c.req.param("id"), { token: parsed.data.token });
      if (!result) return c.json({ error: "Project not found" }, 404);
      return c.json({
        project: result.project,
        invite: result.invite,
        member: result.member,
      });
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.delete("/api/projects/:id/invites/:inviteId", async (c) => {
    try {
      const result = await revokeProjectInvite(c.req.param("id"), c.req.param("inviteId"));
      if (!result) return c.json({ error: "Project not found" }, 404);
      return c.json({
        invite: result.invite,
        members: result.project.members,
        invites: result.project.invites,
      });
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/projects/:id/todos", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ todos: project.todos });
  });

  app.post("/api/projects/:id/todos", async (c) => {
    const parsed = todoCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "title is required" }, 400);
    try {
      const project = await createTodo(c.req.param("id"), parsed.data);
      if (!project) return c.json({ error: "Project not found" }, 404);
      return c.json({ todos: project.todos, todo: project.todos.at(-1) }, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.patch("/api/projects/:id/todos/:todoId", async (c) => {
    const parsed = todoPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid todo patch" }, 400);
    const project = await updateTodo(c.req.param("id"), c.req.param("todoId"), parsed.data);
    if (!project) return c.json({ error: "Todo not found" }, 404);
    return c.json({ todos: project.todos });
  });

  app.delete("/api/projects/:id/todos/:todoId", async (c) => {
    const project = await deleteTodo(c.req.param("id"), c.req.param("todoId"));
    if (!project) return c.json({ error: "Todo not found" }, 404);
    return c.json({ todos: project.todos });
  });

  app.get("/api/projects/:id/assets", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ assets: project.assets });
  });

  app.post("/api/projects/:id/assets", async (c) => {
    const parsed = assetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "filename is required" }, 400);
    let buffer: Buffer;
    if (parsed.data.contentBase64) {
      buffer = Buffer.from(parsed.data.contentBase64, "base64");
    } else {
      buffer = Buffer.from(parsed.data.content ?? "", "utf8");
    }
    if (buffer.length === 0) return c.json({ error: "asset content is required" }, 400);
    if (buffer.length > 1_500_000) return c.json({ error: "asset too large (1.5MB max)" }, 400);
    const result = await addAsset(c.req.param("id"), {
      filename: parsed.data.filename,
      content: buffer,
      mimeType: parsed.data.mimeType,
    });
    if (!result) return c.json({ error: "Project not found" }, 404);
    return c.json({ asset: result.asset, assets: result.project.assets }, 201);
  });

  app.get("/api/projects/:id/assets/:assetId/download", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const asset = findProjectAsset(project, c.req.param("assetId"));
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    const buf = await readAssetBytes(project.id, asset);
    if (!buf) return c.json({ error: "Asset file is missing on disk" }, 404);
    const inline = c.req.query("inline") === "1" || c.req.query("inline") === "true";
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": asset.mimeType || "application/octet-stream",
        "Content-Disposition": contentDisposition(asset.filename, inline ? "inline" : "attachment"),
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=0",
      },
    });
  });

  app.get("/api/projects/:id/assets/:assetId", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const asset = findProjectAsset(project, c.req.param("assetId"));
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    try {
      return c.json(await buildAssetPreview(project.id, asset));
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.get("/api/projects/:id/messages", async (c) => {
    const project = await getProject(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ messages: project.messages });
  });

  app.post("/api/projects/:id/messages", async (c) => {
    const parsed = messageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "body is required" }, 400);
    try {
      const project = await addProjectMessage(c.req.param("id"), parsed.data.body);
      if (!project) return c.json({ error: "Project not found" }, 404);
      return c.json({ messages: project.messages }, 201);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.post("/api/projects/:id/handoffs", async (c) => {
    const parsed = handoffSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "sessionId is required" }, 400);
    const projectId = c.req.param("id");
    const session = await getSession(parsed.data.sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const wantAttach =
      Boolean(parsed.data.attachRecentArtifacts) || (parsed.data.artifactPaths?.length ?? 0) > 0;
    let attached: Array<{ artifactPath: string; asset: { id: string; filename: string } }> = [];
    let skipped: Array<{ artifactPath: string; reason: string }> = [];
    if (wantAttach) {
      if (session.projectId !== projectId) {
        return c.json({ error: "Session is not bound to this project" }, 400);
      }
      const paths =
        parsed.data.artifactPaths && parsed.data.artifactPaths.length > 0
          ? parsed.data.artifactPaths
          : recentSavableArtifactPaths(session);
      try {
        const copied = await saveAllSessionArtifactsToProject(session, { paths });
        attached = copied.saved;
        skipped = copied.skipped;
      } catch (err) {
        if (err instanceof ArtifactSaveError) {
          return c.json({ error: err.message }, err.status);
        }
        const { error, status } = fail(err);
        return c.json({ error }, status);
      }
    }

    const result = await createHandoff(projectId, {
      sessionId: parsed.data.sessionId,
      note: parsed.data.note,
      assetIds: attached.map((a) => a.asset.id),
    });
    if (!result) return c.json({ error: "Project not found" }, 404);
    return c.json(
      {
        inboxItem: result.inboxItem,
        messages: result.project.messages,
        assets: result.project.assets,
        attached,
        skipped,
      },
      201,
    );
  });

  app.post("/api/projects/:id/sessions", async (c) => {
    const id = c.req.param("id");
    const project = await getProject(id);
    if (!project) return c.json({ error: "Project not found" }, 404);
    const parsed = z.object({workspaceId:z.string().min(1).max(120).optional()}).strict().safeParse(await c.req.json().catch(()=>({})));
    if (!parsed.success) return c.json({error:"工作区参数无效"},400);
    let session;
    try { session = await createSession({ projectId: id, workspaceId: parsed.data.workspaceId }); }
    catch(err) {const e=fail(err);return c.json({error:e.error},e.status);}
    await recordSessionBound(id, session.id);
    return c.json(session, 201);
  });

  app.get("/api/inbox", async (c) => {
    const items = await listInbox();
    return c.json({
      items,
      unread: items.filter((i) => !i.read).length,
    });
  });

  app.post("/api/inbox/:id/read", async (c) => {
    const item = await markInboxRead(c.req.param("id"));
    if (!item) return c.json({ error: "Inbox item not found" }, 404);
    return c.json(item);
  });

  app.post("/api/inbox/:id/accept", async (c) => {
    try {
      const result = await acceptInboxInvite(c.req.param("id"));
      if (!result) return c.json({ error: "Inbox item not found" }, 404);
      return c.json(result);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });

  app.post("/api/inbox/:id/decline", async (c) => {
    try {
      const result = await declineInboxInvite(c.req.param("id"));
      if (!result) return c.json({ error: "Inbox item not found" }, 404);
      return c.json(result);
    } catch (err) {
      const { error, status } = fail(err);
      return c.json({ error }, status);
    }
  });
}
