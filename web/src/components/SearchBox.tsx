import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { searchHitLabel } from "../lib/format";
import {
  applySearchHitsSnapshot,
  SEARCH_BOX_DROPDOWN_LIMIT,
  startSearchBoxSync,
} from "../lib/search-sync";
import type { SearchHit } from "../types";

export function SearchBox({
  initialQ = "",
  onOpenAll,
  onOpenHit,
}: {
  initialQ?: string;
  onOpenAll: (q: string) => void;
  onOpenHit: (hit: SearchHit) => void;
}) {
  const [q, setQ] = useState(initialQ);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQ(initialQ);
  }, [initialQ]);

  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed) {
      setHits([]);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void api
        .search(trimmed, SEARCH_BOX_DROPDOWN_LIMIT)
        .then((res) => {
          if (!cancelled) setHits((prev) => applySearchHitsSnapshot(prev, res.hits));
        })
        .catch(() => {
          if (!cancelled) setHits([]);
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
    return startSearchBoxSync({
      query: q,
      dropdownOpen: open,
      fetchHits: async (query) => {
        const res = await api.search(query, SEARCH_BOX_DROPDOWN_LIMIT);
        return res.hits;
      },
      onHits: (next) => setHits((prev) => applySearchHitsSnapshot(prev, next)),
    });
  }, [q, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || Boolean(t?.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
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
  }, []);

  return (
    <div className="relative min-w-0 flex-1" ref={rootRef}>
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-500" />
        <input
          ref={inputRef}
          className="field pl-8"
          placeholder="搜索会话 / 项目 / 记忆…"
          value={q}
          aria-label="全局搜索"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onOpenAll(q);
              setOpen(false);
            }
          }}
        />
      </div>
      {open && q.trim() && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-80 overflow-y-auto rounded-card border border-ink-300 bg-panel p-1 shadow-lift">
          {busy && hits.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-500">搜索中…</p>
          )}
          {!busy && hits.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-ink-500">没有匹配的本机记录</p>
          )}
          {hits.map((hit) => (
            <button
              key={`${hit.type}:${hit.id}`}
              type="button"
              className="flex w-full flex-col rounded-[10px] px-2 py-1.5 text-left hover:bg-ink-100"
              onClick={() => {
                onOpenHit(hit);
                setOpen(false);
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-meta text-ink-500">{searchHitLabel(hit.type)}</span>
                <span className="truncate text-[13px] font-medium text-ink-800">{hit.title}</span>
              </div>
              {hit.snippet && (
                <div className="mt-0.5 truncate text-xs text-ink-500">{hit.snippet}</div>
              )}
            </button>
          ))}
          <button
            type="button"
            className="mt-1 w-full rounded-[10px] px-2 py-1.5 text-left text-xs text-accent hover:bg-accent-soft"
            onClick={() => {
              onOpenAll(q);
              setOpen(false);
            }}
          >
            查看全部结果
          </button>
        </div>
      )}
    </div>
  );
}
