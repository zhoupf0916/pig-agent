import { describe, expect, it } from "vitest";
import { contextUsageFromMetrics, presentContextUsage, unknownContextUsage, type ContextMetrics } from "@pig-agent/contracts";

const metrics: ContextMetrics = {
  transcriptMessages: 4,
  modelMessages: 3,
  omittedMessages: 1,
  sourceIds: ["m1"],
  trimmedToolResults: 2,
  budgetChars: 80000,
  usedChars: 20000,
  systemChars: 3000,
  toolSchemaChars: 4000,
  retrievalHits: 0,
};

describe("last-call context usage", () => {
  it("keeps character counts for the last call and drops prompt text, secrets, and billing tokens", () => {
    const shown = presentContextUsage({
      availability: "collected",
      unit: "tokens",
      measuredTokens: true,
      scope: "session_total",
      note: "ignore",
      capturedAt: "2026-09-24T09:00:00.000Z",
      callId: "ctx_1",
      engine: "pig",
      usedChars: 20000,
      budgetChars: 80000,
      systemChars: 3000,
      toolSchemaChars: 4000,
      messageChars: 13000,
      omittedMessages: 1,
      trimmedToolResults: 2,
      prompt_tokens: 99999,
      completion_tokens: 100,
      systemPrompt: "SECRET_SYSTEM_PROMPT sk-live-key",
      content: "完整系统提示不应出现",
    });
    expect(shown).toMatchObject({
      availability: "collected",
      unit: "estimated_chars",
      measuredTokens: false,
      scope: "last_call",
      usedChars: 20000,
      budgetChars: 80000,
      ratio: 0.25,
      systemChars: 3000,
      toolSchemaChars: 4000,
      messageChars: 13000,
    });
    expect(shown?.note).toContain("字符估算");
    expect(shown?.note).toContain("最近一次");
    const packed = JSON.stringify(shown);
    expect(packed).not.toContain("SECRET_SYSTEM_PROMPT");
    expect(packed).not.toContain("sk-live");
    expect(packed).not.toContain("prompt_tokens");
    expect(packed).not.toContain("99999");
  });

  it("builds the snapshot from context metrics without treating them as a token window", () => {
    const usage = contextUsageFromMetrics({
      metrics,
      capturedAt: "2026-09-24T09:00:00.000Z",
      callId: "ctx_metrics",
      engine: "cloud",
    });
    expect(usage.messageChars).toBe(13000);
    expect(usage.ratio).toBe(0.25);
    expect(usage.measuredTokens).toBe(false);
    expect(usage.engine).toBe("cloud");
  });

  it("records Codex as unknown and does not invent a ratio", () => {
    const usage = unknownContextUsage({
      capturedAt: "2026-09-24T09:00:00.000Z",
      callId: "ctx_codex",
      engine: "codex",
      reason: "codex_runtime",
    });
    expect(usage.availability).toBe("unknown");
    expect(usage.note).toContain("未知");
    expect(usage.usedChars).toBeUndefined();
    expect(usage.ratio).toBeUndefined();
    expect(usage.unknownReason).toBe("codex_runtime");
  });
});
