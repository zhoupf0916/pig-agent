import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import { CREATE_RUN_PROGRESS } from "./create-run-progress.ts";
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

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_w_progress",
    title: "progress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "整理工作区并写一份报告",
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

describe("Milestone W create-run progress", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("emits Chinese create-run steps then hands off to the stream (idle)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-w-ok-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_w_ok" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_w_ok/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "run.started" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "assistant.message", content: "已完成" })}\n\n`);
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
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
      });

      const firstSteps = titlesAt(events, 0);
      expect(firstSteps).toContain(CREATE_RUN_PROGRESS.snapshot.title);
      expect(stepEvents(events).some((e) => e.type === "steps" && e.steps.some((s) => s.title === CREATE_RUN_PROGRESS.create.title))).toBe(
        true,
      );
      expect(
        stepEvents(events).some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === CREATE_RUN_PROGRESS.subscribe.title),
        ),
      ).toBe(true);

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
      expect(next.steps.some((s) => s.id.startsWith("create-run:"))).toBe(false);
      expect(next.messages.some((m) => m.content.includes("已完成"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("create-run failure uses L retry (error, not running) and keeps secrets out of chips", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-w-fail-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    let creates = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        creates += 1;
        if (creates === 1) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream sk-abcdefghijklmnop leaked" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_w_retry" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_w_retry/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "assistant.message", content: "重试成功" })}\n\n`);
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
        session: emptySession(),
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(failed.status).toBe("error");
      expect(failed.status).not.toBe("running");
      expect(failed.lastError).toMatch(/控制面创建运行失败/);
      expect(failed.lastError).not.toContain("sk-abcdefghijklmnop");
      expect(failed.remoteRetry).toBe("create-run");
      expect(failed.remoteRunId).toBeUndefined();
      expect(failed.steps.some((s) => s.status === "error" && s.title === CREATE_RUN_PROGRESS.create.title)).toBe(
        true,
      );
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
      expect(retried.messages.some((m) => m.content.includes("重试成功"))).toBe(true);
      expect(creates).toBe(2);
    } finally {
      await close();
    }
  });

  it("abort during hung create-run returns idle (no zombie running)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-w-ab-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && (req.url ?? "") === "/v1/runs") {
        // Stay open until the host AbortSignal cancels the request.
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    const controller = new AbortController();
    const pending = runCloudAgent({
      session: emptySession(),
      settings: cloudSettings(workspaceRoot, { cloudBaseUrl: url }),
      signal: controller.signal,
      emit: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    const next = await pending;
    await close();
    expect(next.status).toBe("idle");
    expect(next.lastError).toBeUndefined();
    expect(next.remoteRetry).toBeUndefined();
    expect(next.steps.every((s) => s.status !== "running")).toBe(true);
    expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(true);
  });

  it("surfaces the existing Chinese timeout on create-run (L path, not running)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-w-to-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((_req: IncomingMessage, _res: ServerResponse) => {
      // Never write headers.
    });
    const { url, close } = await listen(server);
    try {
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: () => undefined,
        timeoutMs: 80,
      });
      expect(next.status).toBe("error");
      expect(next.lastError).toBe(CLOUD_REMOTE_MESSAGES.control_plane_timeout);
      expect(next.remoteRetry).toBe("create-run");
      expect(next.steps.some((s) => s.status === "error")).toBe(true);
    } finally {
      await close();
    }
  });
});
