import { ExecutionPicker } from "./components/ExecutionPicker";
import { RemoteRunsPanel } from "./components/RemoteRunsPanel";
import { DesktopSetup } from "./components/DesktopSetup";
import { Settings2, FolderOpen, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutomationsPanel } from "./components/AutomationsPanel";
import { ChatPanel } from "./components/ChatPanel";
import { ExpertsPanel } from "./components/ExpertsPanel";
import { InboxMenu } from "./components/InboxMenu";
import { isMorePage, MoreMenu } from "./components/MoreMenu";
import { MemoryPanel } from "./components/MemoryPanel";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { RightPanel } from "./components/RightPanel";
import { SearchBox } from "./components/SearchBox";
import { SearchPanel } from "./components/SearchPanel";
import { RuntimeChip } from "./components/RuntimeChip";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";
import { api, streamMessage, streamRetry, streamTeamRun, subscribeSessionEvents } from "./lib/api";
import {
  applyComposerDraft,
  browserDraftStorage,
  clearComposerDraft,
  loadComposerDraft,
  persistComposerDraft,
  startComposerDraftSync,
} from "./lib/composer-draft";
import { redactSecretsForDisplay, retryActionLabel } from "./lib/remote-retry";
import {
  applyWorkspaceFileSnapshot,
  startWorkspaceFileSync,
  type WorkspaceFilePreview,
} from "./lib/workspace-file-sync";
import { describeExecutionSurface, surfaceFromSettings } from "./lib/runtime-surface";
import {
  applySessionListSnapshot,
  startSessionListSync,
} from "./lib/session-list-sync";
import {
  applyOpenSessionFromList,
  applySessionOpenMetaSnapshot,
  nextOpenSessionHash,
  nextOpenSessionId,
  shouldFetchSessionDetail,
} from "./lib/session-open-sync";
import {
  applySessionPinSnapshot,
  startSessionPinSync,
} from "./lib/session-pin-sync";
import {
  applyPinExpertCatalogSnapshot,
  applyPinProjectCatalogSnapshot,
  applyPinTeamCatalogSnapshot,
  startPinCatalogSync,
} from "./lib/pin-catalog-sync";
import {
  applyWorkspaceTreeSnapshot,
  startWorkspaceTreeSync,
} from "./lib/workspace-tree-sync";
import {
  applySettingsSnapshot,
  startSettingsSurfaceSync,
} from "./lib/settings-surface-sync";
import {
  applySkillsListSnapshot,
  startSkillsListSync,
} from "./lib/skills-list-sync";
import {
  applySyncPhase,
  CATCH_UP_STATUS,
  rememberEventSeq,
  reconcileMessage,
  type TranscriptSyncPhase,
} from "./lib/transcript-sync";
import {
  applyThemeSnapshot,
  browserThemeRoot,
  browserThemeStorage,
  loadPersistedTheme,
  persistTheme,
  startThemeSync,
  type Theme,
} from "./lib/theme";
import {
  automationsHash,
  expertsHash,
  memoryHash,
  parseHash,
  projectsHash,
  searchHash,
  sessionHash,
  workstationHash,
  type AppRoute,
} from "./lib/hash";
import type {
  AgentEvent,
  Expert,
  ExpertTeam,
  LiveTool,
  ProjectSummary,
  SearchHit,
  Session,
  SessionSummary,
  Settings,
  SkillMeta,
  WorkspaceNode,
} from "./types";

