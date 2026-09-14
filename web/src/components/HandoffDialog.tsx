import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Artifact, Session } from "../types";

const RECENT_LIMIT = 8;

export function HandoffDialog({
  projectId,
  projectName,
  session,
  onClose,
  onDone,
}: {
  projectId: string;
  projectName?: string;
  session: Session;
  onClose: () => void;
  onDone: () => void;
}) {
  const recent = useMemo(() => recentArtifacts(session.artifacts), [session.artifacts]);
  const [note, setNote] = useState("请接手继续。");
  const [attach, setAttach] = useState(recent.length > 0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(recent.map((a) => a.path)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createHandoff(projectId, {
        sessionId: session.id,
        note: note.trim() || undefined,
        artifactPaths: attach ? [...selected] : [],
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-800/20 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-card border border-ink-300 bg-white p-5 shadow-lift">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-ink-800">转交到项目收件箱</h2>
            <p className="mt-1 text-xs text-ink-500">
              {projectName ?? projectId} · {session.title}
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={13} />
          </button>
        </div>
        <label className="block">
          <div className="mb-1 text-meta uppercase tracking-[0.16em] text-ink-500">备注</div>
          <textarea
            className="field min-h-[72px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="请接手继续。"
          />
        </label>
        {recent.length > 0 && (
          <div className="mt-3">
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input
                type="checkbox"
                checked={attach}
                onChange={(e) => setAttach(e.target.checked)}
              />
              附带最近保存的产物（写入项目资产）
            </label>
            {attach && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-[10px] border border-ink-200 bg-ink-50 p-2">
                {recent.map((a) => (
                  <li key={a.path}>
                    <label className="flex items-center gap-2 text-xs text-ink-700">
                      <input
                        type="checkbox"
                        checked={selected.has(a.path)}
                        onChange={() => toggle(a.path)}
                      />
                      <span className="truncate font-mono">{a.path}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {recent.length === 0 && (
          <p className="mt-3 text-xs text-ink-500">此会话还没有可附带的产物。仍可只发备注转交。</p>
        )}
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "转交中…" : "写入收件箱"}
          </button>
        </div>
      </div>
    </div>
  );
}

function recentArtifacts(artifacts: Artifact[]): Artifact[] {
  return artifacts
    .filter((a) => a.action !== "deleted")
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_LIMIT);
}
