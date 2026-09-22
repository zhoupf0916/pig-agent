import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";
import type { Project } from "../types";
import { api } from "../lib/api";
import "./project-workspaces.css";

export function ProjectWorkspaces({
  project,
  selected,
  onSelect,
  onChange,
  onCreateTask,
}: {
  project: Project;
  selected: string;
  onSelect: (id: string) => void;
  onChange: (project: Project) => void;
  onCreateTask: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null),
    [name, setName] = useState(""),
    [path, setPath] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const lock = useRef(false),
    identity = useRef(project.id);
  identity.current = project.id;
  useEffect(() => {
    setEditing(null);
    setError("");
    setNotice("");
  }, [project.id]);
  const workspaces = project.workspaces || [];
  async function mutate(action: () => Promise<Project>, message: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const id = project.id;
    try {
      const result = await action();
      if (identity.current !== id) return;
      onChange(result);
      setEditing(null);
      setNotice(message);
    } catch (e) {
      if (identity.current === id)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function edit(id: string) {
    const w = workspaces.find((w) => w.id === id);
    setEditing(id);
    setName(w?.name || "");
    setPath(w?.path || "");
    setError("");
    setNotice("");
  }
  return (
    <section className="project-workspaces" aria-label="项目工作区">
      <header>
        <div>
          <h3>工作区</h3>
          <p>
            一个项目可以关联多个本地目录，每个任务使用其中一个。已有任务保留原目录。
          </p>
        </div>
        <button className="btn-ghost" disabled={busy} onClick={() => edit("")}>
          <Plus size={14} />
          添加工作区
        </button>
      </header>
      {!workspaces.length && (
        <p className="pw-empty">
          尚未关联目录，新任务将使用全局工作区。添加已有目录即可开始。
        </p>
      )}
      <div className="pw-list">
        {workspaces.map((w) => (
          <article key={w.id} className={selected === w.id ? "selected" : ""}>
            <label>
              <input
                type="radio"
                name={`workspace-${project.id}`}
                checked={selected === w.id}
                onChange={() => onSelect(w.id)}
              />
              <span>
                <strong>{w.name}</strong>
                {project.defaultWorkspaceId === w.id && <small>默认</small>}
                <code>{w.path}</code>
              </span>
            </label>
            <div className="pw-actions">
              <button
                className="btn-ghost"
                disabled={busy}
                onClick={() => edit(w.id)}
              >
                编辑
              </button>
              {project.defaultWorkspaceId !== w.id && (
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () =>
                        api.updateProjectWorkspace(project.id, w.id, {
                          setDefault: true,
                        }),
                      "默认工作区已更新。",
                    )
                  }
                >
                  设为默认
                </button>
              )}
              <button
                className="btn-ghost"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () => api.removeProjectWorkspace(project.id, w.id),
                    "已移除关联，目录和已有任务均保留。",
                  )
                }
              >
                移除关联
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing !== null && (
        <form
          className="pw-editor"
          onSubmit={(e) => {
            e.preventDefault();
            if (!path.trim()) return;
            void mutate(
              () =>
                editing
                  ? api.updateProjectWorkspace(project.id, editing, {
                      name: name.trim() || undefined,
                      path: path.trim(),
                    })
                  : api.addProjectWorkspace(project.id, {
                      name: name.trim() || undefined,
                      path: path.trim(),
                    }),
              "工作区已保存。",
            );
          }}
        >
          <h4>{editing ? "编辑工作区" : "添加工作区"}</h4>
          <label>
            名称
            <input
              className="field"
              maxLength={100}
              disabled={busy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：前端、服务端"
            />
          </label>
          <label>
            本地目录
            <input
              className="field"
              required
              disabled={busy}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="已有目录的绝对路径"
            />
          </label>
          <div className="pw-actions">
            {window.pigDesktop && (
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={async () => {
                  const id = project.id;
                  try {
                    const chosen = await window.pigDesktop?.chooseWorkspace();
                    if (chosen && identity.current === id) setPath(chosen);
                  } catch (e) {
                    if (identity.current === id) setError(String(e));
                  }
                }}
              >
                <FolderOpen size={14} />
                选择文件夹
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              取消
            </button>
            <button className="btn-primary" disabled={busy || !path.trim()}>
              {busy ? "保存中…" : "保存工作区"}
            </button>
          </div>
        </form>
      )}
      {workspaces.length > 0 && (
        <p className="pw-help">
          每个任务固定使用选中的目录。移除关联不会删除本地文件。
        </p>
      )}
      <button className="btn-primary" disabled={busy} onClick={onCreateTask}>
        <Plus size={14} />
        在此项目开任务
      </button>
      {error && (
        <p role="alert" className="resource-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
