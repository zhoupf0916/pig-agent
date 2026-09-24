import { describe, expect, it } from "vitest";
import type { ChatMessage, LiveTool } from "../types";
import { buildTurns } from "./conversation-turns";

const createdAt = "2026-09-24T00:00:00.000Z";
const user = (id: string): ChatMessage => ({ id, role: "user", content: "检查项目", createdAt });
const activity: ChatMessage = {
  id: "progress", role: "assistant", content: "我先读取项目说明。", createdAt,
  toolCalls: [{ id: "read", name: "read_file", arguments: "{}" }],
};
const read: LiveTool = { id: "read", name: "read_file", arguments: {}, done: true, ok: true, output: "说明内容" };
const view = (messages: ChatMessage[], tools: LiveTool[] = []) => buildTurns({
  messages, tools, streaming: false, pendingApproval: false, toolTitle: (name) => name,
});

describe("independent conversation acceptance", () => {
  it("does not present a tool preamble as the final answer after execution ends without a reply", () => {
    const turn = view([user("u1"), activity], [read])[0]!;
    expect(turn.outcome).toBe("no_answer");
    expect(turn.answer).toBeUndefined();
  });

  it("does not move earlier tool activity into a later plain conversation turn", () => {
    const turns = view([
      user("u1"), activity,
      { id: "answer", role: "assistant", content: "说明已核对。", createdAt },
      user("u2"), { id: "answer2", role: "assistant", content: "好的。", createdAt },
    ], [read]);
    expect(turns[0]?.collapsed.map((row) => row.id)).toEqual(["read"]);
    expect(turns[1]?.collapsed).toEqual([]);
  });

  it("keeps a cancelled historical turn cancelled after the user starts a new turn", () => {
    const turns = view([
      user("u1"), { id: "cancel", role: "assistant", content: "已停止。", createdAt },
      user("u2"), { id: "answer2", role: "assistant", content: "好的。", createdAt },
    ]);
    expect(turns[0]?.outcome).toBe("cancelled");
    expect(turns[0]?.answer).toBeUndefined();
  });
});
