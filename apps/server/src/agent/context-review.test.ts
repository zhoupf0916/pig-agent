import { describe, expect, it } from "vitest";
import { assembleModelContext, selectInjectableMemory, type ChatMessage } from "@pig-agent/contracts";

const at = "2026-09-24T00:00:00.000Z";
const message = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({ id, role, content, createdAt: at });

describe("context acceptance review", () => {
  it("keeps the current request when a tool loop produces more output than the context can hold", () => {
    const history = [message("goal", "user", "做一个中文报表"), message("latest", "user", "更正：报表只允许读数据，不要修改源文件。")];
    for (let i = 0; i < 30; i++) {
      history.push({ ...message(`a${i}`, "assistant", ""), toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `input-${i}.txt` }) }] });
      history.push({ ...message(`t${i}`, "tool", "数据".repeat(1000)), toolCallId: `c${i}`, toolOk: true });
    }
    const before = JSON.stringify(history);
    const result = assembleModelContext({ messages: history, systemChars: 300, toolSchemaChars: 300, budgetChars: 6000 });
    expect(result.messages.some(m => m.id === "latest" && m.content === history[1]!.content)).toBe(true);
    expect(JSON.stringify(history)).toBe(before);
    expect(result.metrics.usedChars).toBeLessThanOrEqual(6000);
    const currentIndex = result.messages.findIndex(m => m.id === "latest");
    const laterCall = result.messages.findIndex(m => m.toolCalls?.length);
    if (laterCall >= 0) expect(currentIndex).toBeLessThan(laterCall);
    for (let i = 0; i < result.messages.length; i++) {
      const row = result.messages[i]!;
      if (row.toolCalls?.length) {
        const next = result.messages.slice(i + 1, i + 1 + row.toolCalls.length);
        expect(next.map(m => m.toolCallId)).toEqual(row.toolCalls.map(c => c.id));
      }
    }
  });

  it("does not erase a real request that mentions the compact-note label", () => {
    const request = message("real-user", "user", "较早对话的确定性摘录是什么意思？请解释这个提示，然后继续原任务。");
    const result = assembleModelContext({ messages: [request], systemChars: 0, toolSchemaChars: 0, budgetChars: 6000 });
    expect(result.messages).toContainEqual(request);
  });

  it("preserves the goal when it explicitly forbids using old approval", () => {
    const goal = message("goal", "user", "目标：整理文档。不要把已批准的操作当作未来授权。");
    const history = [goal, ...Array.from({ length: 10 }, (_, i) => message(`n${i}`, "assistant", "旧背景".repeat(1500))), message("now", "user", "继续")];
    const result = assembleModelContext({ messages: history, systemChars: 0, toolSchemaChars: 0, budgetChars: 6000 });
    expect(result.messages.map(m => m.content).join("\n")).toContain("目标：整理文档");
    expect(result.messages.map(m => m.content).join("\n")).toContain("不要把已批准的操作当作未来授权");
  });

  it("keeps a substantial user correction after intervening tool output pushes it out of the recent window", () => {
    const history: ChatMessage[] = [message("goal", "user", "最初希望部署到生产。"), message("correction", "user", "更正：只能部署测试环境，禁止修改生产。" + "补充要求。".repeat(180))];
    for (let i = 0; i < 8; i++) history.push(message(`a${i}`, "assistant", "核验日志".repeat(1200)));
    history.push(message("now", "user", "按刚才的更正继续。"));
    const result = assembleModelContext({ messages: history, systemChars: 100, toolSchemaChars: 100, budgetChars: 6000 });
    expect(result.messages.map(m => m.content).join("\n")).toContain("只能部署测试环境，禁止修改生产");
  });

  it("counts large assistant reasoning against the request budget", () => {
    const history: ChatMessage[] = [message("goal", "user", "检查报表"), {
      ...message("reason", "assistant", "分析完毕"), reasoningContent: "推理".repeat(20_000),
    }, message("now", "user", "继续检查")];
    const result = assembleModelContext({ messages: history, systemChars: 500, toolSchemaChars: 500, budgetChars: 6000 });
    const actualContent = result.messages.reduce((n, m) => n + m.content.length + (m.reasoningContent?.length ?? 0) + JSON.stringify(m.toolCalls ?? []).length, 1000);
    expect(actualContent).toBeLessThanOrEqual(6000);
    expect(result.messages.at(-1)?.content).toBe("继续检查");
  });

  it("does not let the compact note overflow a nearly full current request", () => {
    const current = message("now", "user", "要求".repeat(2400));
    const result = assembleModelContext({ messages: [message("old", "user", "历史说明".repeat(500)), current], systemChars: 500, toolSchemaChars: 500, budgetChars: 6000 });
    expect(result.messages.find(m => m.id === current.id)?.content).toBe(current.content);
    expect(result.metrics.usedChars).toBeLessThanOrEqual(6000);
  });

  it("does not inject a session note when its bound project changed", () => {
    const notes = [{ id: "private", text: "旧项目独有信息", source: "user" as const, stability: "stable" as const, scope: "session" as const, sessionId: "same-session", projectId: "project-a", updatedAt: at }];
    expect(selectInjectableMemory(notes, { now: at, sessionId: "same-session", projectId: "project-b", memoryEnabled: true })).toEqual([]);
  });

  it("does not inject a note with an invalid expiry date", () => {
    const notes = [{ id: "invalid", text: "应重新核验", source: "user" as const, stability: "stable" as const, scope: "personal" as const, expiresAt: "invalid-date", updatedAt: at }];
    expect(selectInjectableMemory(notes, { now: at, memoryEnabled: true })).toEqual([]);
  });

  it("does not promote an unbound scoped note into global memory", () => {
    const notes = [{ id: "unbound", text: "已删除项目的私有背景", source: "user" as const, stability: "stable" as const, scope: "project" as const, updatedAt: at }];
    expect(selectInjectableMemory(notes, { now: at, memoryEnabled: true })).toEqual([]);
  });

  it("does not inject an unbound session note into an unbound conversation", () => {
    const notes = [{ id: "unbound-session", text: "旧会话私有背景", source: "user" as const, stability: "stable" as const, scope: "session" as const, updatedAt: at }];
    expect(selectInjectableMemory(notes, { now: at, memoryEnabled: true })).toEqual([]);
  });
});
