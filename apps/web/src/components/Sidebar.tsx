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
    <aside className="session-sidebar flex h-full w-[220px] shrink-0 flex-col border-r border-ink-300 bg-ink-100 lg:w-[232px]">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <div className="text-meta uppercase tracking-[0.16em] text-ink-500">
            会话
          </div>
          <div className="mt-0.5 text-sm font-medium text-ink-800">
            任务列表
          </div>
        </div>
        <button
          type="button"
          disabled={busy || createDisabled}
          onClick={onCreate}
          className="btn-primary px-2.5 py-1.5"
        >
          <Plus size={14} />
          新任务
        </button>
      </div>
      <div className="space-y-2 px-3 pb-3">
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
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
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
            <div
              key={s.id}
              className={`group relative flex items-start gap-2 rounded-card px-3 py-3 ${
                active
                  ? "bg-panel text-ink-800 shadow-sm"
                  : "text-ink-700 hover:bg-ink-200"
              }`}
            >
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
                <div className="truncate text-[13px] font-medium">
                  {s.title}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-meta text-ink-500">
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
                className="mt-0.5 rounded p-1 text-ink-500 opacity-60 sm:opacity-0 hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </aside>
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
