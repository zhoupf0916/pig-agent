import { Pin, Plus, StickyNote, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatTime } from "../lib/format";
import {
  applyMemoryDetailSnapshot,
  applyMemoryListSnapshot,
  nextOpenMemoryId,
  shouldFetchMemoryDetail,
  startMemorySync,
} from "../lib/memory-sync";
import type { MemoryKind, MemoryNote } from "../types";

const KIND_LABEL: Record<MemoryKind, string> = {
  pin: "钉住",
  recap: "摘要",
};

export function MemoryPanel({
  selectedId,
  onSelect,
  onOpenSession,
  onOpenProject,
}: {
  selectedId?: string;
  onSelect: (id?: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [detail, setDetail] = useState<MemoryNote | null>(null);
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [draftText, setDraftText] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [createText, setCreateText] = useState("");
  const [createTags, setCreateTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refreshList = async () => {
    const { notes: next } = await api.memory();
    setNotes(next);
    return next;
  };

  const loadDetail = async (id: string) => {
    const note = await api.memoryNote(id);
    setDetail(note);
    setDraftText(note.text);
    setDraftTags((note.tags ?? []).join(", "));
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await refreshList();
        // AN-02 nail: list absence first — rewrite hash / open state, never GET :id
        if (selectedId && !shouldFetchMemoryDetail(selectedId, list)) {
          const nextId = nextOpenMemoryId(selectedId, list);
          onSelect(nextId ?? undefined);
          setDetail(null);
          return;
        }
        if (selectedId) await loadDetail(selectedId);
        else if (list[0]) onSelect(list[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedId]);

  useEffect(() => {
    return startMemorySync({
      fetchList: async () => {
        const { notes: next } = await api.memory();
        return next;
      },
      onList: (next) => setNotes((prev) => applyMemoryListSnapshot(prev, next)),
      selectedId,
      fetchSelected: selectedId ? (id) => api.memoryNote(id) : undefined,
      onSelected: (next) => setDetail((prev) => applyMemoryDetailSnapshot(prev, next)),
      onOpenId: (nextId) => {
        onSelect(nextId ?? undefined);
        setDetail(null);
      },
    });
  }, [selectedId]);

  useEffect(() => {
    if (!detail) return;
    setDraftText(detail.text);
    setDraftTags((detail.tags ?? []).join(", "));
  }, [detail]);

  const visible = useMemo(
    () => (filter === "all" ? notes : notes.filter((n) => n.kind === filter)),
    [filter, notes],
  );

  const saveCreate = async () => {
    if (!createText.trim()) return;
    setError(null);
    try {
      const tags = createTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await api.createMemory({
        kind: "pin",
        text: createText.trim(),
        tags: tags.length ? tags : undefined,
      });
      setCreateText("");
      setCreateTags("");
      await refreshList();
      onSelect(created.id);
      setStatus("已钉住");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveDetail = async () => {
    if (!detail || !draftText.trim()) return;
    setError(null);
    try {
      const tags = draftTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const next = await api.patchMemory(detail.id, {
        text: draftText.trim(),
        tags: tags.length ? tags : null,
      });
      setDetail(next);
      setStatus("已保存");
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="flex min-w-0 flex-1 overflow-hidden bg-ink-50">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-ink-300 bg-ink-100">
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <div>
            <div className="text-meta uppercase tracking-[0.16em] text-ink-500">记忆</div>
            <div className="mt-0.5 text-sm font-medium text-ink-800">本机笔记</div>
          </div>
        </div>
        <form
          className="space-y-2 px-3 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveCreate();
          }}
        >
          <textarea
            className="field min-h-[72px] resize-y"
            placeholder="钉住一条事实，例如：默认用 DeepSeek"
            value={createText}
            onChange={(e) => setCreateText(e.target.value)}
          />
          <input
            className="field"
            placeholder="标签，逗号分隔（可选）"
            value={createTags}
            onChange={(e) => setCreateTags(e.target.value)}
          />
          <button type="submit" className="btn-primary w-full" disabled={!createText.trim()}>
            <Plus size={14} />
            钉住笔记
          </button>
        </form>
        <div className="flex gap-1 px-3 pb-2">
          {(["all", "pin", "recap"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={filter === key ? "btn-primary px-2.5 py-1 text-xs" : "btn-ghost px-2.5 py-1 text-xs"}
              onClick={() => setFilter(key)}
            >
              {key === "all" ? "全部" : KIND_LABEL[key]}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
          {visible.length === 0 && (
            <p className="px-2 pt-6 text-center text-xs text-ink-500">还没有记忆。钉住一条，或在工作台写回合摘要。</p>
          )}
          {visible.map((note) => {
            const active = note.id === selectedId;
            return (
              <button
                key={note.id}
                type="button"
                onClick={() => onSelect(note.id)}
                className={`w-full rounded-card px-2.5 py-2 text-left ${
                  active ? "bg-accent-soft text-ink-800" : "text-ink-700 hover:bg-ink-200"
                }`}
              >
                <div className="flex items-center gap-1.5 text-meta text-ink-500">
                  {note.kind === "pin" ? <Pin size={11} /> : <StickyNote size={11} />}
                  {KIND_LABEL[note.kind]}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[13px] font-medium">{note.text}</div>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {status && <p className="mb-3 text-xs text-ink-500">{status}</p>}
        {!detail && (
          <div className="flex h-full flex-col items-center justify-center text-ink-500">
            <Pin size={28} className="mb-3 text-ink-400" />
            <p className="text-sm">选择或钉住一条本机记忆</p>
          </div>
        )}
        {detail && (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-medium text-ink-800">
                  {detail.kind === "pin" ? "钉住笔记" : "回合摘要"}
                </h2>
                <p className="mt-1 text-xs text-ink-500">
                  本机 JSON · {formatTime(detail.updatedAt)} · 写入 data/memory/
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost text-danger hover:bg-danger-soft"
                onClick={() => {
                  void (async () => {
                    await api.deleteMemory(detail.id);
                    setDetail(null);
                    const list = await refreshList();
                    onSelect(list[0]?.id);
                  })();
                }}
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">正文</span>
              <textarea
                className="field mt-1 min-h-[180px] resize-y"
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                onBlur={() => {
                  if (draftText.trim() && draftText.trim() !== detail.text) void saveDetail();
                }}
              />
            </label>

            <label className="block">
              <span className="text-meta uppercase tracking-[0.16em] text-ink-500">标签</span>
              <input
                className="field mt-1"
                value={draftTags}
                onChange={(e) => setDraftTags(e.target.value)}
                onBlur={() => {
                  const next = draftTags
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .join(", ");
                  const prev = (detail.tags ?? []).join(", ");
                  if (next !== prev) void saveDetail();
                }}
              />
            </label>

            <div className="flex flex-wrap gap-2 text-xs text-ink-500">
              {detail.sessionId && (
                <button type="button" className="btn-ghost" onClick={() => onOpenSession(detail.sessionId!)}>
                  打开来源会话
                </button>
              )}
              {detail.projectId && (
                <button type="button" className="btn-ghost" onClick={() => onOpenProject(detail.projectId!)}>
                  打开关联项目
                </button>
              )}
              <span>最近若干条钉住会注入 pig 系统提示（每条截断，不含摘要）。</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
