import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { buildSystemPrompt } from "../agent/runtime.ts";
import { DATA_DIR } from "../config.ts";
import { createTodo, resolveProjectInstruction, upsertAsset } from "./projects.ts";
import type { Project, ProjectMessage } from "../types.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("projects collaboration API", () => {
  const app = createApp();

  it("creates, reads, patches, and deletes a project", async () => {
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "调研组", instruction: "始终用中文回复，先列提纲。" }),
    });
    expect(created.status).toBe(201);
    const project = await json<{ id: string; name: string; instruction: string; members: unknown[] }>(created);
    expect(project.name).toBe("调研组");
    expect(project.members.length).toBe(1);

    const listed = await json<{ projects: Array<{ id: string }> }>(await app.request("/api/projects"));
    expect(listed.projects.some((p) => p.id === project.id)).toBe(true);

    const patched = await app.request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "用中文，交付前必须校验。" }),
    });
    expect(patched.status).toBe(200);
    expect((await json<{ instruction: string }>(patched)).instruction).toContain("校验");

    const deleted = await app.request(`/api/projects/${project.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const missing = await app.request(`/api/projects/${project.id}`);
    expect(missing.status).toBe(404);
  });

  it("supports todos, assets, messages, invite inbox, and session binding", async () => {
    const created = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "协作骨架", instruction: "项目指令：先读资产再动手。" }),
      }),
    );

    const todoRes = await app.request(`/api/projects/${created.id}/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "整理笔记", status: "todo" }),
    });
    expect(todoRes.status).toBe(201);
    const todoBody = await json<{ todo: { id: string } }>(todoRes);
    const moved = await app.request(`/api/projects/${created.id}/todos/${todoBody.todo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "doing" }),
    });
    expect(moved.status).toBe(200);
    expect((await json<{ todos: Array<{ status: string }> }>(moved)).todos[0]?.status).toBe("doing");

    const assetRes = await app.request(`/api/projects/${created.id}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "brief.md", content: "# 背景\n只做本机协作 MVP。", mimeType: "text/markdown" }),
    });
    expect(assetRes.status).toBe(201);

    const msgRes = await app.request(`/api/projects/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "先把待办拆开。" }),
    });
    expect(msgRes.status).toBe(201);

    const invite = await app.request(`/api/projects/${created.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "同事" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await json<{ inviteToken: string }>(invite);
    expect(inviteBody.inviteToken.startsWith("inv_")).toBe(true);

    const inbox = await json<{ items: Array<{ id: string; kind: string; read: boolean }>; unread: number }>(
      await app.request("/api/inbox"),
    );
    expect(inbox.unread).toBeGreaterThan(0);
    const inviteItem = inbox.items.find((i) => i.kind === "invite");
    expect(inviteItem).toBeTruthy();
    const read = await app.request(`/api/inbox/${inviteItem!.id}/read`, { method: "POST" });
    expect(read.status).toBe(200);

    const session = await json<{ id: string; projectId?: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: created.id }),
      }),
    );
    expect(session.projectId).toBe(created.id);

    const bound = await json<{ projectId?: string }>(
      await app.request(`/api/sessions/${session.id}`),
    );
    expect(bound.projectId).toBe(created.id);

    const instruction = await resolveProjectInstruction(session.projectId);
    expect(instruction).toContain("先读资产");

    const prompt = await buildSystemPrompt(
      {
        llmBaseUrl: "https://api.deepseek.com/v1",
        llmApiKey: "test",
        llmModel: "deepseek-chat",
        workspaceRoot: "/tmp",
        runtime: "pig",
        codexBinaryPath: "",
        codexModel: "deepseek-flash",
        codexNetworkAccess: false,
        cloudBaseUrl: "",
        cloudToken: "",
        cloudMode: "local-stub",
      },
      { projectInstruction: instruction },
    );
    expect(prompt).toContain("Project instructions");
    expect(prompt).toContain("先读资产");

    const unbound = await app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: null }),
    });
    expect((await json<{ projectId?: string }>(unbound)).projectId).toBeUndefined();
  });
});

