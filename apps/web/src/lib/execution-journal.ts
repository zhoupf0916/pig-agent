import type { AgentEvent } from "../types";
import { toolLabel } from "./format";

export type JournalEntry = {
  key: string;
  title: string;
  detail: string;
  failed: boolean;
  running: boolean;
};
/** Transport fragments and duplicate lifecycle notifications are not user-facing log steps. */
export function executionJournal(events: AgentEvent[]): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const tools = new Map<string, JournalEntry>();
  for (const [index, event] of events.entries()) {
    if (event.type === "tool_start" || event.type === "tool_end") {
      let entry = tools.get(event.id);
      if (!entry) {
        entry = {
          key: `tool:${event.id}`,
          title: toolLabel(event.name),
          detail: "",
          failed: false,
          running: true,
        };
        tools.set(event.id, entry);
        entries.push(entry);
      }
      if (event.type === "tool_start") {
        if (entry.running)
          entry.detail = JSON.stringify(event.arguments, null, 2);
      } else {
        entry.detail = event.output;
        entry.failed = !event.ok;
        entry.running = false;
      }
    } else if (event.type === "error") {
      entries.push({
        key: `error:${index}`,
        title: "运行错误",
        detail: event.message,
        failed: true,
        running: false,
      });
    }
  }
  return entries;
}
