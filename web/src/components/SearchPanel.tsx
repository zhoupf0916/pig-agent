import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { searchHitLabel } from "../lib/format";
import { applySearchHitsSnapshot, startSearchSync } from "../lib/search-sync";
import type { SearchHit, SearchHitType } from "../types";

const GROUPS: SearchHitType[] = ["session", "project", "todo", "asset", "project_message", "memory"];

export function SearchPanel({
  initialQ = "",
  onOpenHit,
}: {
  initialQ?: string;
  onOpenHit: (hit: SearchHit) => void;
}) {
  const [q, setQ] = useState(initialQ);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQ(initialQ);
  }, [initialQ]);

  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) {
      setHits([]);
      setBusy(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void api
        .search(trimmed, 40)
        .then((res) => {
          if (cancelled) return;
          setHits((prev) => applySearchHitsSnapshot(prev, res.hits));
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setHits([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) return;
    return startSearchSync({
      query: trimmed,
      fetchHits: async (query) => {
        const res = await api.search(query, 40);
        return res.hits;
      },
      onHits: (next) => setHits((prev) => applySearchHitsSnapshot(prev, next)),
    });
  }, [q]);

  const grouped = useMemo(() => {
    const map = new Map<SearchHitType, SearchHit[]>();
    for (const type of GROUPS) map.set(type, []);
    for (const hit of hits) {
      const list = map.get(hit.type) ?? [];
      list.push(hit);
      map.set(hit.type, list);
    }
    return GROUPS.filter((type) => (map.get(type) ?? []).length > 0).map((type) => ({
      type,
      hits: map.get(type) ?? [],
    }));
  }, [hits]);

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-ink-50">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 py-6">
        <div className="mb-4">
          <div className="text-meta uppercase tracking-[0.16em] text-ink-500">本机记忆</div>
          <h2 className="mt-0.5 text-base font-medium text-ink-800">搜索会话、项目与记忆</h2>
          <p className="mt-1 text-xs text-ink-500">
            子串 / 分词匹配，不含向量库。只用顶栏搜索框；Ctrl+K 或 / 聚焦，Enter 更新结果。
          </p>
        </div>
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {!q.trim() && (
          <p className="py-10 text-center text-sm text-ink-500">在顶栏输入关键词，查找本机会话和项目记录。</p>
        )}
        {q.trim() && busy && hits.length === 0 && (
          <p className="py-10 text-center text-sm text-ink-500">搜索中…</p>
        )}
        {q.trim() && !busy && hits.length === 0 && !error && (
          <p className="py-10 text-center text-sm text-ink-500">没有匹配的本机记录</p>
        )}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-8">
          {grouped.map((group) => (
            <section key={group.type}>
              <div className="mb-2 text-meta uppercase tracking-[0.16em] text-ink-500">
                {searchHitLabel(group.type)}
              </div>
              <ul className="space-y-1 rounded-card border border-ink-300 bg-panel p-1">
                {group.hits.map((hit) => (
                  <li key={`${hit.type}:${hit.id}`}>
                    <button
                      type="button"
                      className="flex w-full flex-col rounded-[10px] px-3 py-2 text-left hover:bg-ink-100"
                      onClick={() => onOpenHit(hit)}
                    >
                      <div className="truncate text-[13px] font-medium text-ink-800">{hit.title}</div>
                      {hit.snippet && (
                        <div className="mt-0.5 line-clamp-2 text-xs text-ink-500">{hit.snippet}</div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
