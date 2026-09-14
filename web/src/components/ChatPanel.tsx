import { Loader2, Square, Terminal } from "lucide-react";
import { useEffect, useRef } from "react";
import { toolLabel } from "../lib/format";
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

  const visible = (session?.messages ?? []).filter((m) => m.role !== "system");

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <StepStrip steps={session?.steps ?? []} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!session && (
          <EmptyState
            title="选择或新建一个任务"
            body="在浏览器里用自然语言描述目标。Agent 会规划步骤、调用本地工具，并把产物留在右侧供你审阅。"
          />
        )}
        {session && visible.length === 0 && !streaming && (
          <EmptyState
            title="描述一个工作目标"
            body="例如：整理当前工作区，把散落的笔记归类，并写一份中文 README 摘要。"
          />
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {visible.map((m) => (
            <MessageBlock key={m.id} message={m} />
          ))}
          {liveTools.map((t) => (
            <ToolCard key={t.id} tool={t} />
          ))}
          {streaming && liveTools.every((t) => t.done) && (
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

function StepStrip({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="border-b border-white/5 bg-ink-900/40 px-6 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.16em] text-ink-500">步骤</div>
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
  if (status === "running") return "border-accent/40 bg-accent/10 text-sky-200";
  if (status === "done") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (status === "error") return "border-red-500/30 bg-red-500/10 text-red-200";
  return "border-white/10 bg-ink-850 text-ink-300";
}

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return null;
  if (message.role === "assistant" && !message.content && message.toolCalls?.length) {
    return null;
  }
  const mine = message.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          mine
            ? "bg-accent text-ink-950 shadow-panel"
            : "border border-white/5 bg-ink-850 text-ink-300"
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
  return (
    <details className="rounded-xl border border-white/5 bg-ink-900/70">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-ink-300">
        <Terminal size={13} className="text-accent" />
        <span className="font-medium">{toolLabel(tool.name)}</span>
        <span className="truncate text-ink-500">
          {typeof tool.arguments === "object" && tool.arguments
            ? summarize(tool.arguments)
            : ""}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-ink-500">
          {tool.done ? (tool.ok ? "完成" : "失败") : "进行中"}
        </span>
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] text-ink-300">
        {tool.done ? tool.output : JSON.stringify(tool.arguments, null, 2)}
      </pre>
    </details>
  );
}

function summarize(args: object): string {
  const rec = args as Record<string, unknown>;
  if (typeof rec.path === "string") return rec.path;
  if (typeof rec.command === "string") return rec.command;
  if (typeof rec.name === "string") return rec.name;
  return "";
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
    <div className="border-t border-white/5 bg-ink-900/50 px-6 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-3 rounded-2xl border border-white/10 bg-ink-850 px-3 py-2 shadow-panel">
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
          className="min-h-[52px] flex-1 resize-none bg-transparent py-2 text-sm text-white placeholder:text-ink-500"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="mb-1 inline-flex items-center gap-1 rounded-lg bg-red-500/90 px-3 py-2 text-xs font-medium text-white hover:bg-red-400"
          >
            <Square size={12} />
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !draft.trim()}
            onClick={onSend}
            className="mb-1 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-ink-950 hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-[11px] text-ink-500">
        Enter 发送 · Shift+Enter 换行 · 文件与命令仅作用于本地工作区
      </p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h2 className="text-lg font-medium text-white">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
    </div>
  );
}
