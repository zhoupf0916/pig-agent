import { describe, expect, it } from "vitest";
import { assembleModelContext, boundedFollowUpInput, type ChatMessage } from "@pig-agent/contracts";

describe("control-plane to Runner context acceptance", () => {
  it("retains the control-plane excerpt through the second Runner budget pass", () => {
    const at = "2026-09-24T00:00:00.000Z";
    const rows: ChatMessage[] = [{ id: "goal", role: "user", content: "原始任务：整理中文报告，保留 audit.csv 不得改动。", createdAt: at }];
    for (let i = 0; i < 30; i++) rows.push({ id: `a${i}`, role: "assistant", content: "处理经过".repeat(1000), createdAt: at });
    const control = boundedFollowUpInput({ runs: [{ id: "run-a", prompt: rows[0]!.content, createdAt: at, doneMessages: rows }], prompt: "继续原任务", runId: "run-b", createdAt: at });
    expect(control.messages.map(m => m.content).join("\n")).toContain("保留 audit.csv 不得改动");
    const runner = assembleModelContext({ messages: control.messages, systemChars: 5000, toolSchemaChars: 5000 });
    expect(runner.messages.map(m => m.content).join("\n")).toContain("保留 audit.csv 不得改动");
    expect(runner.metrics.usedChars).toBeLessThanOrEqual(80_000);
  });
});
