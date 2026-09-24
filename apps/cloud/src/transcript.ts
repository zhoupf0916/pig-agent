import { isContextCompact } from "@pig-agent/contracts";
import type { CloudConversationMessage } from "@pig-agent/contracts/cloud";

type Message = CloudConversationMessage & {
  role: "user" | "assistant";
  createdAt: string;
};
/** Never forward assistant tool calls without their corresponding tool results. */
export function modelHistory(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m) =>
        m &&
        ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" &&
        m.content.length > 0 &&
        !isContextCompact(m),
    )
    .map((m) => ({
      id: String(m.id),
      role: m.role,
      content: m.content,
      createdAt: String(m.createdAt),
    }));
}
/** UI transcript. Keeps phase after tool calls are removed. Does not copy tool arguments. */
export function displayHistory(messages: unknown): Message[] {
  if (!Array.isArray(messages)) return [];
  const shown: Message[] = [];
  for (const item of messages) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || !item.content.length || isContextCompact(item)) continue;
    const phase = item.role === "assistant"
      ? (Array.isArray(item.toolCalls) && item.toolCalls.length > 0) || item.phase === "progress" ? "progress" : "answer"
      : undefined;
    const message: Message = { id: String(item.id), role: item.role, content: item.content, createdAt: String(item.createdAt ?? "") };
    if (phase) message.phase = phase;
    shown.push(message);
  }
  return shown;
}

type OutcomeRun = {
  id: string;
  state?: string;
  error?: string | null;
  prompt?: string;
  input?: { messages?: Array<{ id?: string; role?: string }> };
};

export function attachRunOutcomes(
  messages: Message[],
  runs: OutcomeRun[],
  pendingApprovalRunIds: string[] = [],
): Message[] {
  const pending = new Set(pendingApprovalRunIds);
  const byPromptId = new Map(runs.map((run) => [`prompt:${run.id}`, run]));
  const byLastUserId = new Map<string, OutcomeRun>();
  for (const run of runs) {
    const lastUser = [...(run.input?.messages ?? [])].reverse().find((item) => item?.role === "user" && typeof item.id === "string");
    if (!lastUser?.id || byPromptId.has(lastUser.id) || byLastUserId.has(lastUser.id)) continue;
    byLastUserId.set(lastUser.id, run);
  }
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const run = byPromptId.get(message.id) ?? byLastUserId.get(message.id);
    if (!run) return message;
    if (pending.has(run.id)) return { ...message, outcome: "approval", notice: "需要批准后才会继续" };
    if (run.state === "failed") return { ...message, outcome: "failed", notice: run.error || "本轮执行失败" };
    if (run.state === "cancelled" || run.state === "cancelling") return { ...message, outcome: "cancelled", notice: run.error || "已取消" };
    if (run.state === "running" || run.state === "preparing" || run.state === "queued") return { ...message, outcome: "running", notice: "正在执行" };
    return message;
  });
}

export function conversationTranscript(
  runs: Array<{
    id: string;
    input: { prompt: string; messages?: Message[] };
    created_at: Date | string;
  }>,
  events: Array<{ run_id: string; messages: unknown }>,
): Message[] {
  const byId = new Map<string, Message>();
  for (const run of runs) {
    for (const m of displayHistory(run.input.messages)) byId.set(m.id, m);
    const previous = run.input.messages?.at(-1);
    if (previous?.role !== "user" || previous.content !== run.input.prompt) {
      const id = "prompt:" + run.id;
      byId.set(id, {
        id,
        role: "user",
        content: run.input.prompt,
        createdAt: new Date(run.created_at).toISOString(),
      });
    }
    for (const event of events.filter((e) => e.run_id === run.id))
      for (const m of displayHistory(event.messages)) byId.set(m.id, m);
  }
  return [...byId.values()];
}
