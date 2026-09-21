import type { MemoryKind, MemoryNote } from "../types";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only memory refresh. Same-host tabs pick up pins / edits / deletes from GET /api/memory. */
export const MEMORY_SYNC_POLL_MS = 2_000;

const KINDS = new Set<MemoryKind>(["pin", "recap"]);

export function normalizeMemoryText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return value;
}

function normalizeKind(kind: MemoryNote["kind"] | string | undefined): MemoryKind {
  return kind === "recap" ? "recap" : "pin";
}

function normalizeTags(tags?: string[] | null): string[] | undefined {
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  return tags.map((tag) => String(tag));
}

/**
 * Fields the `#/memory` list and open detail actually paint.
 * Drops unknown keys so snapshots never become a secret store.
 */
export function sanitizeMemoryNote(note: MemoryNote): MemoryNote {
  const clean: MemoryNote = {
    id: note.id,
    kind: KINDS.has(note.kind) ? note.kind : normalizeKind(note.kind),
    text: normalizeMemoryText(note.text),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  const tags = normalizeTags(note.tags);
  if (tags) clean.tags = tags;
  if (typeof note.sessionId === "string" && note.sessionId) clean.sessionId = note.sessionId;
  if (typeof note.projectId === "string" && note.projectId) clean.projectId = note.projectId;
  return clean;
}

export function memorySyncKey(note: MemoryNote): string {
  return [
    note.id,
    normalizeKind(note.kind),
    normalizeMemoryText(note.text),
    (note.tags ?? []).join("\u0002"),
    note.sessionId ?? "",
    note.projectId ?? "",
    note.updatedAt ?? "",
  ].join("\u0001");
}

/**
 * Replace the `#/memory` list with a GET /api/memory snapshot.
 * Same array reference when nothing visible changed (avoids remounting the page).
 * Adds / updates / removes rows so Tab A pin / edit / delete / write-summary catch up.
 * Read-only: never POSTs / PATCHes / DELETEs memory or writes sessions / events.
 */
export function applyMemoryListSnapshot(prev: MemoryNote[], next: MemoryNote[]): MemoryNote[] {
  const clean = next.map(sanitizeMemoryNote);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && memorySyncKey(row) === memorySyncKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Replace the already-open note with a GET /api/memory/:id snapshot.
 * Same reference when nothing visible changed (avoids remounting the page).
 * Ignores another note's body and a missing open detail.
 * `next === null` means the open note was deleted (gone from GET /api/memory).
 */
export function applyMemoryDetailSnapshot(
  prev: MemoryNote | null,
  next: MemoryNote | null,
): MemoryNote | null {
  if (next === null) return null;
  if (!prev) return prev;
  if (next.id !== prev.id) return prev;
  const clean = sanitizeMemoryNote(next);
  if (memorySyncKey(prev) === memorySyncKey(clean)) return prev;
  return clean;
}

/**
 * When the open id is still in GET /api/memory, keep it.
 * When it is gone, pick the next list row (or null to clear).
 * Does not load note detail bodies.
 */
export function nextOpenMemoryId(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): string | null {
  if (!openId) return null;
  if (list.some((item) => item.id === openId)) return openId;
  return list[0]?.id ?? null;
}

/**
 * AN-02 nail: GET /api/memory/:id only while the list still contains that id.
 * Once the list snapshot says the open id is gone, callers must rewrite hash /
 * open state first and must not request `:id`.
 */
export function shouldFetchMemoryDetail(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): boolean {
  return Boolean(openId && list.some((item) => item.id === openId));
}

/**
 * Periodically GET the existing memory list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Open detail also GET /api/memory/:id — never force-fetch when that detail is not open.
 * If the list snapshot lacks the open id, rewrite open state first and do not GET `:id`.
 */
export function startMemorySync(opts: {
  fetchList: () => Promise<MemoryNote[]>;
  onList: (next: MemoryNote[]) => void;
  selectedId?: string;
  fetchSelected?: (id: string) => Promise<MemoryNote | null>;
  onSelected?: (next: MemoryNote | null) => void;
  onOpenId?: (nextId: string | null) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? MEMORY_SYNC_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const list = await opts.fetchList();
      if (stopped) return;
      opts.onList(list);
      const selectedId = opts.selectedId;
      if (selectedId && !shouldFetchMemoryDetail(selectedId, list)) {
        // list confirms gone — update hash / open state first; never GET :id
        opts.onOpenId?.(nextOpenMemoryId(selectedId, list));
        return;
      }
      if (selectedId && opts.fetchSelected && opts.onSelected) {
        try {
          const selected = await opts.fetchSelected(selectedId);
          if (stopped) return;
          if (selected && selected.id === selectedId) {
            opts.onSelected(selected);
          }
        } catch {
          // keep the last good open note (list already applied)
        }
      }
    } catch {
      // keep the last good memory list
    } finally {
      inFlight = false;
    }
  };

  const tick = () => {
    if (clock.isVisible()) void refresh();
  };

  void refresh();
  const timer = clock.setInterval(tick, intervalMs);
  clock.addListener("visibilitychange", tick);
  clock.addListener("focus", tick);

  return () => {
    stopped = true;
    clock.clearInterval(timer);
    clock.removeListener("visibilitychange", tick);
    clock.removeListener("focus", tick);
  };
}
