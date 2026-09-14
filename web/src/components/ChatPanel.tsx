import { Check, Loader2, Square, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { formatDuration, summarizeArgs, toolLabel } from "../lib/format";
import type { ChatMessage, LiveTool, PlanStep, Session } from "../types";
import { MarkdownView } from "./MarkdownView";

export function ChatPanel({
  session,
  draft,
  streaming,
  liveTools,
  onDraft,
  onSend,
  onStop,
}: {
  session: Session | null;
  draft: string;
  streaming: boolean;
  liveTools: LiveTool[];
  onDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages, liveTools, streaming]);

  const visible = (session?.messages ?? []).filter(
    (m) => m.role !== "system" && !m.content.startsWith("[harness]"),
  );
  const tools = useMemo(
    () => (liveTools.length > 0 ? liveTools : toolsFromMessages(session?.messages ?? [])),
    [liveTools, session?.messages],
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-ink-50">
      <StepStrip steps={session?.steps ?? []} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!session && (
          <EmptyState
            title="选择或新建一个任务"
            body="在浏览器里用自然语言描述目标。Agent 会规划 → 调用工具 → 校验 → 留下可审阅产物。"
          />
        )}
        {session && visible.length === 0 && !streaming && (
          <EmptyState
            title="描述一个工作目标"
            body="例如：搜索散落的笔记，整理到文件夹，并写一份中文调研报告。"
          />
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {interleave(visible, tools).map((item) =>
            item.kind === "message" ? (
              <MessageBlock key={item.message.id} message={item.message} />
            ) : (
              <ToolCard key={item.tool.id} tool={item.tool} />
            ),
          )}
          {streaming && tools.every((t) => t.done) && (
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <Loader2 size={14} className="animate-spin text-accent" />
              正在思考…
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <Composer
        draft={draft}
        streaming={streaming}
        disabled={!session}
        onDraft={onDraft}
        onSend={onSend}
        onStop={onStop}
      />
    </section>
  );
}

function toolsFromMessages(messages: ChatMessage[]): LiveTool[] {
  const cards: LiveTool[] = [];
  const byId = new Map<string, LiveTool>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        let args: unknown = tc.arguments;
        try {
          args = JSON.parse(tc.arguments) as unknown;
        } catch {
          args = tc.arguments;
        }
        const card: LiveTool = {
          id: tc.id,
          name: tc.name,
          arguments: args,
          done: false,
        };
        cards.push(card);
        byId.set(tc.id, card);
      }
    }
    if (m.role === "tool" && m.toolCallId) {
      const card = byId.get(m.toolCallId);
      if (card) {
        card.done = true;
        card.ok = m.toolOk ?? !/^Sandbox blocked|^HTTP fetch blocked|^Error\b/i.test(m.content);
        card.output = m.content;
        card.durationMs = m.toolDurationMs;
      }
    }
  }
  return cards;
}

function interleave(
  messages: ChatMessage[],
  tools: LiveTool[],
): Array<{ kind: "message"; message: ChatMessage } | { kind: "tool"; tool: LiveTool }> {
  const used = new Set<string>();
  const out: Array<{ kind: "message"; message: ChatMessage } | { kind: "tool"; tool: LiveTool }> =
    [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "assistant" && !message.content && message.toolCalls?.length) {
      for (const tc of message.toolCalls) {
        const tool = tools.find((t) => t.id === tc.id);
        if (tool) {
          out.push({ kind: "tool", tool });
          used.add(tool.id);
        }
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const tc of message.toolCalls) {
        const tool = tools.find((t) => t.id === tc.id);
        if (tool) {
          out.push({ kind: "tool", tool });
          used.add(tool.id);
        }
      }
    }
    if (message.role === "user" || (message.role === "assistant" && message.content)) {
      out.push({ kind: "message", message });
    }
  }
  for (const tool of tools) {
    if (!used.has(tool.id)) out.push({ kind: "tool", tool });
  }
  return out;
}

