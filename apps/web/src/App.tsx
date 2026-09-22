import { useDialog } from "./lib/use-dialog";
import { useRemoteActivity, remoteStateLabels } from "./lib/remote-activity";
import { ExecutionPicker } from "./components/ExecutionPicker";
import { RemoteRunsPanel } from "./components/RemoteRunsPanel";
import { DesktopSetup } from "./components/DesktopSetup";
import {
  Settings2,
  FolderOpen,
  Plus,
  X,
  Menu,
  MessageSquare,
  Layers,
  Users,
  Clock3,
  BookOpen,
  Search,
  PanelRight,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AutomationsPanel } from "./components/AutomationsPanel";
import { ChatPanel } from "./components/ChatPanel";
import { ExpertsPanel } from "./components/ExpertsPanel";
import { InboxMenu } from "./components/InboxMenu";
import { isMorePage, MoreMenu } from "./components/MoreMenu";
import { MemoryPanel } from "./components/MemoryPanel";
import { CloudWorkspace } from "./cloud/CloudWorkspace";
import { ProjectsPanel } from "./components/ProjectsPanel";
import { RightPanel } from "./components/RightPanel";
import { SearchBox } from "./components/SearchBox";
import { SearchPanel } from "./components/SearchPanel";
import { InspectorFrame } from "./components/InspectorFrame";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  api,
  streamMessage,
  streamRetry,
  streamTeamRun,
  subscribeSessionEvents,
} from "./lib/api";
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
import {
  describeExecutionSurface,
  surfaceForSession,
} from "./lib/runtime-surface";
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
  remoteHash,
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
  const [remoteFollowSessionId, setRemoteFollowSessionId] = useState<
    string | undefined
  >();
  const [filesOpen, setFilesOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const navigationDialog = useDialog<HTMLElement>(navigationOpen, () =>
    setNavigationOpen(false),
  );
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
  const [loadingSession, setLoadingSession] = useState(false);
  const loadingSessionRef = useRef(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const creatingSessionRef = useRef(false);
  const [savingExecution, setSavingExecution] = useState(false);
  const savingExecutionRef = useRef(false);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [desktopSetup, setDesktopSetup] = useState(
    () =>
      !!window.pigDesktop &&
      localStorage.getItem("pig-agent.desktop-setup") !== "complete",
  );
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
  const controllersRef = useRef(new Map<string, AbortController>());
  const seenSeqRef = useRef<Set<number>>(new Set());
  const lastSeqRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const fileRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);

  const refreshTree = useCallback(async () => {
    try {
      const identity = activeIdRef.current;
      const data = await api.tree(identity || undefined);
      if (identity !== activeIdRef.current) return;
      setTree((prev) => applyWorkspaceTreeSnapshot(prev, data.tree));
    } catch {
      setTree(null);
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    const request = ++sessionRequestRef.current;
    if (id !== activeIdRef.current) {
      setFilesOpen(false);
      setConfigurationOpen(false);
    }
    loadingSessionRef.current = true;
    setLoadingSession(true);
    fileRequestRef.current += 1;
    setPreviewPath(null);
    setPreview(null);
    try {
      const next = await api.session(id);
      if (request !== sessionRequestRef.current) return;
      activeIdRef.current = id;
      setStreaming(controllersRef.current.has(id));
      seenSeqRef.current = new Set();
      lastSeqRef.current = next.eventCheckpointSeq ?? 0;
      setSession(next);
      setActiveId(id);
      setLiveTools([]);
      setDraft(loadComposerDraft(id, browserDraftStorage()));
    } catch (error) {
      if (request === sessionRequestRef.current) {
        setTaskActionError(
          "未能打开任务：" +
            redactSecretsForDisplay(
              error instanceof Error ? error.message : String(error),
            ),
        );
        if (activeIdRef.current)
          window.location.hash = sessionHash(activeIdRef.current);
      }
    } finally {
      if (request === sessionRequestRef.current) {
        loadingSessionRef.current = false;
        setLoadingSession(false);
      }
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects: next } = await api.projects();
      setProjects(next);
    } catch {
      setProjects([]);
    }
  }, []);

  const openRemote = useCallback((id?: string) => {
    setRemoteFollowSessionId(
      id && sessionRef.current?.remoteRunId === id
        ? sessionRef.current.id
        : undefined,
    );
    window.location.hash = remoteHash(id || undefined);
  }, []);

  const goWorkstation = useCallback((sessionId?: string) => {
    window.location.hash = sessionId
      ? sessionHash(sessionId)
      : workstationHash();
  }, []);

  const applySessionListAndOpen = useCallback(
    async (next: SessionSummary[]) => {
      setSessions((prev) => applySessionListSnapshot(prev, next));
      const openId = activeIdRef.current;
      const nextId = nextOpenSessionId(openId, next);
      if (openId && nextId !== openId) {
        controllersRef.current.get(openId)?.abort();
        controllersRef.current.delete(openId);
        setStreaming(false);
        clearComposerDraft(openId, browserDraftStorage());
        const routeNow = parseHash();
        const onDeletedHash =
          routeNow.name === "workstation" && routeNow.sessionId === openId;
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

  const goProjects = useCallback(
    (projectId?: string, extra?: { assetId?: string; todoId?: string }) => {
      window.location.hash = projectsHash(projectId, extra);
    },
    [],
  );

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
      const [{ experts: next }, { teams }] = await Promise.all([
        api.experts(),
        api.expertTeams(),
      ]);
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
      } finally {
        setBootLoading(false);
      }
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
        setSession((prev) =>
          applySessionOpenMetaSnapshot(
            applySessionPinSnapshot(prev, next),
            next,
          ),
        ),
    });
  }, [activeId]);

  useEffect(() => {
    return startPinCatalogSync({
      fetchProjects: async () => {
        const { projects: next } = await api.projects();
        return next;
      },
      onProjects: (next) =>
        setProjects((prev) => applyPinProjectCatalogSnapshot(prev, next)),
      fetchExperts: async () => {
        const { experts: next } = await api.experts();
        return next;
      },
      onExperts: (next) =>
        setExperts((prev) => applyPinExpertCatalogSnapshot(prev, next)),
      fetchTeams: async () => {
        const { teams: next } = await api.expertTeams();
        return next;
      },
      onTeams: (next) =>
        setExpertTeams((prev) => applyPinTeamCatalogSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    return startSettingsSurfaceSync({
      fetchSettings: () => api.settings(),
      onSettings: (next) =>
        setSettings((prev) => applySettingsSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    return startSkillsListSync({
      fetchList: async () => {
        const { skills: next } = await api.skills();
        return next;
      },
      onList: (next) =>
        setSkills((prev) => applySkillsListSnapshot(prev, next)),
    });
  }, []);

  useEffect(() => {
    return startWorkspaceTreeSync({
      fetchTree: async () => {
        const { tree: next } = await api.tree(activeId || undefined);
        return next;
      },
      onTree: (next) =>
        setTree((prev) => applyWorkspaceTreeSnapshot(prev, next)),
    });
  }, [activeId]);

  useEffect(() => {
    if (!previewPath) return;
    return startWorkspaceFileSync({
      path: previewPath,
      fetchFile: (path) => api.file(path, activeId || undefined),
      onFile: (next) => {
        setPreview((prev) => applyWorkspaceFileSnapshot(prev, next));
        if (next === null) setPreviewPath(null);
      },
    });
  }, [previewPath, activeId]);

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
    if (
      creatingSessionRef.current ||
      route.name !== "workstation" ||
      !route.sessionId
    )
      return;
    if (route.sessionId === activeId) return;
    if (!shouldFetchSessionDetail(route.sessionId, sessions)) return;
    void loadSession(route.sessionId);
  }, [activeId, loadSession, route, sessions]);

  useEffect(() => {
    if (!activeId || session?.executionTarget !== "remote") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const id = activeId;
    async function syncRemoteIdentity() {
      try {
        const next = await api.session(id);
        if (active && activeIdRef.current === id)
          setSession((prev) =>
            prev?.id === id
              ? {
                  ...prev,
                  remoteRunId: next.remoteRunId,
                  remoteState: next.remoteState,
                }
              : prev,
          );
      } catch {
        /* Transcript and inline execution status retain their own connection feedback. */
      } finally {
        if (active) timer = setTimeout(syncRemoteIdentity, 1500);
      }
    }
    void syncRemoteIdentity();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [activeId, session?.executionTarget]);

  const openFile = useCallback(async (path: string) => {
    const request = ++fileRequestRef.current;
    setPreviewPath(path);
    setPreview(null);
    try {
      const identity = activeIdRef.current;
      const next = await api.file(path, identity || undefined);
      if (identity !== activeIdRef.current) return;
      if (request !== fileRequestRef.current) return;
      setPreview((prev) => applyWorkspaceFileSnapshot(prev, next));
    } catch (err) {
      if (request !== fileRequestRef.current) return;
      setPreview({
        path,
        content: redactSecretsForDisplay(
          err instanceof Error ? err.message : String(err),
        ),
        binary: false,
        size: 0,
      });
    }
  }, []);

  const createSession = useCallback(
    async (projectId?: string, workspaceId?: string) => {
      if (
        loadingSessionRef.current ||
        creatingSessionRef.current ||
        savingExecutionRef.current
      )
        return;
      creatingSessionRef.current = true;
      setCreatingSession(true);
      setTaskActionError(null);
      try {
        const created = await api.createSession(
          projectId ? { projectId, workspaceId } : undefined,
        );
        await refreshSessions();
        await refreshProjects();
        goWorkstation(created.id);
        await loadSession(created.id);
        return created;
      } catch (error) {
        setTaskActionError(
          redactSecretsForDisplay(
            error instanceof Error ? error.message : String(error),
          ),
        );
      } finally {
        creatingSessionRef.current = false;
        setCreatingSession(false);
      }
    },
    [goWorkstation, loadSession, refreshProjects, refreshSessions],
  );

  const removeSession = useCallback(
    async (id: string) => {
      clearComposerDraft(id, browserDraftStorage());
      await api.deleteSession(id);
      await refreshSessions();
    },
    [refreshSessions],
  );

  const onDraftChange = useCallback(
    (text: string) => {
      setDraft(text);
      if (activeId) persistComposerDraft(activeId, text, browserDraftStorage());
    },
    [activeId],
  );

  const applyEvent = useCallback(
    (event: AgentEvent, seq?: number) => {
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
          if (
            last &&
            last.role === "assistant" &&
            !last.toolCalls &&
            last.id.startsWith("stream_")
          ) {
            msgs[msgs.length - 1] = {
              ...last,
              content: last.content + event.text,
            };
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
          return {
            ...prev,
            messages: reconcileMessage(prev.messages, event.message),
          };
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
              ? {
                  ...t,
                  done: true,
                  ok: event.ok,
                  output: event.output,
                  durationMs: event.durationMs,
                }
              : t,
          ),
        );
        return;
      }
      if (event.type === "artifact") {
        setSession((prev) => {
          if (!prev) return prev;
          const rest = prev.artifacts.filter(
            (a) => a.path !== event.artifact.path,
          );
          return { ...prev, artifacts: [...rest, event.artifact] };
        });
        if (
          sessionRef.current?.executionTarget !== "remote" &&
          !sessionRef.current?.remoteRunId
        ) {
          void refreshTree();
          void openFile(event.artifact.path);
        }
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
        setSession((prev) =>
          prev ? { ...prev, teamRun: event.teamRun } : prev,
        );
        return;
      }
      if (event.type === "done") {
        setSession(event.session);
        void refreshSessions();
        void refreshTree();
      }
    },
    [openFile, refreshSessions, refreshTree],
  );

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    let first = true;
    const run = async () => {
      while (!controller.signal.aborted) {
        if (!first) setSyncPhase("catching_up");
        first = false;
        try {
          await subscribeSessionEvents(
            activeId,
            lastSeqRef.current,
            (event, seq) => {
              if (
                !controller.signal.aborted &&
                activeIdRef.current === activeId
              )
                applyEvent(event, seq);
            },
            controller.signal,
          );
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
    if (
      loadingSessionRef.current ||
      creatingSessionRef.current ||
      savingExecutionRef.current ||
      streaming ||
      controllersRef.current.has(session?.id || "__new__") ||
      session?.status === "running" ||
      !draft.trim()
    )
      return;
    const content = draft.trim();
    const clientMessageId = crypto.randomUUID();
    const controller = new AbortController();
    const originalKey = session?.id || "__new__";
    controllersRef.current.set(originalKey, controller);
    setStreaming(true);
    setBootError(null);
    let target = session;
    try {
      if (!target) {
        creatingSessionRef.current = true;
        setCreatingSession(true);
        target = await api.createSession();
        controllersRef.current.delete(originalKey);
        controllersRef.current.set(target.id, controller);
        seenSeqRef.current = new Set();
        lastSeqRef.current = target.eventCheckpointSeq ?? 0;
        activeIdRef.current = target.id;
        setActiveId(target.id);
        setSessions((prev) => [
          target!,
          ...prev.filter((item) => item.id !== target!.id),
        ]);
        setSession(target);
        goWorkstation(target.id);
      }
      if (originalKey === "__new__") {
        creatingSessionRef.current = false;
        setCreatingSession(false);
      }
      if (controller.signal.aborted) return;
      setDraft("");
      clearComposerDraft(target.id, browserDraftStorage());
      setLiveTools([]);
      setSession({
        ...target,
        status: "running",
        messages: [
          ...target.messages,
          {
            id: clientMessageId,
            role: "user",
            content,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const targetId = target.id;
      await streamMessage(
        targetId,
        content,
        (event, seq) => {
          if (activeIdRef.current === targetId) applyEvent(event, seq);
        },
        controller.signal,
        clientMessageId,
      );
    } catch (err) {
      if (!target)
        setBootError(err instanceof Error ? err.message : String(err));
      else if (controller.signal.aborted)
        setSession((prev) =>
          prev?.id === target!.id ? { ...prev, status: "idle" } : prev,
        );
      else
        setSession((prev) =>
          prev?.id === target!.id
            ? {
                ...prev,
                status: "idle",
                lastError: redactSecretsForDisplay(
                  err instanceof Error ? err.message : String(err),
                ),
                localRetry: "turn",
              }
            : prev,
        );
    } finally {
      if (originalKey === "__new__") {
        creatingSessionRef.current = false;
        setCreatingSession(false);
      }
      const key = target?.id || originalKey;
      if (controllersRef.current.get(key) === controller)
        controllersRef.current.delete(key);
      if (!target || activeIdRef.current === target.id) setStreaming(false);
      void refreshSessions();
    }
  }, [applyEvent, draft, goWorkstation, refreshSessions, session, streaming]);

  const stop = useCallback(async () => {
    if (!session) return;
    const id = session.id;
    controllersRef.current.get(id)?.abort();
    try {
      try {
        await api.stopTeamRun(id);
      } catch {
        await api.abort(id);
      }
      if (activeIdRef.current === id) {
        setStreaming(false);
        await loadSession(id);
      }
    } catch (error) {
      if (activeIdRef.current === id)
        setTaskActionError(
          redactSecretsForDisplay(
            error instanceof Error ? error.message : String(error),
          ),
        );
    }
  }, [session, loadSession]);

  const retry = useCallback(async () => {
    if (
      loadingSessionRef.current ||
      creatingSessionRef.current ||
      savingExecutionRef.current ||
      !session ||
      streaming ||
      controllersRef.current.has(session.id)
    )
      return;
    setStreaming(true);
    setLiveTools([]);
    setSession((prev) =>
      prev?.id === session.id
        ? {
            ...prev,
            status: "running",
            lastError: undefined,
            remoteRetry: undefined,
            localRetry: undefined,
          }
        : prev,
    );
    const controller = new AbortController();
    controllersRef.current.set(session.id, controller);
    try {
      await streamRetry(
        session.id,
        (event, seq) => {
          if (activeIdRef.current === session.id) applyEvent(event, seq);
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        setSession((prev) =>
          prev?.id === session.id ? { ...prev, status: "idle" } : prev,
        );
      } else {
        setSession((prev) =>
          prev?.id === session.id
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
      if (controllersRef.current.get(session.id) === controller)
        controllersRef.current.delete(session.id);
      if (activeIdRef.current === session.id) setStreaming(false);
      void refreshSessions();
    }
  }, [applyEvent, refreshSessions, session, streaming]);

  const startTeamRun = useCallback(async () => {
    if (
      loadingSessionRef.current ||
      creatingSessionRef.current ||
      savingExecutionRef.current ||
      !session ||
      streaming ||
      controllersRef.current.has(session.id) ||
      session.status === "running"
    )
      return;
    const content = draft.trim();
    const clientMessageId = content ? crypto.randomUUID() : undefined;
    const canContinue = Boolean(
      session.teamRun &&
      session.teamRun.members.some(
        (m) =>
          m.status === "pending" ||
          m.status === "error" ||
          m.status === "cancelled",
      ) &&
      session.teamRun.status !== "running" &&
      session.teamRun.status !== "done",
    );
    const action: "start" | "continue" =
      !content && canContinue ? "continue" : "start";
    if (
      action === "start" &&
      !content &&
      !session.messages.some((m) => m.role === "user")
    )
      return;
    if (content) {
      setDraft("");
      clearComposerDraft(session.id, browserDraftStorage());
    }
    setStreaming(true);
    setLiveTools([]);
    if (content) {
      setSession((prev) =>
        prev?.id === session.id
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
      setSession((prev) =>
        prev?.id === session.id ? { ...prev, status: "running" } : prev,
      );
    }
    const controller = new AbortController();
    controllersRef.current.set(session.id, controller);
    try {
      await streamTeamRun(
        session.id,
        action === "start" && content
          ? { action, content, clientMessageId }
          : { action },
        (event, seq) => {
          if (activeIdRef.current === session.id) applyEvent(event, seq);
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        setSession((prev) =>
          prev?.id === session.id ? { ...prev, status: "idle" } : prev,
        );
      } else {
        setSession((prev) =>
          prev?.id === session.id
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
      if (controllersRef.current.get(session.id) === controller)
        controllersRef.current.delete(session.id);
      if (activeIdRef.current === session.id) setStreaming(false);
      void refreshSessions();
    }
  }, [applyEvent, draft, refreshSessions, session, streaming]);

  const bindProject = useCallback(
    async (projectId: string | null) => {
      if (!session || loadingSessionRef.current) return;
      let next: Session;
      try {
        next = await api.patchSession(session.id, { projectId });
      } catch (error) {
        if (activeIdRef.current === session.id)
          setTaskActionError(
            redactSecretsForDisplay(
              error instanceof Error ? error.message : String(error),
            ),
          );
        return;
      }
      if (activeIdRef.current === session.id)
        setSession((prev) => (prev?.id === session.id ? next : prev));
      await refreshSessions();
      await refreshProjects();
    },
    [refreshProjects, refreshSessions, session],
  );

  const bindExpert = useCallback(
    async (expertId: string | null) => {
      if (!session || loadingSessionRef.current) return;
      let next: Session;
      try {
        next = await api.patchSession(session.id, { expertId });
      } catch (error) {
        if (activeIdRef.current === session.id)
          setTaskActionError(
            redactSecretsForDisplay(
              error instanceof Error ? error.message : String(error),
            ),
          );
        return;
      }
      if (activeIdRef.current === session.id)
        setSession((prev) => (prev?.id === session.id ? next : prev));
      await refreshSessions();
    },
    [refreshSessions, session],
  );

  const bindTeam = useCallback(
    async (expertTeamId: string | null) => {
      if (!session || loadingSessionRef.current) return;
      let next: Session;
      try {
        next = await api.patchSession(session.id, { expertTeamId });
      } catch (error) {
        if (activeIdRef.current === session.id)
          setTaskActionError(
            redactSecretsForDisplay(
              error instanceof Error ? error.message : String(error),
            ),
          );
        return;
      }
      if (activeIdRef.current === session.id)
        setSession((prev) => (prev?.id === session.id ? next : prev));
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
    setTheme(
      persistTheme(next, {
        storage: browserThemeStorage(),
        root: browserThemeRoot(),
      }),
    );
  }, []);

  const executionSurface = useMemo(() => {
    if (!settings) {
      return describeExecutionSurface({ runtime: "pig" });
    }
    return surfaceForSession(settings, session);
  }, [settings, session?.executionTarget, session?.engine]);

  const remoteActivity = useRemoteActivity(session?.remoteRunId);
  const remoteStatus =
    remoteActivity.approvals.some((a) => a.state === "pending") &&
    ["running", "preparing"].includes(remoteActivity.run?.state || "")
      ? "等待审批"
      : remoteActivity.run
        ? remoteStateLabels[remoteActivity.run.state]
        : undefined;
  const pageTitles = {
    workstation: session?.title || "新任务",
    projects: "项目",
    collaboration: "项目协同",
    experts: "专家",
    automations: "自动化",
    memory: "记忆",
    search: "搜索",
    remote: "远端记录",
  };
  const navigate = (action: () => void) => {
    action();
    setNavigationOpen(false);
  };
  const executionControls = session ? (
    <ExecutionPicker
      session={session}
      settings={settings}
      disabled={
        loadingSession ||
        creatingSession ||
        savingExecution ||
        streaming ||
        session.status === "running"
      }
      onChange={async (patch) => {
        if (
          loadingSessionRef.current ||
          creatingSessionRef.current ||
          savingExecutionRef.current
        )
          return;
        const targetId = session.id;
        savingExecutionRef.current = true;
        setSavingExecution(true);
        setTaskActionError(null);
        try {
          const next = await api.patchSession(targetId, patch);
          if (activeIdRef.current === targetId)
            setSession((previous) =>
              previous?.id === targetId ? next : previous,
            );
        } catch (error) {
          if (activeIdRef.current === targetId)
            setTaskActionError(
              redactSecretsForDisplay(
                error instanceof Error ? error.message : String(error),
              ),
            );
        } finally {
          savingExecutionRef.current = false;
          setSavingExecution(false);
        }
      }}
    />
  ) : (
    <button className="btn-ghost" onClick={() => setSettingsOpen(true)}>
      配置执行默认值
    </button>
  );
  return (
    <div className="app-layout">
      {navigationOpen && (
        <button
          className="navigation-scrim"
          aria-label="关闭导航"
          onClick={() => setNavigationOpen(false)}
        />
      )}
      <aside
        ref={navigationDialog}
        className={`global-sidebar ${navigationOpen ? "is-open" : ""}`}
        aria-label="全局导航"
      >
        <div className="sidebar-brand">
          <span className="brand-mark">P</span>
          <strong>Pig Agent</strong>
          <button
            className="icon-button mobile-only"
            aria-label="关闭导航"
            onClick={() => setNavigationOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <button
          className="sidebar-new"
          disabled={loadingSession || creatingSession || savingExecution}
          onClick={() => navigate(() => void createSession())}
        >
          <Plus size={17} />
          {route.name === "collaboration" ? "新建本机任务" : "新任务"}
        </button>
        <nav className="global-links">
          {[
            {
              label: "工作台",
              name: "workstation",
              icon: MessageSquare,
              action: () => goWorkstation(activeId ?? undefined),
            },
            {
              label: "项目",
              name: "projects",
              icon: Layers,
              action: () => goProjects(),
            },
            {
              label: "专家",
              name: "experts",
              icon: Users,
              action: () => goExperts(),
            },
            {
              label: "自动化",
              name: "automations",
              icon: Clock3,
              action: () => goAutomations(),
            },
            {
              label: "记忆",
              name: "memory",
              icon: BookOpen,
              action: () => goMemory(),
            },
            {
              label: "搜索",
              name: "search",
              icon: Search,
              action: () => goSearch(),
            },
          ].map(({ label, name, icon: Icon, action }) => (
            <Fragment key={name}>
              <button
                className={
                  route.name === name ||
                  (name === "projects" && route.name === "collaboration")
                    ? "selected"
                    : ""
                }
                aria-current={route.name === name ? "page" : undefined}
                onClick={() => navigate(action)}
              >
                <Icon size={17} />
                {label}
              </button>
              {name === "projects" && (
                <>
                  {(route.name === "projects" ||
                    route.name === "collaboration") && (
                    <nav aria-label="项目分支" className="project-branches">
                      <button
                        className={route.name === "projects" ? "selected" : ""}
                        onClick={() => navigate(() => goProjects())}
                      >
                        普通项目
                      </button>
                      <button
                        className={
                          route.name === "collaboration" ? "selected" : ""
                        }
                        onClick={() =>
                          navigate(() => {
                            location.hash = "/projects/collaboration";
                          })
                        }
                      >
                        <Users size={15} />
                        项目协同
                      </button>
                    </nav>
                  )}
                </>
              )}
            </Fragment>
          ))}
          <button
            className={route.name === "remote" ? "selected" : ""}
            aria-current={route.name === "remote" ? "page" : undefined}
            onClick={() => {
              openRemote("");
              setNavigationOpen(false);
            }}
          >
            <Clock3 size={17} />
            远端记录
          </button>
        </nav>
        {route.name === "workstation" && (
          <Sidebar
            sessions={sessions}
            busy={creatingSession}
            createDisabled={savingExecution}
            activeId={activeId}
            onSelect={(id) =>
              navigate(() => {
                void loadSession(id);
                goWorkstation(id);
              })
            }
            onCreate={() => navigate(() => void createSession())}
            onDelete={(id) => void removeSession(id)}
          />
        )}
        <div className="sidebar-footer">
          <InboxMenu
            onOpenProject={(id) => goProjects(id)}
            onInviteResolved={() => setProjectRefreshTick((n) => n + 1)}
            onOpenSession={(id) => {
              void loadSession(id);
              goWorkstation(id);
            }}
          />
          <button
            className="settings-entry"
            onClick={() => {
              setSettingsOpen(true);
              setNavigationOpen(false);
            }}
          >
            <Settings2 size={17} />
            设置
          </button>
        </div>
      </aside>
      <main className="app-main">
        <header className="task-header">
          <button
            className="icon-button mobile-only"
            data-navigation-trigger
            aria-label="打开导航"
            onClick={() => {
              setFilesOpen(false);
              setNavigationOpen(true);
            }}
          >
            <Menu size={20} />
          </button>
          <div className="task-heading">
            <span className="context-label">
              {route.name === "workstation" ? "工作台" : "Pig Agent"}
            </span>
            <h1 title={pageTitles[route.name]}>{pageTitles[route.name]}</h1>
          </div>
          {route.name === "workstation" && (
            <div className="task-header-actions">
              {session && (
                <span
                  className={`status-label ${remoteStatus === "等待审批" ? "is-waiting" : session.lastError ? "is-error" : streaming || session.status === "running" ? "is-running" : ""}`}
                >
                  {remoteStatus ||
                    (session.lastError
                      ? "需要处理"
                      : streaming || session.status === "running"
                        ? "执行中"
                        : session.messages.length
                          ? "可继续"
                          : "未开始")}
                </span>
              )}
              <button
                className="icon-button"
                aria-label="任务配置"
                title="任务配置"
                aria-expanded={configurationOpen}
                onClick={() => setConfigurationOpen(!configurationOpen)}
              >
                <Settings2 size={18} />
              </button>
              <button
                className="icon-button"
                aria-label="文件与产物"
                title="文件与产物"
                aria-expanded={filesOpen}
                onClick={() => setFilesOpen(!filesOpen)}
              >
                <PanelRight size={18} />
                {!!session?.artifacts.length && (
                  <span className="count-dot">{session.artifacts.length}</span>
                )}
              </button>
            </div>
          )}
        </header>
        {loadingSession && !creatingSession && (
          <div role="status" className="context-loading">
            正在打开任务…
          </div>
        )}
        {(creatingSession || savingExecution) && (
          <div
            role="status"
            className="border-b border-ink-300 bg-accent-soft px-4 py-2 text-xs text-accent"
          >
            {creatingSession
              ? "正在创建新任务，请稍候…"
              : "正在保存执行配置，保存后即可发送…"}
          </div>
        )}
        {taskActionError && (
          <div
            role="alert"
            className="border-b border-danger-soft bg-danger-soft px-4 py-2 text-xs text-danger"
          >
            任务操作失败：{taskActionError}
          </div>
        )}
        {bootError && (
          <div className="border-b border-danger-soft bg-danger-soft px-4 py-2 text-xs text-danger">
            无法连接本地后端：{bootError}。
            {window.pigDesktop ? (
              "请退出并重新打开应用；仍失败时可从帮助菜单导出诊断信息。"
            ) : (
              <>
                请确认已运行 <code>pnpm dev</code>。
              </>
            )}
          </div>
        )}
        {route.name === "workstation" &&
          syncPhase === "catching_up" &&
          !session?.lastError && (
            <div className="flex items-center gap-2 border-b border-ink-300 bg-panel px-4 py-2 text-xs text-ink-600">
              <span>{CATCH_UP_STATUS}</span>
            </div>
          )}
        {route.name === "workstation" && session?.lastError && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning-soft bg-warning-soft px-4 py-2 text-xs text-warning">
            <span>{redactSecretsForDisplay(session.lastError)}</span>
            <button
              type="button"
              className="btn-ghost shrink-0 text-xs"
              disabled={
                creatingSession ||
                savingExecution ||
                streaming ||
                session.localRetry === "unavailable"
              }
              onClick={() => void retry()}
            >
              {retryActionLabel(session.remoteRetry, session.localRetry)}
            </button>
          </div>
        )}

        <div
          className={`workspace-shell flex min-h-0 min-w-0 flex-1 overflow-hidden ${filesOpen ? "show-files" : ""}`}
        >
          {route.name === "collaboration" ? (
            <CloudWorkspace
              embedded
              apiBase="/api/remote"
              webBaseUrl={
                settings?.cloudBaseUrl ||
                settings?.cloudStatus?.effectiveBaseUrl
              }
            />
          ) : route.name === "remote" ? (
            <RemoteRunsPanel
              embedded
              runId={route.runId}
              followSessionId={remoteFollowSessionId}
              onClose={() => goWorkstation(activeId ?? undefined)}
              onOpenSession={(id) => {
                goWorkstation(id);
                void refreshSessions();
                void loadSession(id);
              }}
            />
          ) : route.name === "projects" ? (
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
              onCreateSession={(projectId, workspaceId) =>
                void createSession(projectId, workspaceId)
              }
            />
          ) : route.name === "search" ? (
            <SearchPanel initialQ={route.q} onOpenHit={openHit} />
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
              onOpenRemoteRun={(id) => openRemote(id)}
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
              <ChatPanel
                remoteActivity={remoteActivity}
                configurationOpen={configurationOpen}
                executionControls={executionControls}
                workspaceRoot={
                  session?.workspaceRoot || settings?.workspaceRoot
                }
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenArtifacts={() => setFilesOpen(true)}
                initializing={
                  bootLoading ||
                  loadingSession ||
                  creatingSession ||
                  savingExecution
                }
                executionSurface={executionSurface}
                onOpenRemote={() => openRemote(session?.remoteRunId || "")}
                session={session}
                draft={draft}
                streaming={streaming}
                liveTools={liveTools}
                projectName={
                  projects.find((p) => p.id === session?.projectId)?.name
                }
                projects={projects}
                experts={experts}
                teams={expertTeams}
                expertName={
                  experts.find((e) => e.id === session?.expertId)?.name
                }
                onDraft={onDraftChange}
                onResume={() => void retry()}
                onRefresh={() => {
                  if (activeId) void loadSession(activeId);
                  void refreshTree();
                }}
                onEnsureSession={async () => { const target = session || await createSession(); if (!target) throw new Error("任务正在初始化，请稍后重试。"); return target; }}
                onSend={() => void send()}
                onStop={() => void stop()}
                onTeamRun={() => void startTeamRun()}
                onBindProject={(id) => void bindProject(id)}
                onBindExpert={(id) => void bindExpert(id)}
                onBindTeam={(id) => void bindTeam(id)}
                onHandoffDone={() => void refreshProjects()}
                onOpenMemory={(id) => goMemory(id)}
              />
              {filesOpen && (
                <InspectorFrame onClose={() => setFilesOpen(false)}>
                  <RightPanel
                    key={session?.id || "workspace"}
                    executionTarget={session?.executionTarget}
                    remoteRunId={session?.remoteRunId}
                    remoteState={session?.remoteState}
                    onOpenSession={(id) => {
                      goWorkstation(id);
                      void loadSession(id);
                    }}
                    artifacts={session?.artifacts ?? []}
                    tree={tree}
                    workspaceRoot={
                      session?.workspaceRoot || settings?.workspaceRoot || ""
                    }
                    previewPath={previewPath}
                    preview={preview}
                    onOpenFile={(path) => void openFile(path)}
                    sessionId={session?.id}
                    projectId={session?.projectId}
                    projectName={
                      projects.find((p) => p.id === session?.projectId)?.name
                    }
                    onOpenProject={(id) => {
                      void refreshProjects();
                      goProjects(id);
                    }}
                  />
                </InspectorFrame>
              )}
            </>
          )}
        </div>
      </main>
      {desktopSetup && settings && (
        <DesktopSetup
          settings={settings}
          onDone={(next) => {
            setSettings(next);
            setDesktopSetup(false);
            void refreshTree();
          }}
        />
      )}
      <SettingsModal
        open={settingsOpen}
        theme={theme}
        onTheme={setPersistedTheme}
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