describe("project asset / todo session refs after session delete (Milestone AZ)", () => {
  const app = createApp();

  it("clears sourceSessionId and todo sessionId only (title/status/activity stay)", async () => {
    const project = await json<Project>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AZ 会话关联项目" }),
      }),
    );
    const otherProject = await json<Project>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AZ 保留项目" }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", { method: "POST" }),
    );
    const keep = await json<{ id: string }>(
      await app.request("/api/sessions", { method: "POST" }),
    );

    const goneTodo = await json<{ todo: { id: string; title: string; status: string; sessionId?: string } }>(
      await app.request(`/api/projects/${project.id}/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "AZ 已删会话待办", status: "doing", sessionId: session.id }),
      }),
    );
    const keepTodo = await json<{ todo: { id: string; sessionId?: string } }>(
      await app.request(`/api/projects/${project.id}/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "AZ 保留会话待办", status: "todo", sessionId: keep.id }),
      }),
    );
    await createTodo(otherProject.id, { title: "AZ 其他项目待办", status: "done", sessionId: session.id });

    const goneAsset = await upsertAsset(project.id, {
      filename: "brief.md",
      content: Buffer.from("# AZ brief\n来自已删会话。"),
      mimeType: "text/markdown",
      sourceSessionId: session.id,
      sourceArtifactPath: "notes/brief.md",
    });
    const keepAsset = await upsertAsset(project.id, {
      filename: "keep.md",
      content: Buffer.from("# AZ keep\n来自保留会话。"),
      mimeType: "text/markdown",
      sourceSessionId: keep.id,
      sourceArtifactPath: "notes/keep.md",
    });
    const otherAsset = await upsertAsset(otherProject.id, {
      filename: "other.md",
      content: Buffer.from("# AZ other"),
      mimeType: "text/markdown",
      sourceSessionId: session.id,
      sourceArtifactPath: "notes/other.md",
    });
    expect(goneTodo.todo.sessionId).toBe(session.id);
    expect(goneAsset?.asset.sourceSessionId).toBe(session.id);

    const before = await json<Project>(await app.request(`/api/projects/${project.id}`));
    const activityBodies = before.messages.map((m) => m.body);

    const deleted = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const after = await json<Project>(await app.request(`/api/projects/${project.id}`));
    const afterGoneTodo = after.todos.find((t) => t.id === goneTodo.todo.id);
    const afterKeepTodo = after.todos.find((t) => t.id === keepTodo.todo.id);
    const afterGoneAsset = after.assets.find((a) => a.id === goneAsset?.asset.id);
    const afterKeepAsset = after.assets.find((a) => a.id === keepAsset?.asset.id);

    expect(afterGoneTodo).toBeTruthy();
    expect(afterGoneTodo?.sessionId).toBeUndefined();
    expect(afterGoneTodo?.title).toBe("AZ 已删会话待办");
    expect(afterGoneTodo?.status).toBe("doing");
    expect(afterKeepTodo?.sessionId).toBe(keep.id);
    expect(afterKeepTodo?.title).toBe("AZ 保留会话待办");
    expect(afterKeepTodo?.status).toBe("todo");

    expect(afterGoneAsset).toBeTruthy();
    expect(afterGoneAsset?.sourceSessionId).toBeUndefined();
    expect(afterGoneAsset?.filename).toBe("brief.md");
    expect(afterGoneAsset?.sourceArtifactPath).toBe("notes/brief.md");
    expect(afterKeepAsset?.sourceSessionId).toBe(keep.id);

    expect(after.messages.map((m) => m.body)).toEqual(activityBodies);
    expect(after.todos).toHaveLength(before.todos.length);
    expect(after.assets).toHaveLength(before.assets.length);

    const otherAfter = await json<Project>(await app.request(`/api/projects/${otherProject.id}`));
    expect(otherAfter.todos.find((t) => t.title === "AZ 其他项目待办")?.sessionId).toBeUndefined();
    expect(otherAfter.todos.find((t) => t.title === "AZ 其他项目待办")?.status).toBe("done");
    expect(otherAfter.assets.find((a) => a.id === otherAsset?.asset.id)?.sourceSessionId).toBeUndefined();
    expect(otherAfter.assets.find((a) => a.id === otherAsset?.asset.id)?.filename).toBe("other.md");

    expect(JSON.stringify({ after, otherAfter })).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });
});

