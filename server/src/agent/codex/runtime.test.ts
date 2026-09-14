import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, Session, Settings } from "../../types.ts";
import { runCodexAgent } from "./runtime.ts";

function sessionWith(user: string): Session {
  return {
    id: "ses_codex",
    title: "codex",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "idle",
    messages: [
      {
        id: "u1",
        role: "user",
        content: user,
        createdAt: new Date().toISOString(),
      },
    ],
    steps: [],
    artifacts: [],
  };
}

function settings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "unused",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "codex",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    ...extra,
  };
}

function fakeCodexScript(dir: string, jsonl: string[]): string {
  const script = join(dir, "codex");
  const payload = jsonl.map((line) => `printf '%s\\n' '${line.replace(/'/g, `'\\''`)}'`).join("\n");
  writeFileSync(
    script,
    `#!/bin/sh
${payload}
`,
  );
  chmodSync(script, 0o755);
  return script;
}

describe("runCodexAgent", () => {
  it("persists synthetic tool messages so reload can rebuild tool cards", async () => {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) process.env.DEEPSEEK_API_KEY = "sk-test-not-a-real-key";
    const workspace = mkdtempSync(join(tmpdir(), "pig-codex-run-"));
    const home = mkdtempSync(join(tmpdir(), "pig-codex-home-"));
    writeFileSync(join(workspace, "hello.md"), "# hi\n");
    const binary = fakeCodexScript(home, [
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"hello.md","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"hello.md","kind":"add"}],"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"已写入 hello.md"}}',
      '{"type":"turn.completed"}',
    ]);
    const events: AgentEvent[] = [];
    const next = await runCodexAgent({
      session: sessionWith("写一个 hello.md"),
      settings: settings(workspace, { codexBinaryPath: binary }),
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      hooks: {},
    });

    expect(next.status).toBe("idle");
    const assistantTools = next.messages.filter((m): m is ChatMessage => m.role === "assistant" && Boolean(m.toolCalls?.length));
    const toolMsgs = next.messages.filter((m) => m.role === "tool");
    expect(assistantTools.length).toBeGreaterThan(0);
    expect(toolMsgs.some((m) => m.toolCallId === "item_1" && m.toolOk)).toBe(true);
    expect(next.artifacts.some((a) => a.path === "hello.md")).toBe(true);
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_end")).toBe(true);
    expect(events.some((e) => e.type === "message")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("fails closed when the Codex binary is missing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pig-codex-miss-"));
    const next = await runCodexAgent({
      session: sessionWith("hi"),
      settings: settings(workspace, { codexBinaryPath: "/no/such/codex" }),
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect(next.status).toBe("error");
    expect(next.lastError).toMatch(/Codex binary not found/);
  });
});
