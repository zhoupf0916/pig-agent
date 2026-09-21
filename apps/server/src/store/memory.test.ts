import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../agent/runtime.ts";
import { createApp } from "../app.ts";
import {
  MEMORY_PIN_HEADING,
  buildHeuristicRecap,
  clipPinForPrompt,
  formatMemoryPinBlock,
  isPinInScope,
  MAX_PIN_INJECT_CHARS,
} from "./memory.ts";
import { saveSession } from "./sessions.ts";
import type { MemoryNote, Session, Settings } from "../types.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const MARKER = `zxqmil-h-${Date.now().toString(36)}`;

const pigSettings: Settings = {
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
};

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_recap_test",
    title: "整理笔记",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [],
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

describe("memory helpers", () => {
  it("builds a heuristic recap from recent user/assistant text", () => {
    const recap = buildHeuristicRecap(
      emptySession({
        messages: [
          {
            id: "u1",
            role: "user",
            content: "请抽出会议纪要里的 action items",
            createdAt: new Date().toISOString(),
          },
          {
            id: "a1",
            role: "assistant",
            content: "已整理三件待办并写入 notes/todo.txt",
            createdAt: new Date().toISOString(),
          },
          {
            id: "t1",
            role: "tool",
            content: "ok",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(recap).toContain("回合摘要 · 整理笔记");
    expect(recap).toContain("用户：请抽出会议纪要里的 action items");
    expect(recap).toContain("助手：已整理三件待办并写入 notes/todo.txt");
    expect(recap).toContain("未调用模型");
  });

  it("refuses recap when there is no usable transcript", () => {
    expect(() => buildHeuristicRecap(emptySession())).toThrow(/No user or assistant messages/);
  });

  it("scopes pins and clips prompt injection", () => {
    const globalPin: MemoryNote = {
      id: "mem_g",
      kind: "pin",
      text: "全局偏好：始终用中文回复",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const otherSession: MemoryNote = {
      ...globalPin,
      id: "mem_s",
      sessionId: "ses_other",
    };
    const projectPin: MemoryNote = {
      ...globalPin,
      id: "mem_p",
      projectId: "prj_1",
    };
    expect(isPinInScope(globalPin, { sessionId: "ses_1" })).toBe(true);
    expect(isPinInScope(otherSession, { sessionId: "ses_1" })).toBe(false);
    expect(isPinInScope(otherSession, { sessionId: "ses_other" })).toBe(true);
    expect(isPinInScope(projectPin, { projectId: "prj_1" })).toBe(true);
    expect(isPinInScope(projectPin, { projectId: "prj_2" })).toBe(false);

    const long = "x".repeat(MAX_PIN_INJECT_CHARS + 40);
    expect(clipPinForPrompt(long).endsWith("…")).toBe(true);
    expect(clipPinForPrompt(long).length).toBeLessThanOrEqual(MAX_PIN_INJECT_CHARS);

    const block = formatMemoryPinBlock(["API 用 DeepSeek", ""]);
    expect(block.startsWith(MEMORY_PIN_HEADING)).toBe(true);
    expect(block).toContain("- API 用 DeepSeek");
    expect(formatMemoryPinBlock([])).toBe("");
  });
});

describe("memory API", () => {
  const app = createApp();

  it("creates, lists, patches, and deletes a pin", async () => {
    const created = await json<MemoryNote>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "pin",
          text: `${MARKER} 钉住：默认用 DeepSeek`,
          tags: ["llm", "pref"],
        }),
      }),
    );
    expect(created.id.startsWith("mem_")).toBe(true);
    expect(created.kind).toBe("pin");
    expect(created.tags).toEqual(["llm", "pref"]);

    const listed = await json<{ notes: MemoryNote[] }>(await app.request("/api/memory?kind=pin"));
    expect(listed.notes.some((n) => n.id === created.id)).toBe(true);

    const got = await json<MemoryNote>(await app.request(`/api/memory/${created.id}`));
    expect(got.text).toContain("DeepSeek");

    const patched = await json<MemoryNote>(
      await app.request(`/api/memory/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${MARKER} 钉住：改用 mock-local` }),
      }),
    );
    expect(patched.text).toContain("mock-local");

    const deleted = await app.request(`/api/memory/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await app.request(`/api/memory/${created.id}`)).status).toBe(404);
  });

  it("rejects empty text and unknown ids", async () => {
    const bad = await app.request("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(bad.status).toBe(400);

    expect((await app.request("/api/memory/mem_missing")).status).toBe(404);
    expect((await app.request("/api/memory/../etc", { method: "DELETE" })).status).toBe(404);
  });

  it("writes a session recap from recent messages without an LLM", async () => {
    const session = await json<Session>(await app.request("/api/sessions", { method: "POST" }));
    session.title = `${MARKER} 会话`;
    session.messages.push({
      id: "msg_recap_u",
      role: "user",
      content: `请根据 ${MARKER}-recap-needle 写一份纪要`,
      createdAt: new Date().toISOString(),
    });
    session.messages.push({
      id: "msg_recap_a",
      role: "assistant",
      content: `已写好 ${MARKER}-recap-answer`,
      createdAt: new Date().toISOString(),
    });
    await saveSession(session);

    const recap = await json<MemoryNote>(
      await app.request(`/api/sessions/${session.id}/recap`, { method: "POST" }),
    );
    expect(recap.kind).toBe("recap");
    expect(recap.sessionId).toBe(session.id);
    expect(recap.text).toContain(`${MARKER}-recap-needle`);
    expect(recap.text).toContain("未调用模型");

    const empty = await json<Session>(await app.request("/api/sessions", { method: "POST" }));
    const refused = await app.request(`/api/sessions/${empty.id}/recap`, { method: "POST" });
    expect(refused.status).toBe(400);

    const missing = await app.request("/api/sessions/ses_nope/recap", { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("injects recent in-scope pins into the pig system prompt", async () => {
    const created = await json<MemoryNote>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "pin", text: `${MARKER} 偏好：始终引用路径` }),
      }),
    );

    const prompt = await buildSystemPrompt(pigSettings, {
      memoryPins: [created.text],
    });
    expect(prompt).toContain(MEMORY_PIN_HEADING);
    expect(prompt).toContain(`${MARKER} 偏好：始终引用路径`);
    expect(prompt.indexOf(MEMORY_PIN_HEADING)).toBeLessThan(prompt.indexOf("Suggested skills"));

    const bare = await buildSystemPrompt(pigSettings, {});
    expect(bare).not.toContain(MEMORY_PIN_HEADING);

    await app.request(`/api/memory/${created.id}`, { method: "DELETE" });
  });
});

describe("memory refs after project / session delete (Milestone AV)", () => {
  const app = createApp();

  it("clears memory projectId after deleting that project (body/tags stay)", async () => {
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AV 已删项目", instruction: "项目指令" }),
      }),
    );
    const keep = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AV 保留项目" }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      }),
    );
    const pinned = await json<MemoryNote>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "pin",
          text: `${MARKER} AV 钉住已删项目`,
          tags: ["av", "project"],
          projectId: project.id,
          sessionId: session.id,
        }),
      }),
    );
    const other = await json<MemoryNote>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "pin",
          text: `${MARKER} AV 钉住保留项目`,
          tags: ["keep"],
          projectId: keep.id,
        }),
      }),
    );
    expect(pinned.projectId).toBe(project.id);
    expect(pinned.sessionId).toBe(session.id);

    const deleted = await app.request(`/api/projects/${project.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const after = await json<MemoryNote>(await app.request(`/api/memory/${pinned.id}`));
    expect(after.projectId).toBeUndefined();
    expect(after.sessionId).toBe(session.id);
    expect(after.text).toBe(pinned.text);
    expect(after.tags).toEqual(["av", "project"]);

    const listed = await json<{ notes: MemoryNote[] }>(await app.request("/api/memory"));
    expect(listed.notes.find((n) => n.id === pinned.id)?.projectId).toBeUndefined();
    expect((await json<MemoryNote>(await app.request(`/api/memory/${other.id}`))).projectId).toBe(keep.id);
    expect(JSON.stringify(after)).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });

  it("clears memory sessionId after deleting that session (body/tags stay)", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    const keep = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "AV 会话关联项目" }),
      }),
    );
    const pinned = await json<MemoryNote>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "recap",
          text: `${MARKER} AV 摘要已删会话`,
          tags: ["recap", "av"],
          sessionId: session.id,
          projectId: project.id,
        }),
      }),
    );
    const other = await json<MemoryNote>(
      await app.request("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "pin",
          text: `${MARKER} AV 钉住保留会话`,
          sessionId: keep.id,
        }),
      }),
    );
    expect(pinned.sessionId).toBe(session.id);

    const deleted = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const after = await json<MemoryNote>(await app.request(`/api/memory/${pinned.id}`));
    expect(after.sessionId).toBeUndefined();
    expect(after.projectId).toBe(project.id);
    expect(after.text).toBe(pinned.text);
    expect(after.tags).toEqual(["recap", "av"]);

    const listed = await json<{ notes: MemoryNote[] }>(await app.request("/api/memory"));
    expect(listed.notes.find((n) => n.id === pinned.id)?.sessionId).toBeUndefined();
    expect((await json<MemoryNote>(await app.request(`/api/memory/${other.id}`))).sessionId).toBe(keep.id);
    expect(JSON.stringify(after)).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });
});
