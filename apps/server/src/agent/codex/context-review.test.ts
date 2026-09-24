import { describe, expect, it } from "vitest";
import { assembleCodexPrompt } from "./prompt.ts";
import type { ChatMessage } from "../../types.ts";

const msg = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({ id, role, content, createdAt: "2026-09-24T00:00:00.000Z" });

describe("Codex context integration acceptance", () => {
  it("keeps the initial goal after more than twelve short conversation messages", () => {
    const history = [msg("goal", "user", "验收目标：交付中文月报，禁止改原始数据。")];
    for (let i = 0; i < 18; i++) history.push(msg(`a${i}`, "assistant", `已检查第${i}份材料`));
    history.push(msg("now", "user", "继续完成验收目标"));
    expect(assembleCodexPrompt(history)).toContain("交付中文月报，禁止改原始数据");
  });

  it("bounds the actual prompt rather than only computing a bounded unused copy", () => {
    const history = [msg("goal", "user", "完成报表")];
    for (let i = 0; i < 11; i++) history.push(msg(`a${i}`, "assistant", "历史材料".repeat(3000)));
    history.push(msg("now", "user", "只给最终总结"));
    const prompt = assembleCodexPrompt(history);
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain("只给最终总结");
  });

  it("includes bound project instructions in the actual prompt budget", () => {
    const history = [msg("goal", "user", "完成报表")];
    for (let i = 0; i < 11; i++) history.push(msg(`a${i}`, "assistant", "历史材料".repeat(3000)));
    history.push(msg("now", "user", "只给最终总结"));
    const prompt = assembleCodexPrompt(history, 12, "项目要求".repeat(2000));
    expect(prompt.length).toBeLessThanOrEqual(24_000);
    expect(prompt).toContain("只给最终总结");
  });
});
