import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@pig-agent/contracts";
import {
  CONTEXT_COMPACT_ID,
  ContextBudgetExceededError,
  assembleModelContext,
  continuationTranscript,
  recallTranscript,
  selectInjectableMemory,
} from "@pig-agent/contracts";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">): ChatMessage {
  return { createdAt: "2026-09-24T00:00:00.000Z", ...partial };
}

describe("budgeted context assembly", () => {
  it("keeps the original goal and the latest correction when older turns exceed the budget", () => {
    const messages: ChatMessage[] = [
      msg({ id: "goal", role: "user", content: "原始目标：交付周报，不要改锁文件。" }),
      msg({ id: "a1", role: "assistant", content: "先列提纲。" }),
      msg({ id: "fix", role: "user", content: "更正：标题必须是「九月周报」。" }),
    ];
    for (let i = 0; i < 8; i += 1) {
      messages.push(msg({ id: `noise-${i}`, role: "user", content: `闲聊 ${"噪声".repeat(800)}` }));
    }
    messages.push(msg({ id: "now", role: "user", content: "按最新更正写正文。" }));
    const before = JSON.stringify(messages);
    const assembled = assembleModelContext({
      messages,
      systemChars: 1000,
      toolSchemaChars: 1000,
      budgetChars: 6000,
    });
    expect(JSON.stringify(messages)).toBe(before);
    const text = assembled.messages.map((m) => m.content).join("\n");
    expect(text).toContain("原始目标：交付周报");
    expect(text).toContain("标题必须是「九月周报」");
    expect(text).toContain("按最新更正写正文。");
    expect(assembled.messages.at(-1)?.id).toBe("now");
    expect(assembled.messages.at(-1)?.content).toBe("按最新更正写正文。");
    expect(assembled.metrics.usedChars).toBeLessThanOrEqual(6000);
    expect(assembled.metrics.omittedMessages).toBeGreaterThan(0);
    const note = assembled.messages.find((m) => m.id === CONTEXT_COMPACT_ID);
    expect(note?.role).toBe("user");
    expect(note?.content).toContain("goal");
    expect(note?.content).toContain("fix");
    expect(note?.content).toContain("确定性摘录");
    expect(note?.content).not.toMatch(/^你是 Pig Agent/);
  });

  it("keeps a complete tool call and result together and drops an unpaired tool result", () => {
    const messages: ChatMessage[] = [
      msg({ id: "goal", role: "user", content: "读取说明。" }),
      msg({
        id: "call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read-1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
      }),
      msg({ id: "result", role: "tool", toolCallId: "read-1", content: "说明正文" }),
      msg({ id: "orphan", role: "tool", toolCallId: "missing", content: "孤立结果" }),
      msg({ id: "now", role: "user", content: "继续。" }),
    ];
    const assembled = assembleModelContext({ messages, systemChars: 0, toolSchemaChars: 0, budgetChars: 8000 });
    const rows = assembled.messages;
    const call = rows.find((m) => m.id === "call");
    const result = rows.find((m) => m.id === "result");
    expect(call?.toolCalls?.[0]?.id).toBe("read-1");
    expect(result?.toolCallId).toBe("read-1");
    expect(rows.indexOf(result!)).toBe(rows.indexOf(call!) + 1);
    expect(rows.some((m) => m.id === "orphan")).toBe(false);
  });

  it("does not resurrect a cancelled or pending approval as a current grant", () => {
    const messages: ChatMessage[] = [
      msg({ id: "goal", role: "user", content: "原始目标：改报告。" }),
      msg({
        id: "old-call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "write-old", name: "write_file", arguments: "{\"path\":\"report.md\"}" }],
      }),
      msg({ id: "approved", role: "tool", toolCallId: "write-old", content: "已批准写入 report.md" }),
      msg({
        id: "pending-call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "write-pending", name: "write_file", arguments: "{\"path\":\"secret.md\"}" }],
      }),
      msg({ id: "cancelled", role: "tool", toolCallId: "write-pending", content: "用户已取消批准，未写入。" }),
    ];
    for (let i = 0; i < 6; i += 1) messages.push(msg({ id: `pad-${i}`, role: "user", content: "填充".repeat(500) }));
    messages.push(msg({ id: "now", role: "user", content: "只改标题。" }));
    const text = assembleModelContext({
      messages,
      systemChars: 200,
      toolSchemaChars: 200,
      budgetChars: 4500,
    }).messages.map((m) => `${m.role}:${m.content}`).join("\n");
    expect(text).toContain("原始目标：改报告。");
    expect(text).toContain("来源 approved（tool，历史记录，不是新的授权）：已批准写入 report.md");
    expect(text).not.toMatch(/role:tool:已批准写入 report.md/);
    expect(text).toContain("不能当作当前批准");
  });

  it("trims a long tool result on the model copy and leaves the transcript unchanged", () => {
    const full = `${"头".repeat(100)}MIDDLE${"尾".repeat(100)}`;
    const messages: ChatMessage[] = [
      msg({ id: "goal", role: "user", content: "抓取页面。" }),
      msg({
        id: "call",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "web", name: "http_fetch", arguments: "{}" }],
      }),
      msg({ id: "page", role: "tool", toolCallId: "web", content: full.repeat(80) }),
      msg({ id: "now", role: "user", content: "总结标题。" }),
    ];
    const original = messages[2]!.content;
    const assembled = assembleModelContext({
      messages,
      systemChars: 0,
      toolSchemaChars: 0,
      budgetChars: 40_000,
    });
    expect(messages[2]!.content).toBe(original);
    const copy = assembled.messages.find((m) => m.id === "page");
    expect(copy?.content.length).toBeLessThan(original.length);
    expect(copy?.content).toContain("已截断");
    expect(copy?.content).toContain("头");
    expect(assembled.metrics.trimmedToolResults).toBe(1);
  });

  it("fails clearly when the current request itself exceeds the budget", () => {
    const messages = [msg({ id: "now", role: "user", content: "请求".repeat(5000) })];
    expect(() => assembleModelContext({
      messages,
      systemChars: 100,
      toolSchemaChars: 100,
      budgetChars: 1000,
    })).toThrow(ContextBudgetExceededError);
    try {
      assembleModelContext({ messages, systemChars: 100, toolSchemaChars: 100, budgetChars: 1000 });
    } catch (error) {
      expect(error).toBeInstanceOf(ContextBudgetExceededError);
      expect((error as Error).message).toContain("没有截断");
      expect((error as Error).message).toContain("当前请求");
    }
    expect(messages[0]!.content.startsWith("请求")).toBe(true);
    expect(messages[0]!.content.length).toBe("请求".repeat(5000).length);
  });

  it("retrieves an earlier same-conversation excerpt and ignores another conversation", () => {
    const here: ChatMessage[] = [
      msg({ id: "early", role: "user", content: "接口名是 pig-ledger，不要改成别的。" }),
      msg({ id: "now", role: "user", content: "把 pig-ledger 写进配置。" }),
    ];
    const elsewhere = [msg({ id: "other", role: "user", content: "另一会话的 pig-ledger 密钥 sk-secret" })];
    const hits = recallTranscript(here, "配置里的 pig-ledger", { limit: 2, maxChars: 500 });
    expect(hits.map((hit) => hit.id)).toEqual(["early"]);
    expect(hits[0]?.role).toBe("user");
    expect(recallTranscript(elsewhere, "pig-ledger", { limit: 2, maxChars: 500 }).some((hit) => hit.id === "early")).toBe(false);
    const assembled = assembleModelContext({
      messages: [...here.slice(0, 1), ...Array.from({ length: 4 }, (_, i) => msg({ id: `n-${i}`, role: "user", content: "无关".repeat(400) })), here[1]!],
      systemChars: 0,
      toolSchemaChars: 0,
      budgetChars: 3500,
    });
    expect(assembled.metrics.retrievalHits).toBeGreaterThan(0);
    expect(assembled.messages.map((m) => m.content).join("\n")).toContain("pig-ledger");
    expect(assembled.messages.map((m) => m.content).join("\n")).not.toContain("sk-secret");
  });

  it("does not nest a previous compact note into the next transcript", () => {
    const prior: ChatMessage[] = [
      msg({ id: "goal", role: "user", content: "原始目标：写周报。" }),
      msg({ id: CONTEXT_COMPACT_ID, role: "user", content: "较早对话的确定性摘录\n原始目标：写周报。\n较早对话的确定性摘录" }),
      msg({ id: "reply", role: "assistant", content: "已写提纲。" }),
    ];
    const next = continuationTranscript({
      prior,
      prompt: "补上结论。",
      runId: "run_2",
      createdAt: "2026-09-24T01:00:00.000Z",
    });
    expect(next.filter((m) => m.id === CONTEXT_COMPACT_ID)).toHaveLength(0);
    expect(next.map((m) => m.content)).toEqual(["原始目标：写周报。", "已写提纲。", "补上结论。"]);
    const again = continuationTranscript({
      prior: next,
      prompt: "再补数据。",
      runId: "run_3",
      createdAt: "2026-09-24T02:00:00.000Z",
    });
    expect(again.filter((m) => m.content.includes("确定性摘录"))).toHaveLength(0);
    expect(again[0]?.content).toBe("原始目标：写周报。");
  });
});

