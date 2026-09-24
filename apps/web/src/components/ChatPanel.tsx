import { SkillComposerInput, type SkillChoice } from "./SkillComposerInput";
import { InlineRemoteActivity } from "./InlineRemoteActivity";
import type { RemoteActivity } from "../lib/remote-activity";
import { WorkbenchPanel } from "./WorkbenchPanel";
import {
  ArrowUp,
  Plus,
  FileText,
  FolderOpen,
  Sparkles,
  Check,
  Loader2,
  Pin,
  Play,
  Square,
  StickyNote,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { streamingStatusLabel } from "../lib/create-run-progress";
import { formatDuration, summarizeArgs, toolLabel } from "../lib/format";
import type {
  ChatMessage,
  ExecutionSurface,
  Expert,
  ExpertTeam,
  LiveTool,
  PlanStep,
  Session,
  TeamRunMember,
} from "../types";
import { HandoffDialog } from "./HandoffDialog";
import { MarkdownView } from "./MarkdownView";
import { PinNoteDialog } from "./PinNoteDialog";

export function ChatPanel({
  skills,
  selectedSkillIds,
  onSkillsChange,
  configurationOpen = false,
  executionControls,
  workspaceRoot,
  onOpenSettings,
  onOpenArtifacts,
  remoteActivity,
  initializing = false,
  executionSurface,
  onOpenRemote,
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
  onResume,
  onRefresh,
  onEnsureSession,
  onSend,
  onStop,
  onTeamRun,
  onBindProject,
  onBindExpert,
  onBindTeam,
  onHandoffDone,
  onOpenMemory,
}: {
  skills: SkillChoice[];
  selectedSkillIds: string[];
  onSkillsChange: (ids: string[]) => void;
  configurationOpen?: boolean;
  executionControls?: ReactNode;
  workspaceRoot?: string;
  onOpenSettings?: () => void;
  onOpenArtifacts?: () => void;
  remoteActivity?: RemoteActivity;
  initializing?: boolean;
  executionSurface?: ExecutionSurface;
  onOpenRemote?: () => void;
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
  onResume: () => void;
  onRefresh: () => void;
  onEnsureSession?: () => Promise<Session>;
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useEffect(() => {
    followLatest.current = true;
    setAwayFromLatest(false);
    endRef.current?.scrollIntoView({ block: "end" });
  }, [session?.id]);
  useEffect(() => {
    if (followLatest.current) endRef.current?.scrollIntoView({ block: "end" });
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
  const canChain = Boolean(
    pinnedTeam && pinnedTeam.mode === "chain" && !session?.expertId,
  );
  const canContinue = Boolean(
    canChain &&
    session?.teamRun &&
    session.teamRun.members.some(
      (m) =>
        m.status === "pending" ||
        m.status === "error" ||
        m.status === "cancelled",
    ) &&
    session.teamRun.status !== "running",
  );
  const canStartTeam =
    canChain &&
    !streaming &&
    (Boolean(draft.trim()) ||
      canContinue ||
      Boolean(
        session?.messages.some(
          (m) => m.role === "user" && !m.content.startsWith("[harness]"),
        ),
      ));

  const visible = (session?.messages ?? []).filter(
    (m) => m.role !== "system" && !m.content.startsWith("[harness]"),
  );
  const tools = useMemo(
    () =>
      liveTools.length > 0
        ? liveTools
        : toolsFromMessages(session?.messages ?? []),
    [liveTools, session?.messages],
  );

  const empty = visible.length === 0 && !streaming;
  const attachments = useLocalAttachments(
    session,
    onRefresh,
    onEnsureSession,
    initializing,
    streaming || session?.status === "running",
  );
  const composer = (
    <Composer
      skills={skills}
      selectedSkillIds={selectedSkillIds}
      onSkillsChange={onSkillsChange}
      attachments={attachments}
      draft={draft}
      streaming={streaming || session?.status === "running"}
      disabled={initializing}
      onDraft={onDraft}
      onSend={onSend}
      onStop={onStop}
    />
  );
  return (
    <section className={`conversation ${empty ? "is-empty" : ""}`}>
      {configurationOpen && (
        <section className="task-configuration" aria-label="任务配置面板">
          <div className="configuration-heading">
            <strong>本任务配置</strong>
            <span>运行期间不可切换执行位置</span>
          </div>
          <div className="execution-options">{executionControls}</div>
          <div className="workspace-context">
            <FolderOpen size={16} />
            <span title={workspaceRoot}>
              {executionSurface?.kind === "cloud-remote"
                ? "远端工作区 · 控制面保存版本"
                : workspaceRoot || "尚未选择工作区"}
            </span>
            <button className="text-action" onClick={onOpenSettings}>
              工作区设置
            </button>
          </div>
        </section>
      )}
      {session && configurationOpen && (
        <div>
          <fieldset
            disabled={initializing || streaming}
            className="chat-context flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-300 bg-panel px-6 py-2"
          >
            <label className="flex items-center gap-2">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                项目
              </span>
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
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                专家
              </span>
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
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">
                小队
              </span>
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
              {memoryStatus && (
                <span className="text-xs text-ink-500">{memoryStatus}</span>
              )}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPinOpen(true)}
              >
                <Pin size={13} />
                钉住笔记
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={
                  recapBusy ||
                  !session.messages.some(
                    (m) => m.role === "user" || m.role === "assistant",
                  )
                }
                onClick={() => {
                  void (async () => {
                    setRecapBusy(true);
                    setMemoryStatus(null);
                    try {
                      const note = await api.sessionRecap(session.id);
                      setMemoryStatus("已写入回合摘要");
                      onOpenMemory?.(note.id);
                    } catch (err) {
                      setMemoryStatus(
                        err instanceof Error ? err.message : String(err),
                      );
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
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setHandoffOpen(true)}
                >
                  转交到收件箱
                </button>
              )}
            </div>
          </fieldset>
        </div>
      )}
      <div
        ref={transcriptRef}
        onScroll={() => {
          const el = transcriptRef.current;
          if (!el) return;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          followLatest.current = near;
          setAwayFromLatest(!near);
        }}
        className="transcript"
      >
        {empty && (
          <div className="new-task-center">
            <div className="new-task-heading">
              <span className="eyebrow">新对话</span>
              <h2>Pig Agent</h2>
              <p>沙箱或本机执行，结果由你核对。</p>
            </div>
            <div className="new-task-workspace">
              <FolderOpen size={16} />
              <span title={workspaceRoot}>
                {executionSurface?.kind === "cloud-remote"
                  ? "远端工作区"
                  : workspaceRoot?.split("/").filter(Boolean).pop() ||
                    "选择工作区"}
              </span>
              <button className="text-action" onClick={onOpenSettings}>
                更改
              </button>
            </div>
            {composer}
            <div className="new-task-configuration">{executionControls}</div>
            <EmptyState title="" body="" onChoose={onDraft} />
          </div>
        )}
        <div
          className={`conversation-content mx-auto flex w-full max-w-3xl flex-col gap-4 ${empty ? "empty-controls" : ""}`}
        >
          {pinnedTeam && teamMembers.length > 0 && (
            <TeamPipeline
              teamName={session?.teamRun?.teamName ?? pinnedTeam.name}
              members={teamMembers}
              status={session?.teamRun?.status}
            />
          )}
          <StepStrip steps={session?.steps ?? []} />
          {session && executionSurface?.kind !== "cloud-remote" && (
            <WorkbenchPanel
              key={session.id}
              sessionId={session.id}
              remote={false}
              remoteRequireApproval={session.remoteRequireApproval}
              onOpenRemote={onOpenRemote}
              running={streaming}
              onResume={onResume}
              onRefresh={onRefresh}
              onDraft={onDraft}
            />
          )}

          {compactToolHistory(interleave(visible, tools)).map((item) =>
            item.kind === "message" ? (
              <MessageBlock key={item.message.id} message={item.message} />
            ) : item.kind === "tool-group" ? (
              <details
                key={item.tools[0]!.id}
                className="rounded-btn border border-ink-300 p-3 text-sm text-ink-600"
              >
                <summary className="cursor-pointer">
                  已完成 {item.tools.length} 项操作{" "}
                  <span className="text-xs">· 展开查看</span>
                </summary>
                <div className="mt-3 space-y-2">
                  {item.tools.map((tool) => (
                    <ToolCard key={tool.id} tool={tool} />
                  ))}
                </div>
              </details>
            ) : (
              <ToolCard
                key={item.tool.id}
                tool={item.tool}
                awaitingApproval={remoteActivity?.approvals.some(
                  (a) =>
                    !item.tool.done &&
                    a.state === "pending" &&
                    a.call_id === item.tool.id,
                )}
              />
            ),
          )}
          {!empty && session?.remoteRunId && remoteActivity && (
            <InlineRemoteActivity
              key={session.remoteRunId}
              activity={remoteActivity}
              runId={session.remoteRunId}
              onOpenDetails={onOpenRemote || (() => {})}
            />
          )}
          {streaming && tools.every((t) => t.done) && (
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <Loader2 size={14} className="animate-spin text-accent" />
              {session?.messages.some(
                (message) => message.id === "stream_live" && message.content,
              )
                ? "正在生成回复…"
                : streamingStatusLabel(session?.steps ?? [])}
            </div>
          )}
          {!!session?.artifacts.length && !streaming && (
            <button className="result-summary" onClick={onOpenArtifacts}>
              <FileText size={19} />
              <span>
                <strong>{session.artifacts.length} 项成果可核验</strong>
                <small>
                  {session.remoteRunId
                    ? "远端版本 · 预览、下载或显式导入"
                    : "本机工作区 · 文件与变更"}
                </small>
              </span>
              <span>查看成果 →</span>
            </button>
          )}
          <div ref={endRef} />
        </div>
      </div>
      {awayFromLatest && (
        <div className="flex justify-center py-1">
          <button
            className="btn-ghost rounded-full border border-ink-300 bg-panel"
            onClick={() => {
              followLatest.current = true;
              setAwayFromLatest(false);
              endRef.current?.scrollIntoView({ block: "end" });
            }}
          >
            回到最新消息 ↓
          </button>
        </div>
      )}

      {!empty && composer}
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
        card.ok =
          m.toolOk ??
          !/^Sandbox blocked|^HTTP fetch blocked|^Error\b/i.test(m.content);
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
): Array<
  { kind: "message"; message: ChatMessage } | { kind: "tool"; tool: LiveTool }
> {
  const used = new Set<string>();
  const out: Array<
    { kind: "message"; message: ChatMessage } | { kind: "tool"; tool: LiveTool }
  > = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (
      message.role === "assistant" &&
      !message.content &&
      message.toolCalls?.length
    ) {
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
    if (
      message.role === "user" ||
      (message.role === "assistant" && message.content)
    ) {
      out.push({ kind: "message", message });
    }
  }
  for (const tool of tools) {
    if (!used.has(tool.id)) out.push({ kind: "tool", tool });
  }
  return out;
}

function compactToolHistory(items: ReturnType<typeof interleave>) {
  const result: Array<
    (typeof items)[number] | { kind: "tool-group"; tools: LiveTool[] }
  > = [];
  let completed: LiveTool[] = [];
  const flush = () => {
    if (completed.length === 1)
      result.push({ kind: "tool", tool: completed[0]! });
    else if (completed.length > 1)
      result.push({ kind: "tool-group", tools: completed });
    completed = [];
  };
  for (const item of items) {
    if (
      item.kind === "tool" &&
      item.tool.done &&
      item.tool.ok &&
      !/^(待批准|前序变更等待|undone:|rejected:)/.test(item.tool.output || "")
    )
      completed.push(item.tool);
    else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
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
        <span className="uppercase tracking-[0.16em]">
          小队流水线 · {teamName}
        </span>
        <span>
          {done}/{members.length} 完成
          {running ? ` · ${running} 进行中` : ""}
          {status && status !== "idle" && status !== "running"
            ? ` · ${status}`
            : ""}
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
    <details className="step-summary">
      <summary>
        <span>执行步骤</span>
        <span>
          {done}/{steps.length} 完成{running ? ` · ${running} 进行中` : ""}
        </span>
      </summary>
      <ol>
        {steps.map((step, i) => (
          <li key={step.id} className={tone(step.status)}>
            <span>{i + 1}</span>
            {step.title}
          </li>
        ))}
      </ol>
    </details>
  );
}

function tone(status: PlanStep["status"]): string {
  if (status === "running")
    return "border-accent bg-accent-soft text-accent-mute";
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
        className={`message-body ${mine ? "from-user" : "from-agent"}`}
        data-streaming={message.id === "stream_live" ? "true" : undefined}
        aria-busy={message.id === "stream_live" || undefined}
      >
        {mine ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <MarkdownView
            text={(message.content || " ").replace(
              "请打开「远端运行记录」审批",
              "请在下方审批卡片中确认",
            )}
          />
        )}
      </div>
    </div>
  );
}

function ToolCard({
  tool,
  awaitingApproval = false,
}: {
  tool: LiveTool;
  awaitingApproval?: boolean;
}) {
  const summary = summarizeArgs(tool.arguments);
  const awaitingReview =
    awaitingApproval ||
    tool.output?.startsWith("待批准") ||
    tool.output?.startsWith("前序变更等待");
  const disposition = awaitingReview
    ? "待批准"
    : tool.output?.startsWith("undone:")
      ? "已撤销"
      : tool.output?.startsWith("rejected:")
        ? "已拒绝"
        : undefined;
  return (
    <details
      className="rounded-xl border border-ink-300 bg-panel"
      open={tool.done && tool.ok === false}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-meta text-ink-700">
        <Terminal size={13} className="text-accent-mute" />
        <span className="font-medium text-ink-800">{toolLabel(tool.name)}</span>
        <span className="truncate text-ink-600">{summary}</span>
        <span className="ml-auto flex items-center gap-2 text-meta uppercase tracking-wider">
          {tool.durationMs !== undefined && (
            <span className="normal-case text-ink-600">
              {formatDuration(tool.durationMs)}
            </span>
          )}
          {!tool.done && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 font-medium text-accent-mute">
              <Loader2 size={11} className="animate-spin" />
              {awaitingApproval ? "待批准" : "进行中"}
            </span>
          )}
          {tool.done && disposition && (
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">
              {disposition}
            </span>
          )}
          {tool.done && tool.ok && !disposition && (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-1.5 py-0.5 font-medium text-success">
              <Check size={11} />
              成功
            </span>
          )}
          {tool.done && !tool.ok && !disposition && (
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
  skills, selectedSkillIds, onSkillsChange,
  attachments,
  draft,
  streaming,
  disabled,
  onDraft,
  onSend,
  onStop,
}: {
  skills: SkillChoice[];
  selectedSkillIds: string[];
  onSkillsChange: (ids: string[]) => void;
  attachments: ReturnType<typeof useLocalAttachments>;
  draft: string;
  streaming: boolean;
  disabled: boolean;
  onDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const {
    picker,
    uploads,
    uploadError,
    available,
    blocked,
    uploadLock,
    uploadFiles,
    setUploads,
  } = attachments;
  return (
    <div
      className="composer-shell bg-ink-50"
      onDragOver={(e) => {
        if (available) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (available) {
          e.preventDefault();
          void uploadFiles(Array.from(e.dataTransfer.files));
        }
      }}
    >
      {uploads.length > 0 && (
        <div
          className="local-attachments mx-auto max-w-3xl"
          aria-label="任务附件"
        >
          {uploads.map((row) => (
            <div key={row.id}>
              <FileText size={16} />
              <span>
                {row.file.name}
                <small>
                  {row.state === "uploading"
                    ? "正在上传…"
                    : row.state === "done"
                      ? "已保存到工作区"
                      : row.error}
                </small>
              </span>
              {row.state === "error" && (
                <>
                  <button
                    onClick={() => {
                      setUploads((rows) => rows.filter((f) => f.id !== row.id));
                      void uploadFiles([row.file]);
                    }}
                  >
                    重试
                  </button>
                  <button
                    aria-label={`移除 ${row.file.name}`}
                    onClick={() =>
                      setUploads((rows) => rows.filter((f) => f.id !== row.id))
                    }
                  >
                    <X size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {uploadError && (
        <p role="alert" className="mx-auto max-w-3xl text-danger">
          {uploadError}
        </p>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="添加本地任务文件"
        onChange={(e) => {
          void uploadFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <div className="composer-box mx-auto flex max-w-3xl items-end gap-3 rounded-card border border-ink-400 bg-panel px-3 py-2 shadow-panel">
        {available && (
          <button
            type="button"
            className="btn-quiet mb-1"
            aria-label="添加文件"
            title="添加文件，每个不超过5MB；也可拖拽或粘贴截图"
            disabled={disabled || streaming || blocked}
            onClick={() => picker.current?.click()}
          >
            <Plus size={20} />
          </button>
        )}
        <SkillComposerInput
          skills={skills}
          selectedIds={selectedSkillIds}
          onSkillsChange={onSkillsChange}
          onValueChange={onDraft}
          aria-label="任务消息"
          onPaste={(e) => {
            if (available && e.clipboardData.files.length) {
              e.preventDefault();
              void uploadFiles(Array.from(e.clipboardData.files));
            }
          }}
          value={draft}
          disabled={disabled || streaming}
          placeholder={
            disabled
              ? "正在加载工作台…"
              : "描述目标，例如：整理工作区并写一份摘要 README"
          }
          rows={2}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (
                !blocked &&
                !uploadLock.current &&
                !disabled &&
                !streaming &&
                draft.trim()
              )
                onSend();
            }
          }}
          className="min-h-[52px] flex-1 resize-none bg-transparent py-2 text-body text-ink-800 placeholder:text-ink-500 disabled:cursor-not-allowed disabled:text-ink-500"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            disabled={disabled}
            className="mb-1 inline-flex items-center gap-1 rounded-btn bg-danger px-3 py-2 text-xs font-medium text-white hover:bg-red-700"
          >
            <Square size={12} />
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || blocked || !draft.trim()}
            onClick={() => {
              if (!uploadLock.current && !blocked) onSend();
            }}
            className="btn-primary mb-1 h-10 w-10 shrink-0 rounded-xl"
            aria-label="发送"
            title="发送"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-meta text-ink-500">
        Enter 发送 · Shift+Enter 换行{available ? " · 拖拽文件或粘贴截图" : ""}
      </p>
    </div>
  );
}

function EmptyState({
  title,
  body,
  onChoose,
}: {
  title: string;
  body: string;
  onChoose?: (value: string) => void;
}) {
  const suggestions = [
    {
      icon: FolderOpen,
      title: "整理工作区",
      detail: "先了解文件，再制定整理计划",
      prompt: "查看当前工作区的文件结构，提出整理建议，先不要修改文件。",
    },
    {
      icon: FileText,
      title: "写一份报告",
      detail: "从现有资料中提炼重点",
      prompt: "阅读当前工作区中的文档，整理一份中文摘要，并标明引用的文件。",
    },
    {
      icon: Sparkles,
      title: "探索项目",
      detail: "读懂项目，找到下一步",
      prompt: "分析当前工作区的项目，介绍主要功能，并列出值得改进的三个方向。",
    },
  ];
  return (
    <div className="task-suggestions">
      {onChoose && (
        <div className="suggestion-grid">
          {suggestions.map(({ icon: Icon, title: label, detail, prompt }) => (
            <button
              key={label}
              className="suggestion-button"
              onClick={() => onChoose(prompt)}
            >
              <Icon size={19} className="text-accent" strokeWidth={1.5} />
              <div className="text-sm font-medium text-ink-800">{label}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useLocalAttachments(
  session: Session | null,
  onRefresh: () => void,
  onEnsureSession: (() => Promise<Session>) | undefined,
  disabled: boolean,
  streaming: boolean,
) {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const picker = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const attachmentSession = useRef(session?.id);
  attachmentSession.current = session?.id;
  useEffect(() => {
    if (!uploadLock.current) {
      setUploads([]);
      setUploadError("");
    }
  }, [session?.id]);
  const [uploads, setUploads] = useState<
    Array<{
      id: string;
      file: File;
      state: "uploading" | "done" | "error";
      error?: string;
    }>
  >([]);
  const [uploadError, setUploadError] = useState("");
  const available =
    !session ||
    (session.executionTarget !== "remote" &&
      (!session.engine || session.engine === "pig"));
  const blocked = uploads.some((f) => f.state !== "done");
  async function uploadFiles(files: File[]) {
    if (
      !available ||
      disabled ||
      streaming ||
      uploadLock.current ||
      !files.length
    )
      return;
    uploadLock.current = true;
    setUploadError("");
    try {
      const target = session || (await onEnsureSession?.());
      if (!target) throw new Error("请先新建任务，再添加文件。");
      for (const file of files) {
        const id = crypto.randomUUID();
        setUploads((rows) => [...rows, { id, file, state: "uploading" }]);
        try {
          if (file.size > 5 * 1024 * 1024) throw new Error("超过5MB上限");
          const body = new FormData();
          body.append("file", file);
          const response = await fetch(`/api/sessions/${target.id}/upload`, {
            method: "POST",
            body,
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "上传失败");
          setUploads((rows) =>
            rows.map((row) =>
              row.id === id ? { ...row, state: "done" } : row,
            ),
          );
        } catch (e) {
          setUploads((rows) =>
            rows.map((row) =>
              row.id === id
                ? { ...row, state: "error", error: String(e) }
                : row,
            ),
          );
        }
      }
      if (attachmentSession.current && attachmentSession.current !== target.id)
        setUploads([]);
      refreshRef.current();
    } catch (e) {
      setUploadError(String(e));
    } finally {
      uploadLock.current = false;
    }
  }

  return {
    picker,
    uploads,
    uploadError,
    available,
    blocked,
    uploadLock,
    uploadFiles,
    setUploads,
  };
}
