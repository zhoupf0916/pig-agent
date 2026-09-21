import { Inbox } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { applyInboxSnapshot, startInboxSync, type InboxSnapshot } from "../lib/inbox-sync";
import type { InboxItem, ProjectInviteStatus } from "../types";

const INVITE_STATUS: Record<ProjectInviteStatus, string> = {
  pending: "待接受",
  accepted: "已加入",
  declined: "已拒绝",
  revoked: "已撤销",
};

function invitePending(item: InboxItem): boolean {
  return item.kind === "invite" && (item.inviteStatus ?? "pending") === "pending";
}

export function InboxMenu({
  onOpenProject,
  onInviteResolved,
  onOpenSession,
}: {
  onOpenProject: (projectId: string) => void;
  onInviteResolved?: (projectId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<InboxSnapshot>({ items: [], unread: 0 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const items = inbox.items;
  const unread = inbox.unread;

  const refresh = async () => {
    const next = await api.inbox();
    setInbox((prev) => applyInboxSnapshot(prev, next));
  };

  useEffect(() => {
    return startInboxSync({
      fetchInbox: () => api.inbox(),
      onInbox: (next) => setInbox((prev) => applyInboxSnapshot(prev, next)),
    });
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

  const openProject = (item: InboxItem) => {
    void api.markInboxRead(item.id).then(() => refresh());
    onOpenProject(item.projectId);
    setOpen(false);
  };

  const runInviteAction = async (item: InboxItem, action: "accept" | "decline") => {
    setBusyId(item.id);
    setError(null);
    try {
      if (action === "accept") await api.acceptInboxInvite(item.id);
      else await api.declineInboxInvite(item.id);
      await refresh();
      onInviteResolved?.(item.projectId);
      if (action === "accept") {
        onOpenProject(item.projectId);
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="btn-ghost"
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            if (next) void refresh().catch(() => undefined);
            return next;
          });
        }}
      >
        <Inbox size={14} />
        收件箱
        {unread > 0 && (
          <span className="ml-1 rounded-full bg-accent px-1.5 text-[10px] text-white">{unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-96 rounded-card border border-ink-300 bg-white p-2 shadow-lift">
          <div className="mb-2 px-2 text-meta uppercase tracking-[0.16em] text-ink-500">邀请 / 转交</div>
          {error && <p className="mb-2 px-2 text-xs text-danger">{error}</p>}
          {items.length === 0 && <p className="px-2 py-4 text-center text-xs text-ink-500">暂无消息</p>}
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className={`rounded-[10px] px-2 py-2 ${item.read ? "bg-white" : "bg-accent-soft"}`}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => openProject(item)}
                >
                  <div className="text-[13px] font-medium text-ink-800">
                    {item.kind === "invite"
                      ? `邀请加入「${item.projectName ?? "项目"}」`
                      : item.title}
                  </div>
                  {item.kind === "invite" ? (
                    <>
                      <div className="mt-0.5 text-xs text-ink-500">
                        {item.inviterName ?? "本机用户"}
                        {item.inviteeName ? ` → ${item.inviteeName}` : ""}
                      </div>
                      {item.inviteNote && (
                        <div className="mt-0.5 whitespace-pre-wrap text-xs text-ink-500">{item.inviteNote}</div>
                      )}
                    </>
                  ) : (
                    <div className="mt-0.5 whitespace-pre-wrap text-xs text-ink-500">{item.body}</div>
                  )}
                  <div className="mt-1 text-meta text-ink-400">
                    {item.kind === "handoff" ? "转交" : "邀请"}
                    {item.kind === "invite" && item.inviteStatus
                      ? ` · ${INVITE_STATUS[item.inviteStatus]}`
                      : item.kind === "invite"
                        ? " · 待接受"
                        : ""}
                    {item.assetIds && item.assetIds.length > 0
                      ? ` · ${item.assetIds.length} 个资产`
                      : ""}
                  </div>
                </button>
                {item.kind === "invite" && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {invitePending(item) && (
                      <>
                        <button
                          type="button"
                          className="text-meta text-accent hover:underline"
                          disabled={busyId === item.id}
                          onClick={() => void runInviteAction(item, "accept")}
                        >
                          {busyId === item.id ? "…" : "接受"}
                        </button>
                        <button
                          type="button"
                          className="text-meta text-ink-500 hover:underline"
                          disabled={busyId === item.id}
                          onClick={() => void runInviteAction(item, "decline")}
                        >
                          忽略
                        </button>
                      </>
                    )}
                    {!item.read && (
                      <button
                        type="button"
                        className="text-meta text-ink-500 hover:underline"
                        onClick={() => void api.markInboxRead(item.id).then(() => refresh())}
                      >
                        标为已读
                      </button>
                    )}
                  </div>
                )}
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
