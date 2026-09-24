import { describe, it, expect } from "vitest";
import { modelHistory, conversationTranscript, displayHistory, attachRunOutcomes } from "./transcript.ts";
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
  it("keeps progress phase after tool calls are stripped and does not copy tool arguments", () => {
    const done = [
      { id: "u", role: "user", content: "检查项目", createdAt: "2026-01-01" },
      { id: "preamble", role: "assistant", content: "我先读取项目说明。", createdAt: "2026-01-01", toolCalls: [{ id: "c", name: "read_file", arguments: "{\"path\":\"SECRET_PATH\"}" }] },
      { id: "tool", role: "tool", content: "正文", toolCallId: "c" },
    ];
    const shown = displayHistory(done);
    expect(shown.find((message) => message.id === "preamble")).toMatchObject({ phase: "progress" });
    expect(shown.find((message) => message.id === "preamble")).not.toHaveProperty("toolCalls");
    expect(JSON.stringify(shown)).not.toContain("SECRET_PATH");
    expect(modelHistory(done).find((message) => message.id === "preamble")).toEqual({
      id: "preamble", role: "assistant", content: "我先读取项目说明。", createdAt: "2026-01-01",
    });
    const transcript = conversationTranscript(
      [{ id: "run_old", input: { prompt: "检查项目" }, created_at: "2026-01-01" }, { id: "run_new", input: { prompt: "继续" }, created_at: "2026-01-02" }],
      [{ run_id: "run_old", messages: done }],
    );
    const labeled = attachRunOutcomes(transcript, [
      { id: "run_old", state: "failed", error: "本轮执行失败", prompt: "检查项目" },
      { id: "run_new", state: "cancelled", error: null, prompt: "继续" },
    ], []);
    expect(labeled.find((message) => message.id === "preamble")?.phase).toBe("progress");
    expect(labeled.find((message) => message.content === "检查项目")).toMatchObject({ outcome: "failed", notice: "本轮执行失败" });
    expect(labeled.find((message) => message.id === "prompt:run_new")).toMatchObject({ outcome: "cancelled" });
  });
  it("marks a waiting approval on the historical run that still needs it", () => {
    const labeled = attachRunOutcomes(
      [{ id: "prompt:run_a", role: "user", content: "改文件", createdAt: "2026-01-01" }, { id: "prompt:run_b", role: "user", content: "另一轮", createdAt: "2026-01-02" }],
      [{ id: "run_a", state: "running", prompt: "改文件" }, { id: "run_b", state: "succeeded", prompt: "另一轮" }],
      ["run_a"],
    );
    expect(labeled[0]).toMatchObject({ outcome: "approval" });
    expect(labeled[1]?.outcome).toBeUndefined();
  });
});
