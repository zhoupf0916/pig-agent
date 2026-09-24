import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types.ts";
import {
  assembleCodexPrompt,
  CODEX_TOOL_SUMMARY_CHARS,
  CODEX_TOOL_SUMMARY_MAX,
} from "./prompt.ts";

function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: extra.id ?? `m_${role}_${content.slice(0, 8)}`,
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

  it("assembles last N user/assistant texts and interleaves truncated tool summaries", () => {
    const prompt = assembleCodexPrompt([
      msg("user", "先看一下"),
      msg("assistant", "", { toolCalls: [{ id: "c1", name: "list_dir", arguments: "{}" }] }),
      msg("tool", "notes/", { toolCallId: "c1", toolOk: true }),
      msg("assistant", "看到 notes 了"),
      msg("user", "写入 hello.md"),
    ]);
    expect(prompt).toContain("Previous conversation");
    expect(prompt).toContain("User: 先看一下");
    expect(prompt).toContain("Tool(list_dir): ok — notes/");
    expect(prompt).toContain("Assistant: 看到 notes 了");
    expect(prompt).toContain("Current user request:\n写入 hello.md");
    expect(prompt).toContain("no native cross-turn memory");
    expect(prompt.indexOf("Tool(list_dir)")).toBeGreaterThan(prompt.indexOf("User: 先看一下"));
    expect(prompt.indexOf("Assistant: 看到 notes 了")).toBeGreaterThan(prompt.indexOf("Tool(list_dir)"));
  });

  it("includes a truncated tool summary so follow-ups can refer to recent writes", () => {
    const longOutput = `wrote hello.md\n${"x".repeat(CODEX_TOOL_SUMMARY_CHARS + 80)}`;
    const prompt = assembleCodexPrompt([
      msg("user", "写一个 hello.md"),
      msg("assistant", "", { toolCalls: [{ id: "w1", name: "write_file", arguments: '{"path":"hello.md"}' }] }),
      msg("tool", longOutput, { toolCallId: "w1", toolOk: true }),
      msg("user", "fix the file you just wrote"),
    ]);
    const collapsed = longOutput.replace(/\s+/g, " ").trim();
    const expectedSnippet = `${collapsed.slice(0, CODEX_TOOL_SUMMARY_CHARS)}…`;
    expect(prompt).toContain("Previous conversation");
    expect(prompt).toContain(`Tool(write_file): ok — ${expectedSnippet}`);
    expect(prompt).not.toContain(collapsed);
    expect(prompt).toContain("Current user request:\nfix the file you just wrote");
  });

  it("caps recent tool summaries and marks errors", () => {
    const messages: ChatMessage[] = [msg("user", "开始")];
    for (let i = 0; i < CODEX_TOOL_SUMMARY_MAX + 3; i++) {
      messages.push(
        msg("assistant", "", {
          id: `a_${i}`,
          toolCalls: [{ id: `t_${i}`, name: "read_file", arguments: "{}" }],
        }),
        msg("tool", `output-${String(i).padStart(2, "0")}`, {
          id: `tool_${i}`,
          toolCallId: `t_${i}`,
          toolOk: i === CODEX_TOOL_SUMMARY_MAX + 2 ? false : true,
        }),
      );
    }
    messages.push(msg("user", "继续改刚才的文件"));
    const prompt = assembleCodexPrompt(messages);
    expect(prompt).not.toContain("output-00");
    expect(prompt).not.toContain("output-01");
    expect(prompt).not.toContain("output-02");
    expect(prompt).toContain("Tool(read_file): ok — output-03");
    expect(prompt).toContain("Tool(read_file): err — output-10");
    expect(prompt.match(/Tool\(read_file\):/g)?.length).toBe(CODEX_TOOL_SUMMARY_MAX);
  });

  it("keeps the original goal when the recent Codex window is only filler", () => {
    const messages: ChatMessage[] = [msg("user", "原始目标：交付周报，不要改锁文件。", { id: "goal" })];
    for (let i = 0; i < 20; i += 1) messages.push(msg("user", `闲聊 ${"噪声".repeat(400)}`, { id: `n${i}` }));
    messages.push(msg("user", "按原目标继续。", { id: "now" }));
    const prompt = assembleCodexPrompt(messages);
    expect(prompt).toContain("原始目标：交付周报");
    expect(prompt).toContain("Current user request:\n按原目标继续。");
  });

  it("falls back to unknown when a tool result has no matching toolCall", () => {
    const prompt = assembleCodexPrompt([
      msg("user", "先看一下"),
      msg("tool", "orphan result", { toolCallId: "missing", toolOk: true }),
      msg("user", "下一步"),
    ]);
    expect(prompt).toContain("Tool(unknown): ok — orphan result");
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