describe("project message sessionId after session delete (Milestone BA)", () => {
  const app = createApp();

  async function setMessageSessionId(projectId: string, messageId: string, sessionId: string) {
    const file = join(DATA_DIR, "projects", projectId, "project.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Project;
    const row = raw.messages.find((m) => m.id === messageId);
    if (!row) throw new Error(`message ${messageId} not found`);
    row.sessionId = sessionId;
    await writeFile(file, JSON.stringify(raw, null, 2));
  }

  function identity(message: ProjectMessage) {
    return {
      id: message.id,
      kind: message.kind,
      body: message.body,
      createdAt: message.createdAt,
      actorId: message.actorId,
    };
  }

  it("clears message sessionId only (body/kind/timestamp stay; messages stay)", async () => {
    const project = await json<Project>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BA 会话动态项目" }),
      }),
    );
    const otherProject = await json<Project>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "BA 保留项目" }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      }),
    );
    const keep = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      }),
    );

    const goneHandoff = await json<{ messages: ProjectMessage[] }>(
      await app.request(`/api/projects/${project.id}/handoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, note: "BA 请接手已删会话" }),
      }),
    );
    const keepHandoff = await json<{ messages: ProjectMessage[] }>(
      await app.request(`/api/projects/${project.id}/handoffs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: keep.id, note: "BA 请接手保留会话" }),
      }),
    );
    expect(goneHandoff.messages.some((m) => m.kind === "handoff" && m.sessionId === session.id)).toBe(
      true,
    );
    expect(keepHandoff.messages.some((m) => m.kind === "handoff" && m.sessionId === keep.id)).toBe(
      true,
    );

    const goneComment = await json<{ messages: ProjectMessage[] }>(
      await app.request(`/api/projects/${project.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "BA 已删会话评论" }),
      }),
    );
    const goneCommentRow = goneComment.messages.find((m) => m.body === "BA 已删会话评论");
    expect(goneCommentRow).toBeTruthy();
    await setMessageSessionId(project.id, goneCommentRow!.id, session.id);

    const keepComment = await json<{ messages: ProjectMessage[] }>(
      await app.request(`/api/projects/${project.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "BA 保留会话评论" }),
      }),
    );
    const keepCommentRow = keepComment.messages.find((m) => m.body === "BA 保留会话评论");
    expect(keepCommentRow).toBeTruthy();
    await setMessageSessionId(project.id, keepCommentRow!.id, keep.id);

    const plainComment = await json<{ messages: ProjectMessage[] }>(
      await app.request(`/api/projects/${project.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "BA 无会话评论" }),
      }),
    );
    expect(plainComment.messages.find((m) => m.body === "BA 无会话评论")?.sessionId).toBeUndefined();

    const otherComment = await json<{ messages: ProjectMessage[] }>(
      await app.request(`/api/projects/${otherProject.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "BA 其他项目评论" }),
      }),
    );
    const otherCommentRow = otherComment.messages.find((m) => m.body === "BA 其他项目评论");
    expect(otherCommentRow).toBeTruthy();
    await setMessageSessionId(otherProject.id, otherCommentRow!.id, session.id);

    const before = await json<Project>(await app.request(`/api/projects/${project.id}`));
    const beforeIds = before.messages.map((m) => m.id);
    const beforeIdentity = before.messages.map(identity);
    expect(before.messages.some((m) => m.kind === "activity" && m.sessionId === session.id)).toBe(
      true,
    );
    expect(before.messages.find((m) => m.body === "BA 已删会话评论")?.sessionId).toBe(session.id);
    expect(before.messages.find((m) => m.body === "BA 保留会话评论")?.sessionId).toBe(keep.id);

    const deleted = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const after = await json<Project>(await app.request(`/api/projects/${project.id}`));
    expect(after.messages.map((m) => m.id)).toEqual(beforeIds);
    expect(after.messages.map(identity)).toEqual(beforeIdentity);
    expect(after.messages.filter((m) => m.sessionId === session.id)).toEqual([]);
    expect(after.messages.find((m) => m.body === "BA 已删会话评论")?.sessionId).toBeUndefined();
    expect(after.messages.find((m) => m.body === "BA 已删会话评论")?.kind).toBe("comment");
    expect(after.messages.find((m) => m.kind === "handoff" && m.body.includes("BA 请接手已删会话"))?.sessionId).toBeUndefined();
    expect(after.messages.find((m) => m.kind === "handoff" && m.body.includes("BA 请接手保留会话"))?.sessionId).toBe(
      keep.id,
    );
    expect(after.messages.find((m) => m.body === "BA 保留会话评论")?.sessionId).toBe(keep.id);
    expect(after.messages.find((m) => m.body === "BA 无会话评论")?.sessionId).toBeUndefined();
    expect(after.messages.find((m) => m.kind === "activity" && m.body.includes(keep.id))?.sessionId).toBe(
      keep.id,
    );

    const otherAfter = await json<Project>(await app.request(`/api/projects/${otherProject.id}`));
    const otherRow = otherAfter.messages.find((m) => m.body === "BA 其他项目评论");
    expect(otherRow).toBeTruthy();
    expect(otherRow?.sessionId).toBeUndefined();
    expect(otherRow?.kind).toBe("comment");
    expect(otherRow?.body).toBe("BA 其他项目评论");

    expect(JSON.stringify({ after, otherAfter })).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });
});
