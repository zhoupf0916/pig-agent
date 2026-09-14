import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types.ts";
import { assembleCodexPrompt } from "./prompt.ts";

function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m_${content.slice(0, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("assembleCodexPrompt", () => {
  it("returns the latest user text when there is no prior history", () => {
    expect(assembleCodexPrompt([msg("user", "写一个 hello.md")])).toBe("写一个 hello.md");
  });

  it("assembles last N user/assistant texts and skips tool messages", () => {
    const prompt = assembleCodexPrompt([
      msg("user", "先看一下"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "list_dir", arguments: "{}" }] }),
      msg("tool", "notes/", { toolCallId: "c1", toolOk: true }),
      msg("assistant", "看到 notes 了"),
      msg("user", "写入 hello.md"),
    ]);
    expect(prompt).toContain("Previous conversation");
    expect(prompt).toContain("User: 先看一下");
    expect(prompt).toContain("Assistant: 看到 notes 了");
    expect(prompt).toContain("Current user request:\n写入 hello.md");
    expect(prompt).not.toContain("notes/");
    expect(prompt).toContain("no native cross-turn memory");
  });

  it("prefixes project instruction when a session is bound", () => {
    const prompt = assembleCodexPrompt([msg("user", "写 hello.md")], 12, "始终用中文，先列提纲。");
    expect(prompt).toContain("Project instructions");
    expect(prompt).toContain("始终用中文，先列提纲。");
    expect(prompt).toContain("写 hello.md");
  });

  it("puts expert instruction before project instruction", () => {
    const prompt = assembleCodexPrompt(
      [msg("user", "写 hello.md")],
      12,
      "项目：用中文。",
      "专家：先侦察，不要改文件。",
    );
    expect(prompt.indexOf("Expert instructions")).toBeGreaterThan(-1);
    expect(prompt.indexOf("Expert instructions")).toBeLessThan(prompt.indexOf("Project instructions"));
    expect(prompt).toContain("先侦察，不要改文件。");
    expect(prompt).toContain("项目：用中文。");
  });
});
