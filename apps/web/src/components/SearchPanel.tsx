import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { searchHitLabel } from "../lib/format";
import {
  applySearchHitsSnapshot,
  dropSearchHit,
  openSearchHitOrDrop,
  probeSearchHitTarget,
  startSearchSync,
} from "../lib/search-sync";
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

  const openHitOrDrop = (hit: SearchHit) => {
    void openSearchHitOrDrop({
      hit,
      probe: (row) =>
        probeSearchHitTarget(row, {
          session: (id) => api.session(id),
          project: (id) => api.project(id),
          memory: (id) => api.memoryNote(id),
        }),
      onOpen: onOpenHit,
      onDrop: (gone) => setHits((prev) => dropSearchHit(prev, gone)),
    });
  };

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
    <section className="resource-page" aria-label="搜索">
      <header className="resource-header"><div><h2>搜索</h2><p>查找这台设备上的任务、项目、成果与记忆</p></div></header>
      <div className="resource-search">
        <form className="resource-search-form" onSubmit={event => event.preventDefault()}>
          <input className="field" aria-label="搜索所有记录" placeholder="输入关键词…" value={q} onChange={event => setQ(event.target.value)} autoFocus />
          {q && <button type="button" className="btn-quiet" onClick={() => setQ("")}>清空</button>}
        </form>
        <p className="resource-search-summary" role="status">{busy ? "正在搜索…" : q.trim() ? `找到 ${hits.length} 条记录` : "支持任务标题、正文、项目名称与笔记内容"}</p>
        {error && <p role="alert" className="resource-error">{error}</p>}
        {!q.trim() && <div className="resource-empty"><p>从一个关键词开始</p><span className="text-sm text-ink-500">例如项目名、文件名，或上次讨论的决定。</span></div>}
        {q.trim() && !busy && hits.length === 0 && !error && <div className="resource-empty"><p>没有匹配的记录</p><span className="text-sm text-ink-500">试试更短的关键词，或检查名称是否正确。</span></div>}
        <div className="resource-search-results">
          {grouped.map(group => <section key={group.type}><h3>{searchHitLabel(group.type)} <span className="text-ink-500">{group.hits.length}</span></h3><ul>{group.hits.map(hit => <li key={`${hit.type}:${hit.id}`}><button type="button" onClick={() => openHitOrDrop(hit)}><strong className="line-clamp-2">{hit.title}</strong>{hit.snippet && hit.snippet.trim() !== hit.title.trim() && <p className="line-clamp-2">{hit.snippet}</p>}</button></li>)}</ul></section>)}
        </div>
      </div>
    </section>
  );
}
