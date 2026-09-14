import { Plus, Trash2 } from "lucide-react";
import type { SessionSummary } from "../types";

export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-white/5 bg-ink-900/80 lg:w-[240px]">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-ink-500">会话</div>
          <div className="mt-0.5 text-sm font-medium text-white">任务列表</div>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-ink-950 hover:bg-sky-300"
        >
          <Plus size={14} />
          新任务
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {sessions.length === 0 && (
          <p className="px-2 pt-6 text-center text-xs text-ink-500">
            还没有会话。描述一个工作目标即可开始。
          </p>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <div
              key={s.id}
              className={`group flex items-start gap-2 rounded-lg px-2.5 py-2 ${
                active ? "bg-ink-800 text-white" : "text-ink-300 hover:bg-ink-850"
              }`}
            >
              <button type="button" onClick={() => onSelect(s.id)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-[13px]">{s.title}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-500">
                  <StatusDot status={s.status} />
                  {new Date(s.updatedAt).toLocaleTimeString()}
                </div>
              </button>
              <button
                type="button"
                title="删除会话"
                onClick={() => onDelete(s.id)}
                className="mt-0.5 rounded p-1 text-ink-500 opacity-0 hover:bg-ink-700 hover:text-red-300 group-hover:opacity-100"
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
  const color =
    status === "running" ? "bg-accent animate-pulse" : status === "error" ? "bg-red-400" : "bg-emerald-400/80";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}
