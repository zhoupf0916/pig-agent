import { Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutomationsPanel } from "./components/AutomationsPanel";
import { ChatPanel } from "./components/ChatPanel";
import { ExpertsPanel } from "./components/ExpertsPanel";
import { InboxMenu } from "./components/InboxMenu";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { RightPanel } from "./components/RightPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { api, streamMessage, subscribeSessionEvents } from "./lib/api";
import {
  automationsHash,
  expertsHash,
  parseHash,
  projectsHash,
  workstationHash,
  type AppRoute,
} from "./lib/hash";
import type {
  AgentEvent,
  Expert,
  ExpertTeam,
  LiveTool,
  ProjectSummary,
  Session,
  SessionSummary,
  Settings,
  SkillMeta,
  WorkspaceNode,
} from "./types";

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [tree, setTree] = useState<WorkspaceNode | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    path: string;
    content: string;
    binary: boolean;
    size: number;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [route, setRoute] = useState<AppRoute>(() => parseHash());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [expertTeams, setExpertTeams] = useState<ExpertTeam[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const seenSeqRef = useRef<Set<number>>(new Set());
  const lastSeqRef = useRef(0);

  const refreshSessions = useCallback(async () => {
    const { sessions: next } = await api.sessions();
    setSessions(next);
    return next;
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const data = await api.tree();
      setTree(data.tree);
    } catch {
      setTree(null);
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    const next = await api.session(id);
    seenSeqRef.current = new Set();
    lastSeqRef.current = next.eventCheckpointSeq ?? 0;
    setSession(next);
    setActiveId(id);
    setLiveTools([]);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects: next } = await api.projects();
      setProjects(next);
    } catch {
      setProjects([]);
    }
  }, []);

  const goWorkstation = useCallback(() => {
    window.location.hash = workstationHash();
  }, []);

  const goProjects = useCallback((projectId?: string) => {
    window.location.hash = projectsHash(projectId);
  }, []);

  const goExperts = useCallback((expertId?: string) => {
    window.location.hash = expertsHash(expertId);
  }, []);

  const goAutomations = useCallback((automationId?: string) => {
    window.location.hash = automationsHash(automationId);
  }, []);

  const refreshExperts = useCallback(async () => {
    try {
      const [{ experts: next }, { teams }] = await Promise.all([api.experts(), api.expertTeams()]);
      setExperts(next);
      setExpertTeams(teams);
    } catch {
      setExperts([]);
      setExpertTeams([]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [s, sk, list] = await Promise.all([
          api.settings(),
          api.skills(),
          api.sessions(),
        ]);
        setSettings(s);
        setSkills(sk.skills);
        setSessions(list.sessions);
        await refreshTree();
        await refreshProjects();
        await refreshExperts();
        if (list.sessions[0]) {
          await loadSession(list.sessions[0].id);
        }
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadSession, refreshExperts, refreshProjects, refreshTree]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openFile = useCallback(async (path: string) => {
    setPreviewPath(path);
    try {
      setPreview(await api.file(path));
    } catch (err) {
      setPreview({
        path,
        content: err instanceof Error ? err.message : String(err),
        binary: false,
        size: 0,
      });
    }
  }, []);

  const createSession = useCallback(async (projectId?: string) => {
    const created = await api.createSession(projectId ? { projectId } : undefined);
    await refreshSessions();
    await refreshProjects();
    await loadSession(created.id);
    setDraft("");
    goWorkstation();
  }, [goWorkstation, loadSession, refreshProjects, refreshSessions]);

  const removeSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
      const list = await refreshSessions();
      if (activeId === id) {
        if (list[0]) await loadSession(list[0].id);
        else {
          setSession(null);
          setActiveId(null);
        }
      }
    },
    [activeId, loadSession, refreshSessions],
  );

  const applyEvent = useCallback((event: AgentEvent, seq?: number) => {
    if (typeof seq === "number") {
      if (seenSeqRef.current.has(seq)) return;
      seenSeqRef.current.add(seq);
      lastSeqRef.current = Math.max(lastSeqRef.current, seq);
    }
    if (event.type === "token") {
      setSession((prev) => {
        if (!prev) return prev;
        const msgs = [...prev.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && !last.toolCalls && last.id.startsWith("stream_")) {
          msgs[msgs.length - 1] = { ...last, content: last.content + event.text };
        } else {
          msgs.push({
            id: "stream_live",
            role: "assistant",
            content: event.text,
            createdAt: new Date().toISOString(),
          });
        }
        return { ...prev, messages: msgs };
      });
      return;
    }
    if (event.type === "message") {
      setSession((prev) => {
        if (!prev) return prev;
        const withoutStream = prev.messages.filter((m) => m.id !== "stream_live");
        if (withoutStream.some((m) => m.id === event.message.id)) {
          return { ...prev, messages: withoutStream };
        }
        return { ...prev, messages: [...withoutStream, event.message] };
      });
      return;
    }
    if (event.type === "steps") {
      setSession((prev) => (prev ? { ...prev, steps: event.steps } : prev));
      return;
    }
    if (event.type === "step") {
      setSession((prev) => {
        if (!prev) return prev;
        const rest = prev.steps.filter((s) => s.id !== event.step.id);
        return { ...prev, steps: [...rest, event.step] };
      });
      return;
    }
    if (event.type === "tool_start") {
      setLiveTools((prev) => [
        ...prev.filter((t) => t.id !== event.id),
        {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          done: false,
          startedAt: event.startedAt,
        },
      ]);
      return;
    }
    if (event.type === "tool_end") {
      setLiveTools((prev) =>
        prev.map((t) =>
          t.id === event.id
            ? { ...t, done: true, ok: event.ok, output: event.output, durationMs: event.durationMs }
            : t,
        ),
      );
      return;
    }
    if (event.type === "artifact") {
      setSession((prev) => {
        if (!prev) return prev;
        const rest = prev.artifacts.filter((a) => a.path !== event.artifact.path);
        return { ...prev, artifacts: [...rest, event.artifact] };
      });
      void refreshTree();
      void openFile(event.artifact.path);
      return;
    }
    if (event.type === "status") {
      setSession((prev) => (prev ? { ...prev, status: event.status } : prev));
      return;
    }
    if (event.type === "error") {
      setSession((prev) => (prev ? { ...prev, lastError: event.message, status: "error" } : prev));
      return;
    }
    if (event.type === "done") {
      setSession(event.session);
      void refreshSessions();
      void refreshTree();
    }
  }, [openFile, refreshSessions, refreshTree]);

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          await subscribeSessionEvents(activeId, lastSeqRef.current, applyEvent, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [activeId, applyEvent]);

  const send = useCallback(async () => {
    if (!session || streaming || !draft.trim()) return;
    const content = draft.trim();
    setDraft("");
    setStreaming(true);
    setLiveTools([]);
    setSession((prev) =>
      prev
        ? {
            ...prev,
            status: "running",
            messages: [
              ...prev.messages,
              {
                id: `local_${Date.now()}`,
                role: "user",
                content,
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : prev,
    );
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamMessage(session.id, content, applyEvent, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
      } else {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                status: "error",
                lastError: err instanceof Error ? err.message : String(err),
              }
            : prev,
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      void refreshSessions();
    }
  }, [applyEvent, draft, refreshSessions, session, streaming]);

  const stop = useCallback(async () => {
    if (!session) return;
    abortRef.current?.abort();
    await api.abort(session.id);
    setStreaming(false);
    setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
  }, [session]);

  const bindProject = useCallback(
    async (projectId: string | null) => {
      if (!session) return;
      const next = await api.patchSession(session.id, { projectId });
      setSession(next);
      await refreshSessions();
      await refreshProjects();
    },
    [refreshProjects, refreshSessions, session],
  );

  const bindExpert = useCallback(
    async (expertId: string | null) => {
      if (!session) return;
      const next = await api.patchSession(session.id, { expertId });
      setSession(next);
      await refreshSessions();
    },
    [refreshSessions, session],
  );

  const bindTeam = useCallback(
    async (expertTeamId: string | null) => {
      if (!session) return;
      const next = await api.patchSession(session.id, { expertTeamId });
      setSession(next);
      await refreshSessions();
    },
    [refreshSessions, session],
  );

  const pinExpertToSession = useCallback(
    async (expertId: string) => {
      if (session) {
        await bindExpert(expertId);
      } else {
        const created = await api.createSession({ expertId });
        await refreshSessions();
        await loadSession(created.id);
        setDraft("");
      }
      goWorkstation();
    },
    [bindExpert, goWorkstation, loadSession, refreshSessions, session],
  );

  const pinTeamToSession = useCallback(
    async (teamId: string) => {
      if (session) {
        await bindTeam(teamId);
      } else {
        const created = await api.createSession({ expertTeamId: teamId });
        await refreshSessions();
        await loadSession(created.id);
        setDraft("");
      }
      goWorkstation();
    },
    [bindTeam, goWorkstation, loadSession, refreshSessions, session],
  );

  const headerHint = useMemo(() => {
    if (!settings) return "正在连接本地后端…";
    if (settings.runtime === "codex") {
      const net = settings.codexNetworkAccess ? " · 外网已开" : "";
      return `本机 Codex · ${settings.codexModel}${net}`;
    }
    if (settings.runtime === "cloud") {
      if (settings.cloudMode === "remote" && settings.cloudBaseUrl) {
        const host = settings.cloudBaseUrl.replace(/^https?:\/\//, "");
        return `云端 · ${host}`;
      }
      return "云端 · local-stub";
    }
    const model = settings.llmModel;
    const host = settings.llmBaseUrl.replace(/^https?:\/\//, "");
    return `本机 Pig · ${model} · ${host}`;
  }, [settings]);

  return (
    <div className="flex h-full flex-col bg-ink-50">
      <header className="flex items-center justify-between border-b border-ink-300 bg-white/90 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-btn bg-accent text-sm font-semibold text-white">
            P
          </div>
          <div>
            <div className="text-sm font-medium text-ink-800">Pig Agent</div>
            <div className="text-meta text-ink-500">工作台 · 本机与云端同一协议</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={route.name === "workstation" ? "btn-primary" : "btn-ghost"}
            onClick={goWorkstation}
          >
            工作台
          </button>
          <button
            type="button"
            className={route.name === "projects" ? "btn-primary" : "btn-ghost"}
            onClick={() => goProjects(route.name === "projects" ? route.projectId : undefined)}
          >
            项目
          </button>
          <button
            type="button"
            className={route.name === "experts" ? "btn-primary" : "btn-ghost"}
            onClick={() => goExperts(route.name === "experts" ? route.expertId : undefined)}
          >
            专家
          </button>
          <button
            type="button"
            className={route.name === "automations" ? "btn-primary" : "btn-ghost"}
            onClick={() => goAutomations(route.name === "automations" ? route.automationId : undefined)}
          >
            自动化
          </button>
          <InboxMenu
            onOpenProject={(id) => goProjects(id)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation();
            }}
          />
          <div className="hidden text-right text-meta text-ink-500 sm:block">
            <div>{headerHint}</div>
            <div className="max-w-[360px] truncate font-mono">
              {settings?.workspaceRoot ?? ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="btn-ghost"
          >
            <Settings2 size={14} />
            设置
          </button>
        </div>
      </header>

      {bootError && (
        <div className="border-b border-danger-soft bg-danger-soft px-4 py-2 text-xs text-danger">
          无法连接本地后端：{bootError}。请确认已运行 <code>pnpm dev</code>。
        </div>
      )}
      {session?.lastError && (
        <div className="border-b border-warning-soft bg-warning-soft px-4 py-2 text-xs text-warning">
          {session.lastError}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {route.name === "projects" ? (
          <ProjectsPanel
            selectedId={route.projectId}
            sessions={sessions}
            onSelectProject={(id) => goProjects(id)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation();
            }}
            onCreateSession={(projectId) => void createSession(projectId)}
          />
        ) : route.name === "experts" ? (
          <ExpertsPanel
            selectedId={route.expertId}
            skills={skills}
            onSelectExpert={(id) => goExperts(id)}
            onPinExpert={(id) => void pinExpertToSession(id)}
            onPinTeam={(id) => void pinTeamToSession(id)}
          />
        ) : route.name === "automations" ? (
          <AutomationsPanel
            selectedId={route.automationId}
            experts={experts}
            teams={expertTeams}
            projects={projects}
            onSelect={(id) => goAutomations(id)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation();
            }}
          />
        ) : (
          <>
            <Sidebar
              sessions={sessions}
              activeId={activeId}
              onSelect={(id) => void loadSession(id)}
              onCreate={() => void createSession()}
              onDelete={(id) => void removeSession(id)}
            />
            <ChatPanel
              session={session}
              draft={draft}
              streaming={streaming}
              liveTools={liveTools}
              projectName={projects.find((p) => p.id === session?.projectId)?.name}
              projects={projects}
              experts={experts}
              teams={expertTeams}
              expertName={experts.find((e) => e.id === session?.expertId)?.name}
              onDraft={setDraft}
              onSend={() => void send()}
              onStop={() => void stop()}
              onBindProject={(id) => void bindProject(id)}
              onBindExpert={(id) => void bindExpert(id)}
              onBindTeam={(id) => void bindTeam(id)}
              onHandoffDone={() => void refreshProjects()}
            />
            <RightPanel
              artifacts={session?.artifacts ?? []}
              tree={tree}
              workspaceRoot={settings?.workspaceRoot ?? ""}
              previewPath={previewPath}
              preview={preview}
              onOpenFile={(path) => void openFile(path)}
              sessionId={session?.id}
              projectId={session?.projectId}
              projectName={projects.find((p) => p.id === session?.projectId)?.name}
              onOpenProject={(id) => {
                void refreshProjects();
                goProjects(id);
              }}
            />
          </>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        skills={skills}
        onClose={() => setSettingsOpen(false)}
        onSave={async (patch) => {
          const next = await api.saveSettings(patch);
          setSettings(next);
          await refreshTree();
        }}
      />
    </div>
  );
}
