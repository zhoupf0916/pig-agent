import type { ChatMessage } from "../../types.ts";

/** Last N user/assistant text turns assembled into one Codex prompt. */
export const CODEX_HISTORY_MESSAGES = 12;

export function assembleCodexPrompt(
  messages: ChatMessage[],
  limit = CODEX_HISTORY_MESSAGES,
): string {
  const text = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      m.content.trim().length > 0 &&
      !m.content.startsWith("[harness]"),
  );
  const kept = text.slice(-limit);
  if (kept.length === 0) return "";
  const current = kept[kept.length - 1];
  const prior = kept.slice(0, -1);
  const currentText = current?.content.trim() ?? "";
  if (prior.length === 0) return currentText;

  const history = prior
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`)
    .join("\n\n");

  return [
    "Previous conversation (assembled by Pig Agent; Codex has no native cross-turn memory in this MVP):",
    history,
    "",
    "Current user request:",
    currentText,
  ].join("\n");
}