function StepStrip({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;
  const running = steps.filter((s) => s.status === "running").length;
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div className="border-b border-ink-300 bg-white/80 px-6 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] text-ink-500">
        <span className="uppercase tracking-[0.16em]">步骤</span>
        <span>
          {done}/{steps.length} 完成{running ? ` · ${running} 进行中` : ""}
        </span>
      </div>
      <ol className="flex flex-wrap gap-2">
        {steps.map((step, i) => (
          <li
            key={step.id}
            title={step.detail}
            className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] ${tone(step.status)}`}
          >
            <span className="font-mono text-[10px] opacity-70">{i + 1}</span>
            {step.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

function tone(status: PlanStep["status"]): string {
  if (status === "running") return "border-accent/30 bg-accent-soft text-accent";
  if (status === "done") return "border-success/20 bg-success-soft text-success";
  if (status === "error") return "border-danger/20 bg-danger-soft text-danger";
  return "border-ink-300 bg-white text-ink-600";
}

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return null;
  const mine = message.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-card px-4 py-3 text-body ${
          mine
            ? "border border-ink-300 bg-ink-100 text-ink-800"
            : "border border-ink-300 bg-white text-ink-800 shadow-panel"
        }`}
      >
        {mine ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <MarkdownView text={message.content || " "} />
        )}
      </div>
    </div>
  );
}

function ToolCard({ tool }: { tool: LiveTool }) {
  const summary = summarizeArgs(tool.arguments);
  return (
    <details
      className="rounded-card border border-ink-300 bg-white shadow-panel"
      open={!tool.done || !tool.ok}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-meta text-ink-700">
        <Terminal size={13} className="text-accent" />
        <span className="font-medium text-ink-800">{toolLabel(tool.name)}</span>
        <span className="truncate text-ink-600">{summary}</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] uppercase tracking-wider">
          {tool.durationMs !== undefined && (
            <span className="normal-case text-ink-600">{formatDuration(tool.durationMs)}</span>
          )}
          {!tool.done && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-accent">
              <Loader2 size={11} className="animate-spin" />
              进行中
            </span>
          )}
          {tool.done && tool.ok && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 text-success">
              <Check size={11} />
              成功
            </span>
          )}
          {tool.done && !tool.ok && (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-1.5 py-0.5 text-danger">
              <X size={11} />
              失败
            </span>
          )}
        </span>
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-ink-300 bg-ink-100 px-3 py-2 font-mono text-[12px] text-ink-700">
        {tool.done ? tool.output : JSON.stringify(tool.arguments, null, 2)}
      </pre>
    </details>
  );
}

function Composer({
  draft,
  streaming,
  disabled,
  onDraft,
  onSend,
  onStop,
}: {
  draft: string;
  streaming: boolean;
  disabled: boolean;
  onDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="border-t border-ink-300 bg-white/80 px-6 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-3 rounded-card border border-ink-300 bg-white px-3 py-2 shadow-panel">
        <textarea
          value={draft}
          disabled={disabled || streaming}
          placeholder={disabled ? "先新建一个任务…" : "描述目标，例如：整理工作区并写一份摘要 README"}
          rows={2}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          className="min-h-[52px] flex-1 resize-none bg-transparent py-2 text-body text-ink-800 placeholder:text-ink-500 disabled:cursor-not-allowed disabled:text-ink-500"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="mb-1 inline-flex items-center gap-1 rounded-btn bg-danger px-3 py-2 text-xs font-medium text-white hover:bg-red-500"
          >
            <Square size={12} />
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !draft.trim()}
            onClick={onSend}
            className="btn-primary mb-1"
          >
            发送
          </button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-[11px] text-ink-500">
        Enter 发送 · Shift+Enter 换行 · 运行中可点停止 · 文件与命令仅作用于本地工作区
      </p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h2 className="text-lg font-medium text-ink-800">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
    </div>
  );
}
