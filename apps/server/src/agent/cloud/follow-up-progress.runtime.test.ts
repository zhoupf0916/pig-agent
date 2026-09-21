import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import { CREATE_RUN_PROGRESS, FOLLOW_UP_PROGRESS } from "./create-run-progress.ts";
import { CLOUD_REMOTE_MESSAGES } from "./errors.ts";
import { runCloudAgent } from "./runtime.ts";

function cloudSettings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "sk-host-control-path-secret",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "cloud",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "cp-token-must-not-leak",
    cloudMode: "remote",
    ...extra,
  };
}

function liveSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_x_progress",
    title: "follow-up progress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    remoteRunId: "run_x_live",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "再写一个文件",
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function stepEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === "steps");
}

function titlesAt(events: AgentEvent[], index: number): string[] {
  const ev = stepEvents(events)[index];
  return ev && ev.type === "steps" ? ev.steps.map((s) => s.title) : [];
}

describe("Milestone X follow-up / reconnect progress", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("emits Chinese follow-up/reconnect steps then hands off (no W create-run chips)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-x-ok-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    let creates = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        creates += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_should_not_create" }));
        return;
      }
      if (req.method === "POST" && url === "/v1/runs/run_x_live/follow-ups") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "run_x_live" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_x_live/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "run.started" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "assistant.message", content: "已跟进" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "run.idle" })}\n\n`);
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    try {
      const events: AgentEvent[] = [];
      const next = await runCloudAgent({
        session: liveSession(),
        settings: cloudSettings(workspaceRoot, { cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
      });

      expect(creates).toBe(0);
      const firstSteps = titlesAt(events, 0);
      expect(firstSteps).toContain(FOLLOW_UP_PROGRESS.followup.title);
      expect(firstSteps).not.toContain(CREATE_RUN_PROGRESS.snapshot.title);
      expect(firstSteps).not.toContain(CREATE_RUN_PROGRESS.create.title);
      expect(
        stepEvents(events).some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === FOLLOW_UP_PROGRESS.reconnect.title),
        ),
      ).toBe(true);
      expect(
        stepEvents(events).some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === CREATE_RUN_PROGRESS.create.title),
        ),
      ).toBe(false);

      const firstProgress = events.findIndex((e) => e.type === "steps");
      const firstLive = events.findIndex(
        (e) => e.type === "message" || e.type === "token" || e.type === "tool_start",
      );
      expect(firstProgress).toBeGreaterThanOrEqual(0);
      expect(firstLive).toBeGreaterThan(firstProgress);

      expect(JSON.stringify(stepEvents(events))).not.toContain("sk-host-control-path-secret");
      expect(JSON.stringify(stepEvents(events))).not.toContain("cp-token-must-not-leak");
      expect(next.status).toBe("idle");
      expect(next.lastError).toBeUndefined();
      expect(next.remoteRunId).toBe("run_x_live");
      expect(next.steps.some((s) => s.id.startsWith("follow-up:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("create-run:"))).toBe(false);
      expect(next.messages.some((m) => m.content.includes("已跟进"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("follow-up failure uses L retry (error, not running) and keeps secrets out of chips", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-x-fail-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    let follows = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs/run_x_live/follow-ups") {
        follows += 1;
        if (follows === 1) {
          // Hang until host timeout so L keeps remoteRunId (follow-up retry).
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "run_x_live" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_x_live/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "assistant.message", content: "重试跟进成功" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "run.idle" })}\n\n`);
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    const settings = cloudSettings(workspaceRoot, { cloudBaseUrl: url });
    try {
      const failed = await runCloudAgent({
        session: liveSession(),
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
        timeoutMs: 80,
      });
      expect(failed.status).toBe("error");
      expect(failed.status).not.toBe("running");
      expect(failed.lastError).toBe(CLOUD_REMOTE_MESSAGES.control_plane_timeout);
      expect(failed.remoteRetry).toBe("follow-up");
      expect(failed.remoteRunId).toBe("run_x_live");
      expect(failed.steps.some((s) => s.status === "error" && s.title === FOLLOW_UP_PROGRESS.followup.title)).toBe(
        true,
      );
      expect(failed.steps.some((s) => s.title === CREATE_RUN_PROGRESS.create.title)).toBe(false);
      expect(JSON.stringify(failed.steps)).not.toContain("sk-abcdefghijklmnop");
      expect(JSON.stringify(failed.steps)).not.toContain("sk-host-control-path-secret");
      expect(JSON.stringify(failed.steps)).not.toContain("cp-token-must-not-leak");

      const retried = await runCloudAgent({
        session: {
          ...failed,
          lastError: undefined,
          remoteRetry: undefined,
        },
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(retried.status).toBe("idle");
      expect(retried.lastError).toBeUndefined();
      expect(retried.remoteRetry).toBeUndefined();
      expect(retried.remoteRunId).toBe("run_x_live");
      expect(retried.messages.some((m) => m.content.includes("重试跟进成功"))).toBe(true);
      expect(follows).toBe(2);
    } finally {
      await close();
    }
  });

  it("does not claim stopped when control plane rejects cancellation", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-x-ab-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && (req.url ?? "") === "/v1/runs/run_x_live/follow-ups") {
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    const controller = new AbortController();
    const pending = runCloudAgent({
      session: liveSession(),
      settings: cloudSettings(workspaceRoot, { cloudBaseUrl: url }),
      signal: controller.signal,
      emit: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    const next = await pending;
    await close();
    expect(next.status).toBe("error");
    expect(next.lastError).toContain("停止请求尚未获控制面确认");
    expect(next.remoteState).toBeUndefined(); // Never invent a control-plane state.
    expect(next.remoteRunId).toBe("run_x_live");
    expect(next.steps.every((s) => s.status !== "running")).toBe(true);
    expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(false);
  });

  it("expired follow-up falls back to W create-run chips (catalogs do not mix)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-x-exp-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    let creates = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs/run_x_live/follow-ups") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "gone" }));
        return;
      }
      if (req.method === "POST" && url === "/v1/runs") {
        creates += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_x_fresh" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_x_fresh/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "assistant.message", content: "新运行" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "run.idle" })}\n\n`);
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    try {
      const events: AgentEvent[] = [];
      const next = await runCloudAgent({
        session: liveSession(),
        settings: cloudSettings(workspaceRoot, { cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
      });

      expect(creates).toBe(1);
      const dumped = JSON.stringify(stepEvents(events));
      expect(dumped).toContain(CREATE_RUN_PROGRESS.snapshot.title);
      expect(dumped).toContain(CREATE_RUN_PROGRESS.create.title);
      expect(dumped).toContain(CREATE_RUN_PROGRESS.subscribe.title);
      const createPhase = stepEvents(events).find(
        (e) => e.type === "steps" && e.steps.some((s) => s.id === CREATE_RUN_PROGRESS.create.id),
      );
      expect(createPhase && createPhase.type === "steps").toBe(true);
      if (createPhase && createPhase.type === "steps") {
        expect(createPhase.steps.some((s) => s.id.startsWith("follow-up:"))).toBe(false);
      }
      expect(next.status).toBe("idle");
      expect(next.remoteRunId).toBe("run_x_fresh");
      expect(next.steps.some((s) => s.id.startsWith("follow-up:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("create-run:"))).toBe(false);
      expect(next.messages.some((m) => m.content.includes("新运行"))).toBe(true);
    } finally {
      await close();
    }
  });
});
