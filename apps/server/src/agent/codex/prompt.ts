import { assembleModelContext, ContextBudgetExceededError, isContextCompact } from "@pig-agent/contracts";
import type { ChatMessage } from "../../types.ts";
import { prependBoundInstructions } from "../bound-instructions.ts";

/** Last N user/assistant text turns assembled into one Codex prompt. */
export const CODEX_HISTORY_MESSAGES = 12;

/** Last K pig `role: "tool"` results included as one-line summaries (not full dumps). */
export const CODEX_TOOL_SUMMARY_MAX = 8;

/** Max characters of each tool result kept in the summary. */
export const CODEX_TOOL_SUMMARY_CHARS = 240;

function isPromptText(m: ChatMessage): boolean {
  return (
    (m.role === "user" || m.role === "assistant") &&
    m.content.trim().length > 0 &&
    !m.content.startsWith("[harness]")
  );
}

function toolNameByCallId(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      names.set(call.id, call.name);
    }
  }
  return names;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** `Tool(name): ok/err — first N chars of output` */
export function summarizeToolResult(
  message: ChatMessage,
  name: string,
  maxChars = CODEX_TOOL_SUMMARY_CHARS,
): string {
  const status = message.toolOk === false ? "err" : "ok";
  const snippet = truncate(oneLine(message.content), maxChars);
  return `Tool(${name}): ${status} — ${snippet || "(empty)"}`;
}

export function assembleCodexPrompt(
  messages: ChatMessage[],
  limit = CODEX_HISTORY_MESSAGES,
  projectInstruction?: string,
  expertInstruction?: string,
): string {
  // The legacy count is retained in the signature for callers; the actual
  // model input now uses a size budget rather than discarding early user goals.
  void limit;
  const current = [...messages].reverse().find((m) => m.role === "user" && isPromptText(m) && !isContextCompact(m));
  if (!current) return "";
  const currentIndex = messages.lastIndexOf(current);
  const names = toolNameByCallId(messages);
  const recentToolIds = new Set(messages.slice(0, currentIndex)
    .filter((m) => m.role === "tool").slice(-CODEX_TOOL_SUMMARY_MAX).map((m) => m.id));
  const candidates: ChatMessage[] = [];
  for (const message of messages.slice(0, currentIndex + 1)) {
    if (message.role === "tool" && recentToolIds.has(message.id)) {
      candidates.push({ ...message, role: "assistant", content: summarizeToolResult(message, (message.toolCallId && names.get(message.toolCallId)) || "unknown"), toolCallId: undefined, toolCalls: undefined });
    } else if (isPromptText(message) && !isContextCompact(message)) {
      candidates.push({ ...message, toolCalls: undefined, reasoningContent: undefined });
    }
  }
  const instructions = { expertInstruction, projectInstruction };
  const totalBudget = 24_000;
  const boundChars = prependBoundInstructions("", instructions).length;
  let bodyBudget = totalBudget - boundChars - 256;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const assembled = assembleModelContext({ messages: candidates, systemChars: 0, toolSchemaChars: 0, budgetChars: bodyBudget });
    const prior = assembled.messages.filter((m) => m.id !== current.id);
    const lines = prior.map((m) => isContextCompact(m) || recentToolIds.has(m.id)
      ? m.content : `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`);
    const body = lines.length ? [
      "Previous conversation (assembled by Pig Agent; Codex has no native cross-turn memory in this MVP):",
      lines.join("\n\n"), "", "Current user request:", current.content.trim(),
    ].join("\n") : current.content.trim();
    const prompt = prependBoundInstructions(body, instructions);
    if (prompt.length <= totalBudget) return prompt;
    bodyBudget -= prompt.length - totalBudget + 128;
  }
  throw new ContextBudgetExceededError("项目指令与当前请求超过 Codex 上下文预算，没有截断当前请求。请缩短指令或分拆请求。");
}
