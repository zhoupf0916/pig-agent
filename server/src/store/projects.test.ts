import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { buildSystemPrompt } from "../agent/runtime.ts";
import { resolveProjectInstruction } from "./projects.ts";

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
