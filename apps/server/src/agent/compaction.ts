/**
 * Structured (LLM-generated) context compaction.
 *
 * When the model-visible transcript grows past a ratio of the context budget, older
 * messages are replaced in *model context* by one sectioned summary (goal, done,
 * decisions, constraints, open items, key files). The full transcript stays persisted
 * for the UI and recall_context; `session.contextCompaction` records the summary and cut point.
 * Compaction only happens at loop boundaries (all tool calls answered), never mid-call.
 */
import type { ChatMessage } from "../types.ts";
import { CONTEXT_COMPACT_ID } from "@pig-agent/contracts";

export const DEFAULT_COMPACT_RATIO = 0.6;
export const DEFAULT_KEEP_RATIO = 0.25;
export const MAX_SUMMARY_INPUT_CHARS = 60_000;

export const COMPACTION_SECTIONS = ["目标", "已完成", "关键决策与证据", "约束与用户偏好", "未完成 / 下一步", "涉及文件"] as const;

const charsOf = (m: ChatMessage) => m.content.length + (m.reasoningContent?.length ?? 0) + JSON.stringify(m.toolCalls ?? []).length;
const isCompact = (m: ChatMessage) => m.synthetic === "context-compact" || m.id === CONTEXT_COMPACT_ID;
const isRealUser = (m: ChatMessage) => m.role === "user" && !m.synthetic && !m.content.startsWith("[harness]");

export function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(max, Math.max(min, raw)) : fallback;
}

export type CompactionState = { summary: string; through: string; createdAt: string; count: number };

/**
 * Model-visible view: the summary replaces every message up to `through`; the current user
 * request is re-included if it was folded. The persisted transcript is never modified.
 */
export function compactedView(messages: ChatMessage[], state?: CompactionState): ChatMessage[] {
  if (!state) return messages;
  const through = messages.findIndex((m) => m.id === state.through);
  if (through < 0) return messages;
  const tail = messages.slice(through + 1);
  const lastUser = [...messages].reverse().find(isRealUser);
  const needsRequest = lastUser && !tail.some((m) => m.id === lastUser.id) ? [lastUser] : [];
  return [summaryMessage(state.summary, state.createdAt), ...needsRequest, ...tail];
}

/**
 * Pick the last message id to fold into the summary. Keeps roughly `keepChars` of the most
 * recent messages, and never splits an assistant tool-call from its tool results.
 * Returns undefined when nothing is worth compacting.
 */
export function selectCompactionCut(view: ChatMessage[], keepChars: number): string | undefined {
  const body = view.filter((m) => !isCompact(m));
  let kept = 0;
  let cut = body.length; // index of first kept message
  for (let i = body.length - 1; i >= 0; i--) {
    if (kept + charsOf(body[i]!) > keepChars && cut < body.length) break;
    kept += charsOf(body[i]!);
    cut = i;
  }
  // Never let the kept tail start with tool results: pull in the assistant call that produced them.
  while (cut > 0 && cut < body.length && body[cut]!.role === "tool") cut--;
  if (cut <= 1) return undefined; // need at least two messages to fold
  return body[cut - 1]!.id;
}

function render(m: ChatMessage): string {
  const calls = m.toolCalls?.map((c) => `${c.name}(${c.arguments.slice(0, 300)})`).join("; ");
  const head = m.role === "tool" ? `tool[${m.toolOk === false ? "失败" : "ok"}]` : m.role;
  const body = m.content.length > 1500 ? `${m.content.slice(0, 1000)}\n…(省略 ${m.content.length - 1300} 字)…\n${m.content.slice(-300)}` : m.content;
  return `### ${head} ${m.id}\n${body}${calls ? `\n调用: ${calls}` : ""}`;
}

/** Messages to send to the model for producing the summary (no tools). */
export function buildCompactionRequest(folded: ChatMessage[], previousSummary?: string): ChatMessage[] {
  let transcript = folded.map(render).join("\n\n");
  if (transcript.length > MAX_SUMMARY_INPUT_CHARS) transcript = transcript.slice(-MAX_SUMMARY_INPUT_CHARS);
  const now = new Date().toISOString();
  return [
    { id: "compact_sys", role: "system", createdAt: now, content: [
      "你负责为一个编码/办公 Agent 压缩上下文。只根据给定记录写摘要，不要编造。",
      `用简体中文输出，严格使用以下 Markdown 小节标题（缺省写“无”）：${COMPACTION_SECTIONS.map((s) => `## ${s}`).join("、")}。`,
      "保留：用户原始目标与约束、已执行操作及其结果（成功/失败）、关键证据（路径、命令、报错原文要点）、尚未完成的事项。",
      "不要保留：寒暄、重复的工具输出、已被推翻的方案细节。总长度不超过 1500 字。",
    ].join("\n") },
    { id: "compact_user", role: "user", createdAt: now, content: `${previousSummary ? `此前的摘要：\n${previousSummary}\n\n` : ""}需要压缩的新记录：\n\n${transcript}` },
  ];
}

export function summaryMessage(summary: string, createdAt: string): ChatMessage {
  return {
    id: CONTEXT_COMPACT_ID, role: "user", synthetic: "context-compact", createdAt,
    content: `[上下文摘要] 以下为较早对话的结构化摘要（原文可用 recall_context 查阅）：\n\n${summary.trim()}`,
  };
}

export function viewChars(view: ChatMessage[]): number {
  return view.reduce((n, m) => n + charsOf(m), 0);
}
