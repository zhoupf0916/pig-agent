import { describe, expect, it } from "vitest";
import { assembleModelContext, recallTranscript, ContextBudgetExceededError, type ChatMessage } from "@pig-agent/contracts";
const m = (id: string, content: string, role: ChatMessage["role"] = "user"): ChatMessage => ({ id, content, role, createdAt: "2026-09-26T00:00:00Z" });
const assemble = (messages: ChatMessage[], budgetChars = 4000) => assembleModelContext({ messages, budgetChars, systemChars: 0, toolSchemaChars: 0 });
const text = (messages: ChatMessage[]) => messages.map(m => m.content).join("\n");
describe("context v2 observable input", () => {
  it("keeps all short history when the complete input fits", () => {
    const messages = [m("goal", "说明".repeat(600)), m("answer", "回答".repeat(600), "assistant"), m("now", "继续")];
    expect(assemble(messages).messages).toEqual(messages);
  });
  it("rejects system and tools alone exceeding the input budget", () => {
    expect(() => assembleModelContext({ messages: [], systemChars: 4001, toolSchemaChars: 0, budgetChars: 4000 })).toThrow(ContextBudgetExceededError);
  });
  it("retains multiple independent corrections even after a verbose initial goal", () => {
    const messages = [m("goal", "原始目标：部署服务。" + "背景".repeat(1000)), m("fix1", "更正：区域只能是上海。"), m("fix2", "更正：禁止修改生产环境。"), m("noise", "日志".repeat(3000), "assistant"), m("now", "继续实施")];
    const result = assemble(messages);
    expect(text(result.messages)).toContain("区域只能是上海");
    expect(text(result.messages)).toContain("禁止修改生产环境");
    expect(result.metrics.usedChars).toBeLessThanOrEqual(4000);
  });
  it("retrieves evidence from the middle of an old result", () => {
    const history = [m("log", "noise ".repeat(800) + "invoice-77: total=391" + " tail".repeat(800), "assistant"), m("now", "Find INVOICE-77 total")];
    expect(recallTranscript(history, "Find INVOICE-77 total", { limit: 2, maxChars: 180 })[0]?.excerpt).toContain("total=391");
  });
  it("prefers the newest equally relevant evidence", () => {
    const history = [m("old", "service-port=3000"), m("new", "service-port=9000"), m("now", "查找 service-port")];
    expect(recallTranscript(history, "service-port", { limit: 1, maxChars: 180 })[0]?.id).toBe("new");
  });
  it("retains newly omitted constraints during a second cloud assembly", () => {
    const carried = { ...m("context-compact", "历史目标：整理报表。"), synthetic: "context-compact" as const };
    const result = assemble([carried, m("fix", "更正：只允许使用匿名数据。"), m("noise", "数据".repeat(3000), "assistant"), m("now", "继续")]);
    expect(text(result.messages)).toContain("历史目标：整理报表");
    expect(text(result.messages)).toContain("只允许使用匿名数据");
  });
  it("does not report sources whose excerpts could not fit", () => {
    const result = assemble([m("goal", "目标".repeat(800)), m("fix", "更正：保持中文"), m("noise", "noise".repeat(3000), "assistant"), m("now", "继续")], 1000);
    for (const id of result.metrics.sourceIds) expect(text(result.messages)).toContain(`来源 ${id}（`);
  });
  it("keeps the goal in a carried structured note after long correction excerpts", () => {
    const carried = { ...m("context-compact", "较早对话的确定性摘录\n[用户约束与纠正] 来源 c1（user）：" + "约束".repeat(300) + "\n[用户约束与纠正] 来源 c2（user）：" + "约束".repeat(300) + "\n[原始目标] 来源 goal（user）：交付annual-report.csv"), synthetic: "context-compact" as const };
    const result = assemble([carried, m("fix", "更正：只允许匿名数据。"), m("noise", "数据".repeat(3000), "assistant"), m("now", "继续")]);
    expect(text(result.messages)).toContain("annual-report.csv");
    expect(text(result.messages)).toContain("只允许匿名数据");
  });

});
