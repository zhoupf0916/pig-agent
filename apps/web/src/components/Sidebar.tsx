import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { sessionStatusLabel } from "../lib/session-list-sync";
import type { SessionSummary } from "../types";

export function Sidebar({
  sessions,
  busy = false,
  createDisabled = false,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: {
  sessions: SessionSummary[];
  busy?: boolean;
  createDisabled?: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const visible = sessions.filter(
    (session) =>
      session.title.toLowerCase().includes(query.toLowerCase().trim()) &&
      (filter === "all" || session.status === filter),
  );
  return (
    <section className="session-sidebar" aria-label="任务列表">
      <div className="session-list-heading">
        <strong>最近任务</strong>
        <span>{sessions.length}</span>
      </div>
      <div className="session-list-controls">
        <input
          className="field"
          aria-label="搜索本地任务"
          placeholder="搜索任务"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="field"
          aria-label="筛选本地任务"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部任务 · {sessions.length}</option>
          <option value="running">运行中</option>
          <option value="error">出错</option>
          <option value="idle">空闲</option>
        </select>
      </div>
      <div className="session-list">
        {sessions.length === 0 && (
          <p className="px-2 pt-6 text-center text-xs text-ink-500">
            还没有会话。描述一个工作目标即可开始。
          </p>
        )}
        {sessions.length > 0 && !visible.length && (
          <p className="px-3 py-6 text-xs text-ink-500">没有匹配的任务。</p>
        )}
        {visible.map((s) => {
          const active = s.id === activeId;
          return (
            <div key={s.id} className={`session-row ${active ? "active" : ""}`}>
              {active && (
                <span className="absolute bottom-1.5 left-0 top-1.5 w-0.5 rounded-full bg-accent" />
              )}
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                title={s.title}
                disabled={busy}
                onClick={() => onSelect(s.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="session-row-title">{s.title}</div>
                <div className="session-row-meta">
                  <StatusDot status={s.status} />
                  {s.status === "running" || s.status === "error"
                    ? sessionStatusLabel(s.status)
                    : new Date(s.updatedAt).toLocaleDateString("zh-CN", {
                        month: "short",
                        day: "numeric",
                      })}
                </div>
              </button>
              <button
                type="button"
                disabled={busy}
                title="删除会话"
                aria-label={`删除会话：${s.title}`}
                onClick={() => onDelete(s.id)}
                className="session-delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StatusDot({ status }: { status: SessionSummary["status"] }) {
  const label = sessionStatusLabel(status);
  const color =
    status === "running"
      ? "bg-accent animate-pulse"
      : status === "error"
        ? "bg-danger"
        : "bg-ink-400";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${color}`}
      title={label}
      aria-label={label}
    />
  );
}
