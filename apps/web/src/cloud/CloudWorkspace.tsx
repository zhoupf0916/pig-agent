import { ApprovalPreview } from "../components/ApprovalPreview";
import { useCloudDraft } from "./use-cloud-draft";
import {
  MessageAttachments,
  useMessageAttachments,
  type Attachment,
} from "./MessageAttachments";
import {
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
  type KeyboardEvent,
} from "react";
import {
  Menu,
  ShieldCheck,
  ChevronDown,
  Plus,
  Send,
  Users,
  X,
  FileText,
  FolderKanban,
  MessageSquare,
  LogOut,
  Search,
  PenLine,
} from "lucide-react";
import { useDialog } from "../lib/use-dialog";
import { MarkdownView } from "../components/MarkdownView";
import { ExecutionJournal } from "../components/ExecutionJournal";
import type { AgentEvent } from "../types";
import type {
  CloudApproval,
  CloudArtifactSummary,
  CloudSharedProject,
  CloudSpace,
} from "@pig-agent/contracts/cloud";
import { redactSecretsForDisplay } from "../lib/remote-retry";
import "./cloud-workspace.css";

type WorkspaceProject = CloudSharedProject & {
  kind: "personal" | "collaborative";
  workspace_name: string;
};
type ProjectWorkspace = {
  seed?: { fileCount: number; byteSize: number; files: string[] };
  projectId: string;
  workspaceName: string;
  conversations: Array<{
    id: string;
    title: string;
    versions: Array<{
      run_id: string;
      created_at: string;
      manifest: { files?: string[] };
    }>;
  }>;
};
type Message = {
  id: string;
  role: string;
  content: string;
  author?: { id: string; name: string };
};
type Conversation = {
  id: string;
  title: string;
  project_id?: string;
  last_run_id?: string;
  state?: string;
  can_write?: boolean;
};
type Run = {
  attachments?: Attachment[];
  id: string;
  state: string;
  prompt: string;
  error?: string;
  author?: { name: string };
};
type Detail = { conversation: Conversation; runs: Run[]; messages: Message[] };
const labels: Record<string, string> = {
  queued: "排队中",
  preparing: "准备环境",
  running: "执行中",
  cancelling: "正在停止",
  cancelled: "已停止",
  succeeded: "已完成",
  failed: "执行失败",
};
const terminal = (state?: string) =>
  !!state && ["succeeded", "failed", "cancelled"].includes(state);
