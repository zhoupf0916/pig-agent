import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../config.ts";
import type { AgentEvent, Session, Settings } from "../../types.ts";
import {
  CODEX_PROGRESS,
  CREATE_RUN_PROGRESS,
  FOLLOW_UP_PROGRESS,
  LOCAL_STUB_PROGRESS,
} from "../cloud/create-run-progress.ts";
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
    cloudToken: "cp-token-must-not-leak",
    cloudMode: "local-stub",
    ...extra,
  };
}

function emptySession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_ae_progress",
    title: "codex progress",
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

function ensureDummyCodexKey(): () => void {
  if (process.env.DEEPSEEK_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim()) {
    return () => undefined;
  }
  process.env.DEEPSEEK_API_KEY = "sk-test-not-a-real-key";
  return () => {
    delete process.env.DEEPSEEK_API_KEY;
  };
}

function stepEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === "steps");
}

function titlesAt(events: AgentEvent[], index: number): string[] {
  const ev = stepEvents(events)[index];
  return ev && ev.type === "steps" ? ev.steps.map((s) => s.title) : [];
}

describe("Milestone AE Codex startup progress", () => {
  it("keeps the default runtime on pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("emits Chinese Codex steps then hands off on first tool/assistant (no W/X/AD chips)", async () => {
    const restoreKey = ensureDummyCodexKey();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-ae-ok-"));
    const home = mkdtempSync(join(tmpdir(), "pig-ae-ok-home-"));
    writeFileSync(join(workspaceRoot, "hello-codex.md"), "ok");
    const binary = fakeCodexScript(home, [
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"hello-codex.md","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"已写入 hello-codex.md"}}',
      '{"type":"turn.completed"}',
    ]);
    try {
      const events: AgentEvent[] = [];
      const next = await runCodexAgent({
        session: emptySession(),
        settings: codexSettings(workspaceRoot, { codexBinaryPath: binary }),
        signal: new AbortController().signal,
        emit: (e) => events.push(e),
      });

      const firstSteps = titlesAt(events, 0);
      expect(firstSteps).toContain(CODEX_PROGRESS.env.title);
      expect(firstSteps).not.toContain(CREATE_RUN_PROGRESS.snapshot.title);
      expect(firstSteps).not.toContain(FOLLOW_UP_PROGRESS.followup.title);
      expect(firstSteps).not.toContain(LOCAL_STUB_PROGRESS.materialize.title);
      expect(
        stepEvents(events).some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === CODEX_PROGRESS.spawn.title),
        ),
      ).toBe(true);

      const dumped = JSON.stringify(stepEvents(events));
      expect(dumped).not.toContain(CREATE_RUN_PROGRESS.create.title);
      expect(dumped).not.toContain(FOLLOW_UP_PROGRESS.reconnect.title);
      expect(dumped).not.toContain(LOCAL_STUB_PROGRESS.start.title);
      expect(dumped).not.toContain("sk-host-must-not-leak-to-banner");
      expect(dumped).not.toContain("cp-token-must-not-leak");
      expect(dumped).not.toMatch(/sk-[A-Za-z0-9]{8,}/);

      const firstProgress = events.findIndex((e) => e.type === "steps");
      const firstLive = events.findIndex(
        (e) =>
          e.type === "tool_start" ||
          (e.type === "message" && e.message.role === "assistant"),
      );
      expect(firstProgress).toBeGreaterThanOrEqual(0);
      expect(firstLive).toBeGreaterThan(firstProgress);

      const afterLive = events.slice(firstLive);
      expect(
        afterLive.some((e) => e.type === "steps" && e.steps.some((s) => s.id.startsWith("codex:"))),
      ).toBe(false);

      expect(next.status).toBe("idle");
      expect(next.lastError).toBeUndefined();
      expect(next.steps.some((s) => s.id.startsWith("codex:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("create-run:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("follow-up:"))).toBe(false);
      expect(next.steps.some((s) => s.id.startsWith("local-stub:"))).toBe(false);
      expect(next.messages.some((m) => m.content.includes("hello-codex.md"))).toBe(true);
    } finally {
      restoreKey();
    }
  });

  it("abort during hung Codex spawn returns idle (no zombie running chips)", async () => {
    const restoreKey = ensureDummyCodexKey();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "pig-ae-ab-"));
    const home = mkdtempSync(join(tmpdir(), "pig-ae-ab-home-"));
    writeFileSync(join(workspaceRoot, "ok.md"), "ok");
    const binary = fakeCodexScript(home, [], "sleep 30");
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    try {
      const pending = runCodexAgent({
        session: emptySession(),
        settings: codexSettings(workspaceRoot, { codexBinaryPath: binary }),
        signal: controller.signal,
        emit: (e) => events.push(e),
      });
      const deadline = Date.now() + 2_000;
      while (
        Date.now() < deadline &&
        !events.some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === CODEX_PROGRESS.spawn.title),
        )
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(
        events.some(
          (e) => e.type === "steps" && e.steps.some((s) => s.title === CODEX_PROGRESS.spawn.title),
        ),
      ).toBe(true);
      controller.abort();
      const next = await pending;
      expect(next.status).toBe("idle");
      expect(next.lastError).toBeUndefined();
      expect(next.steps.every((s) => s.status !== "running")).toBe(true);
      expect(next.steps.some((s) => s.id.startsWith("codex:"))).toBe(false);
      expect(next.messages.some((m) => m.content.includes("已停止"))).toBe(true);
    } finally {
      restoreKey();
    }
  });

  it("Codex failure uses existing Chinese banner/retry and clears bootstrap chips", async () => {
    const events: AgentEvent[] = [];
    const next = await runCodexAgent({
      session: emptySession(),
      settings: codexSettings(mkdtempSync(join(tmpdir(), "pig-ae-fail-")), {
        codexBinaryPath: "/no/such/codex",
      }),
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
    });
    expect(next.status).toBe("idle");
    expect(next.status).not.toBe("running");
    expect(next.lastError).toMatch(/未找到 Codex 二进制/);
    expect(next.lastError).not.toContain("sk-host-must-not-leak-to-banner");
    expect(next.localRetry).toBe("turn");
    expect(next.steps.some((s) => s.id.startsWith("codex:"))).toBe(false);
    expect(JSON.stringify(next.steps)).not.toContain("sk-host-must-not-leak-to-banner");
    expect(JSON.stringify(stepEvents(events))).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
  });
});
