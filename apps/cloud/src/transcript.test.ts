import { describe, it, expect } from "vitest";
import { modelHistory, conversationTranscript } from "./transcript.ts";
describe("authoritative conversation history", () => {
  it("does not send orphaned tool calls to providers", () => {
    expect(
      modelHistory([
        {
          id: "a",
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call" }],
        },
        { id: "b", role: "tool", content: "result" },
        {
          id: "c",
          role: "assistant",
          content: "Done",
          createdAt: "now",
          toolCalls: [],
        },
      ]),
    ).toEqual([
      { id: "c", role: "assistant", content: "Done", createdAt: "now" },
    ]);
  });
  it("keeps previous turns when the next model context is trimmed and includes cancelled user prompts", () => {
    const runs = [
      { id: "1", input: { prompt: "first" }, created_at: "2026-01-01" },
      { id: "2", input: { prompt: "second" }, created_at: "2026-01-02" },
    ];
    const messages = conversationTranscript(runs, [
      {
        run_id: "1",
        messages: [
          {
            id: "prompt:1",
            role: "user",
            content: "first",
            createdAt: "2026-01-01",
          },
          {
            id: "reply",
            role: "assistant",
            content: "answer",
            createdAt: "2026-01-01",
          },
        ],
      },
    ]);
    expect(messages.map((m) => m.content)).toEqual([
      "first",
      "answer",
      "second",
    ]);
  });
  it("hides synthetic compact notes and does not treat private memory as a message", () => {
    const messages = conversationTranscript(
      [{ id: "9", input: { prompt: "取消后的请求", messages: [{ id: "context-compact", role: "user", content: "较早对话的确定性摘录\n私人记忆 sk-secret", createdAt: "2026-01-01" }] }, created_at: "2026-01-03" }],
      [],
    );
    expect(messages.map((m) => m.content)).toEqual(["取消后的请求"]);
    expect(messages.some((m) => m.content.includes("sk-secret"))).toBe(false);
  });
});