function hashConversationId(hash = window.location.hash) {
  return (
    hash.match(
      /^#\/(?:shared|conversations|projects\/collaboration|projects\/personal)\/(conv_[a-z0-9]+)(?:\?|$)/,
    )?.[1] || ""
  );
}
function workspaceHash(hash = window.location.hash) {
  const path = hash.split("?")[0] || "";
  return (
    path === "" ||
    path === "#" ||
    path.startsWith("#/conversations") ||
    path.startsWith("#/projects") ||
    path.startsWith("#/shared")
  );
}
export function CloudWorkspace({
  apiBase = "",
  embedded = false,
  webBaseUrl,
  onBack,
  account,
  onAccount,
  initialBranch,
  routePrefix,
  taskOptions,
  onOpenNavigation,
  hashSync = true,
}: {
  apiBase?: string;
  embedded?: boolean;
  webBaseUrl?: string;
  onBack?: () => void;
  account?: { id: string; name: string };
  onAccount?: (account: { id: string; name: string } | null) => void;
  initialBranch?: "personal" | "collaborative";
  routePrefix?: string;
  onOpenNavigation?: () => void;
  hashSync?: boolean;
  taskOptions?: { expertId?: string; skillIds?: string[] };
}) {
  const composerControls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !composerControls.current?.contains(event.target)
      )
        composerControls.current
          ?.querySelectorAll<HTMLDetailsElement>("details[open]")
          .forEach((d) => {
            d.open = false;
          });
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => {
    const previous = document.title;
    document.title = "Pig Agent · 工作台";
    return () => {
      document.title = previous;
    };
  }, []);
  const [me, setMe] = useState<{ name: string; id: string } | null>(
      account ?? null,
    ),
    [authLoading, setAuthLoading] = useState(!account),
    [credential, setCredential] = useState(""),
    [loginMode, setLoginMode] = useState<"login" | "register" | "token">(
      "login",
    );
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [reason, setReason] = useState(""),
    [authFeedback, setAuthFeedback] = useState("");
  const [projects, setProjects] = useState<WorkspaceProject[]>([]),
    [spaces, setSpaces] = useState<CloudSpace[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [projectId, setProjectId] = useState(""),
    [selected, setSelected] = useState(() => hashConversationId()),
    [detail, setDetail] = useState<Detail | null>(null);
  const [projectBranch, setProjectBranch] = useState<
      "personal" | "collaborative" | "choose"
    >(initialBranch ?? (embedded ? "collaborative" : "personal")),
    [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null),
    [workspaceLoading, setWorkspaceLoading] = useState(false),
    [networkPolicy, setNetworkPolicy] = useState<"ask" | "blocked">("ask");
  const [networkChanged, setNetworkChanged] = useState(false);
  const [requireApproval, setRequireApproval] = useState(true),
    [approvalChanged, setApprovalChanged] = useState(false);
  const [expertId, setExpertId] = useState(taskOptions?.expertId || ""),
    [skillIds, setSkillIds] = useState<string[]>(taskOptions?.skillIds || []);
  const [experts, setExperts] = useState<Array<{ id: string; name: string }>>(
      [],
    ),
    [skills, setSkills] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!me || apiBase) return;
    let valid = true;
    void Promise.all([request("/v1/experts"), request("/v1/skills")])
      .then(([a, b]) => {
        if (valid) {
          setExperts(a.experts);
          setSkills(b.skills);
        }
      })
      .catch(() => {});
    return () => {
      valid = false;
    };
  }, [me?.id]);
  useEffect(() => {
    onAccount?.(me);
  }, [me?.id]);
  useEffect(() => {
    if (me)
      void request("/v1/settings")
        .then((v) => {
          setNetworkPolicy(v.networkPolicy);
          setRequireApproval(v.requireApproval);
        })
        .catch(() => {});
  }, [me?.id]);
  const [prompt, setPrompt] = useCloudDraft(
      `${me?.id || "anonymous"}:${selected || `new:${projectId}`}`,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [mobile, setMobile] = useState(false),
    [membersOpen, setMembersOpen] = useState(false),
    [resource, setResource] = useState(false),
    [tab, setTab] = useState<"files" | "logs" | "workspace">("files");
  const [approvals, setApprovals] = useState<CloudApproval[]>([]),
    [artifacts, setArtifacts] = useState<CloudArtifactSummary[]>([]),
    [events, setEvents] = useState<AgentEvent[]>([]),
    [live, setLive] = useState(""),
    [liveMessages, setLiveMessages] = useState<Message[]>([]),
    [connection, setConnection] = useState(""),
    [preview, setPreview] = useState<{ path: string; text: string } | null>(
      null,
    );
  const contextDialog = useDialog<HTMLElement>(mobile, () => setMobile(false));
  const resourceDialog = useDialog<HTMLElement>(resource, () =>
    setResource(false),
  );
  const scrollArea = useRef<HTMLDivElement>(null),
    promptInput = useRef<HTMLTextAreaElement>(null),
    followBottom = useRef(true);
  const lock = useRef(false),
    sendKey = useRef({ signature: "", key: "" }),
    selectedRef = useRef(selected);
  selectedRef.current = selected;
  const current = detail?.conversation.id === selected ? detail : null,
    last = current?.runs.at(-1),
    active = !!last && !terminal(last.state),
    project = projects.find((p) => p.id === projectId),
    canWrite = selected
      ? current?.conversation.can_write === true
      : projectBranch === "collaborative" && !projectId
        ? false
        : project?.role !== "viewer";
  const pendingApproval =
    active && approvals.some((a) => a.state === "pending");
  const approvalPlaceholder = (message: Message) =>
    pendingApproval &&
    message.role === "assistant" &&
    /^操作 \S+ 等待审批，尚未执行[。；]/.test(message.content);
  const currentRunRef = useRef(last?.id);
  currentRunRef.current = last?.id;
  const accountGeneration = useRef(0);
  function clearAccount(clearSelection = true) {
    accountGeneration.current++;
    setExperts([]);
    setSkills([]);
    setExpertId("");
    setSkillIds([]);
    setNetworkChanged(false);
    setApprovalChanged(false);
    setConversations([]);
    setProjects([]);
    setWorkspace(null);
    setSpaces([]);
    setProjectId("");
    setDetail(null);
    setApprovals([]);
    setArtifacts([]);
    setEvents([]);
    setPreview(null);
    setLive("");
    setLiveMessages([]);
    setPrompt("");
    setMembersOpen(false);
    setResource(false);
    setConnection("");
    sendKey.current = { signature: "", key: "" };
    if (clearSelection) setSelected("");
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ) {
    const generation = accountGeneration.current;
    const response = await fetch(apiBase + path, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (generation !== accountGeneration.current)
      throw Error("账号已切换，已忽略旧请求");
    if (!response.ok) {
      if (response.status === 401 && generation === accountGeneration.current) {
        clearAccount(false);
        setMe(null);
      }
      throw Error(
        typeof data.error === "string"
          ? data.error
          : `请求失败 (${response.status})`,
      );
    }
    return data;
  }
  const attachments = useMessageAttachments(
    `${me?.id || "anonymous"}:${selected || `new:${projectId}`}`,
    request,
  );
  async function refresh() {
    const generation = accountGeneration.current;
    const [a, b, c] = await Promise.all([
      request("/v1/conversations"),
      request("/v1/projects"),
      request("/v1/spaces"),
    ]);
    if (generation !== accountGeneration.current) return;
    setConversations(a.conversations);
    setProjects(b.projects);
    setSpaces(c.spaces);
    window.dispatchEvent(new Event("pig-cloud-catalog"));
  }
  async function act(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        redactSecretsForDisplay(e instanceof Error ? e.message : String(e)),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let valid = true;
    void request("/v1/me")
      .then((value) => {
        if (valid) setMe(value);
      })
      .catch(() => {})
      .finally(() => {
        if (valid) setAuthLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [apiBase]);
  useEffect(() => {
    if (!me) return;
    let valid = true;
    async function poll() {
      try {
        if (valid) await refresh();
      } catch (e) {
        if (valid) setError(String(e));
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      valid = false;
      clearInterval(timer);
    };
  }, [me?.id, apiBase]);
  useEffect(() => {
    setDetail(null);
    setLive("");
    setLiveMessages([]);
    setEvents([]);
    setPreview(null);
    setApprovals([]);
    setArtifacts([]);
    setConnection("");
    if (!selected || !me) return;
    let valid = true;
    const generation = accountGeneration.current;
    let snapshot: Detail | null = null;
    let cursor = "0";
    const seen = new Set<string>();
    const journal = new Map<string, { runId: string; event: AgentEvent }>();
    const controller = new AbortController();
    setLoading(true);
    function receive(raw: string) {
      if (generation !== accountGeneration.current) return;
      const data = JSON.parse(raw);
      if (data.type === "access_revoked") {
        setDetail(null);
        setError("你已没有此会话的访问权限");
        controller.abort();
        return;
      }
      if (data.type === "conversation_snapshot") {
        const before = snapshot?.runs.at(-1)?.id;
        snapshot = data;
        setDetail(data);
        setLoading(false);
        setProjectId(data.conversation.project_id || "");
        const latest = snapshot!.runs.at(-1);
        if (before !== latest?.id || terminal(latest?.state)) {
          setLive("");
          setLiveMessages([]);
        }
        setEvents(
          [...journal.values()]
            .filter((row) => row.runId === latest?.id)
            .map((row) => row.event),
        );
        return;
      }
      if (data.type !== "run_event" || seen.has(String(data.seq))) return;
      seen.add(String(data.seq));
      cursor = String(data.seq);
      const event = data.event as AgentEvent;
      journal.set(cursor, { runId: data.runId, event });
      const latest = snapshot?.runs.at(-1);
      if (!latest || latest.id !== data.runId) return;
      setEvents(
        [...journal.values()]
          .filter((row) => row.runId === latest.id)
          .map((row) => row.event),
      );
      if (terminal(latest.state)) return;
      if (event.type === "token") setLive((t) => t + event.text);
      if (event.type === "message" && event.message.role === "assistant") {
        setLiveMessages((ms) => [
          ...ms.filter((m) => m.id !== event.message.id),
          event.message,
        ]);
        setLive("");
      }
    }
    async function connect() {
      while (valid && !controller.signal.aborted) {
        try {
          const response = await fetch(
            apiBase + `/v1/conversations/${selected}/events?after=${cursor}`,
            {
              signal: controller.signal,
              headers: { Accept: "text/event-stream" },
              credentials: "same-origin",
            },
          );
          if (!response.ok) {
            if ([401, 403, 404].includes(response.status)) {
              setDetail(null);
              setLoading(false);
              setError("会话不存在或当前账号没有访问权限");
              return;
            }
            throw Error("无法连接会话");
          }
          setConnection("");
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (valid) {
              const part = await reader.read();
              if (part.done) break;
              buffer += decoder
                .decode(part.value, { stream: true })
                .replace(/\r/g, "");
              let boundary;
              while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const raw = frame
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                if (raw) receive(raw);
              }
            }
          } finally {
            reader.releaseLock();
          }
        } catch {
          if (!valid || controller.signal.aborted) return;
        }
        if (valid) {
          setConnection("连接中断，正在自动重连…");
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    void connect();
    return () => {
      valid = false;
      controller.abort();
    };
  }, [selected, me?.id, apiBase]);
  useEffect(() => {
    setPreview(null);
    setApprovals([]);
    setArtifacts([]);
    if (!last?.id) return;
    const runId = last.id;
    const generation = accountGeneration.current;
    let valid = true;
    async function poll() {
      try {
        const [a, b] = await Promise.all([
          request(`/v1/runs/${runId}/approvals`),
          request(`/v1/runs/${runId}/artifacts`),
        ]);
        if (valid && generation === accountGeneration.current) {
          setApprovals(a.approvals);
          setArtifacts(b.artifacts);
        }
      } catch (e) {
        if (valid) setError(String(e));
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      valid = false;
      clearInterval(timer);
    };
  }, [last?.id, apiBase]);
  useEffect(() => {
    const apply = () => {
      if (!workspaceHash()) return;
      setSelected(hashConversationId());
    };
    const onIntent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          create?: "personal" | "collaborative" | "choose";
          projectId?: string;
          panel?: string;
        }>
      ).detail;
      if (!detail) return;
      if (
        detail.create === "personal" ||
        detail.create === "collaborative" ||
        detail.create === "choose"
      ) {
        setProjectBranch(detail.create);
        setSelected("");
        if (detail.create === "choose") setProjectId("");
        setMembersOpen(true);
      }
      if (typeof detail.projectId === "string") {
        setSelected("");
        setProjectId(detail.projectId);
      }
      if (detail.panel === "workspace") {
        setTab("workspace");
        setResource(true);
      }
    };
    apply();
    window.addEventListener("hashchange", apply);
    window.addEventListener("pig-cloud-intent", onIntent);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("pig-cloud-intent", onIntent);
    };
  }, []);
  useEffect(() => {
    if (!hashSync || !workspaceHash()) return;
    const prefix =
      routePrefix ?? (apiBase ? "#/projects/collaboration" : "#/conversations");
    const next = prefix + (selected ? "/" + selected : "");
    const current = location.hash.split("?")[0] || "";
    if (current !== next) history.replaceState(null, "", next);
  }, [hashSync, selected, apiBase, routePrefix]);
  useEffect(() => {
    const node = scrollArea.current;
    if (node && followBottom.current) node.scrollTop = node.scrollHeight;
  }, [current?.messages.length, live, liveMessages.length, approvals.length]);
  useEffect(() => {
    if (project) setProjectBranch(project.kind);
  }, [project?.id, project?.kind]);
  useEffect(() => {
    let valid = true;
    const generation = accountGeneration.current;
    setWorkspace(null);
    if (!projectId) return;
    setWorkspaceLoading(true);
    void request(`/v1/projects/${projectId}/workspace`)
      .then((d) => {
        if (valid && generation === accountGeneration.current) setWorkspace(d);
      })
      .catch((e) => {
        if (valid) setError(e.message);
      })
      .finally(() => {
        if (valid) setWorkspaceLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [projectId, last?.state]);
  function choose(c: Conversation) {
    followBottom.current = true;
    setSelected(c.id);
    setProjectId(c.project_id || "");
    const selectedProject = projects.find((p) => p.id === c.project_id);
    if (selectedProject) setProjectBranch(selectedProject.kind);
    setMobile(false);
    setError("");
  }
  async function send() {
    const text = prompt.trim();
    if (!text || active || !canWrite || attachments.blocked) return;
    await act(async () => {
      const signature = JSON.stringify([
        selected,
        projectId,
        last?.id,
        text,
        attachments.ids,
      ]);
      if (sendKey.current.signature !== signature)
        sendKey.current = { signature, key: crypto.randomUUID() };
      const result = await request(
        last ? `/v1/runs/${last.id}/follow-ups` : "/v1/runs",
        "POST",
        last
          ? { prompt: text, attachmentIds: attachments.ids }
          : {
              prompt: text,
              attachmentIds: attachments.ids,
              useUserDefaults: true,
              ...(networkChanged ? { networkPolicy } : {}),
              ...(approvalChanged ? { requireApproval } : {}),
              ...(expertId ? { expertId } : {}),
              ...(skillIds.length ? { skillIds } : {}),
              ...(projectId ? { projectId } : {}),
            },
        sendKey.current.key,
      );
      const run = await request("/v1/runs/" + result.id);
      attachments.clear();
      setSelected(run.conversation_id);
      setPrompt("");
      setLive("");
      setLiveMessages([]);
      await refresh();
    });
  }
  if (authLoading)
    return (
      <div className="cw-auth">
        <p role="status">正在连接工作台…</p>
      </div>
    );
  if (!me)
    return (
      <div className={`cw-auth ${embedded ? "cw-embedded-auth" : ""}`}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              setAuthFeedback("");
              if (loginMode === "register") {
                const result = await request("/auth/web/register", "POST", {
                  username,
                  password,
                  name: displayName,
                  reason,
                });
                setPassword("");
                setAuthFeedback(
                  result.message || "申请已提交，管理员审核通过后即可登录。",
                );
                setLoginMode("login");
                return;
              }
              await request(
                "/auth/web/login",
                "POST",
                loginMode === "token"
                  ? { token: credential }
                  : { username, password },
              );
              setPassword("");
              setCredential("");
              const account = await request("/v1/me");
              clearAccount(false);
              setMe(account);
            });
          }}
        >
          <span className="cw-mark">P</span>
          <h1>{loginMode === "register" ? "申请加入工作台" : "登录工作台"}</h1>
          <p>使用你的账号继续项目，或申请加入团队。</p>
          <div className="cw-tabs">
            <button
              type="button"
              aria-pressed={loginMode === "login"}
              onClick={() => setLoginMode("login")}
            >
              账号登录
            </button>
            <button
              type="button"
              aria-pressed={loginMode === "register"}
              onClick={() => setLoginMode("register")}
            >
              申请账号
            </button>
          </div>
          {loginMode !== "token" ? (
            <>
              <label>
                用户名
                <input
                  required
                  autoComplete="username"
                  pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}"
                  minLength={3}
                  maxLength={32}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="3–32 位字母、数字或 ._-"
                />
              </label>
              <label>
                密码
                <input
                  required
                  type="password"
                  autoComplete={
                    loginMode === "register"
                      ? "new-password"
                      : "current-password"
                  }
                  minLength={loginMode === "register" ? 10 : 1}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    loginMode === "register" ? "至少 10 位" : "请输入密码"
                  }
                />
              </label>
              {loginMode === "register" && (
                <>
                  <label>
                    显示名称
                    <input
                      required
                      maxLength={80}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </label>
                  <label>
                    申请说明（选填）
                    <textarea
                      maxLength={500}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <p>提交后由管理员审核，审核通过后使用账号密码登录。</p>
                </>
              )}
            </>
          ) : (
            <label>
              访问令牌
              <input
                required
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
              />
            </label>
          )}
          <button className="cw-primary" disabled={busy}>
            {busy
              ? "正在提交…"
              : loginMode === "register"
                ? "提交申请"
                : "登录"}
          </button>
          {authFeedback && <p role="status">{authFeedback}</p>}
          {error && <p role="alert">{error}</p>}
          <details className="cw-auth-advanced">
            <summary>高级连接</summary>
            <button type="button" onClick={() => setLoginMode("token")}>
              使用访问令牌
            </button>
          </details>
          {onBack && (
            <button type="button" onClick={onBack}>
              返回
            </button>
          )}
        </form>
      </div>
    );
  return (
    <div className={`cw-shell ${embedded ? "cw-embedded" : ""}`}>
      {mobile && (
        <button
          className="cw-drawer-scrim"
          aria-label="关闭项目与任务"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        ref={contextDialog}
        aria-label="项目与任务"
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile || undefined}
        className={`cw-sidebar ${mobile ? "is-open" : ""}`}
      >
        <header>
          <strong>项目与任务</strong>
          <button
            className="cw-context-close"
            aria-label="关闭项目面板"
            onClick={() => setMobile(false)}
          >
            <X size={18} />
          </button>
        </header>
        <button
          className="cw-primary"
          disabled={busy}
          onClick={() => {
            setSelected("");
            setPrompt("");
            setMobile(false);
          }}
        >
          <Plus size={17} />
          {projectBranch === "collaborative" ? "新建协同任务" : "新任务"}
        </button>
        {!embedded && (
          <div className="cw-tabs" aria-label="项目分类">
            <button
              aria-pressed={projectBranch === "personal"}
              onClick={() => {
                setProjectBranch("personal");
                setProjectId("");
                setSelected("");
              }}
            >
              普通项目
            </button>
            <button
              aria-pressed={projectBranch === "collaborative"}
              onClick={() => {
                setProjectBranch("collaborative");
                setProjectId("");
                setSelected("");
              }}
            >
              项目协同
            </button>
          </div>
        )}
        <div className="cw-side-caption">
          {projectBranch === "collaborative" ? "协同项目" : "我的项目"}
        </div>
        <div className="cw-project-tree" aria-label="项目列表">
          {projectBranch === "personal" && (
            <button
              aria-current={!projectId}
              disabled={busy}
              onClick={() => {
                setProjectId("");
                setSelected("");
              }}
            >
              <MessageSquare size={16} />
              <span>独立对话</span>
            </button>
          )}
          {projects
            .filter((p) => p.kind === projectBranch)
            .map((p) => (
              <button
                key={p.id}
                aria-current={projectId === p.id}
                disabled={busy}
                onClick={() => {
                  setProjectId(p.id);
                  setSelected("");
                }}
              >
                <FolderKanban size={16} />
                <span>{p.name}</span>
              </button>
            ))}
          {!projects.some((p) => p.kind === projectBranch) && (
            <p>还没有项目，创建一个整理任务与文件。</p>
          )}
        </div>
        <button
          className="cw-link"
          onClick={() => {
            setMembersOpen(true);
            setMobile(false);
          }}
        >
          <Users size={16} />
          {projectBranch === "personal" ? "新建项目" : "协作成员与项目"}
        </button>
        {projectId && (
          <button
            className="cw-link"
            onClick={() => {
              setTab("workspace");
              setResource(true);
              setMobile(false);
            }}
          >
            <FileText size={16} />
            {project?.workspace_name || "项目工作区"}
          </button>
        )}
        <div className="cw-side-caption">最近会话</div>
        <nav>
          {conversations
            .filter(
              (c) =>
                (c.project_id || "") === projectId &&
                (projectBranch !== "collaborative" || !!projectId),
            )
            .map((c) => (
              <button
                key={c.id}
                className={selected === c.id ? "selected" : ""}
                disabled={busy}
                onClick={() => choose(c)}
              >
                <MessageSquare size={15} />
                <span>{c.title}</span>
              </button>
            ))}
          {!conversations.some(
            (c) =>
              (c.project_id || "") === projectId &&
              (projectBranch !== "collaborative" || !!projectId),
          ) && <p>这里还没有会话。</p>}
        </nav>
        <footer>
          <span>{me.name || "我的账号"}</span>
          {onBack ? (
            <button onClick={onBack}>本机工作台</button>
          ) : (
            <button
              aria-label="退出登录"
              onClick={() =>
                void act(async () => {
                  await request("/auth/web/logout", "POST");
                  clearAccount();
                  setMe(null);
                })
              }
            >
              <LogOut size={16} />
            </button>
          )}
        </footer>
      </aside>
      <main className={`cw-main ${!selected ? "is-empty" : ""}`}>
        <header className={`cw-topbar ${!selected ? "is-home" : ""}`}>
          {onOpenNavigation && (
            <button
              className="mobile-only icon-button"
              data-navigation-trigger
              aria-label="打开导航"
              onClick={onOpenNavigation}
            >
              <Menu size={18} />
            </button>
          )}
          <button
            className="cw-context-trigger"
            aria-label="选择项目"
            onClick={() => setMobile(true)}
          >
            {embedded ? (
              <>
                <FolderKanban size={18} />
                <span className="cw-mobile-project-label">项目</span>
              </>
            ) : (
              <Menu size={20} />
            )}
          </button>
            <div>
            {(project?.name || projectId) && (
              <span>
                {project?.name ||
                  (projectBranch === "collaborative" ? "项目协同" : "项目")}
              </span>
            )}
            <h1>{current?.conversation.title || "新任务"}</h1>
          </div>
          {last && (
            <>
              <span className="cw-state">
                {active && approvals.some((a) => a.state === "pending")
                  ? "等待审批"
                  : labels[last.state]}
              </span>
              <button
                aria-label="成果与过程"
                onClick={() => setResource(!resource)}
              >
                <FileText size={18} />
              </button>
            </>
          )}
        </header>
        {error && (
          <div className="cw-notice error" role="alert">
            {error}
            <button aria-label="关闭错误提示" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {connection && (
          <div className="cw-notice" role="status">
            {connection}
          </div>
        )}
        <div
          className="cw-conversation"
          aria-label="会话内容"
          ref={scrollArea}
          onScroll={() => {
            const n = scrollArea.current;
            if (n)
              followBottom.current =
                n.scrollHeight - n.scrollTop - n.clientHeight < 100;
          }}
        >
          {loading && <p role="status">正在读取会话…</p>}
          {!selected && (
            <div className="jd-home">
              <h1>Pig Agent</h1>
              <p>交代一个任务，在云端沙箱里做完，你来批准和核对。</p>
              {project && (
                <>
                  <h2>{project.name}</h2>
                  <p className="jd-project-note">
                    {project.kind === "collaborative"
                      ? `${project.space_name || "协作项目"} · 成员可见`
                      : project.description || "仅自己可见"}
                  </p>
                  <div className="cw-project-summary">
                    <button
                      type="button"
                      onClick={() => {
                        setTab("workspace");
                        setResource(true);
                      }}
                    >
                      <FolderKanban size={22} />
                      <strong>{project.workspace_name || "项目工作区"}</strong>
                      <span>查看导入的文件和每次任务保存的工作区版本</span>
                    </button>
                    {project.kind === "collaborative" && (
                      <button type="button" onClick={() => setMembersOpen(true)}>
                        <Users size={22} />
                        <strong>协作成员与权限</strong>
                        <span>管理共享范围，与成员一起推进任务</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          {current?.messages
            .filter(
              (m) =>
                (m.role === "user" || m.role === "assistant") &&
                m.content.trim() &&
                !approvalPlaceholder(m),
            )
            .map((m) => (
              <article key={m.id} className={`cw-message ${m.role}`}>
                <small>
                  {m.role === "user" ? m.author?.name || "成员" : "Pig Agent"}
                </small>
                <MarkdownView text={m.content} />
                {m.role === "user" &&
                  current?.runs
                    .find((r) => m.id === `prompt:${r.id}`)
                    ?.attachments?.map((file) => (
                      <a
                        className="message-input-file"
                        key={file.id}
                        href={apiBase + `/v1/attachments/${file.id}/download`}
                        download
                      >
                        <FileText size={14} />
                        {file.name}
                        <small>
                          输入文件 · {Math.ceil(file.size / 1024)} KB
                        </small>
                      </a>
                    ))}
              </article>
            ))}
          {liveMessages
            .filter(
              (m) =>
                m.content.trim() &&
                !approvalPlaceholder(m) &&
                !current?.messages.some((saved) => saved.id === m.id),
            )
            .map((m) => (
              <article key={m.id} className="cw-message assistant">
                <small>Pig Agent</small>
                <MarkdownView text={m.content} />
              </article>
            ))}
          {live && (
            <article className="cw-message assistant" aria-busy="true">
              <small>Pig Agent · 正在生成</small>
              <MarkdownView text={live} />
            </article>
          )}
          {approvals
            .filter((a) => a.state === "pending" && active)
            .slice(0, 1)
            .map((a) => (
              <section key={a.id} className="cw-approval">
                <h3>
                  {a.tool === "http_fetch" ? "请求访问网络" : "需要批准操作"}
                </h3>
                <ApprovalPreview tool={a.tool} args={a.args}/>
                <p>
                  {a.tool === "http_fetch"
                    ? "仅授权此次 HTTPS GET 请求，不开放沙箱公网。"
                    : "批准后将在远端执行；不会写入本机目录。"}
                </p>
                {canWrite ? (
                  <div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request(
                            `/v1/runs/${last!.id}/approvals/${a.id}/decision`,
                            "POST",
                            { decision: "reject" },
                          );
                          setApprovals((v) => v.filter((x) => x.id !== a.id));
                        })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="cw-primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request(
                            `/v1/runs/${last!.id}/approvals/${a.id}/decision`,
                            "POST",
                            { decision: "approve" },
                          );
                          setApprovals((v) => v.filter((x) => x.id !== a.id));
                        })
                      }
                    >
                      批准操作
                    </button>
                  </div>
                ) : (
                  <p>需要项目编辑者批准。</p>
                )}
              </section>
            ))}
          {last?.error && (
            <p role="alert" className="cw-notice error">
              {last.error}
            </p>
          )}
          {active && !live && !pendingApproval && (
            <p role="status" className="cw-progress">
              {approvals.some((a) => a.state === "pending")
                ? "等待操作审批"
                : labels[last!.state]}
              …
            </p>
          )}
          {!!artifacts.length && !active && (
            <button
              className="cw-result"
              onClick={() => {
                setResource(true);
                setTab("files");
              }}
            >
              <FileText size={20} />
              <span>
                {artifacts.length} 项成果已就绪<small>预览或下载远端文件</small>
              </span>
              查看成果 →
            </button>
          )}
        </div>
        {(canWrite || selected) && (
          <div className="jd-compose-stack">
          <form
            className="cw-composer"
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (canWrite && !active) attachments.add(e.dataTransfer.files);
            }}
            onPaste={(e) => {
              if (canWrite && !active && e.clipboardData.files.length) {
                e.preventDefault();
                attachments.add(e.clipboardData.files);
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <MessageAttachments
              value={attachments}
              disabled={!canWrite || active}
            />
            <textarea
              ref={promptInput}
              aria-label="任务消息"
              placeholder={
                canWrite
                  ? selected
                    ? "继续这个任务…"
                    : "从一个问题开始"
                  : !projectId && projectBranch === "collaborative"
                    ? "先选择或创建协同项目"
                    : selected && !current
                      ? "正在读取会话权限…"
                      : "当前项目为只读权限"
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!canWrite}
              maxLength={32000}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="cw-composer-controls" ref={composerControls}>
              {!selected && canWrite && !apiBase && (
                <details
                  className="cw-task-method"
                  onToggle={closeOtherCapsules}
                  onKeyDown={closeCapsuleOnEscape}
                >
                  <summary>
                    <Users size={14} />
                    技能
                    {skillIds.length ? ` · ${skillIds.length} 个技能` : ""}
                    <ChevronDown size={13} />
                  </summary>
                  <div className="cw-capsule-popover">
                    <label>
                      专家
                      <select
                        aria-label="任务专家"
                        value={expertId}
                        onChange={(e) => setExpertId(e.target.value)}
                      >
                        <option value="">通用助手</option>
                        {experts.map((e) => (
                          <option value={e.id} key={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {skills.length > 0 ? (
                      <fieldset>
                        <legend>技能</legend>
                        {skills.map((s) => (
                          <label key={s.id}>
                            <input
                              type="checkbox"
                              checked={skillIds.includes(s.id)}
                              onChange={(e) =>
                                setSkillIds(
                                  e.target.checked
                                    ? [...skillIds, s.id]
                                    : skillIds.filter((id) => id !== s.id),
                                )
                              }
                            />
                            {s.name}
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      <p>还没有可选技能。</p>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        location.hash = "#/experts/skills";
                      }}
                    >
                      管理技能
                    </button>
                  </div>
                </details>
              )}
              {!selected && canWrite && (
                <details
                  className="cw-execution-options"
                  onToggle={closeOtherCapsules}
                  onKeyDown={closeCapsuleOnEscape}
                >
                  <summary>
                    <ShieldCheck size={14} />
                    默认权限
                    <ChevronDown size={13} />
                  </summary>
                  <div className="cw-capsule-popover">
                    <div className="cw-options-grid">
                      <label>
                        操作审批
                        <select
                          aria-label="操作审批"
                          value={requireApproval ? "ask" : "auto"}
                          onChange={(e) => {
                            setApprovalChanged(true);
                            setRequireApproval(e.target.value === "ask");
                          }}
                        >
                          <option value="ask">写入与命令需审批</option>
                          <option value="auto">沙箱内自动执行</option>
                        </select>
                      </label>
                      <label>
                        网络访问
                        {!selected && canWrite && (
                          <select
                            aria-label="网络访问策略"
                            title="逐次审批仅支持单次 HTTPS GET；不开放沙箱直接联网，也不支持命令联网或安装依赖"
                            value={networkPolicy}
                            onChange={(e) => {
                              setNetworkChanged(true);
                              setNetworkPolicy(
                                e.target.value as "ask" | "blocked",
                              );
                            }}
                          >
                            <option value="ask">HTTPS 逐次审批</option>
                            <option value="blocked">禁止联网</option>
                          </select>
                        )}
                      </label>
                    </div>
                    <p>
                      任务在原生沙箱内执行。网络请求单次授权，与文件和命令审批独立。
                    </p>
                  </div>
                </details>
              )}
              <footer>
                {project?.kind === "collaborative" && <small>团队共享</small>}
                {active && canWrite ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await request(`/v1/runs/${last!.id}/abort`, "POST");
                      })
                    }
                  >
                    停止任务
                  </button>
                ) : (
                  <button
                    className="cw-primary"
                    aria-label="发送消息"
                    disabled={
                      busy || !prompt.trim() || !canWrite || attachments.blocked
                    }
                  >
                    <Send size={17} />
                    {busy ? "发送中" : "发送"}
                  </button>
                )}
              </footer>
            </div>
          </form>
          {!selected && canWrite && (
            <>
              <div className="jd-picks">
                <label>
                  选择项目
                  <select
                    aria-label="选择项目"
                    value={projectId}
                    onChange={(e) => {
                      setProjectId(e.target.value);
                      setSelected("");
                    }}
                  >
                    <option value="">不归入项目</option>
                    {projects.filter((item) => item.kind === "personal").length >
                      0 && (
                      <optgroup label="我的项目">
                        {projects
                          .filter((item) => item.kind === "personal")
                          .map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                    {projects.filter((item) => item.kind === "collaborative")
                      .length > 0 && (
                      <optgroup label="协作项目">
                        {projects
                          .filter((item) => item.kind === "collaborative")
                          .map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                {!apiBase && (
                  <label>
                    选择专家
                    <select
                      aria-label="选择专家"
                      value={expertId}
                      onChange={(e) => setExpertId(e.target.value)}
                    >
                      <option value="">通用助手</option>
                      {experts.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="jd-starters">
                {[
                  {
                    title: "联网查资料",
                    detail: "查公开页面，整理成结论",
                    prompt: "帮我查公开资料，并整理成简短结论。主题：",
                    icon: Search,
                    network: true,
                  },
                  {
                    title: "处理项目文件",
                    detail: "阅读工作区文件并修改",
                    prompt: "先查看当前项目里的文件，再按这个目标修改：",
                    icon: FolderKanban,
                  },
                  {
                    title: "写一份文档",
                    detail: "说明、纪要或长文",
                    prompt: "帮我写一份文档。要求：",
                    icon: PenLine,
                  },
                  {
                    title: "先计划再改动",
                    detail: "改文件或执行命令前等我批准",
                    prompt:
                      "先给出计划。需要改文件或执行命令时停下来等我批准。目标：",
                    icon: ShieldCheck,
                    approval: true,
                  },
                ].map((item) => (
                  <button
                    type="button"
                    key={item.title}
                    onClick={() => {
                      if (item.network) {
                        setNetworkPolicy("ask");
                        setNetworkChanged(true);
                      }
                      if (item.approval) {
                        setRequireApproval(true);
                        setApprovalChanged(true);
                      }
                      setPrompt(item.prompt);
                      promptInput.current?.focus();
                    }}
                  >
                    <item.icon size={16} />
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          </div>
        )}
      </main>
      {resource && (last || projectId) && (
        <>
          <button
            className="cw-drawer-scrim cw-resource-scrim"
            aria-label="关闭成果抽屉"
            onClick={() => setResource(false)}
          />
          <aside
            ref={resourceDialog}
            className="cw-resources"
            role="dialog"
            aria-modal="true"
            aria-label="成果与过程"
          >
            <header>
              <h2>成果与过程</h2>
              <button aria-label="关闭成果" onClick={() => setResource(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="cw-tabs">
              {projectId && (
                <button
                  aria-pressed={tab === "workspace"}
                  onClick={() => setTab("workspace")}
                >
                  项目工作区
                </button>
              )}
              <button
                disabled={!last}
                aria-pressed={tab === "files"}
                onClick={() => setTab("files")}
              >
                成果 {artifacts.length}
              </button>
              <button
                disabled={!last}
                aria-pressed={tab === "logs"}
                onClick={() => setTab("logs")}
              >
                执行步骤
              </button>
            </div>
            <div className="cw-resource-body">
              {selected && (
                <details>
                  <summary>分享会话</summary>
                  <p>项目成员登录后可打开此链接。</p>
                  <input
                    aria-label="会话链接"
                    readOnly
                    value={
                      webBaseUrl
                        ? webBaseUrl.replace(/\/$/, "") +
                          "/#/conversations/" +
                          selected
                        : window.location.href
                    }
                  />
                </details>
              )}
              {tab === "workspace" ? (
                <section>
                  <h3>{workspace?.workspaceName || "工作区"}</h3>
                  <p>
                    每个会话保留独立的远端文件版本；续聊沿用该会话的工作区。
                  </p>
                  {workspaceLoading && (
                    <p role="status">正在读取项目文件版本…</p>
                  )}
                  {Boolean(workspace?.seed?.fileCount) && (
                    <details className="cw-workspace-seed" open>
                      <summary>
                        初始文件 · {workspace!.seed!.fileCount} 个文件
                      </summary>
                      <p>
                        新会话以这些文件作为起点，后续修改保存在各自会话版本中。
                      </p>
                      <ul>
                        {workspace!.seed!.files.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {workspace?.conversations.map((c) => (
                    <details key={c.id}>
                      <summary>
                        {c.title} · {c.versions.length} 个版本
                      </summary>
                      {c.versions.map((v) => (
                        <div key={v.run_id} className="cw-workspace-version">
                          <small>
                            {new Date(v.created_at).toLocaleString()}
                          </small>
                          <ul>
                            {v.manifest.files?.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                          <a
                            href={
                              apiBase +
                              `/v1/conversations/${c.id}/workspace/${v.run_id}`
                            }
                            download
                          >
                            下载工作区版本
                          </a>
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          choose({
                            id: c.id,
                            title: c.title,
                            project_id: projectId,
                          });
                          setResource(false);
                        }}
                      >
                        打开会话
                      </button>
                    </details>
                  ))}
                  {!workspaceLoading && !workspace?.conversations.length && (
                    <p>工作区已创建。完成项目任务后，文件版本会显示在这里。</p>
                  )}
                </section>
              ) : tab === "logs" ? (
                <ExecutionJournal events={events} />
              ) : (
                <>
                  {current?.runs.some((r) => r.attachments?.length) && (
                    <section className="input-file-section">
                      <h3>输入文件</h3>
                      {current.runs
                        .flatMap((r) => r.attachments || [])
                        .map((file) => (
                          <a
                            className="message-input-file"
                            key={file.id}
                            href={
                              apiBase + `/v1/attachments/${file.id}/download`
                            }
                            download
                          >
                            <FileText size={15} />
                            {file.name}
                          </a>
                        ))}
                    </section>
                  )}
                  <h3>任务成果</h3>
                  {!artifacts.length && <p>本轮尚无已保存成果。</p>}
                  {artifacts.map((file) => (
                    <div className="cw-file" key={file.id}>
                      <button
                        onClick={() =>
                          void act(async () => {
                            const identity = selected;
                            const response = await fetch(
                              apiBase +
                                `/v1/runs/${last!.id}/artifacts/${file.id}`,
                            );
                            if (!response.ok) throw Error("读取文件失败");
                            const text = await response.text();
                            if (
                              selectedRef.current === identity &&
                              currentRunRef.current === last!.id
                            )
                              setPreview({ path: file.path, text });
                          })
                        }
                      >
                        {file.path}
                      </button>
                      <a
                        href={
                          apiBase + `/v1/runs/${last!.id}/artifacts/${file.id}`
                        }
                        download
                      >
                        下载
                      </a>
                    </div>
                  ))}
                  {preview && (
                    <section>
                      <h3>{preview.path}</h3>
                      <p>远端保存版本</p>
                      <pre>{preview.text}</pre>
                    </section>
                  )}
                </>
              )}
            </div>
          </aside>
        </>
      )}
      {membersOpen && projectBranch === "choose" && (
        <div className="cw-modal-backdrop">
          <section
            className="cw-space-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="新建项目"
          >
            <header>
              <h2>新建项目</h2>
              <button
                type="button"
                aria-label="关闭新建项目"
                onClick={() => setMembersOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <p>选择谁可以看见这个项目里的对话和文件。</p>
            <div className="jd-visibility">
              <button type="button" onClick={() => setProjectBranch("personal")}>
                <strong>仅自己</strong>
                <span>对话和文件只在你的账号里。</span>
              </button>
              <button
                type="button"
                onClick={() => setProjectBranch("collaborative")}
              >
                <strong>与成员共享</strong>
                <span>组织成员可以查看，编辑者可以继续任务。</span>
              </button>
            </div>
          </section>
        </div>
      )}
      {membersOpen && projectBranch === "personal" && (
        <PersonalProjectDialog
          busy={busy}
          error={error}
          act={act}
          request={request}
          onClose={() => setMembersOpen(false)}
          onCreated={async (id) => {
            await refresh();
            setProjectId(id);
            setSelected("");
            setMembersOpen(false);
          }}
        />
      )}
      {membersOpen && projectBranch === "collaborative" && (
        <SpacesDialog
          spaces={spaces}
          error={error}
          projectId={projectId}
          request={request}
          busy={busy}
          act={act}
          refresh={refresh}
          onProject={(id) => {
            setProjectId(id);
            setSelected("");
            setMembersOpen(false);
          }}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </div>
  );
}
function SpacesDialog({
  spaces,
  error,
  request,
  busy,
  act,
  refresh,
  onProject,
  onClose,
}: {
  spaces: CloudSpace[];
  error: string;
  projectId: string;
  request: (path: string, method?: string, body?: unknown) => Promise<any>;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  onProject: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(""),
    [join, setJoin] = useState(""),
    [spaceId, setSpaceId] = useState(spaces[0]?.id || ""),
    [projectName, setProjectName] = useState(""),
    [background, setBackground] = useState(""),
    [membersError, setMembersError] = useState(""),
    [invite, setInvite] = useState(""),
    [role, setRole] = useState("viewer"),
    [members, setMembers] = useState<
      { id: string; name: string; role: string }[]
    >([]);
  const space = spaces.find((s) => s.id === spaceId);
  useEffect(() => {
    let valid = true;
    setInvite("");
    setMembers([]);
    setMembersError("");
    if (spaceId)
      void request(`/v1/spaces/${spaceId}/members`)
        .then((d) => {
          if (valid) setMembers(d.members);
        })
        .catch((e) => {
          if (valid) setMembersError(e.message);
        });
    return () => {
      valid = false;
    };
  }, [spaceId]);
  return (
    <div className="cw-modal-backdrop">
      <section
        className="cw-space-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="项目协同"
      >
        <header>
          <h2>项目协同</h2>
          <button aria-label="关闭空间管理" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p>组织成员在共享项目里查看会话与成果，编辑者可继续任务。</p>
        {(error || membersError) && (
          <p role="alert" className="cw-notice error">
            {error || membersError}
          </p>
        )}
        <label>
          当前组织
          <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
            <option value="">选择组织</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {space && (
          <>
            <ul>
              {members.map((m) => (
                <li key={m.id}>
                  {m.name}
                  <span>
                    {m.role === "viewer"
                      ? "只读"
                      : m.role === "admin"
                        ? "管理员"
                        : "编辑者"}
                  </span>
                </li>
              ))}
            </ul>
            {space.role !== "viewer" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const d = await request("/v1/shared-projects", "POST", {
                      spaceId,
                      name: projectName,
                      description: background,
                    });
                    await refresh();
                    onProject(d.id);
                  });
                }}
              >
                <label>
                  新项目名称
                  <input
                    required
                    maxLength={100}
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                </label>
                <label>
                  共享背景
                  <textarea
                    aria-label="共享背景"
                    value={background}
                    maxLength={4000}
                    onChange={(e) => setBackground(e.target.value)}
                    placeholder="团队目标、术语和任务共用的背景"
                  />
                </label>
                <button disabled={busy || !projectName.trim()}>
                  创建共享项目
                </button>
              </form>
            )}
            {space.role === "admin" && (
              <details>
                <summary>邀请已有账号加入组织</summary>
                <label>
                  成员权限
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="viewer">只读</option>
                    <option value="editor">编辑者</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const d = await request(
                        `/v1/spaces/${spaceId}/invitations`,
                        "POST",
                        { role },
                      );
                      setInvite(d.invite);
                    })
                  }
                >
                  生成一次性邀请码
                </button>
                {invite && (
                  <label>
                    24 小时有效
                    <input readOnly value={invite} />
                  </label>
                )}
              </details>
            )}
          </>
        )}
        <details>
          <summary>创建组织</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const d = await request("/v1/spaces", "POST", { name });
                await refresh();
                setSpaceId(d.id);
                setName("");
              });
            }}
          >
            <label>
              组织名称
              <input
                required
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button disabled={busy || !name.trim()}>创建组织</button>
          </form>
        </details>
        <details>
          <summary>使用组织邀请码加入</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const d = await request("/v1/spaces/join", "POST", {
                  invite: join,
                });
                await refresh();
                setSpaceId(d.id);
                setJoin("");
              });
            }}
          >
            <label>
              组织邀请码
              <input
                required
                type="password"
                value={join}
                onChange={(e) => setJoin(e.target.value)}
              />
            </label>
            <button disabled={busy || !join.trim()}>加入组织</button>
          </form>
        </details>
      </section>
    </div>
  );
}
function closeOtherCapsules(event: SyntheticEvent<HTMLDetailsElement>) {
  const current = event.currentTarget;
  if (current.open)
    current.parentElement
      ?.querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((other) => {
        if (other !== current) other.open = false;
      });
}
function closeCapsuleOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.currentTarget.open = false;
  event.currentTarget.querySelector("summary")?.focus();
}

function PersonalProjectDialog({
  busy,
  error,
  act,
  request,
  onCreated,
  onClose,
}: {
  busy: boolean;
  error: string;
  act: (fn: () => Promise<void>) => Promise<void>;
  request: (path: string, method?: string, body?: unknown) => Promise<any>;
  onCreated: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [workspaceName, setWorkspaceName] = useState("工作区");
  const folderInput = useRef<HTMLInputElement>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<
    Array<{ path: string; content: string }>
  >([]);
  const [folderName, setFolderName] = useState("");
  const [folderStatus, setFolderStatus] = useState("");
  const [readingFolder, setReadingFolder] = useState(false);
  const [folderError, setFolderError] = useState("");
  async function selectFolder(files: FileList | null) {
    if (!files?.length) return;
    setReadingFolder(true);
    setFolderError("");
    setWorkspaceFiles([]);
    setFolderName("");
    setFolderStatus("");
    try {
      const rows: Array<{ path: string; content: string }> = [];
      let bytes = 0,
        skipped = 0;
      const name = files[0]!.webkitRelativePath.split("/")[0] || "所选文件夹";
      for (const file of Array.from(files)) {
        const parts = file.webkitRelativePath.split("/").slice(1);
        const path = parts.join("/");
        if (
          !path ||
          parts.some((p) =>
            /^(?:\.git|node_modules|\.env.*|\.ssh|\.aws|\.azure|\.gcloud|\.venv|venv|\.npmrc|\.pypirc|\.netrc|\.DS_Store|dist|build)$/i.test(
              p,
            ),
          ) ||
          /\.(?:pem|key|p12|pfx|keystore|png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mp3|exe|dmg)$/i.test(
            path,
          ) ||
          /(?:^|\/)(?:id_rsa|id_dsa|id_ed25519|credentials|secrets?)(?:\.|$)/i.test(
            path,
          )
        ) {
          skipped++;
          continue;
        }
        if (file.size > 200000)
          throw new Error(`文件 ${path} 超过200KB，请选择更小的文本工作区。`);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          );
        } catch {
          skipped++;
          continue;
        }
        if (content.includes("\0")) {
          skipped++;
          continue;
        }
        bytes += new TextEncoder().encode(content).length;
        if (rows.length >= 400 || bytes > 2000000)
          throw new Error("文件夹超过400个文本文件或2MB，请选择较小的子目录。");
        rows.push({ path, content });
      }
      if (!rows.length)
        throw new Error("未找到可导入的文本文件，请选择代码或文档目录。");
      setFolderName(name);
      setWorkspaceName(name);
      setName((current) => current || name);
      setWorkspaceFiles(rows);
      setFolderStatus(
        `${rows.length} 个文本文件 · ${bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`}${skipped ? ` · 已跳过 ${skipped} 个依赖、敏感或非文本文件` : ""}`,
      );
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    } finally {
      setReadingFolder(false);
      if (folderInput.current) folderInput.current.value = "";
    }
  }
  return (
    <div className="cw-modal-backdrop">
      <section
        className="cw-space-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新建普通项目"
      >
        <header>
          <h2>新建普通项目</h2>
          <button aria-label="关闭新建项目" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <p>整理相关任务和背景，在项目工作区查看每次任务保存的文件。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const result = await request("/v1/projects", "POST", {
                name,
                description,
                workspaceName,
                workspaceFiles,
              });
              await onCreated(result.id);
            });
          }}
        >
          <label>
            项目名称
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            项目背景
            <textarea
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="cw-folder-choice">
            <strong>工作区文件夹</strong>
            <input
              ref={folderInput}
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              hidden
              aria-label="选择工作区文件夹"
              onChange={(e) => void selectFolder(e.target.files)}
            />
            <button
              type="button"
              disabled={busy || readingFolder}
              onClick={() => folderInput.current?.click()}
            >
              <FolderKanban size={16} />
              {readingFolder ? "正在读取文件…" : folderName || "选择本地文件夹"}
            </button>
            <p>
              将代码或文档上传为云端工作区副本，任务在云端运行，不会直接修改本地目录。需要持续读写本地文件，请在客户端绑定目录。
            </p>
            {folderStatus && <p role="status">{folderStatus}</p>}
            {(folderName || folderError) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setWorkspaceFiles([]);
                  setFolderName("");
                  setFolderStatus("");
                  setFolderError("");
                }}
              >
                使用空白工作区
              </button>
            )}
            {folderError && (
              <p role="alert" className="cw-notice error">
                {folderError}
              </p>
            )}
          </div>
          <label>
            工作区名称
            <input
              required
              maxLength={100}
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
            />
          </label>
          <button
            className="cw-primary"
            disabled={
              busy ||
              readingFolder ||
              !!folderError ||
              !name.trim() ||
              !workspaceName.trim()
            }
          >
            {busy ? "创建中…" : "创建项目"}
          </button>
          {error && (
            <p role="alert" className="cw-notice error">
              {error}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
