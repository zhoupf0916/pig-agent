import { ArrowUp, FileText, FolderOpen, Sparkles, Check, Loader2, Pin, Play, Square, StickyNote, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { streamingStatusLabel } from "../lib/create-run-progress";
import { formatDuration, summarizeArgs, toolLabel } from "../lib/format";
import type { ChatMessage, Expert, ExpertTeam, LiveTool, PlanStep, Session, TeamRunMember } from "../types";
import { HandoffDialog } from "./HandoffDialog";
import { MarkdownView } from "./MarkdownView";
import { PinNoteDialog } from "./PinNoteDialog";

export function ChatPanel({
  session,
  draft,
  streaming,
  liveTools,
  projectName,
  projects,
  experts,
  teams,
  expertName,
  onDraft,
  onSend,
  onStop,
  onTeamRun,
  onBindProject,
  onBindExpert,
  onBindTeam,
  onHandoffDone,
  onOpenMemory,
}: {
  session: Session | null;
  draft: string;
  streaming: boolean;
  liveTools: LiveTool[];
  projectName?: string;
  projects: Array<{ id: string; name: string }>;
  experts: Expert[];
  teams: ExpertTeam[];
  expertName?: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onTeamRun: () => void;
  onBindProject: (projectId: string | null) => void;
  onBindExpert: (expertId: string | null) => void;
  onBindTeam: (teamId: string | null) => void;
  onHandoffDone?: () => void;
  onOpenMemory?: (noteId?: string) => void;
}) {
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages, liveTools, streaming]);

  const pinnedTeam = teams.find((t) => t.id === session?.expertTeamId);
  const teamMembers: TeamRunMember[] = session?.teamRun?.members?.length
    ? session.teamRun.members
    : (pinnedTeam?.expertIds ?? []).map((id) => {
        const expert = experts.find((e) => e.id === id);
        return {
          expertId: id,
          name: expert?.name ?? id,
          kind: expert?.kind ?? "custom",
          status: "pending" as const,
        };
      });
  const canChain = Boolean(pinnedTeam && pinnedTeam.mode === "chain" && !session?.expertId);
  const canContinue = Boolean(
    canChain &&
      session?.teamRun &&
      session.teamRun.members.some(
        (m) => m.status === "pending" || m.status === "error" || m.status === "cancelled",
      ) &&
      session.teamRun.status !== "running",
  );
  const canStartTeam =
    canChain &&
    !streaming &&
    (Boolean(draft.trim()) ||
      canContinue ||
      Boolean(session?.messages.some((m) => m.role === "user" && !m.content.startsWith("[harness]"))));

  const visible = (session?.messages ?? []).filter(
    (m) => m.role !== "system" && !m.content.startsWith("[harness]"),
  );
  const tools = useMemo(
    () => (liveTools.length > 0 ? liveTools : toolsFromMessages(session?.messages ?? [])),
    [liveTools, session?.messages],
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-ink-50">
      {session && (
        <details className="border-b border-ink-300">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 py-4">
            <span className="truncate text-sm font-medium text-ink-800">{session.title}</span>
            <span className="shrink-0 text-xs text-ink-500">任务配置 ···</span>
          </summary>
        <div className="chat-context flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-300 bg-panel px-6 py-2">
          <label className="flex items-center gap-2">
            <span className="text-meta uppercase tracking-[0.16em] text-ink-500">项目</span>
            <select
              className="field max-w-[160px] py-1 text-xs"
              value={session.projectId ?? ""}
              onChange={(e) => onBindProject(e.target.value || null)}
            >
              <option value="">未绑定</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-meta uppercase tracking-[0.16em] text-ink-500">专家</span>
            <select
              className="field max-w-[180px] py-1 text-xs"
              value={session.expertId ?? ""}
              onChange={(e) => onBindExpert(e.target.value || null)}
            >
              <option value="">未绑定</option>
              {experts.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-meta uppercase tracking-[0.16em] text-ink-500">小队</span>
            <select
              className="field max-w-[160px] py-1 text-xs"
              value={session.expertTeamId ?? ""}
              onChange={(e) => onBindTeam(e.target.value || null)}
            >
              <option value="">未绑定</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {(expertName || projectName || pinnedTeam) && (
            <span className="text-xs text-ink-500">
              {expertName && pinnedTeam
                ? "已钉选单个专家，小队仅作元数据"
                : pinnedTeam && pinnedTeam.mode === "chain"
                  ? "小队按顺序各跑一轮（同会话）"
                  : expertName && projectName
                    ? "专家指令先于项目指令注入"
                    : expertName
                      ? "专家指令将注入本会话系统提示"
                      : projectName
                        ? "项目指令将注入本会话系统提示"
                        : "小队指令将注入本会话系统提示"}
            </span>
          )}
          {canChain && (
            <button
              type="button"
              className="btn-ghost"
              disabled={!canStartTeam}
              onClick={onTeamRun}
            >
              <Play size={13} />
              {canContinue && !draft.trim() ? "继续小队" : "顺序执行小队"}
            </button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {memoryStatus && <span className="text-xs text-ink-500">{memoryStatus}</span>}
            <button type="button" className="btn-ghost" onClick={() => setPinOpen(true)}>
              <Pin size={13} />
              钉住笔记
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={recapBusy || !session.messages.some((m) => m.role === "user" || m.role === "assistant")}
              onClick={() => {
                void (async () => {
                  setRecapBusy(true);
                  setMemoryStatus(null);
                  try {
                    const note = await api.sessionRecap(session.id);
                    setMemoryStatus("已写入回合摘要");
                    onOpenMemory?.(note.id);
                  } catch (err) {
                    setMemoryStatus(err instanceof Error ? err.message : String(err));
                  } finally {
                    setRecapBusy(false);
                  }
                })();
              }}
            >
              <StickyNote size={13} />
              写摘要
            </button>
            {session.projectId && (
              <button type="button" className="btn-ghost" onClick={() => setHandoffOpen(true)}>
                转交到收件箱
              </button>
            )}
          </div>
        </div>
        </details>
      )}
      {pinnedTeam && teamMembers.length > 0 && (
        <TeamPipeline
          teamName={session?.teamRun?.teamName ?? pinnedTeam.name}
          members={teamMembers}
          status={session?.teamRun?.status}
        />
      )}
      <StepStrip steps={session?.steps ?? []} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!session && (
          <EmptyState
            title="今天，让什么想法落地？"
            body="新建一个任务，从一句话开始。规划、执行与成果，都在这里。"
          />
        )}
        {session && visible.length === 0 && !streaming && (
          <EmptyState
            title="把下一件事，交给 Pig。"
            body="整理文件、探索问题，或完成一份报告。告诉我你想做什么。"
            onChoose={onDraft}
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
              {streamingStatusLabel(session?.steps ?? [])}
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
      {handoffOpen && session?.projectId && (
        <HandoffDialog
          projectId={session.projectId}
          projectName={projectName}
          session={session}
          onClose={() => setHandoffOpen(false)}
          onDone={() => {
            setHandoffOpen(false);
            onHandoffDone?.();
          }}
        />
      )}
      {pinOpen && session && (
        <PinNoteDialog
          session={session}
          onClose={() => setPinOpen(false)}
          onDone={() => {
            setPinOpen(false);
            setMemoryStatus("已钉住到本机记忆");
          }}
        />
      )}
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

function TeamPipeline({
  teamName,
  members,
  status,
}: {
  teamName: string;
  members: TeamRunMember[];
  status?: string;
}) {
  const done = members.filter((m) => m.status === "done").length;
  const running = members.filter((m) => m.status === "running").length;
  return (
    <div className="border-b border-ink-400 bg-panel px-6 py-3">
      <div className="mb-2 flex items-center justify-between text-meta text-ink-600">
        <span className="uppercase tracking-[0.16em]">小队流水线 · {teamName}</span>
        <span>
          {done}/{members.length} 完成
          {running ? ` · ${running} 进行中` : ""}
          {status && status !== "idle" && status !== "running" ? ` · ${status}` : ""}
        </span>
      </div>
      <ol className="flex flex-wrap gap-2">
        {members.map((member, i) => (
          <li
            key={`${member.expertId}-${i}`}
            title={member.detail}
            className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-meta ${tone(member.status === "cancelled" ? "error" : member.status)}`}
          >
            <span className="font-mono text-[12px] text-ink-600">{i + 1}</span>
            {member.name}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepStrip({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;
  const running = steps.filter((s) => s.status === "running").length;
  const done = steps.filter((s) => s.status === "done").length;
  const pending = steps.filter((s) => s.status === "pending").length;
  return (
    <div className="border-b border-ink-400 bg-panel px-6 py-3">
      <div className="mb-2 flex items-center justify-between text-meta text-ink-600">
        <span className="uppercase tracking-[0.16em]">步骤</span>
        <span>
          {done}/{steps.length} 完成{running ? ` · ${running} 进行中` : ""}
          {pending ? ` · ${pending} 待处理` : ""}
        </span>
      </div>
      <ol className="flex flex-wrap gap-2">
        {steps.map((step, i) => (
          <li
            key={step.id}
            title={step.detail}
            className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-meta ${tone(step.status)}`}
          >
            <span className="font-mono text-[12px] text-ink-600">{i + 1}</span>
            {step.title}
          </li>
        ))}
      </ol>
    </div>
  );
}

function tone(status: PlanStep["status"]): string {
  if (status === "running") return "border-accent bg-accent-soft text-accent-mute";
  if (status === "done") return "border-success bg-success-soft text-success";
  if (status === "error") return "border-danger bg-danger-soft text-danger";
  return "border-ink-400 bg-panel text-ink-700";
}

function MessageBlock({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return null;
  if (message.content.startsWith("[team]")) {
    return (
      <div className="flex justify-center">
        <div className="rounded-full border border-accent bg-accent-soft px-3 py-1 text-meta text-accent-mute">
          {message.content.replace(/^\[team\]\s*/, "")}
        </div>
      </div>
    );
  }
  const mine = message.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-[18px] px-5 py-4 text-body ${
          mine
            ? "bg-accent-soft text-ink-800"
            : "bg-panel text-ink-800"
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
      className="rounded-xl border border-ink-300 bg-panel"
      open={!tool.done || !tool.ok}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-meta text-ink-700">
        <Terminal size={13} className="text-accent-mute" />
        <span className="font-medium text-ink-800">{toolLabel(tool.name)}</span>
        <span className="truncate text-ink-600">{summary}</span>
        <span className="ml-auto flex items-center gap-2 text-meta uppercase tracking-wider">
          {tool.durationMs !== undefined && (
            <span className="normal-case text-ink-600">{formatDuration(tool.durationMs)}</span>
          )}
          {!tool.done && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 font-medium text-accent-mute">
              <Loader2 size={11} className="animate-spin" />
              进行中
            </span>
          )}
          {tool.done && tool.ok && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 font-medium text-success">
              <Check size={11} />
              成功
            </span>
          )}
          {tool.done && !tool.ok && (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-1.5 py-0.5 font-medium text-danger">
              <X size={11} />
              失败
            </span>
          )}
        </span>
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-ink-400 bg-ink-100 px-3 py-2 font-mono text-[12px] text-ink-800">
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
    <div className="composer-shell bg-ink-50">
      <div className="composer-box mx-auto flex max-w-3xl items-end gap-3 rounded-card border border-ink-400 bg-panel px-3 py-2 shadow-panel">
        <textarea
          value={draft}
          disabled={disabled || streaming}
          placeholder={disabled ? "先新建一个任务…" : "描述目标，例如：整理工作区并写一份摘要 README"}
          rows={2}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
            className="mb-1 inline-flex items-center gap-1 rounded-btn bg-danger px-3 py-2 text-xs font-medium text-white hover:bg-red-700"
          >
            <Square size={12} />
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !draft.trim()}
            onClick={onSend}
            className="btn-primary mb-1 h-10 w-10 shrink-0 rounded-xl"
            aria-label="发送"
            title="发送"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-meta text-ink-500">
        Enter 发送 · Shift+Enter 换行 · 请核对重要操作与交付结果
      </p>
    </div>
  );
}

function EmptyState({ title, body, onChoose }: { title: string; body: string; onChoose?: (value: string) => void }) {
  const suggestions = [
    { icon: FolderOpen, title: "整理工作区", detail: "先了解文件，再制定整理计划", prompt: "查看当前工作区的文件结构，提出整理建议，先不要修改文件。" },
    { icon: FileText, title: "写一份报告", detail: "从现有资料中提炼重点", prompt: "阅读当前工作区中的文档，整理一份中文摘要，并标明引用的文件。" },
    { icon: Sparkles, title: "探索项目", detail: "读懂项目，找到下一步", prompt: "分析当前工作区的项目，介绍主要功能，并列出值得改进的三个方向。" },
  ];
  return (
    <div className="welcome mx-auto max-w-2xl pb-10 text-center">
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-[18px] bg-accent-soft text-accent"><Sparkles size={26} strokeWidth={1.5} /></div>
      <div className="mb-3 text-[11px] font-semibold tracking-[0.22em] text-accent">PIG AGENT · 工作台</div>
      <h2 className="text-[32px] font-semibold tracking-tight text-ink-800">{title}</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-ink-500">{body}</p>
      {onChoose && <div className="mt-8 grid gap-3 lg:grid-cols-3">
        {suggestions.map(({ icon: Icon, title: label, detail, prompt }) => (
          <button key={label} className="welcome-card group" onClick={() => onChoose(prompt)}>
            <Icon size={19} className="mb-4 text-accent" strokeWidth={1.5} />
            <div className="text-sm font-medium text-ink-800">{label}</div>
            <div className="mt-1 text-xs leading-5 text-ink-500">{detail}</div>
          </button>
        ))}
      </div>}
    </div>
  );
}