export function App() {
  const [remoteRunView,setRemoteRunView] = useState<string|null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [tree, setTree] = useState<WorkspaceNode | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [draft, setDraft] = useState(() => {
    const boot = parseHash();
    return boot.name === "workstation" && boot.sessionId
      ? loadComposerDraft(boot.sessionId, browserDraftStorage())
      : "";
  });
  const [streaming, setStreaming] = useState(false);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [desktopSetup, setDesktopSetup] = useState(() => !!window.pigDesktop && localStorage.getItem("pig-agent.desktop-setup") !== "complete");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [syncPhase, setSyncPhase] = useState<TranscriptSyncPhase>("idle");
  const [theme, setTheme] = useState<Theme>(() => loadPersistedTheme());
  const [route, setRoute] = useState<AppRoute>(() => parseHash());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectRefreshTick, setProjectRefreshTick] = useState(0);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [expertTeams, setExpertTeams] = useState<ExpertTeam[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const seenSeqRef = useRef<Set<number>>(new Set());
  const lastSeqRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const refreshTree = useCallback(async () => {
    try {
      const data = await api.tree();
      setTree((prev) => applyWorkspaceTreeSnapshot(prev, data.tree));
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
    setDraft(loadComposerDraft(id, browserDraftStorage()));
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects: next } = await api.projects();
      setProjects(next);
    } catch {
      setProjects([]);
    }
  }, []);

  const goWorkstation = useCallback((sessionId?: string) => {
    window.location.hash = sessionId ? sessionHash(sessionId) : workstationHash();
  }, []);

  const applySessionListAndOpen = useCallback(
    async (next: SessionSummary[]) => {
      setSessions((prev) => applySessionListSnapshot(prev, next));
      const openId = activeIdRef.current;
      const nextId = nextOpenSessionId(openId, next);
      if (openId && nextId !== openId) {
        abortRef.current?.abort();
        setStreaming(false);
        clearComposerDraft(openId, browserDraftStorage());
        const routeNow = parseHash();
        const onDeletedHash = routeNow.name === "workstation" && routeNow.sessionId === openId;
        // AN-02: rewrite hash / open pointer before any per-id load so a stale
        // #/sessions/:deletedId cannot retrigger GET /api/sessions/:deletedId.
        const nextHash = nextOpenSessionHash(openId, next);
        if (onDeletedHash && nextHash) window.location.hash = nextHash;
        activeIdRef.current = nextId;
        if (nextId && shouldFetchSessionDetail(nextId, next)) {
          await loadSession(nextId);
        } else {
          setSession(null);
          setActiveId(null);
          setDraft("");
          setLiveTools([]);
        }
        return;
      }
      setSession((prev) => applyOpenSessionFromList(prev, next));
    },
    [loadSession],
  );

  const refreshSessions = useCallback(async () => {
    const { sessions: next } = await api.sessions();
    await applySessionListAndOpen(next);
    return next;
  }, [applySessionListAndOpen]);

  const goProjects = useCallback((projectId?: string, extra?: { assetId?: string; todoId?: string }) => {
    window.location.hash = projectsHash(projectId, extra);
  }, []);

  const goSearch = useCallback((q?: string) => {
    window.location.hash = searchHash(q);
  }, []);

  const goMemory = useCallback((noteId?: string) => {
    window.location.hash = memoryHash(noteId);
  }, []);

  const openHit = useCallback(
    (hit: SearchHit) => {
      if (hit.type === "session") {
        const id = hit.sessionId || hit.id;
        void loadSession(id);
        window.location.hash = hit.href || sessionHash(id);
        return;
      }
      if (hit.type === "memory") {
        window.location.hash = hit.href || memoryHash(hit.id);
        return;
      }
      window.location.hash = hit.href;
    },
    [loadSession],
  );

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
        const bootRoute = parseHash();
        if (bootRoute.name === "workstation" && bootRoute.sessionId) {
          await loadSession(bootRoute.sessionId);
        } else if (list.sessions[0]) {
          await loadSession(list.sessions[0].id);
        }
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err));
      } finally { setBootLoading(false); }
    })();
  }, [loadSession, refreshExperts, refreshProjects, refreshTree]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    return startSessionListSync({
      fetchList: async () => {
        const { sessions: next } = await api.sessions();
        return next;
      },
      onList: (next) => {
        void applySessionListAndOpen(next);
      },
    });
  }, [applySessionListAndOpen]);

  useEffect(() => {
    if (!activeId) return;
    return startSessionPinSync({
      sessionId: activeId,
      fetchList: async () => {
        const { sessions: next } = await api.sessions();
        return next;
      },
      onPins: (next) =>
        setSession((prev) => applySessionOpenMetaSnapshot(applySessionPinSnapshot(prev, next), next)),
    });
  }, [activeId]);

  useEffect(() => {
    return startPinCatalogSync({
      fetchProjects: async () => {
        const { projects: next } = await api.projects();
        return next;
      },
      onProjects: (next) => setProjects((prev) => applyPinProjectCatalogSnapshot(prev, next)),
      fetchExperts: async () => {
        const { experts: next } = await api.experts();
        return next;
      },
      onExperts: (next) => setExperts((prev) => applyPinExpertCatalogSnapshot(prev, next)),
      fetchTeams: async () => {
        const { teams: next } = await api.expertTeams();
        return next;
      },
      onTeams: (next) => setExpertTeams((prev) => applyPinTeamCatalogSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    return startSettingsSurfaceSync({
      fetchSettings: () => api.settings(),
      onSettings: (next) => setSettings((prev) => applySettingsSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    return startSkillsListSync({
      fetchList: async () => {
        const { skills: next } = await api.skills();
        return next;
      },
      onList: (next) => setSkills((prev) => applySkillsListSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    return startWorkspaceTreeSync({
      fetchTree: async () => {
        const { tree: next } = await api.tree();
        return next;
      },
      onTree: (next) => setTree((prev) => applyWorkspaceTreeSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    if (!previewPath) return;
    return startWorkspaceFileSync({
      path: previewPath,
      fetchFile: (path) => api.file(path),
      onFile: (next) => {
        setPreview((prev) => applyWorkspaceFileSnapshot(prev, next));
        if (next === null) setPreviewPath(null);
      },
    });
  }, [previewPath]);

  useEffect(() => {
    if (!activeId) return;
    return startComposerDraftSync({
      sessionId: activeId,
      storage: browserDraftStorage(),
      onDraft: (next) => setDraft((prev) => applyComposerDraft(prev, next)),
    });
  }, [activeId]);

  useEffect(() => {
    return startThemeSync({
      storage: browserThemeStorage(),
      root: browserThemeRoot(),
      onTheme: (next) => setTheme((prev) => applyThemeSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    if (route.name !== "workstation" || !route.sessionId) return;
    if (route.sessionId === activeId) return;
    if (!shouldFetchSessionDetail(route.sessionId, sessions)) return;
    void loadSession(route.sessionId);
  }, [activeId, loadSession, route, sessions]);

  const openFile = useCallback(async (path: string) => {
    setPreviewPath(path);
    try {
      const next = await api.file(path);
      setPreview((prev) => applyWorkspaceFileSnapshot(prev, next));
    } catch (err) {
      setPreview({
        path,
        content: redactSecretsForDisplay(err instanceof Error ? err.message : String(err)),
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
    goWorkstation(created.id);
  }, [goWorkstation, loadSession, refreshProjects, refreshSessions]);

  const removeSession = useCallback(
    async (id: string) => {
      clearComposerDraft(id, browserDraftStorage());
      await api.deleteSession(id);
      await refreshSessions();
    },
    [refreshSessions],
  );

  const onDraftChange = useCallback((text: string) => {
    setDraft(text);
    if (activeId) persistComposerDraft(activeId, text, browserDraftStorage());
  }, [activeId]);

  const applyEvent = useCallback((event: AgentEvent, seq?: number) => {
    if (event.type === "sync") {
      setSyncPhase((prev) => applySyncPhase(event, prev));
      return;
    }
    if (typeof seq === "number") {
      if (seenSeqRef.current.has(seq)) return;
      seenSeqRef.current.add(seq);
      lastSeqRef.current = rememberEventSeq(lastSeqRef.current, seq);
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
        return { ...prev, messages: reconcileMessage(prev.messages, event.message) };
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
      setSession((prev) =>
        prev
          ? {
              ...prev,
              lastError: event.message,
              status: prev.remoteRetry ? "error" : "idle",
              localRetry: prev.remoteRetry ? prev.localRetry : "turn",
            }
          : prev,
      );
      return;
    }
    if (event.type === "team_run") {
      setSession((prev) => (prev ? { ...prev, teamRun: event.teamRun } : prev));
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
    let first = true;
    const run = async () => {
      while (!controller.signal.aborted) {
        if (!first) setSyncPhase("catching_up");
        first = false;
        try {
          await subscribeSessionEvents(activeId, lastSeqRef.current, (event, seq) => {
            if (!controller.signal.aborted && activeIdRef.current === activeId) applyEvent(event, seq);
          }, controller.signal);
        } catch {
          if (controller.signal.aborted) break;
          setSyncPhase("catching_up");
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      setSyncPhase("idle");
    };
    void run();
    return () => {
      controller.abort();
      setSyncPhase("idle");
    };
  }, [activeId, applyEvent]);

  const send = useCallback(async () => {
    if (streaming || abortRef.current || session?.status === "running" || !draft.trim()) return;
    const content = draft.trim();
    const clientMessageId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setBootError(null);
    let target = session;
    try {
      if (!target) {
        target = await api.createSession();
        seenSeqRef.current = new Set();
        lastSeqRef.current = target.eventCheckpointSeq ?? 0;
        activeIdRef.current = target.id;
        setActiveId(target.id);
        setSessions(prev => [target!, ...prev.filter(item => item.id !== target!.id)]);
        setSession(target);
        goWorkstation(target.id);
      }
      if (controller.signal.aborted) return;
      setDraft("");
      clearComposerDraft(target.id, browserDraftStorage());
      setLiveTools([]);
      setSession({ ...target, status: "running", messages: [...target.messages, { id: clientMessageId, role: "user", content, createdAt: new Date().toISOString() }] });
      const targetId = target.id;
      await streamMessage(targetId, content, (event, seq) => {
        if (activeIdRef.current === targetId) applyEvent(event, seq);
      }, controller.signal, clientMessageId);
    } catch (err) {
      if (!target) setBootError(err instanceof Error ? err.message : String(err));
      else if (controller.signal.aborted) setSession(prev => prev?.id === target!.id ? { ...prev, status: "idle" } : prev);
      else setSession(prev => prev?.id === target!.id ? { ...prev, status: "idle", lastError: redactSecretsForDisplay(err instanceof Error ? err.message : String(err)), localRetry: "turn" } : prev);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      void refreshSessions();
    }
  }, [applyEvent, draft, goWorkstation, refreshSessions, session, streaming]);

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    if (!session) return;
    try {
      await api.stopTeamRun(session.id);
    } catch {
      await api.abort(session.id);
    }
    setStreaming(false);
    await loadSession(session.id);
  }, [session]);

  const retry = useCallback(async () => {
    if (!session || streaming || abortRef.current) return;
    setStreaming(true);
    setLiveTools([]);
    setSession((prev) =>
      prev
        ? { ...prev, status: "running", lastError: undefined, remoteRetry: undefined, localRetry: undefined }
        : prev,
    );
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamRetry(session.id, (event, seq) => { if (activeIdRef.current === session.id) applyEvent(event, seq); }, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
      } else {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                status: "idle",
                lastError: redactSecretsForDisplay(
                  err instanceof Error ? err.message : String(err),
                ),
                localRetry: prev.remoteRetry ? undefined : "turn",
              }
            : prev,
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
      void refreshSessions();
    }
  }, [applyEvent, refreshSessions, session, streaming]);

  const startTeamRun = useCallback(async () => {
    if (!session || streaming || abortRef.current || session.status === "running") return;
    const content = draft.trim();
    const clientMessageId = content ? crypto.randomUUID() : undefined;
    const canContinue = Boolean(
      session.teamRun &&
        session.teamRun.members.some(
          (m) => m.status === "pending" || m.status === "error" || m.status === "cancelled",
        ) &&
        session.teamRun.status !== "running" &&
        session.teamRun.status !== "done",
    );
    const action: "start" | "continue" = !content && canContinue ? "continue" : "start";
    if (action === "start" && !content && !session.messages.some((m) => m.role === "user")) return;
    if (content) {
      setDraft("");
      clearComposerDraft(session.id, browserDraftStorage());
    }
    setStreaming(true);
    setLiveTools([]);
    if (content) {
      setSession((prev) =>
        prev
          ? {
              ...prev,
              status: "running",
              messages: [
                ...prev.messages,
                {
                  id: clientMessageId!,
                  role: "user",
                  content,
                  createdAt: new Date().toISOString(),
                },
              ],
            }
          : prev,
      );
    } else {
      setSession((prev) => (prev ? { ...prev, status: "running" } : prev));
    }
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamTeamRun(
        session.id,
        action === "start" && content ? { action, content, clientMessageId } : { action },
        (event, seq) => {
          if (activeIdRef.current === session.id) applyEvent(event, seq);
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
      } else {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                status: "error",
                lastError: redactSecretsForDisplay(
                  err instanceof Error ? err.message : String(err),
                ),
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
        goWorkstation(created.id);
        return;
      }
      goWorkstation(session?.id);
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
        goWorkstation(created.id);
        return;
      }
      goWorkstation(session?.id);
    },
    [bindTeam, goWorkstation, loadSession, refreshSessions, session],
  );

  const setPersistedTheme = useCallback((next: Theme) => {
    setTheme(persistTheme(next, { storage: browserThemeStorage(), root: browserThemeRoot() }));
  }, []);

  const executionSurface = useMemo(() => {
    if (!settings) {
      return describeExecutionSurface({ runtime: "pig" });
    }
    return surfaceFromSettings(session?.executionTarget ? {...settings,runtime:session.executionTarget === "remote" ? "cloud" : session.engine || "pig",cloudMode:session.executionTarget === "remote" ? "remote" : settings.cloudMode} : settings);
  }, [settings,session?.executionTarget,session?.engine]);

  return (
    <div className="flex h-full flex-col bg-ink-50">
      {remoteRunView !== null && <RemoteRunsPanel runId={remoteRunView || undefined} onClose={()=>setRemoteRunView(null)} onOpenSession={id=>{setRemoteRunView(null);goWorkstation(id);void refreshSessions();void loadSession(id);}}/>}
      <header className="app-header flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-300 bg-panel px-4 py-2.5 backdrop-blur-sm">
        <button
          type="button"
          className="flex shrink-0 items-center gap-3 text-left"
          aria-label="回到工作台"
          onClick={() => goWorkstation(activeId ?? undefined)}
        >
          <div className="brand-mark flex h-10 w-10 items-center justify-center rounded-btn bg-accent text-sm font-semibold text-white">
            P
          </div>
          <div className="block">
            <div className="text-sm font-medium text-ink-800">Pig Agent</div>
            <div className="text-meta text-ink-500">让想法成为成果</div>
          </div>
        </button>
        <div className="order-3 min-w-0 w-full flex-1 basis-full md:order-none md:max-w-lg md:basis-auto">
          <SearchBox
            initialQ={route.name === "search" ? route.q ?? "" : ""}
            onOpenAll={(q) => goSearch(q)}
            onOpenHit={openHit}
          />
        </div>
        <div className="header-actions ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={route.name === "projects" ? "btn-nav-active" : "btn-nav"}
            onClick={() => goProjects(route.name === "projects" ? route.projectId : undefined)}
          >
            项目
          </button>
          <button
            type="button"
            className={route.name === "experts" ? "btn-nav-active" : "btn-nav"}
            onClick={() => goExperts(route.name === "experts" ? route.expertId : undefined)}
          >
            专家
          </button>
          <MoreMenu
            active={isMorePage(route.name) ? route.name : undefined}
            onMemory={() => goMemory(route.name === "memory" ? route.noteId : undefined)}
            onAutomations={() =>
              goAutomations(route.name === "automations" ? route.automationId : undefined)
            }
          />
          <div className="hidden h-4 w-px bg-ink-300 sm:block" aria-hidden />
          <InboxMenu
            onOpenProject={(id) => goProjects(id)}
            onInviteResolved={() => setProjectRefreshTick((n) => n + 1)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation(id);
            }}
          />
          <ThemeToggle theme={theme} onChange={setPersistedTheme} />
          <button className="btn-ghost text-xs" onClick={()=>setRemoteRunView(session?.remoteRunId || "")}>远端运行</button>
          {route.name === "workstation" && session && (
            <ExecutionPicker session={session} settings={settings} disabled={streaming || session.status === "running"}
              onChange={async patch => {
                try { setSession(await api.patchSession(session.id, patch)); }
                catch (error) { setBootError(String(error)); }
              }} />
          )}
          <RuntimeChip surface={executionSurface} onClick={() => setSettingsOpen(true)} />
          <div className="hidden max-w-[220px] truncate font-mono text-meta text-ink-500 min-[1600px]:block" title={settings?.workspaceRoot}>
            {settings?.workspaceRoot ?? ""}
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
          无法连接本地后端：{bootError}。{window.pigDesktop ? "请退出并重新打开应用；仍失败时可从帮助菜单导出诊断信息。" : <>请确认已运行 <code>pnpm dev</code>。</>}
        </div>
      )}
      {syncPhase === "catching_up" && !session?.lastError && (
        <div className="flex items-center gap-2 border-b border-ink-300 bg-panel px-4 py-2 text-xs text-ink-600">
          <span>{CATCH_UP_STATUS}</span>
        </div>
      )}
      {session?.lastError && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning-soft bg-warning-soft px-4 py-2 text-xs text-warning">
          <span>{redactSecretsForDisplay(session.lastError)}</span>
          <button
            type="button"
            className="btn-ghost shrink-0 text-xs"
            disabled={streaming || session.localRetry === "unavailable"}
            onClick={() => void retry()}
          >
            {retryActionLabel(session.remoteRetry, session.localRetry)}
          </button>
        </div>
      )}

      {route.name === "workstation" && (
        <div className="mobile-workspace-bar items-center gap-2 border-b border-ink-300 bg-panel px-4 py-2">
          <select aria-label="切换任务" className="field min-w-0 flex-1 md:hidden" value={activeId ?? ""} onChange={(e) => { void loadSession(e.target.value); goWorkstation(e.target.value); }}>
            <option value="" disabled>选择任务</option>
            {sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <button className="btn-ghost md:hidden" onClick={() => void createSession()} aria-label="新建任务"><Plus size={16} /></button>
          <button className="btn-ghost ml-auto shrink-0" aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
            {filesOpen ? <X size={14} /> : <FolderOpen size={14} />}{filesOpen ? "关闭文件" : "文件与产物"}
          </button>
        </div>
      )}
      <div className={`workspace-shell flex min-h-0 min-w-0 flex-1 overflow-hidden ${filesOpen ? "show-files" : ""}`}>
        {route.name === "projects" ? (
          <ProjectsPanel
            selectedId={route.projectId}
            refreshTick={projectRefreshTick}
            highlightAssetId={route.assetId}
            highlightTodoId={route.todoId}
            sessions={sessions}
            onSelectProject={(id, extra) => goProjects(id, extra)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation(id);
            }}
            onCreateSession={(projectId) => void createSession(projectId)}
          />
        ) : route.name === "search" ? (
          <SearchPanel
            initialQ={route.q}
            onOpenHit={openHit}
          />
        ) : route.name === "memory" ? (
          <MemoryPanel
            selectedId={route.noteId}
            onSelect={(id) => goMemory(id)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation(id);
            }}
            onOpenProject={(id) => goProjects(id)}
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
            onOpenRemoteRun={id=>setRemoteRunView(id)}
            selectedId={route.automationId}
            experts={experts}
            teams={expertTeams}
            projects={projects}
            onSelect={(id) => goAutomations(id)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation(id);
            }}
          />
        ) : (
          <>
            <Sidebar
              sessions={sessions}
              activeId={activeId}
              onSelect={(id) => {
                void loadSession(id);
                goWorkstation(id);
              }}
              onCreate={() => void createSession()}
              onDelete={(id) => void removeSession(id)}
            />
            <ChatPanel
              initializing={bootLoading}
              session={session}
              draft={draft}
              streaming={streaming}
              liveTools={liveTools}
              projectName={projects.find((p) => p.id === session?.projectId)?.name}
              projects={projects}
              experts={experts}
              teams={expertTeams}
              expertName={experts.find((e) => e.id === session?.expertId)?.name}
              onDraft={onDraftChange}
              onResume={() => void retry()}
              onRefresh={() => { if (activeId) void loadSession(activeId); void refreshTree(); }}
              onSend={() => void send()}
              onStop={() => void stop()}
              onTeamRun={() => void startTeamRun()}
              onBindProject={(id) => void bindProject(id)}
              onBindExpert={(id) => void bindExpert(id)}
              onBindTeam={(id) => void bindTeam(id)}
              onHandoffDone={() => void refreshProjects()}
              onOpenMemory={(id) => goMemory(id)}
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

      {desktopSetup && settings && <DesktopSetup settings={settings} onDone={next => { setSettings(next); setDesktopSetup(false); void refreshTree(); }} />}
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
