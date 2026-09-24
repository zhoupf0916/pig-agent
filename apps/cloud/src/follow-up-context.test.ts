import { describe, expect, it } from "vitest";
import { CONTEXT_COMPACT_ID, boundedFollowUpInput, type ChatMessage } from "@pig-agent/contracts";

describe("cloud follow-up continuation", () => {
  it("keeps a cancelled prompt and does not copy every old tool body into the next run input", () => {
    const done: ChatMessage[] = [
      { id: "goal", role: "user", content: "原始目标：交付周报。", createdAt: "2026-09-24T00:00:00.000Z" },
    ];
    for (let i = 0; i < 30; i += 1) {
      done.push({
        id: `a${i}`,
        role: "assistant",
        content: "",
        createdAt: "2026-09-24T00:00:00.000Z",
        toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }],
      });
      done.push({
        id: `t${i}`,
        role: "tool",
        content: `TOOL_BODY_${i}_${"x".repeat(3000)}`,
        toolCallId: `c${i}`,
        createdAt: "2026-09-24T00:00:00.000Z",
      });
    }
    const bounded = boundedFollowUpInput({
      runs: [
        { id: "run_1", prompt: "原始目标：交付周报。", createdAt: "2026-09-24T00:00:00.000Z", doneMessages: done },
        { id: "run_cancelled", prompt: "取消前的更正：不要改锁文件。", createdAt: "2026-09-24T01:00:00.000Z" },
      ],
      prompt: "继续写结论。",
      runId: "run_3",
      createdAt: "2026-09-24T02:00:00.000Z",
      budgetChars: 12_000,
    });
    const stored = JSON.stringify(bounded.messages);
    expect(stored).toContain("原始目标：交付周报");
    expect(stored).toContain("不要改锁文件");
    expect(stored).toContain("继续写结论。");
    expect(stored).not.toContain("TOOL_BODY_0_");
    expect(bounded.messages.some((message) => message.id === CONTEXT_COMPACT_ID)).toBe(true);
    expect(bounded.continuation.strategy).toBe("server-events");
    expect(bounded.continuation.unit).toBe("estimated_chars");
    expect(bounded.continuation.measuredTokens).toBe(false);
    expect(stored.length).toBeLessThan(20_000);
    const again = boundedFollowUpInput({
      runs: [
        { id: "run_1", prompt: "原始目标：交付周报。", createdAt: "2026-09-24T00:00:00.000Z", doneMessages: done },
        { id: "run_3", prompt: "继续写结论。", createdAt: "2026-09-24T02:00:00.000Z", doneMessages: bounded.messages },
      ],
      prompt: "补上日期。",
      runId: "run_4",
      createdAt: "2026-09-24T03:00:00.000Z",
      budgetChars: 12_000,
    });
    expect(again.messages.filter((message) => message.id === CONTEXT_COMPACT_ID)).toHaveLength(1);
    expect(JSON.stringify(again.messages)).toContain("原始目标：交付周报");
  });
});
