import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { DEFAULT_SETTINGS } from "../../config.ts";
import { createSession, getSession, saveSession } from "../../store/sessions.ts";
import { loadSettings, saveSettings } from "../../store/settings.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import { runningTurns } from "../turn.ts";
import { CODEX_TURN_MESSAGES } from "./errors.ts";
import { runCodexAgent } from "./runtime.ts";

function codexSettings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "sk-host-must-not-leak-to-banner",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "codex",
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
    id: "ses_n_rec",
    title: "recover",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: "请在工作区写一个 hello-codex.md",
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
    ...overrides,
  };
}

function fakeCodexScript(dir: string, jsonl: string[], extra = ""): string {
  const script = join(dir, "codex");
  const payload = jsonl.map((line) => `printf '%s\\n' '${line.replace(/'/g, `'\\''`)}'`).join("\n");
  writeFileSync(
    script,
    `#!/bin/sh
${payload}
${extra}
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function spawnThatFails(message = "spawn EACCES"): typeof spawn {
  return (() => {
    const child = new EventEmitter() as ChildProcess;
    child.stdout = null;
    child.stderr = null;
    child.pid = undefined;
    child.kill = () => true;
    queueMicrotask(() =>
      child.emit("error", Object.assign(new Error(message), { code: "EACCES" })),
    );
    return child;
  }) as typeof spawn;
}

async function drainSseTypes(
  body: ReadableStream<Uint8Array> | null,
  ms = 3_000,
): Promise<string[]> {
  if (!body) throw new Error("missing body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const types: string[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (read.done && !read.value) break;
    buffer += decoder.decode(read.value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!dataLine) continue;
      try {
        const event = JSON.parse(dataLine) as { type?: string };
        if (event.type) types.push(event.type);
      } catch {
        // ignore keepalives
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return types;
}

function ensureDummyCodexKey(): () => void {
  if (process.env.DEEPSEEK_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim()) {
    return () => undefined;
  }
  process.env.DEEPSEEK_API_KEY = "sk-test-not-a-real-key";
  return () => {
    delete process.env.DEEPSEEK_API_KEY;
  };
}

describe("Milestone N Codex-turn recoverability", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("shows a Chinese reason when the Codex binary is missing and returns idle", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-n-bin-"));
    const events: AgentEvent["type"][] = [];
    const next = await runCodexAgent({
      session: emptySession(),
      settings: codexSettings(workspaceRoot, { codexBinaryPath: "/no/such/codex" }),
      signal: new AbortController().signal,
      emit: (e) => events.push(e.type),
    });
    expect(next.status).toBe("idle");
    expect(next.lastError).toMatch(/未找到 Codex 二进制/);
    expect(next.localRetry).toBe("turn");
    expect(next.remoteRetry).toBeUndefined();
    expect(next.lastError).not.toContain("sk-");
    expect(next.lastError).not.toContain("sk-host-must-not-leak-to-banner");
    expect(events).toContain("error");
    expect(events).toContain("done");
  });

  it("shows a Chinese reason when Codex fails to start", async () => {
    const restoreKey = ensureDummyCodexKey();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-n-start-"));
    const home = mkdtempSync(join(tmpdir(), "pig-n-start-home-"));
    const binary = fakeCodexScript(home, []);
    try {
      const next = await runCodexAgent({
        session: emptySession(),
        settings: codexSettings(workspaceRoot, { codexBinaryPath: binary }),
        signal: new AbortController().signal,
        emit: () => undefined,
        hooks: { spawn: spawnThatFails() },
      });
      expect(next.status).toBe("idle");
      expect(next.lastError).toMatch(/进程启动失败/);
      expect(next.localRetry).toBe("turn");
      expect(runningTurns.has(next.id)).toBe(false);
    } finally {
      restoreKey();
    }
  });

  it("surfaces a session error in Chinese, stays idle, and redacts secrets", async () => {
    const restoreKey = ensureDummyCodexKey();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-n-sess-"));
    const home = mkdtempSync(join(tmpdir(), "pig-n-sess-home-"));
    const binary = fakeCodexScript(
      home,
      [
        '{"type":"turn.started"}',
        '{"type":"turn.failed","error":{"message":"provider 401 sk-abcdefghijklmnop"}}',
      ],
      "printf '%s\\n' 'CODEX_API_KEY=sk-should-not-leak' >&2\nexit 2",
    );
    try {
      const next = await runCodexAgent({
        session: emptySession(),
        settings: codexSettings(workspaceRoot, { codexBinaryPath: binary }),
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      expect(next.status).toBe("idle");
      expect(next.lastError).toMatch(/本轮执行失败/);
      expect(next.localRetry).toBe("turn");
      expect(next.lastError).not.toContain("sk-abcdefghijklmnop");
      expect(next.lastError).not.toContain("sk-should-not-leak");
      expect(next.lastError).not.toContain("sk-host-must-not-leak-to-banner");
      expect(next.messages.filter((m) => m.role === "user")).toHaveLength(1);
    } finally {
      restoreKey();
    }
  });
});

describe("Codex session retry does not duplicate the user message", () => {
  const app = createApp();

  it("rewinds and re-runs the same goal without inserting another user row", async () => {
    const restoreKey = ensureDummyCodexKey();
    const workspace = mkdtempSync(join(tmpdir(), "pig-n-retry-ws-"));
    const home = mkdtempSync(join(tmpdir(), "pig-n-retry-home-"));
    const binary = fakeCodexScript(home, [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"重试后已完成。"}}',
      '{"type":"turn.completed"}',
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
    created.lastError = CODEX_TURN_MESSAGES.binary_missing;
    created.localRetry = "turn";
    created.status = "idle";
    await saveSession(created);
    await saveSettings({
      workspaceRoot: workspace,
      runtime: "codex",
      codexBinaryPath: binary,
    });
    try {
      const res = await app.request(`/api/sessions/${created.id}/retry`, { method: "POST" });
      expect(res.status).toBe(200);
      const types = await drainSseTypes(res.body);
      expect(types).toContain("done");
      const latest = await getSession(created.id);
      expect(latest?.status).toBe("idle");
      expect(latest?.lastError).toBeUndefined();
      expect(latest?.localRetry).toBeUndefined();
      const goals = latest?.messages.filter((m) => m.role === "user" && m.content === "请写一份报告") ?? [];
      expect(goals).toHaveLength(1);
      expect(latest?.messages.some((m) => m.role === "assistant" && m.content.includes("重试后已完成"))).toBe(
        true,
      );
      expect(runningTurns.has(created.id)).toBe(false);
    } finally {
      await saveSettings(prevSettings);
      restoreKey();
    }
  });
});
