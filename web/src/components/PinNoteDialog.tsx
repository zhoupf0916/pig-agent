import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Session } from "../types";

export function PinNoteDialog({
  session,
  onClose,
  onDone,
}: {
  session: Session;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const nextTags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await api.createMemory({
        kind: "pin",
        text: text.trim(),
        tags: nextTags.length ? nextTags : undefined,
        sessionId: session.id,
        projectId: session.projectId,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay px-4">
      <div className="w-full max-w-md rounded-card border border-ink-300 bg-panel p-4 shadow-lift">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-ink-800">钉住到本机记忆</div>
            <p className="mt-0.5 text-xs text-ink-500">写入 data/memory/，可被搜索；最近钉住会注入 pig 提示。</p>
          </div>
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose} disabled={busy}>
            <X size={14} />
          </button>
        </div>
        <textarea
          className="field min-h-[96px] resize-y"
          placeholder="一条短事实，例如：这个项目用中文交付"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <input
          className="field mt-2"
          placeholder="标签，逗号分隔（可选）"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
            钉住
          </button>
        </div>
      </div>
    </div>
  );
}
