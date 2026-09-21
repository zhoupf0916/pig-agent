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
  const text = messages.filter(isPromptText);
  const kept = text.slice(-limit);
  if (kept.length === 0) return "";
  const current = kept[kept.length - 1]!;
  const prior = kept.slice(0, -1);
  const currentText = current.content.trim();
  const currentIndex = messages.lastIndexOf(current);

  const names = toolNameByCallId(messages);
  const toolsBeforeCurrent: { index: number; line: string }[] = [];
  if (currentIndex > 0) {
    for (let i = 0; i < currentIndex; i++) {
      const m = messages[i];
      if (m?.role !== "tool") continue;
      const name = (m.toolCallId && names.get(m.toolCallId)) || "unknown";
      toolsBeforeCurrent.push({ index: i, line: summarizeToolResult(m, name) });
    }
  }
  const recentTools = toolsBeforeCurrent.slice(-CODEX_TOOL_SUMMARY_MAX);

  const priorLines: { index: number; line: string }[] = prior.map((m) => ({
    index: messages.lastIndexOf(m),
    line: `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`,
  }));

  const historyLines = [...priorLines, ...recentTools]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.line);

  const body =
    historyLines.length === 0
      ? currentText
      : [
          "Previous conversation (assembled by Pig Agent; Codex has no native cross-turn memory in this MVP):",
          historyLines.join("\n\n"),
          "",
          "Current user request:",
          currentText,
        ].join("\n");
  return prependBoundInstructions(body, { expertInstruction, projectInstruction });
}
