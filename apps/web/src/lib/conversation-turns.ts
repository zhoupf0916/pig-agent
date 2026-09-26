import type { AgentEvent, ChatMessage, LiveTool } from "../types";

export type TurnAttachment = { id: string; name: string; href: string; detail?: string };

export type TurnMessage = ChatMessage & {
  /** Set when tool calls were removed for display. Progress is not a final answer. */
  phase?: "progress" | "answer";
  outcome?: TurnOutcome;
  notice?: string;
  author?: string;
  attachments?: TurnAttachment[];
};

export type ActivityState = "running" | "ok" | "failed" | "approval" | "cancelled";

export type ActivityRow = {
  id: string;
  title: string;
  detail: string;
  state: ActivityState;
  output?: string;
};

export type TurnOutcome = "running" | "approval" | "failed" | "cancelled" | "answered" | "no_answer";

export type TurnView = {
  id: string;
  userText?: string;
  answer?: string;
  answerStreaming?: boolean;
  collapsed: ActivityRow[];
  visible: ActivityRow[];
  current?: ActivityRow;
  outcome: TurnOutcome;
  notice?: string;
  notes: string[];
  author?: string;
  attachments?: TurnAttachment[];
};

const APPROVAL = /^(待批准|前序变更等待)/;

function rowFromTool(tool: LiveTool, title: string): ActivityRow {
  const approval = APPROVAL.test(tool.output || "");
  const cancelled = tool.done && tool.ok === false && tool.output === "用户已取消本轮，操作未执行。";
  const failed = tool.done && tool.ok === false && !approval;
  const detail = typeof tool.arguments === "string" ? tool.arguments : summarize(tool.arguments);
  return {
    id: tool.id,
    title,
    detail: detail.slice(0, 160),
    state: cancelled ? "cancelled" : approval ? "approval" : !tool.done ? "running" : failed ? "failed" : "ok",
    output: tool.output,
  };
}

function summarize(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === "{}" || text === undefined ? "" : text;
  } catch {
    return "";
  }
}

function isCancelText(text: string): boolean {
  return text.startsWith("已停止");
}

function isProgress(message: TurnMessage): boolean {
  return message.phase === "progress" || Boolean(message.toolCalls?.length);
}

export function mergeTools(historical: LiveTool[], live: LiveTool[]): LiveTool[] {
  const byId = new Map<string, LiveTool>();
  const order: string[] = [];
  for (const tool of historical) {
    if (!byId.has(tool.id)) order.push(tool.id);
    byId.set(tool.id, { ...tool });
  }
  for (const tool of live) {
    if (!byId.has(tool.id)) order.push(tool.id);
    const previous = byId.get(tool.id);
    byId.set(tool.id, previous ? { ...previous, ...tool } : { ...tool });
  }
  return order.map((id) => byId.get(id)!);
}

export function toolsFromEvents(events: AgentEvent[]): LiveTool[] {
  const tools: LiveTool[] = [];
  for (const event of events) {
    if (event.type === "tool_start") {
      tools.push({ id: event.id, name: event.name, arguments: event.arguments, done: false, startedAt: event.startedAt });
    } else if (event.type === "tool_end") {
      const tool = tools.find((item) => item.id === event.id);
      if (!tool) continue;
      tool.done = true;
      tool.ok = event.ok;
      tool.output = event.output;
      tool.durationMs = event.durationMs;
    }
  }
  return tools;
}

export function buildTurns(input: {
  messages: TurnMessage[];
  tools: LiveTool[];
  toolTitle: (name: string) => string;
  streaming: boolean;
  pendingApproval: boolean;
  lastError?: string;
}): TurnView[] {
  const visible = input.messages.filter((message) => message.role !== "system" && !message.content.startsWith("[harness]"));
  const turns: Array<{ id: string; user?: TurnMessage; assistants: TurnMessage[]; toolIds: string[]; uploads: string[] }> = [];
  let uploads: string[] = [];
  for (const message of visible) {
    if (message.synthetic === "attachment") { uploads.push(message.content); continue; }
    if (message.role === "tool" || message.content.startsWith("[team]")) continue;
    if (message.role === "user") {
      turns.push({ id: message.id, user: message, assistants: [], toolIds: [], uploads });
      uploads = [];
      continue;
    }
    const turn = turns.at(-1) ?? { id: message.id, assistants: [], toolIds: [], uploads: [] };
    if (!turns.length) turns.push(turn);
    if (message.content.trim() || message.id === "stream_live") turn.assistants.push(message);
    for (const call of message.toolCalls ?? []) turn.toolIds.push(call.id);
  }
  const used = new Set<string>();
  return turns.map((turn, index) => {
    const last = index === turns.length - 1;
    const owned = turn.toolIds.length
      ? input.tools.filter((tool) => turn.toolIds.includes(tool.id))
      : last ? input.tools.filter((tool) => !used.has(tool.id)) : [];
    const rows = owned.map((tool) => rowFromTool(tool, input.toolTitle(tool.name)));
    for (const row of rows) used.add(row.id);
    const answerMessage = [...turn.assistants].reverse().find((message) => message.content.trim() && !isProgress(message));
    const streamingAnswer = last && input.streaming && answerMessage?.id === "stream_live";
    const cancel = turn.assistants.some((message) => !isProgress(message) && isCancelText(message.content));
    const collapsed = rows.filter((row) => row.state === "ok" && !(last && input.streaming));
    const rest = rows.filter((row) => !collapsed.includes(row));
    const current = last && input.streaming ? rest.find((row) => row.state === "running") : undefined;
    const visibleRows = rest.filter((row) => row !== current && (row.state !== "ok" || !last || !input.streaming));
    const historicalOkWhileRunning = last && input.streaming ? rows.filter((row) => row.state === "ok") : [];
    let outcome: TurnOutcome = "answered";
    let notice: string | undefined;
    let answer = answerMessage?.content;
    const declared = turn.user?.outcome;
    if (declared === "approval" || declared === "failed" || declared === "cancelled" || declared === "running") {
      outcome = declared;
      notice = turn.user?.notice;
      if (declared === "cancelled") answer = undefined;
    } else if (last && input.pendingApproval) {
      outcome = "approval";
      notice = "需要批准后才会继续";
    } else if (cancel) {
      outcome = "cancelled";
      notice = turn.assistants.find((message) => isCancelText(message.content))?.content || "已取消";
      answer = undefined;
    } else if (last && input.lastError) {
      outcome = "failed";
      notice = input.lastError;
    } else if (last && input.streaming) {
      outcome = "running";
      notice = current ? `${current.title}${current.detail ? ` · ${current.detail}` : ""}` : "正在生成回复";
    } else if (!answer?.trim()) {
      outcome = "no_answer";
      notice = "本轮没有最终回答";
    }
    return {
      id: turn.id,
      userText: turn.user?.content,
      author: turn.user?.author,
      attachments: turn.user?.attachments,
      answer,
      answerStreaming: streamingAnswer,
      collapsed: last && input.streaming ? historicalOkWhileRunning : collapsed,
      visible: visibleRows.filter((row) => row.state !== "ok" || !input.streaming || !last),
      current,
      outcome,
      notice,
      notes: [...turn.uploads, ...turn.assistants.filter((message) => isProgress(message) && message.content.trim()).map((message) => message.content)],
    };
  });
}
