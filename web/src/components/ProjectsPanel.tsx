import { FolderKanban, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Project, ProjectSummary, SessionSummary, TodoStatus } from "../types";

const TODO_COLS: { status: TodoStatus; label: string }[] = [
  { status: "todo", label: "待办" },
  { status: "doing", label: "进行中" },
  { status: "done", label: "已完成" },
];

export function ProjectsPanel({
  selectedId,
  sessions,
  onSelectProject,
  onOpenSession,
  onCreateSession,
}: {
  selectedId?: string;
  sessions: SessionSummary[];
  onSelectProject: (id?: string) => void;
  onOpenSession: (id: string) => void;
  onCreateSession: (projectId: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [detail, setDetail] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [todoTitle, setTodoTitle] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const refreshList = async () => {
    const { projects: next } = await api.projects();
    setProjects(next);
    return next;
  };

  const loadDetail = async (id: string) => {
    const project = await api.project(id);
    setDetail(project);
    setInstruction(project.instruction);
    setInviteToken(null);
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        if (selectedId) await loadDetail(selectedId);
        else if (list[0]) onSelectProject(list[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedId]);

  const linked = useMemo(
    () => sessions.filter((s) => s.projectId === detail?.id),
    [sessions, detail?.id],
  );

  return (
    <section className="flex min-w-0 flex-1 overflow-hidden bg-ink-50">
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-ink-300 bg-ink-100">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">项目</div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">协作空间</div>
          </div>
        </div>
        <form
          className="space-y-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void (async () => {
              const created = await api.createProject({ name: name.trim() });
              setName("");
              await refreshList();
              onSelectProject(created.id);
            })();
          }}
        >
          <input
            className="field"
            placeholder="新项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn-primary w-full">
            <Plus size={14} />
            新建项目
          </button>
        </form>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {projects.length === 0 && (
            <p className="px-2 pt-6 text-center text-xs text-ink-500">
              还没有项目。建一个空间，再把会话绑上去。
            </p>
          )}
          {projects.map((p) => {
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectProject(p.id)}
                className={`w-full rounded-card px-2.5 py-2 text-left ${
                  active ? "bg-accent-soft text-ink-800" : "text-ink-700 hover:bg-ink-200"
                }`}
              >
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                <div className="mt-0.5 text-meta text-ink-500">
                  {p.todoCount} 待办 · {p.assetCount} 资产 · {p.sessionCount} 会话
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {!detail && (
          <div className="flex h-full flex-col items-center justify-center text-ink-500">
            <FolderKanban size={28} className="mb-3 text-ink-400" />
            <p className="text-sm">选择或新建一个项目</p>
          </div>
        )}
        {detail && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-ink-800">{detail.name}</h2>
                <p className="mt-1 text-xs text-ink-500">
                  本机单用户骨架 · 指令会注入已绑定会话的系统提示
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
              <div className="mb-1 text-meta uppercase tracking-[0.16em] text-ink-500">项目指令</div>
              <textarea
                className="field min-h-[88px]"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onBlur={() => {
                  if (instruction !== detail.instruction) {
                    void api.patchProject(detail.id, { instruction }).then(() => loadDetail(detail.id));
                  }
                }}
                placeholder="团队共享的行为规则，例如：始终用中文，先列提纲再改文件。"
              />
            </label>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-meta uppercase tracking-[0.16em] text-ink-500">待办看板</div>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!todoTitle.trim()) return;
                    void api.createTodo(detail.id, { title: todoTitle.trim() }).then(() => {
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
                  <div key={col.status} className="rounded-card border border-ink-300 bg-white p-2">
                    <div className="mb-2 px-1 text-meta text-ink-500">{col.label}</div>
                    <div className="space-y-2">
                      {detail.todos
                        .filter((t) => t.status === col.status)
                        .map((todo) => (
                          <div key={todo.id} className="rounded-[10px] border border-ink-200 bg-ink-50 px-2 py-1.5">
                            <div className="text-[13px] text-ink-800">{todo.title}</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {TODO_COLS.filter((c) => c.status !== todo.status).map((c) => (
                                <button
                                  key={c.status}
                                  type="button"
                                  className="text-meta text-accent hover:underline"
                                  onClick={() =>
                                    void api.patchTodo(detail.id, todo.id, { status: c.status }).then(() =>
                                      loadDetail(detail.id),
                                    )
                                  }
                                >
                                  {c.label}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="text-meta text-danger hover:underline"
                                onClick={() =>
                                  void api.deleteTodo(detail.id, todo.id).then(() => loadDetail(detail.id))
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
                <div className="text-meta uppercase tracking-[0.16em] text-ink-500">资产</div>
                <label className="btn-ghost cursor-pointer">
                  上传文本
                  <input
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      void file.text().then((content) =>
                        api
                          .uploadAsset(detail.id, {
                            filename: file.name,
                            content,
                            mimeType: file.type || "text/plain",
                          })
                          .then(() => loadDetail(detail.id)),
                      );
                    }}
                  />
                </label>
              </div>
              <ul className="space-y-1 rounded-card border border-ink-300 bg-white p-2">
                {detail.assets.length === 0 && (
                  <li className="px-2 py-3 text-center text-xs text-ink-500">还没有资产。上传一份 brief 即可。</li>
                )}
                {detail.assets.map((a) => (
                  <li key={a.id} className="flex items-center justify-between px-2 py-1 text-[13px]">
                    <span className="truncate font-mono">{a.filename}</span>
                    <span className="text-meta text-ink-500">{a.size} B</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-meta uppercase tracking-[0.16em] text-ink-500">已绑定会话</div>
                <button type="button" className="btn-primary" onClick={() => onCreateSession(detail.id)}>
                  <Plus size={14} />
                  在此项目开任务
                </button>
              </div>
              <ul className="space-y-1 rounded-card border border-ink-300 bg-white p-2">
                {linked.length === 0 && (
                  <li className="px-2 py-3 text-center text-xs text-ink-500">
                    还没有会话。开一个任务后，项目指令会进系统提示。
                  </li>
                )}
                {linked.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-[10px] px-2 py-1.5 text-left hover:bg-ink-100"
                      onClick={() => onOpenSession(s.id)}
                    >
                      <span className="truncate text-[13px]">{s.title}</span>
                      <span className="text-meta text-ink-500">{s.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-meta uppercase tracking-[0.16em] text-ink-500">成员 / 邀请</div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    void api.inviteMember(detail.id, "同事").then((r) => {
                      setInviteToken(r.inviteToken);
                      return loadDetail(detail.id);
                    })
                  }
                >
                  生成邀请令牌
                </button>
              </div>
              <p className="text-xs text-ink-500">
                本机单用户：成员只有「本机用户」。邀请令牌会写入收件箱，供后续多端占位。
              </p>
              {inviteToken && (
                <p className="mt-2 rounded-[10px] bg-ink-100 px-2 py-1 font-mono text-xs">{inviteToken}</p>
              )}
              <ul className="mt-2 text-[13px] text-ink-700">
                {detail.members.map((m) => (
                  <li key={m.id}>
                    {m.displayName} · {m.role}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="mb-2 text-meta uppercase tracking-[0.16em] text-ink-500">动态</div>
              <form
                className="mb-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!comment.trim()) return;
                  void api.postProjectMessage(detail.id, comment.trim()).then(() => {
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
                {[...detail.messages].reverse().slice(0, 20).map((m) => (
                  <li key={m.id} className="text-xs text-ink-600">
                    <span className="text-ink-400">{new Date(m.createdAt).toLocaleString()} · </span>
                    {m.body}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
