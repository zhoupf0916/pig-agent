import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { DEFAULT_SETTINGS } from "../../config.ts";
import { createSession, getSession, saveSession } from "../../store/sessions.ts";
import { releaseStaleRunningSession } from "../turn.ts";
import type { Session, Settings } from "../../types.ts";
import { startCloudControlStub } from "./control-stub.ts";
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
    cloudMode: "local-stub",
    ...extra,
  };
}

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_recover",
    title: "recover",
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

describe("Milestone L remote recoverability", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("shows a Chinese reason when the remote run expired (events 404)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-l-exp-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_expired_1" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_expired_1/events") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "run expired" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    try {
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { cloudMode: "remote", cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(next.status).toBe("error");
      expect(next.lastError).toBe(CLOUD_REMOTE_MESSAGES.run_expired);
      expect(next.remoteRetry).toBe("create-run");
      expect(next.remoteRunId).toBeUndefined();
      expect(next.lastError).not.toContain("sk-");
    } finally {
      await close();
    }
  });

  it("shows a Chinese reason when the SSE disconnects before idle", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-l-disc-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_drop" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_drop/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "run.started" })}\n\n`);
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    try {
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { cloudMode: "remote", cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(next.status).toBe("error");
      expect(next.lastError).toBe(CLOUD_REMOTE_MESSAGES.disconnected);
      expect(next.remoteRetry).toBe("follow-up");
      expect(next.remoteRunId).toBe("run_drop");
    } finally {
      await close();
    }
  });

  it("redacts secrets from create-run error details", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-l-sec-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && (req.url ?? "") === "/v1/runs") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream sk-abcdefghijklmnop leaked" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    try {
      const next = await runCloudAgent({
        session: emptySession(),
        settings: cloudSettings(workspaceRoot, { cloudMode: "remote", cloudBaseUrl: url }),
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(next.status).toBe("error");
      expect(next.lastError).toMatch(/控制面创建运行失败/);
      expect(next.lastError).not.toContain("sk-abcdefghijklmnop");
      expect(next.lastError).not.toContain("sk-host-control-path-secret");
      expect(next.lastError).not.toContain("cp-token-must-not-leak");
      expect(next.remoteRetry).toBe("create-run");
    } finally {
      await close();
    }
  });

  it("aborts a hung SSE without zombie, then the next send can follow-up", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-l-ab-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    let followUps = 0;
    let eventSubs = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/v1/runs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "run_hang_l" }));
        return;
      }
      if (req.method === "GET" && url === "/v1/runs/run_hang_l/events") {
        eventSubs += 1;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "run.started" })}\n\n`);
        if (eventSubs === 1) return;
        res.write(
          `data: ${JSON.stringify({ type: "assistant.message", content: "[stub] follow-up: 再来一轮" })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ type: "run.idle" })}\n\n`);
        res.end();
        return;
      }
      if (req.method === "POST" && url === "/v1/runs/run_hang_l/follow-ups") {
        followUps += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "run_hang_l" }));
        return;
      }
      if (req.method === "POST" && url === "/v1/runs/run_hang_l/abort") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const { url, close } = await listen(server);
    const settings = cloudSettings(workspaceRoot, { cloudMode: "remote", cloudBaseUrl: url });
    const controller = new AbortController();
    const pending = runCloudAgent({
      session: emptySession(),
      settings,
      signal: controller.signal,
      emit: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    const aborted = await pending;
    expect(aborted.status).toBe("idle");
    expect(aborted.lastError).toBeUndefined();
    expect(aborted.messages.some((m) => m.content.includes("已停止"))).toBe(true);
    expect(aborted.remoteRunId).toBe("run_hang_l");

    const again = await runCloudAgent({
      session: {
        ...aborted,
        messages: [
          ...aborted.messages,
          {
            id: "u2",
            role: "user",
            content: "再来一轮",
            createdAt: new Date().toISOString(),
          },
        ],
      },
      settings,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    await close();
    expect(followUps).toBe(1);
    expect(again.status).toBe("idle");
    expect(again.lastError).toBeUndefined();
    expect(again.remoteRunId).toBe("run_hang_l");
    expect(again.messages.some((m) => m.content.includes("再来一轮"))).toBe(true);
  });

  it("retries an expired run by allocating a new create-run", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-l-retry-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "pig-l-retry-runs-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "visible");
    const stub = await startCloudControlStub({ runsRoot });
    try {
      const settings = cloudSettings(workspaceRoot, {
        cloudMode: "remote",
        cloudBaseUrl: stub.url,
      });
      const first = await runCloudAgent({
        session: emptySession(),
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(first.remoteRunId).toBeTruthy();
      stub.runs.get(first.remoteRunId!)!.status = "expired";

      const expired = await runCloudAgent({
        session: {
          ...first,
          remoteRunId: first.remoteRunId,
          messages: [
            ...first.messages,
            {
              id: "u2",
              role: "user",
              content: "过期后再试",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        settings,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      // follow-up 404 → same-turn create-run (already recoverable)
      expect(expired.status).toBe("idle");
      expect(expired.remoteRunId).toBeTruthy();
      expect(expired.remoteRunId).not.toBe(first.remoteRunId);
      expect(expired.messages.some((m) => m.content.includes("accepted workspace"))).toBe(true);
    } finally {
      await stub.close();
    }
  });
});

describe("session retry / zombie HTTP", () => {
  const app = createApp();

  it("releases a stale running session so abort returns idle (no zombie)", async () => {
    const session = await createSession();
    session.status = "running";
    session.messages.push({
      id: "u_stale",
      role: "user",
      content: "先前一轮卡住了",
      createdAt: new Date().toISOString(),
    });
    await saveSession(session);
    expect(await releaseStaleRunningSession(session)).toBe(true);
    expect(session.status).toBe("idle");

    session.status = "running";
    await saveSession(session);
    const res = await app.request(`/api/sessions/${session.id}/abort`, { method: "POST" });
    expect(res.status).toBe(200);
    const latest = await getSession(session.id);
    expect(latest?.status).toBe("idle");
  });

  it("refuses retry without a user message", async () => {
    const empty = await createSession();
    const refused = await app.request(`/api/sessions/${empty.id}/retry`, { method: "POST" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/没有可重试/);
  });
});
