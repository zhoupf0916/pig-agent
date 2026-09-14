import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createMemory } from "../store/memory.ts";
import { createExpert, createExpertTeam } from "../store/experts.ts";
import { createSession, saveSession } from "../store/sessions.ts";
import { firstResumableIndex, hasResumableMember, shouldRunSequentialTeam } from "../store/team-run-state.ts";
import { loadSettings, saveSettings } from "../store/settings.ts";
import { getSession } from "../store/sessions.ts";
import type { AgentEvent, ExpertTeam, Session, Settings, TeamRun } from "../types.ts";
import { runAgent } from "./runtime.ts";
import { runSequentialTeamTurn, wrapMemberEmit } from "./team-run.ts";

function pigSettings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "test",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "pig",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "",
    cloudMode: "local-stub",
    ...extra,
  };
}

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startScriptedLlm(
  script: Array<(reqBody: string, res: ServerResponse) => void | { keepOpen: true }>,
): Promise<{ url: string; close: () => Promise<void>; bodies: string[] }> {
  const bodies: string[] = [];
  let turn = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      bodies.push(raw);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const handler = script[Math.min(turn, script.length - 1)];
      turn += 1;
      const result = handler?.(raw, res);
      if (result && typeof result === "object" && result.keepOpen) return;
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        bodies,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_team_test",
    title: "小队测试",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "摸清工作区并给出下一步",
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function makeChainPair(): Promise<{ team: ExpertTeam; scoutId: string; planId: string }> {
  const scout = await createExpert({
    name: "测试侦察",
    instruction: "UNIQUE_SCOUT_INSTRUCTION: only look, never write.",
    kind: "scout",
  });
  const plan = await createExpert({
    name: "测试规划",
    instruction: "UNIQUE_PLAN_INSTRUCTION: write a plan, do not implement.",
    kind: "plan",
  });
  const team = await createExpertTeam({
    name: "测试接力",
    mode: "chain",
    expertIds: [scout.id, plan.id],
  });
  return { team, scoutId: scout.id, planId: plan.id };
}

function cancelledTeamRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    teamId: "team_x",
    teamName: "x",
    strategy: "same-session",
    status: "cancelled",
    currentIndex: 0,
    members: [
      { expertId: "a", name: "A", kind: "scout", status: "done" },
      { expertId: "b", name: "B", kind: "plan", status: "cancelled" },
    ],
    startedAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("firstResumableIndex", () => {
  it("treats cancelled members as resumable after a stop", () => {
    const stopped = cancelledTeamRun();
    expect(hasResumableMember(stopped)).toBe(true);
    expect(firstResumableIndex(stopped)).toBe(1);
  });

  it("skips finished members and resumes from the first cancelled or error", () => {
    const mixed = cancelledTeamRun({
      members: [
        { expertId: "a", name: "A", kind: "scout", status: "done" },
        { expertId: "b", name: "B", kind: "plan", status: "cancelled" },
        { expertId: "c", name: "C", kind: "implement", status: "cancelled" },
      ],
    });
    expect(firstResumableIndex(mixed)).toBe(1);
  });

  it("returns length when every member is done", () => {
    const done = cancelledTeamRun({
      status: "done",
      members: [
        { expertId: "a", name: "A", kind: "scout", status: "done" },
        { expertId: "b", name: "B", kind: "plan", status: "done" },
      ],
    });
    expect(hasResumableMember(done)).toBe(false);
    expect(firstResumableIndex(done)).toBe(2);
  });
});

describe("shouldRunSequentialTeam", () => {
  it("requires chain mode and no expertId", () => {
    const team: ExpertTeam = {
      id: "team_x",
      name: "x",
      description: "",
      mode: "chain",
      expertIds: ["a", "b"],
      bundled: false,
      createdAt: "",
      updatedAt: "",
    };
    expect(shouldRunSequentialTeam(emptySession({ expertTeamId: "team_x" }), team)).toBe(true);
    expect(
      shouldRunSequentialTeam(emptySession({ expertTeamId: "team_x", expertId: "a" }), team),
    ).toBe(false);
    expect(shouldRunSequentialTeam(emptySession({ expertTeamId: "team_x" }), { ...team, mode: "parallel" })).toBe(
      false,
    );
  });
});

describe("wrapMemberEmit", () => {
  it("drops per-member done and keeps status running", () => {
    const events: AgentEvent["type"][] = [];
    const emit = wrapMemberEmit((e) => events.push(e.type));
    emit({ type: "status", status: "idle" });
    emit({ type: "done", session: emptySession() });
    emit({ type: "token", text: "x" });
    expect(events).toEqual(["status", "token"]);
  });
});

describe("runSequentialTeamTurn", () => {
  it("runs each chain member as its own pig turn with project + memory pins", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-team-"));
    const { team } = await makeChainPair();
    const project = await json<{ id: string }>(
      await createApp().request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "小队项目", instruction: "PROJECT_PIN_UNIQUE: 先核对再改。" }),
      }),
    );
    const session = await createSession({ projectId: project.id, expertTeamId: team.id });
    session.messages = emptySession().messages;
    session.title = "小队测试";
    await saveSession(session);
    await createMemory({
      kind: "pin",
      text: "MEMORY_PIN_UNIQUE: 默认用中文回复。",
      sessionId: session.id,
      projectId: project.id,
    });

    const mock = await startScriptedLlm([
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "侦察完成：只有笔记，没有代码。" } }] });
      },
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "规划：先列目录再写摘要。" } }] });
      },
    ]);

    const events: AgentEvent["type"][] = [];
    try {
      const next = await runSequentialTeamTurn(session, {
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        runtime: "pig",
        signal: new AbortController().signal,
        emit: (e) => events.push(e.type),
        flush: async () => undefined,
        runner: runAgent,
        action: "start",
      });

      expect(mock.bodies).toHaveLength(2);
      expect(mock.bodies[0]).toContain("UNIQUE_SCOUT_INSTRUCTION");
      expect(mock.bodies[0]).not.toContain("UNIQUE_PLAN_INSTRUCTION");
      expect(mock.bodies[1]).toContain("UNIQUE_PLAN_INSTRUCTION");
      expect(mock.bodies[1]).not.toContain("UNIQUE_SCOUT_INSTRUCTION");
      for (const body of mock.bodies) {
        expect(body).toContain("PROJECT_PIN_UNIQUE");
        expect(body).toContain("MEMORY_PIN_UNIQUE");
        expect(body).toContain("sequential same-session");
      }

      expect(next.status).toBe("idle");
      expect(next.teamRun?.strategy).toBe("same-session");
      expect(next.teamRun?.status).toBe("done");
      expect(next.teamRun?.members.map((m) => m.status)).toEqual(["done", "done"]);
      expect(next.messages.some((m) => m.content.startsWith("[team]") && m.content.includes("开始"))).toBe(
        true,
      );
      expect(next.messages.some((m) => m.content.includes("侦察完成"))).toBe(true);
      expect(next.messages.some((m) => m.content.includes("规划："))).toBe(true);
      expect(events.filter((t) => t === "team_run").length).toBeGreaterThan(2);
      expect(events.at(-1)).toBe("done");
    } finally {
      await mock.close();
    }
  });

  it("continues from the first pending member", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-team-cont-"));
    const { team, scoutId, planId } = await makeChainPair();
    const session = await createSession({ expertTeamId: team.id });
    session.messages = emptySession().messages;
    session.teamRun = {
      teamId: team.id,
      teamName: team.name,
      strategy: "same-session",
      status: "cancelled",
      currentIndex: 1,
      members: [
        { expertId: scoutId, name: "测试侦察", kind: "scout", status: "done" },
        { expertId: planId, name: "测试规划", kind: "plan", status: "pending" },
      ],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveSession(session);

    const mock = await startScriptedLlm([
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "只做规划这一步。" } }] });
      },
    ]);

    try {
      const next = await runSequentialTeamTurn(session, {
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        runtime: "pig",
        signal: new AbortController().signal,
        emit: () => undefined,
        flush: async () => undefined,
        runner: runAgent,
        action: "continue",
      });
      expect(mock.bodies).toHaveLength(1);
      expect(mock.bodies[0]).toContain("UNIQUE_PLAN_INSTRUCTION");
      expect(mock.bodies[0]).not.toContain("UNIQUE_SCOUT_INSTRUCTION");
      expect(next.teamRun?.members.map((m) => m.status)).toEqual(["done", "done"]);
      expect(next.teamRun?.status).toBe("done");
    } finally {
      await mock.close();
    }
  });

  it("continues from the first cancelled member after a stop", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-team-cont-cancel-"));
    const { team, scoutId, planId } = await makeChainPair();
    const session = await createSession({ expertTeamId: team.id });
    session.messages = emptySession().messages;
    session.teamRun = {
      teamId: team.id,
      teamName: team.name,
      strategy: "same-session",
      status: "cancelled",
      currentIndex: 1,
      members: [
        { expertId: scoutId, name: "测试侦察", kind: "scout", status: "done" },
        { expertId: planId, name: "测试规划", kind: "plan", status: "cancelled", detail: "Stopped" },
      ],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveSession(session);

    const mock = await startScriptedLlm([
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "从取消处继续规划。" } }] });
      },
    ]);

    try {
      const next = await runSequentialTeamTurn(session, {
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        runtime: "pig",
        signal: new AbortController().signal,
        emit: () => undefined,
        flush: async () => undefined,
        runner: runAgent,
        action: "continue",
      });
      expect(mock.bodies).toHaveLength(1);
      expect(mock.bodies[0]).toContain("UNIQUE_PLAN_INSTRUCTION");
      expect(mock.bodies[0]).not.toContain("UNIQUE_SCOUT_INSTRUCTION");
      expect(next.teamRun?.members.map((m) => m.status)).toEqual(["done", "done"]);
      expect(next.teamRun?.status).toBe("done");
    } finally {
      await mock.close();
    }
  });

  it("cancels remaining members when aborted mid-chain", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-team-ab-"));
    const { team } = await makeChainPair();
    const session = await createSession({ expertTeamId: team.id });
    session.messages = emptySession().messages;
    await saveSession(session);

    let secondStarted!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });

    const mock = await startScriptedLlm([
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "侦察先结束。" } }] });
      },
      (_raw, _res) => {
        secondStarted();
        return { keepOpen: true };
      },
    ]);

    const controller = new AbortController();
    const pending = runSequentialTeamTurn(session, {
      settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
      runtime: "pig",
      signal: controller.signal,
      emit: () => undefined,
      flush: async () => undefined,
      runner: runAgent,
      action: "start",
    });

    await secondGate;
    controller.abort();
    const next = await pending;
    await mock.close();

    expect(next.status).toBe("idle");
    expect(next.teamRun?.members[0]?.status).toBe("done");
    expect(next.teamRun?.members[1]?.status).toBe("cancelled");
    expect(next.teamRun?.status).toBe("cancelled");

    const resumeMock = await startScriptedLlm([
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "中断后继续第二步。" } }] });
      },
    ]);
    try {
      const resumed = await runSequentialTeamTurn(next, {
        settings: pigSettings(workspaceRoot, { llmBaseUrl: resumeMock.url }),
        runtime: "pig",
        signal: new AbortController().signal,
        emit: () => undefined,
        flush: async () => undefined,
        runner: runAgent,
        action: "continue",
      });
      expect(resumeMock.bodies).toHaveLength(1);
      expect(resumed.teamRun?.members.map((m) => m.status)).toEqual(["done", "done"]);
      expect(resumed.teamRun?.status).toBe("done");
    } finally {
      await resumeMock.close();
    }
  });
});

