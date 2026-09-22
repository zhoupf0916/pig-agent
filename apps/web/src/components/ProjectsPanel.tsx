import "../pages.css";
import { useDialog } from "../lib/use-dialog";
import { Download, FolderKanban, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, isImage, isTextLike } from "../lib/format";
import {
  applyOpenAssetPreviewSnapshot,
  applyProjectDetailSnapshot,
  applyProjectsListSnapshot,
  nextOpenProjectId,
  shouldClearOpenTodoHighlight,
  shouldFetchProjectDetail,
  startProjectsSync,
} from "../lib/projects-sync";
import type {
  Project,
  ProjectAsset,
  ProjectSummary,
  Session,
  SessionSummary,
  TodoStatus,
} from "../types";
import { AssetPreviewModal } from "./AssetPreviewModal";
import { HandoffDialog } from "./HandoffDialog";
import { ProjectWorkspaces } from "./ProjectWorkspaces";

const TODO_COLS: { status: TodoStatus; label: string }[] = [
  { status: "todo", label: "待办" },
  { status: "doing", label: "进行中" },
  { status: "done", label: "已完成" },
];

export function ProjectsPanel({
  selectedId,
  refreshTick = 0,
  highlightAssetId,
  highlightTodoId,
  sessions,
  onSelectProject,
  onOpenSession,
  onCreateSession,
}: {
  selectedId?: string;
  refreshTick?: number;
  highlightAssetId?: string;
  highlightTodoId?: string;
  sessions: SessionSummary[];
  onSelectProject: (
    id?: string,
    extra?: { assetId?: string; todoId?: string },
  ) => void;
  onOpenSession: (id: string) => void;
  onCreateSession: (projectId: string, workspaceId?: string) => void;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  const catalogDialog = useDialog(catalogOpen, () => setCatalogOpen(false));
  useEffect(() => {
    if (selectedId) setCatalogOpen(false);
  }, [selectedId]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [detail, setDetail] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [draftProjectId, setDraftProjectId] = useState("");
  const draftIdentity = useRef("");
  const selectedIdentity = useRef(selectedId);
  selectedIdentity.current = selectedId;
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [initialWorkspace, setInitialWorkspace] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const createLock = useRef(false);
  const [todoTitle, setTodoTitle] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inviteName, setInviteName] = useState("");
  const [inviteNote, setInviteNote] = useState("");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [redeemToken, setRedeemToken] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<ProjectAsset | null>(null);
  const [handoffSession, setHandoffSession] = useState<Session | null>(null);
  const [handoffBusy, setHandoffBusy] = useState<string | null>(null);
  const highlightTodoIdRef = useRef(highlightTodoId);
  const highlightAssetIdRef = useRef(highlightAssetId);
  highlightTodoIdRef.current = highlightTodoId;
  highlightAssetIdRef.current = highlightAssetId;

  const refreshList = async () => {
    const { projects: next } = await api.projects();
    setProjects(next);
    return next;
  };

  const loadDetail = async (id: string) => {
    const project = await api.project(id);
    if (selectedIdentity.current !== id) return;
    setDetail(project);
    if (draftIdentity.current !== id) {
      draftIdentity.current = id;
      setDraftProjectId(id);
      setInstruction(project.instruction);
      setSelectedWorkspace(project.defaultWorkspaceId || "");
    }
  };

  useEffect(() => {
    setInviteToken(null);
    setRedeemToken("");
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await refreshList();
        if (!active) return;
        // AN-02 nail: list absence first — rewrite hash / open state, never GET :id
        if (selectedId && !shouldFetchProjectDetail(selectedId, list)) {
          const nextId = nextOpenProjectId(selectedId, list);
          onSelectProject(nextId ?? undefined);
          setDetail(null);
          return;
        }
        if (selectedId) await loadDetail(selectedId);
        else setDetail(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedId, refreshTick]);

  useEffect(() => {
    return startProjectsSync({
      fetchList: async () => {
        const { projects: next } = await api.projects();
        return next;
      },
      onList: (next) =>
        setProjects((prev) => applyProjectsListSnapshot(prev, next)),
      selectedId,
      fetchSelected: selectedId ? (id) => api.project(id) : undefined,
      onSelected: (next) => {
        setDetail((prev) => applyProjectDetailSnapshot(prev, next));
        setPreviewAsset((prev) => applyOpenAssetPreviewSnapshot(prev, next));
        // BF: AA detail snapshot is the source of truth for ?todo= — no GET of the deleted id.
        const openTodo = highlightTodoIdRef.current;
        if (shouldClearOpenTodoHighlight(selectedId, openTodo, next)) {
          onSelectProject(selectedId, { assetId: highlightAssetIdRef.current });
        }
      },
      onOpenId: (nextId) => {
        onSelectProject(nextId ?? undefined);
        setDetail(null);
      },
    });
  }, [selectedId]);

  useEffect(() => {
    if (!detail || !highlightAssetId) return;
    const asset = detail.assets.find((a) => a.id === highlightAssetId);
    if (asset) setPreviewAsset(asset);
  }, [detail, highlightAssetId]);

  useEffect(() => {
    if (!shouldClearOpenTodoHighlight(selectedId, highlightTodoId, detail))
      return;
    onSelectProject(selectedId, { assetId: highlightAssetId });
  }, [detail, highlightTodoId, highlightAssetId, selectedId]);

  const linked = useMemo(
    () => sessions.filter((s) => s.projectId === detail?.id),
    [sessions, detail?.id],
  );

  return (
    <section className="resource-page" aria-label="项目">
      <header className="resource-header">
        <div>
          <h2>项目</h2>
          <p>管理本机项目的任务与交付成果</p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setCatalogOpen(true)}
          aria-expanded={catalogOpen}
        >
          项目目录 <span>{projects.length}</span>
        </button>
      </header>
      {catalogOpen && (
        <button
          className="resource-scrim"
          aria-label="关闭项目目录"
          onClick={() => setCatalogOpen(false)}
        />
      )}
      <div
        ref={catalogDialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="项目目录"
        hidden={!catalogOpen}
        className="resource-catalog"
      >
        <div className="resource-catalog-heading">
          <h3>项目目录</h3>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => setCatalogOpen(false)}
          >
            关闭
          </button>
        </div>
        <input
          className="field resource-catalog-search"
          aria-label="搜索项目"
          placeholder="搜索项目"
          value={catalogQuery}
          onChange={(e) => setCatalogQuery(e.target.value)}
        />

        {catalogQuery &&
          !projects.some((row) =>
            row.name
              .toLocaleLowerCase()
              .includes(catalogQuery.toLocaleLowerCase()),
          ) && (
            <p role="status" className="resource-catalog-empty">
              没有匹配的项目
            </p>
          )}
        <div className="resource-catalog-intro">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
              项目
            </div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">
              项目与本地工作区
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="resource-error">
            {error}
          </p>
        )}
        <form
          className="resource-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || createLock.current) return;
            createLock.current = true;
            setCreatingProject(true);
            setError(null);
            void (async () => {
              const created = await api.createProject({
                name: name.trim(),
                workspaceRoot: initialWorkspace.trim() || undefined,
              });
              setName("");
              setInitialWorkspace("");
              await refreshList();
              onSelectProject(created.id);
            })()
              .catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              )
              .finally(() => {
                createLock.current = false;
                setCreatingProject(false);
              });
          }}
        >
          <input
            className="field"
            placeholder="新项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="text-xs text-ink-500">
            首个工作区（可选）
            <input
              className="field mt-2"
              value={initialWorkspace}
              onChange={(e) => setInitialWorkspace(e.target.value)}
              placeholder="本地目录绝对路径"
              disabled={creatingProject}
            />
          </label>
          {window.pigDesktop && (
            <button
              type="button"
              className="btn-ghost"
              disabled={creatingProject}
              onClick={async () => {
                try {
                  const path = await window.pigDesktop?.chooseWorkspace();
                  if (path) setInitialWorkspace(path);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              选择本地文件夹
            </button>
          )}
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={creatingProject || !name.trim()}
          >
            <Plus size={14} />
            {creatingProject ? "创建中…" : "新建项目"}
          </button>
        </form>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {projects.length === 0 && (
            <p className="px-2 pt-6 text-center text-xs text-ink-500">
              还没有项目。建一个空间，再把会话绑上去。
            </p>
          )}
          {projects
            .filter((row) =>
              row.name
                .toLocaleLowerCase()
                .includes(catalogQuery.toLocaleLowerCase()),
            )
            .map((p) => {
              const active = p.id === selectedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setCatalogOpen(false);
                    onSelectProject(p.id);
                  }}
                  className={`w-full rounded-card px-2.5 py-2 text-left ${
                    active
                      ? "bg-accent-soft text-ink-800"
                      : "text-ink-700 hover:bg-ink-200"
                  }`}
                >
                  <div className="truncate text-[13px] font-medium">
                    {p.name}
                  </div>
                  <div className="mt-0.5 text-meta text-ink-500">
                    {p.todoCount} 待办 · {p.assetCount} 资产 · {p.sessionCount}{" "}
                    会话
                  </div>
                </button>
              );
            })}
        </div>
      </div>

      <div className="resource-content">
        {error && (
          <p role="alert" className="resource-error">
            {error}
          </p>
        )}
        {selectedId && draftProjectId !== selectedId && (
          <p role="status" className="p-4 text-sm text-ink-500">
            正在读取项目…
          </p>
        )}
        {!detail && !selectedId && (
          <div className="desktop-library">
            <div className="desktop-library-toolbar">
              <h3>我的项目</h3>
              <input
                className="field"
                aria-label="筛选项目"
                placeholder="搜索项目"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
              />
              <button
                className="btn-primary"
                onClick={() => setCatalogOpen(true)}
              >
                <Plus size={16} />
                新建项目
              </button>
            </div>
            <div className="desktop-library-grid">
              {projects
                .filter((p) =>
                  p.name.toLowerCase().includes(catalogQuery.toLowerCase()),
                )
                .map((p) => (
                  <article key={p.id}>
                    <div className="desktop-library-avatar">
                      <FolderKanban size={23} />
                    </div>
                    <h3>{p.name}</h3>
                    <p>
                      {p.sessionCount} 个会话 · {p.assetCount} 个文件 ·{" "}
                      {p.todoCount} 项待办
                    </p>
                    <button
                      className="btn-quiet"
                      onClick={() => onSelectProject(p.id)}
                    >
                      打开项目 →
                    </button>
                  </article>
                ))}
            </div>
            {!projects.length && (
              <div className="desktop-library-empty">
                <FolderKanban size={30} />
                <h3>给任务一个工作空间</h3>
                <p>创建项目并关联本地目录，在同一个上下文中管理对话和成果。</p>
                <button
                  className="btn-primary"
                  onClick={() => setCatalogOpen(true)}
                >
                  创建第一个项目
                </button>
              </div>
            )}
          </div>
        )}
        {detail &&
          detail.id === selectedId &&
          draftProjectId === selectedId && (
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
              <button
                className="btn-quiet self-start"
                onClick={() => onSelectProject(undefined)}
              >
                ← 返回项目列表
              </button>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-medium text-ink-800">
                    {detail.name}
                  </h2>
                  <p className="mt-1 text-xs text-ink-500">
                    项目指令、待办、会话和成果集中管理
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-ghost text-danger hover:bg-danger-soft"
                  onClick={() => {
                    void (async () => {
                      await api.deleteProject(detail.id);
                      setDetail(null);
                      const list = await refreshList();
                      onSelectProject(list[0]?.id);
                    })();
                  }}
                >
                  <Trash2 size={13} />
                  删除
                </button>
              </div>

              <label className="block">
                <div className="mb-1 text-meta uppercase tracking-[0.16em] text-ink-500">
                  项目指令
                </div>
                <textarea
                  className="field min-h-[88px]"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onBlur={() => {
                    if (instruction !== detail.instruction) {
                      void api
                        .patchProject(detail.id, { instruction })
                        .then(() => loadDetail(detail.id));
                    }
                  }}
                  placeholder="团队共享的行为规则，例如：始终用中文，先列提纲再改文件。"
                />
              </label>

              <ProjectWorkspaces
                key={detail.id}
                project={detail}
                selected={selectedWorkspace}
                onSelect={setSelectedWorkspace}
                onCreateTask={() =>
                  onCreateSession(detail.id, selectedWorkspace || undefined)
                }
                onChange={(next) => {
                  setDetail(next);
                  setSelectedWorkspace((current) =>
                    next.workspaces?.some((w) => w.id === current)
                      ? current
                      : next.defaultWorkspaceId || "",
                  );
                  void refreshList();
                }}
              />

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
                    待办看板
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!todoTitle.trim()) return;
                      void api
                        .createTodo(detail.id, { title: todoTitle.trim() })
                        .then(() => {
                          setTodoTitle("");
                          return loadDetail(detail.id);
                        });
                    }}
                  >
                    <input
                      className="field w-48"
                      placeholder="新待办"
                      value={todoTitle}
                      onChange={(e) => setTodoTitle(e.target.value)}
                    />
                    <button type="submit" className="btn-ghost">
                      添加
                    </button>
                  </form>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {TODO_COLS.map((col) => (
                    <div
                      key={col.status}
                      className="rounded-card border border-ink-300 bg-panel p-2"
                    >
                      <div className="mb-2 px-1 text-meta text-ink-500">
                        {col.label}
                      </div>
                      <div className="space-y-2">
                        {detail.todos
                          .filter((t) => t.status === col.status)
                          .map((todo) => (
                            <div
                              key={todo.id}
                              className={`rounded-[10px] border px-2 py-1.5 ${
                                todo.id === highlightTodoId
                                  ? "border-accent bg-accent-soft"
                                  : "border-ink-200 bg-ink-50"
                              }`}
                            >
                              <div className="text-[13px] text-ink-800">
                                {todo.title}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {TODO_COLS.filter(
                                  (c) => c.status !== todo.status,
                                ).map((c) => (
                                  <button
                                    key={c.status}
                                    type="button"
                                    className="text-meta text-accent hover:underline"
                                    onClick={() =>
                                      void api
                                        .patchTodo(detail.id, todo.id, {
                                          status: c.status,
                                        })
                                        .then(() => loadDetail(detail.id))
                                    }
                                  >
                                    {c.label}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className="text-meta text-danger hover:underline"
                                  onClick={() =>
                                    void api
                                      .deleteTodo(detail.id, todo.id)
                                      .then(() => loadDetail(detail.id))
                                  }
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
                    资产
                  </div>
                  <label className="btn-ghost cursor-pointer">
                    上传
                    <input
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        void fileToAssetPayload(file)
                          .then((payload) =>
                            api.uploadAsset(detail.id, payload),
                          )
                          .then(() => loadDetail(detail.id))
                          .catch((err) =>
                            setError(
                              err instanceof Error ? err.message : String(err),
                            ),
                          );
                      }}
                    />
                  </label>
                </div>
                <ul className="space-y-1 rounded-card border border-ink-300 bg-panel p-2">
                  {detail.assets.length === 0 && (
                    <li className="px-2 py-3 text-center text-xs text-ink-500">
                      还没有资产。上传一份 brief 或图片即可。
                    </li>
                  )}
                  {detail.assets.map((a) => (
                    <li
                      key={a.id}
                      className={`flex items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-[13px] ${
                        a.id === highlightAssetId ? "bg-accent-soft" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left"
                        onClick={() => setPreviewAsset(a)}
                      >
                        <span className="font-mono text-ink-800 hover:text-accent">
                          {a.filename}
                        </span>
                        {a.sourceArtifactPath && (
                          <span className="ml-2 font-sans text-meta text-ink-400">
                            来自 {a.sourceArtifactPath}
                          </span>
                        )}
                      </button>
                      <span className="shrink-0 text-meta text-ink-500">
                        {formatBytes(a.size)}
                      </span>
                      {a.sourceSessionId && (
                        <button
                          type="button"
                          className="shrink-0 text-meta text-accent hover:underline"
                          onClick={() => onOpenSession(a.sourceSessionId!)}
                        >
                          来源会话
                        </button>
                      )}
                      <a
                        href={api.assetDownloadUrl(detail.id, a.id)}
                        className="btn-ghost shrink-0 px-1.5 py-1"
                        download={a.filename}
                        title="下载"
                      >
                        <Download size={12} />
                      </a>
                      <button
                        type="button"
                        className="text-meta text-accent hover:underline"
                        onClick={() => setPreviewAsset(a)}
                      >
                        预览
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
                    已绑定会话
                  </div>
                </div>
                <ul className="space-y-1 rounded-card border border-ink-300 bg-panel p-2">
                  {linked.length === 0 && (
                    <li className="px-2 py-3 text-center text-xs text-ink-500">
                      还没有会话。开一个任务后，项目指令会进系统提示。
                    </li>
                  )}
                  {linked.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-ink-100"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between text-left"
                        onClick={() => onOpenSession(s.id)}
                      >
                        <span className="truncate text-[13px]">{s.title}</span>
                        <span className="ml-2 shrink-0 text-meta text-ink-500">
                          {s.status}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn-ghost shrink-0"
                        disabled={handoffBusy === s.id}
                        onClick={() => {
                          setHandoffBusy(s.id);
                          void api
                            .session(s.id)
                            .then((full) => setHandoffSession(full))
                            .catch((err) =>
                              setError(
                                err instanceof Error
                                  ? err.message
                                  : String(err),
                              ),
                            )
                            .finally(() => setHandoffBusy(null));
                        }}
                      >
                        {handoffBusy === s.id ? "…" : "转交"}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <div className="mb-2 text-meta uppercase tracking-[0.16em] text-ink-500">
                  成员 / 邀请
                </div>
                <p className="mb-2 text-xs text-ink-500">
                  同一台 Pig
                  上用显示名邀请协作成员。令牌可在本页兑换；收件箱可接受或拒绝。所有者不可移除。
                </p>
                <form
                  className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!inviteName.trim() || inviteBusy) return;
                    setInviteBusy(true);
                    setError(null);
                    void api
                      .inviteMember(detail.id, {
                        displayName: inviteName.trim(),
                        note: inviteNote.trim() || undefined,
                      })
                      .then((r) => {
                        setInviteToken(r.inviteToken);
                        setInviteName("");
                        setInviteNote("");
                        return loadDetail(detail.id);
                      })
                      .catch((err) =>
                        setError(
                          err instanceof Error ? err.message : String(err),
                        ),
                      )
                      .finally(() => setInviteBusy(false));
                  }}
                >
                  <input
                    className="field"
                    placeholder="显示名称"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                  />
                  <input
                    className="field"
                    placeholder="备注（可选）"
                    value={inviteNote}
                    onChange={(e) => setInviteNote(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn-ghost"
                    disabled={inviteBusy}
                  >
                    {inviteBusy ? "…" : "邀请"}
                  </button>
                </form>
                {inviteToken && (
                  <div className="mb-3 flex items-center gap-2 rounded-[10px] bg-ink-100 px-2 py-1.5">
                    <p className="min-w-0 flex-1 truncate font-mono text-xs">
                      {inviteToken}
                    </p>
                    <button
                      type="button"
                      className="text-meta text-accent hover:underline"
                      onClick={() =>
                        void navigator.clipboard.writeText(inviteToken)
                      }
                    >
                      复制
                    </button>
                  </div>
                )}
                <form
                  className="mb-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!redeemToken.trim()) return;
                    setError(null);
                    void api
                      .redeemInvite(detail.id, redeemToken.trim())
                      .then(() => {
                        setRedeemToken("");
                        setInviteToken(null);
                        return loadDetail(detail.id);
                      })
                      .catch((err) =>
                        setError(
                          err instanceof Error ? err.message : String(err),
                        ),
                      );
                  }}
                >
                  <input
                    className="field"
                    placeholder="粘贴邀请令牌以加入"
                    value={redeemToken}
                    onChange={(e) => setRedeemToken(e.target.value)}
                  />
                  <button type="submit" className="btn-ghost">
                    兑换
                  </button>
                </form>
                <p className="mb-3 text-xs text-ink-400">
                  无效或已失效的令牌会显示错误，不会加入项目。
                </p>
                <ul className="space-y-1 rounded-card border border-ink-300 bg-white p-2 text-[13px] text-ink-700">
                  {detail.members.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between gap-2 rounded-[10px] px-2 py-1.5"
                    >
                      <span>
                        {m.displayName} ·{" "}
                        {m.role === "owner"
                          ? "所有者"
                          : m.role === "admin"
                            ? "管理员"
                            : "成员"}
                      </span>
                      {m.role === "owner" ? (
                        <span className="text-meta text-ink-400">不可移除</span>
                      ) : (
                        <button
                          type="button"
                          className="text-meta text-danger hover:underline"
                          onClick={() =>
                            void api
                              .removeMember(detail.id, m.id)
                              .then(() => loadDetail(detail.id))
                              .catch((err) =>
                                setError(
                                  err instanceof Error
                                    ? err.message
                                    : String(err),
                                ),
                              )
                          }
                        >
                          移除
                        </button>
                      )}
                    </li>
                  ))}
                  {(detail.invites ?? [])
                    .filter((inv) => inv.status === "pending")
                    .map((inv) => (
                      <li
                        key={inv.id}
                        className="flex items-center justify-between gap-2 rounded-[10px] bg-ink-50 px-2 py-1.5"
                      >
                        <span>
                          {inv.displayName} · 待接受
                          {inv.note ? ` · ${inv.note}` : ""}
                        </span>
                        <button
                          type="button"
                          className="text-meta text-danger hover:underline"
                          onClick={() =>
                            void api
                              .revokeInvite(detail.id, inv.id)
                              .then(() => loadDetail(detail.id))
                              .catch((err) =>
                                setError(
                                  err instanceof Error
                                    ? err.message
                                    : String(err),
                                ),
                              )
                          }
                        >
                          撤销
                        </button>
                      </li>
                    ))}
                </ul>
              </section>

              <section>
                <div className="mb-2 text-meta uppercase tracking-[0.16em] text-ink-500">
                  动态
                </div>
                <form
                  className="mb-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!comment.trim()) return;
                    void api
                      .postProjectMessage(detail.id, comment.trim())
                      .then(() => {
                        setComment("");
                        return loadDetail(detail.id);
                      });
                  }}
                >
                  <input
                    className="field"
                    placeholder="写一条评论"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                  />
                  <button type="submit" className="btn-ghost">
                    发送
                  </button>
                </form>
                <ol className="space-y-2">
                  {[...detail.messages]
                    .reverse()
                    .slice(0, 20)
                    .map((m) => (
                      <li key={m.id} className="text-xs text-ink-600">
                        <span className="text-ink-400">
                          {new Date(m.createdAt).toLocaleString()} ·{" "}
                        </span>
                        {m.body}
                      </li>
                    ))}
                </ol>
              </section>
            </div>
          )}
      </div>
      {detail && previewAsset && (
        <AssetPreviewModal
          projectId={detail.id}
          asset={previewAsset}
          onClose={() => {
            setPreviewAsset(null);
            if (highlightAssetId) onSelectProject(detail.id);
          }}
          onOpenSession={onOpenSession}
        />
      )}
      {detail && handoffSession && (
        <HandoffDialog
          projectId={detail.id}
          projectName={detail.name}
          session={handoffSession}
          onClose={() => setHandoffSession(null)}
          onDone={() => {
            setHandoffSession(null);
            void loadDetail(detail.id);
          }}
        />
      )}
    </section>
  );
}

async function fileToAssetPayload(file: File): Promise<{
  filename: string;
  content?: string;
  contentBase64?: string;
  mimeType?: string;
}> {
  const mime =
    file.type ||
    (isImage(file.name)
      ? "image/png"
      : isTextLike(file.name)
        ? "text/plain"
        : "application/octet-stream");
  if (isImage(file.name, file.type) || !isTextLike(file.name)) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(",");
    return {
      filename: file.name,
      contentBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
      mimeType: mime,
    };
  }
  return { filename: file.name, content: await file.text(), mimeType: mime };
}
