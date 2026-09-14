import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { DEFAULT_SETTINGS } from "../config.ts";
import { createSession, getSession, saveSession } from "../store/sessions.ts";
import { loadSettings, saveSettings } from "../store/settings.ts";
import type { AgentEvent, Session, Settings } from "../types.ts";
import { LOCAL_TURN_MESSAGES } from "./local-errors.ts";
import { isTurnActive, runningTurns } from "./turn.ts";
import { runAgent } from "./runtime.ts";

function pigSettings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "sk-host-must-not-leak-to-banner",
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

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_m_rec",
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

function sse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function toolDelta(
  res: ServerResponse,
  calls: Array<{ id: string; name: string; args: unknown }>,
): void {
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
  });
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function startScriptedLlm(
  script: Array<(reqBody: string, res: ServerResponse) => boolean | void>,
): Promise<{ url: string; close: () => Promise<void> }> {
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
      const handler = script[Math.min(turn, script.length - 1)];
      turn += 1;
      const handled = handler?.(raw, res);
      if (handled === false) return;
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return listen(server);
}

describe("Milestone M local-turn recoverability", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("shows a Chinese reason for a bad key and returns idle (not running)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-m-key-"));
    const mock = await startScriptedLlm([
      (_raw, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Authentication Fails sk-abcdefghijklmnop" } }));
        return false;
      },
    ]);
    try {
      const events: AgentEvent["type"][] = [];
      const next = await runAgent({
        session: emptySession(),
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e.type),
      });
      expect(next.status).toBe("idle");
      expect(next.lastError).toBe(LOCAL_TURN_MESSAGES.bad_key);
      expect(next.localRetry).toBe("turn");
      expect(next.lastError).not.toContain("sk-");
      expect(next.lastError).not.toContain("sk-abcdefghijklmnop");
      expect(next.lastError).not.toContain("sk-host-must-not-leak-to-banner");
      expect(events).toContain("error");
      expect(events).toContain("done");
      expect(isTurnActive(next.id)).toBe(false);
    } finally {
      await mock.close();
    }
  });

  it("shows a Chinese reason when the LLM gateway is unreachable", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-m-down-"));
    const next = await runAgent({
      session: emptySession(),
      settings: pigSettings(workspaceRoot, {
        llmBaseUrl: "http://127.0.0.1:1/v1",
      }),
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect(next.status).toBe("idle");
    expect(next.lastError).toBe(LOCAL_TURN_MESSAGES.gateway_unreachable);
    expect(next.localRetry).toBe("turn");
    expect(runningTurns.has(next.id)).toBe(false);
  });

  it("surfaces consecutive tool failures in Chinese and stays idle", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-m-tool-"));
    const fail = (_raw: string, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      toolDelta(res, [{ id: `call_${Date.now()}`, name: "read_file", args: { path: "missing.md" } }]);
    };
    const mock = await startScriptedLlm([
      fail,
      fail,
      fail,
      (_raw, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, { choices: [{ delta: { content: "连续读取失败，请换路径。" } }] });
      },
    ]);
    try {
      const next = await runAgent({
        session: emptySession(),
        settings: pigSettings(workspaceRoot, { llmBaseUrl: mock.url }),
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(next.status).toBe("idle");
      expect(next.lastError).toBe(LOCAL_TURN_MESSAGES.tool_failed);
      expect(next.localRetry).toBe("turn");
      expect(next.messages.filter((m) => m.role === "tool" && m.toolOk === false).length).toBeGreaterThanOrEqual(
        3,
      );
      expect(next.messages.filter((m) => m.role === "user" && m.content.includes("整理工作区"))).toHaveLength(1);
    } finally {
      await mock.close();
    }
  });
});

describe("session retry does not duplicate the user message", () => {
  const app = createApp();

  it("rewinds and re-runs the same goal without inserting another user row", async () => {
    const mock = await startScriptedLlm([
      (_raw, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, { choices: [{ delta: { content: "重试后已完成。" } }] });
      },
    ]);
    const prevSettings = await loadSettings();
    const created = await createSession();
    created.messages.push({
      id: "u_goal",
      role: "user",
      content: "请写一份报告",
      createdAt: new Date().toISOString(),
    });
    created.messages.push({
      id: "a_fail",
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    });
    created.lastError = LOCAL_TURN_MESSAGES.bad_key;
    created.localRetry = "turn";
    created.status = "idle";
    await saveSession(created);
    await saveSettings({ llmBaseUrl: mock.url, llmApiKey: "test", runtime: "pig" });
    try {
      const res = await app.request(`/api/sessions/${created.id}/retry`, { method: "POST" });
      expect(res.status).toBe(200);
      const latest = await getSession(created.id);
      expect(latest?.status).toBe("idle");
      expect(latest?.lastError).toBeUndefined();
      expect(latest?.localRetry).toBeUndefined();
      const goals = latest?.messages.filter((m) => m.role === "user" && m.content === "请写一份报告") ?? [];
      expect(goals).toHaveLength(1);
      expect(latest?.messages.some((m) => m.role === "assistant" && m.content.includes("重试后已完成"))).toBe(
        true,
      );
    } finally {
      await saveSettings(prevSettings);
      await mock.close();
    }
  });
});