describe("POST /api/sessions/:id/team-run", () => {
  const app = createApp();

  it("rejects start without a chain team or prompt", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    const missing = await app.request(`/api/sessions/${session.id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", content: "hello" }),
    });
    expect(missing.status).toBe(400);

    const empty = await json<{ id: string; expertTeamId?: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertTeamId: "team_coding" }),
      }),
    );
    const noPrompt = await app.request(`/api/sessions/${empty.id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    expect(noPrompt.status).toBe(400);

    const withExpert = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertTeamId: "team_coding", expertId: "exp_scout" }),
      }),
    );
    const blocked = await app.request(`/api/sessions/${withExpert.id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", content: "go" }),
    });
    expect(blocked.status).toBe(400);
  });

  it("rejects continue without a paused run and accepts stop", async () => {
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertTeamId: "team_coding" }),
      }),
    );
    const cont = await app.request(`/api/sessions/${session.id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "continue" }),
    });
    expect(cont.status).toBe(400);

    const stop = await app.request(`/api/sessions/${session.id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    expect(stop.status).toBe(200);
    const body = await json<{ ok: boolean; session: { teamRun?: TeamRun } }>(stop);
    expect(body.ok).toBe(true);
  });

  it("returns 200 for continue after start then stop when members are cancelled", async () => {
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const mock = await startScriptedLlm([
      (_raw, _res) => {
        firstStarted();
        return { keepOpen: true };
      },
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "停止后继续第一步。" } }] });
      },
      (_raw, res) => {
        sse(res, { choices: [{ delta: { content: "停止后继续第二步。" } }] });
      },
    ]);
    const prevSettings = await loadSettings();
    await saveSettings({ llmBaseUrl: mock.url, llmApiKey: "test", runtime: "pig" });
    try {
      const { team } = await makeChainPair();
      const session = await json<{ id: string }>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expertTeamId: team.id }),
        }),
      );

      const startPromise = app.request(`/api/sessions/${session.id}/team-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", content: "摸清工作区并给出下一步" }),
      });

      await firstGate;
      const stop = await app.request(`/api/sessions/${session.id}/team-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      expect(stop.status).toBe(200);
      const stopped = await json<{ session: Session }>(stop);
      expect(stopped.session.teamRun?.members.some((m) => m.status === "cancelled")).toBe(true);

      const startRes = await startPromise;
      expect(startRes.status).toBe(200);

      const afterStop = await getSession(session.id);
      expect(afterStop?.status).not.toBe("running");
      expect(afterStop?.teamRun?.members.some((m) => m.status === "cancelled")).toBe(true);
      expect(hasResumableMember(afterStop?.teamRun)).toBe(true);

      const cont = await app.request(`/api/sessions/${session.id}/team-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue" }),
      });
      expect(cont.status).toBe(200);
      expect(cont.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    } finally {
      await saveSettings(prevSettings);
      await mock.close();
    }
  });

  it("rejects a parallel team", async () => {
    const { scoutId, planId } = await makeChainPair();
    const created = await json<{ id: string }>(
      await app.request("/api/expert-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "并行组",
          mode: "parallel",
          expertIds: [scoutId, planId],
        }),
      }),
    );
    const session = await json<{ id: string }>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertTeamId: created.id }),
      }),
    );
    const res = await app.request(`/api/sessions/${session.id}/team-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", content: "go" }),
    });
    expect(res.status).toBe(400);
  });
});
