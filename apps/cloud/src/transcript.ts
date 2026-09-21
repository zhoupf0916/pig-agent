type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
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
        m.content.length > 0,
    )
    .map((m) => ({
      id: String(m.id),
      role: m.role,
      content: m.content,
      createdAt: String(m.createdAt),
    }));
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
    for (const m of modelHistory(run.input.messages)) byId.set(m.id, m);
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
      for (const m of modelHistory(event.messages)) byId.set(m.id, m);
  }
  return [...byId.values()];
}
