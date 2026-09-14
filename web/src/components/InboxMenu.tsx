import { Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { InboxItem } from "../types";

export function InboxMenu({
  onOpenProject,
  onOpenSession,
}: {
  onOpenProject: (projectId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    const next = await api.inbox();
    setItems(next.items);
    setUnread(next.unread);
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 8_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button type="button" className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        <Inbox size={14} />
        收件箱
        {unread > 0 && (
          <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] text-white">{unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 rounded-card border border-ink-300 bg-white p-2 shadow-lift">
          <div className="mb-2 px-2 text-meta uppercase tracking-[0.16em] text-ink-500">邀请 / 转交</div>
          {items.length === 0 && <p className="px-2 py-4 text-center text-xs text-ink-500">暂无消息</p>}
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className={`rounded-[10px] px-2 py-2 ${item.read ? "bg-white" : "bg-accent-soft"}`}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => {
                    void api.markInboxRead(item.id).then(() => refresh());
                    onOpenProject(item.projectId);
                    setOpen(false);
                  }}
                >
                  <div className="text-[13px] font-medium text-ink-800">{item.title}</div>
                  <div className="mt-0.5 whitespace-pre-wrap text-xs text-ink-500">{item.body}</div>
                  <div className="mt-1 text-meta text-ink-400">
                    {item.kind === "handoff" ? "转交" : "邀请"}
                    {item.assetIds && item.assetIds.length > 0
                      ? ` · ${item.assetIds.length} 个资产`
                      : ""}
                  </div>
                </button>
                {item.kind === "handoff" && item.sessionId && onOpenSession && (
                  <button
                    type="button"
                    className="mt-1 text-meta text-accent hover:underline"
                    onClick={() => {
                      void api.markInboxRead(item.id).then(() => refresh());
                      onOpenSession(item.sessionId!);
                      setOpen(false);
                    }}
                  >
                    打开会话
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