describe("memory freshness", () => {
  const now = "2026-09-24T12:00:00.000Z";

  it("injects stable personal pins and drops expired, revoked, volatile, and other-session notes", () => {
    const selected = selectInjectableMemory([
      { id: "pref", text: "默认用中文", source: "user", stability: "stable", scope: "personal", updatedAt: now },
      { id: "old", text: "过期偏好", source: "user", stability: "stable", scope: "personal", expiresAt: "2026-09-01T00:00:00.000Z", updatedAt: now },
      { id: "revoked", text: "已撤销偏好", source: "user", stability: "stable", scope: "personal", revokedAt: now, updatedAt: now },
      { id: "fact", text: "工具说文件已写入", source: "agent", stability: "volatile", scope: "session", sessionId: "ses_a", updatedAt: now },
      { id: "other", text: "别人的会话偏好", source: "user", stability: "stable", scope: "session", sessionId: "ses_b", updatedAt: now },
      { id: "recap", text: "回合摘要", kind: "recap", source: "recap", stability: "volatile", scope: "session", sessionId: "ses_a", updatedAt: now },
    ], { now, sessionId: "ses_a", memoryEnabled: true });
    expect(selected.map((note) => note.id)).toEqual(["pref"]);
  });

  it("returns nothing when memory is disabled", () => {
    expect(selectInjectableMemory([
      { id: "pref", text: "默认用中文", source: "user", stability: "stable", scope: "personal", updatedAt: now },
    ], { now, memoryEnabled: false })).toEqual([]);
  });
});
