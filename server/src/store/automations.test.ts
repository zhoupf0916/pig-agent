import { afterEach, describe, expect, it } from "vitest";
import {
  resetAutomationRuns,
  runAutomation,
  setAutomationTurnForTests,
  tickDueAutomations,
} from "../automations/run.ts";
import { createApp } from "../app.ts";
import type { Session } from "../types.ts";
import { BUNDLED_SCOUT_ID } from "./bundled-experts.ts";
import { updateAutomation } from "./automations.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function idleTurn(session: Session): Promise<Session> {
  session.status = "idle";
  session.lastError = undefined;
  return Promise.resolve(session);
}

describe("local automations", () => {
  const app = createApp();

  afterEach(() => {
    setAutomationTurnForTests(null);
    resetAutomationRuns();
  });

  it("creates, lists, patches, and deletes an automation", async () => {
    const created = await app.request("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "每日整理",
        prompt: "整理工作区并写一份简报",
        schedule: "@daily",
        expertId: BUNDLED_SCOUT_ID,
      }),
    });
    expect(created.status).toBe(201);
    const automation = await json<{
      id: string;
      runtime: string;
      enabled: boolean;
      schedule: string | null;
      saveArtifactsToProject?: boolean;
    }>(created);
    expect(automation.runtime).toBe("pig");
    expect(automation.enabled).toBe(true);
    expect(automation.schedule).toBe("@daily");
    expect(automation.saveArtifactsToProject).toBe(false);

    const listed = await json<{ automations: Array<{ id: string }> }>(
      await app.request("/api/automations"),
    );
    expect(listed.automations.some((a) => a.id === automation.id)).toBe(true);

    const patched = await app.request(`/api/automations/${automation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, schedule: null }),
    });
    expect(patched.status).toBe(200);
    const next = await json<{ enabled: boolean; schedule: string | null }>(patched);
    expect(next.enabled).toBe(false);
    expect(next.schedule).toBeNull();

    const deleted = await app.request(`/api/automations/${automation.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await app.request(`/api/automations/${automation.id}`)).status).toBe(404);
  });

  it("rejects an invalid cron schedule", async () => {
    const res = await app.request("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "坏计划", prompt: "x", schedule: "every tuesday" }),
    });
    expect(res.status).toBe(400);
  });

  it("manual run creates a session, pins expert/project, and records lastSessionId", async () => {
    setAutomationTurnForTests(idleTurn);
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "自动化项目", instruction: "项目指令" }),
      }),
    );
    const created = await json<{ id: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "手动跑",
          prompt: "搜索笔记并写一份中文摘要",
          schedule: null,
          expertId: BUNDLED_SCOUT_ID,
          projectId: project.id,
        }),
      }),
    );

    const run = await app.request(`/api/automations/${created.id}/run`, { method: "POST" });
    expect(run.status).toBe(202);
    const body = await json<{
      automation: { lastSessionId?: string; lastRunAt?: string; runtime: string };
      session: { id: string; expertId?: string; projectId?: string; messages: Array<{ content: string }> };
    }>(run);
    expect(body.automation.runtime).toBe("pig");
    expect(body.automation.lastSessionId).toBe(body.session.id);
    expect(body.automation.lastRunAt).toBeTruthy();
    expect(body.session.expertId).toBe(BUNDLED_SCOUT_ID);
    expect(body.session.projectId).toBe(project.id);
    expect(body.session.messages[0]?.content).toContain("中文摘要");

    const session = await json<{ expertId?: string; projectId?: string }>(
      await app.request(`/api/sessions/${body.session.id}`),
    );
    expect(session.expertId).toBe(BUNDLED_SCOUT_ID);
    expect(session.projectId).toBe(project.id);
  });

  it("skips an overlapping run of the same automation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setAutomationTurnForTests(async (session) => {
      await gate;
      session.status = "idle";
      return session;
    });

    const created = await json<{ id: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "重叠", prompt: "先不要结束" }),
      }),
    );

    const first = runAutomation(created.id);
    await new Promise((r) => setTimeout(r, 20));
    const second = await app.request(`/api/automations/${created.id}/run`, { method: "POST" });
    expect(second.status).toBe(409);
    release();
    const result = await first;
    expect(result.session.id).toBeTruthy();
  });

  it("scheduler fires a due @hourly automation with a fake clock", async () => {
    setAutomationTurnForTests(idleTurn);
    const created = await json<{ id: string; createdAt: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "整点",
          prompt: "每小时扫一眼工作区",
          schedule: "@hourly",
          enabled: true,
        }),
      }),
    );
    const hourAgo = new Date();
    hourAgo.setHours(hourAgo.getHours() - 1, 0, 0, 0);
    await updateAutomation(created.id, { lastRunAt: hourAgo.toISOString() });

    const now = new Date();
    now.setMinutes(0, 0, 0);
    const started = await tickDueAutomations(now);
    expect(started).toContain(created.id);

    const again = await tickDueAutomations(now);
    expect(again).not.toContain(created.id);

    const got = await json<{ lastSessionId?: string; lastRunAt?: string }>(
      await app.request(`/api/automations/${created.id}`),
    );
    expect(got.lastSessionId).toBeTruthy();
    expect(got.lastRunAt).toBeTruthy();
  });

  it("does not schedule a disabled or manual-only automation", async () => {
    setAutomationTurnForTests(idleTurn);
    const manual = await json<{ id: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "仅手动", prompt: "p", schedule: null }),
      }),
    );
    const disabled = await json<{ id: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "关掉",
          prompt: "p",
          schedule: "@hourly",
          enabled: false,
        }),
      }),
    );
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const started = await tickDueAutomations(now);
    expect(started).not.toContain(manual.id);
    expect(started).not.toContain(disabled.id);
  });

  it("auto-saves artifacts after a successful run only when saveArtifactsToProject is set", async () => {
    const { getProject } = await import("./projects.ts");
    const { nowIso } = await import("../util.ts");
    setAutomationTurnForTests(async (session) => {
      session.status = "idle";
      session.lastError = undefined;
      session.artifacts = [{ path: "notes/todo.txt", action: "modified", updatedAt: nowIso() }];
      return session;
    });
    const project = await json<{ id: string }>(
      await app.request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "自动归档" }),
      }),
    );
    const off = await json<{ id: string }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "默认不归档",
          prompt: "写一份简报",
          projectId: project.id,
        }),
      }),
    );
    const on = await json<{ id: string; saveArtifactsToProject?: boolean }>(
      await app.request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "归档产物",
          prompt: "写一份简报",
          projectId: project.id,
          saveArtifactsToProject: true,
        }),
      }),
    );
    expect(on.saveArtifactsToProject).toBe(true);

    await runAutomation(off.id, { wait: true });
    expect((await getProject(project.id))?.assets ?? []).toHaveLength(0);

    await runAutomation(on.id, { wait: true });
    const assets = (await getProject(project.id))?.assets ?? [];
    expect(assets.some((a) => a.sourceArtifactPath === "notes/todo.txt")).toBe(true);
  });
});
