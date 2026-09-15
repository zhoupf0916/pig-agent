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
 * `next === null` means the open note was deleted (confirmed 404 / gone from list).
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
 * Periodically GET the existing memory list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 * Open detail also GET /api/memory/:id — never force-fetch when that detail is not open.
 */
export function startMemorySync(opts: {
  fetchList: () => Promise<MemoryNote[]>;
  onList: (next: MemoryNote[]) => void;
  selectedId?: string;
  fetchSelected?: (id: string) => Promise<MemoryNote | null>;
  onSelected?: (next: MemoryNote | null) => void;
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
      if (selectedId && opts.fetchSelected && opts.onSelected) {
        try {
          const selected = await opts.fetchSelected(selectedId);
          if (stopped) return;
          if (selected && selected.id === selectedId) {
            opts.onSelected(selected);
          } else if (!selected) {
            const stillListed = list.some((note) => note.id === selectedId);
            if (!stillListed) opts.onSelected(null);
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
