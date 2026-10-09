import { describe, expect, it } from "vitest";
import { bindCode, chatKey, finalReply, normalizeCode, parseIncoming } from "./text.ts";

const BOT = "ou_bot";
const ev = (over: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => ({
  sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
  message: { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你好" }), ...msg },
  ...over,
});
describe("feishu parseIncoming", () => {
  it("treats DMs as prompts", () => {
    expect(parseIncoming(ev(), BOT)).toEqual({ kind: "prompt", text: "你好", messageId: "om_1", chatId: "oc_1", openId: "ou_user", group: false });
  });
  it("answers in groups only when the bot itself is mentioned", () => {
    const mention = (id: string) => ({ chat_type: "group", content: JSON.stringify({ text: "@_user_1 查一下 @_user_2" }), mentions: [{ key: "@_user_1", id: { open_id: id }, name: "猪猪" }, { key: "@_user_2", id: { open_id: "ou_x" }, name: "小王" }] });
    expect(parseIncoming(ev({}, mention("ou_other")), BOT).kind).toBe("ignore");
    expect(parseIncoming(ev({}, { chat_type: "group" }), BOT).kind).toBe("ignore");
    expect(parseIncoming(ev({}, { chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: BOT } }] }), undefined).kind).toBe("ignore");
    const r = parseIncoming(ev({}, mention(BOT)), BOT);
    expect(r).toMatchObject({ kind: "prompt", text: "查一下 @小王", group: true });
  });
  it("parses commands, empty mentions and non-text messages", () => {
    expect(parseIncoming(ev({}, { content: JSON.stringify({ text: "/bind ab12-cd34" }) }), BOT)).toMatchObject({ kind: "command", command: "bind", arg: "ab12-cd34" });
    expect(parseIncoming(ev({}, { content: JSON.stringify({ text: "/NEW" }) }), BOT)).toMatchObject({ kind: "command", command: "new" });
    expect(parseIncoming(ev({}, { content: JSON.stringify({ text: "  " }) }), BOT)).toMatchObject({ kind: "command", command: "help" });
    expect(parseIncoming(ev({}, { message_type: "image", content: "{}" }), BOT).kind).toBe("unsupported");
    expect(parseIncoming(ev({}, { content: "not json" }), BOT).kind).toBe("unsupported");
  });
  it("ignores bots and incomplete events", () => {
    expect(parseIncoming(ev({ sender: { sender_id: { open_id: "ou_b" }, sender_type: "app" } }), BOT).kind).toBe("ignore");
    expect(parseIncoming({ message: { message_id: "om" } }, BOT).kind).toBe("ignore");
  });
  it("caps prompt length", () => {
    const r = parseIncoming(ev({}, { content: JSON.stringify({ text: "长".repeat(9000) }) }), BOT);
    expect(r.kind === "prompt" && r.text.length).toBe(8000);
  });
});
describe("feishu helpers", () => {
  it("keys conversations per DM and per group member", () => {
    expect(chatKey("oc_1", "ou_a", false)).toBe("oc_1");
    expect(chatKey("oc_1", "ou_a", true)).toBe("oc_1:ou_a");
  });
  it("makes unambiguous bind codes and normalizes input", () => {
    const code = bindCode(new Uint8Array([0, 1, 2, 3, 31, 32, 200, 255]));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(normalizeCode(" ab12-cd34 ")).toBe("AB12CD34");
  });
  it("formats final replies with truncation and link", () => {
    expect(finalReply("succeeded", "答案", null, "https://x/#/c/1")).toBe("答案\n\n在工作台查看：https://x/#/c/1");
    expect(finalReply("succeeded", "长".repeat(4000), null, undefined)).toMatch(/已截断）$/);
    expect(finalReply("failed", undefined, "额度不足", undefined)).toBe("任务失败：额度不足");
    expect(finalReply("cancelled", undefined, null, undefined)).toBe("任务已取消。");
  });
});
