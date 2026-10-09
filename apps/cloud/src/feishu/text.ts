// Pure helpers for the Feishu bot (F3): no I/O, unit-tested in text.test.ts.

export type FeishuMessageEvent = {
  event_id?: string;
  sender?: { sender_id?: { open_id?: string }; sender_type?: string; tenant_key?: string };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string; // "p2p" | "group"
    message_type?: string;
    content?: string;
    thread_id?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
};

export type Incoming =
  | { kind: "ignore"; reason: string }
  | { kind: "unsupported"; messageId: string; chatId: string; openId: string; group: boolean }
  | { kind: "command"; command: "bind" | "unbind" | "new" | "help"; arg: string; messageId: string; chatId: string; openId: string; group: boolean }
  | { kind: "prompt"; text: string; messageId: string; chatId: string; openId: string; group: boolean };

export const MAX_PROMPT_CHARS = 8000;

/** Decide what to do with one im.message.receive_v1 event. In groups only explicit @-mentions of the bot count. */
export function parseIncoming(event: FeishuMessageEvent, botOpenId: string | undefined): Incoming {
  const m = event.message;
  const openId = event.sender?.sender_id?.open_id;
  if (!m?.message_id || !m.chat_id || !openId) return { kind: "ignore", reason: "incomplete event" };
  if (event.sender?.sender_type && event.sender.sender_type !== "user") return { kind: "ignore", reason: "not from a user" };
  const group = m.chat_type !== "p2p";
  const mentions = m.mentions ?? [];
  if (group) {
    const mentioned = botOpenId ? mentions.some((x) => x.id?.open_id === botOpenId) : false;
    if (!mentioned) return { kind: "ignore", reason: "group message without @bot" };
  }
  const base = { messageId: m.message_id, chatId: m.chat_id, openId, group };
  if (m.message_type !== "text") return { kind: "unsupported", ...base };
  let text = "";
  try {
    text = String((JSON.parse(m.content || "{}") as { text?: unknown }).text ?? "");
  } catch {
    return { kind: "unsupported", ...base };
  }
  // Strip the bot's own mention placeholder; keep other people's names readable.
  for (const x of mentions) {
    if (!x.key) continue;
    text = text.split(x.key).join(x.id?.open_id === botOpenId ? "" : "@" + (x.name || "某人"));
  }
  text = text.replace(/\u00a0/g, " ").trim();
  if (!text) return { kind: "command", command: "help", arg: "", ...base };
  const cmd = text.match(/^\/(bind|unbind|new|help)\b\s*(.*)$/is);
  if (cmd) return { kind: "command", command: cmd[1]!.toLowerCase() as "bind", arg: cmd[2]!.trim(), ...base };
  return { kind: "prompt", text: text.slice(0, MAX_PROMPT_CHARS), ...base };
}

/** One conversation per DM, and per (group, member) so members never share a workspace. */
export function chatKey(chatId: string, openId: string, group: boolean) {
  return group ? `${chatId}:${openId}` : chatId;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function bindCode(bytes: Uint8Array) {
  return Array.from(bytes.slice(0, 8), (b) => ALPHABET[b % ALPHABET.length]).join("");
}
export function normalizeCode(arg: string) {
  return arg.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const MAX_REPLY_CHARS = 3500;
export function finalReply(state: string, text: string | undefined, error: string | null | undefined, link: string | undefined) {
  const tail = link ? `\n\n在工作台查看：${link}` : "";
  if (state === "succeeded") {
    const body = (text || "").trim() || "任务已完成（没有文字回复）。";
    return (body.length > MAX_REPLY_CHARS ? body.slice(0, MAX_REPLY_CHARS) + "…（内容较长，已截断）" : body) + tail;
  }
  if (state === "cancelled") return "任务已取消。" + tail;
  return `任务失败：${(error || "未知错误").slice(0, 300)}` + tail;
}

export const HELP_TEXT = [
  "我是猪猪 Agent。私聊直接发消息，或在群里 @我，就会以你的工作台账号执行任务并把结果发回来。",
  "首次使用：在工作台「设置 → 飞书」生成绑定码，然后私聊我发送 /bind 绑定码。",
  "命令：/new 开始新会话 · /unbind 解除绑定 · /help 帮助",
].join("\n");
