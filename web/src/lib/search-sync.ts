import type { SearchHit, SearchHitType } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only `#/search` refresh. Same-host tabs pick up same-query hits from GET /api/search. */
export const SEARCH_SYNC_POLL_MS = 2_000;

const HIT_TYPES = new Set<SearchHitType>([
  "session",
  "project",
  "todo",
  "asset",
  "project_message",
  "memory",
]);

export function normalizeSearchText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return redactSecretsForDisplay(value);
}

function optionalId(value?: string | null): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizeType(type: SearchHit["type"] | string | undefined): SearchHitType | null {
  return HIT_TYPES.has(type as SearchHitType) ? (type as SearchHitType) : null;
}

/**
 * Fields the `#/search` hit list actually paints.
 * Drops unknown keys so snapshots never become a secret store.
 * Title / snippet / href never keep provider-key plaintext.
 */
export function sanitizeSearchHit(hit: SearchHit): SearchHit | null {
  const type = normalizeType(hit.type);
  if (!type) return null;
  if (typeof hit.id !== "string" || !hit.id) return null;
  const clean: SearchHit = {
    type,
    id: hit.id,
    title: normalizeSearchText(hit.title),
    snippet: normalizeSearchText(hit.snippet),
    href: normalizeSearchText(typeof hit.href === "string" ? hit.href : ""),
  };
  const sessionId = optionalId(hit.sessionId);
  if (sessionId) clean.sessionId = sessionId;
  const projectId = optionalId(hit.projectId);
  if (projectId) clean.projectId = projectId;
  const assetId = optionalId(hit.assetId);
  if (assetId) clean.assetId = assetId;
  const todoId = optionalId(hit.todoId);
  if (todoId) clean.todoId = todoId;
  const messageId = optionalId(hit.messageId);
  if (messageId) clean.messageId = messageId;
  return clean;
}

export function searchHitSyncKey(hit: SearchHit): string {
  return [
    hit.type,
    hit.id,
    normalizeSearchText(hit.title),
    normalizeSearchText(hit.snippet),
    normalizeSearchText(hit.href),
    hit.sessionId ?? "",
    hit.projectId ?? "",
    hit.assetId ?? "",
    hit.todoId ?? "",
    hit.messageId ?? "",
  ].join("\u0001");
}

/**
 * Replace the `#/search` hit list with a GET /api/search?q= snapshot.
 * Same array reference when nothing visible changed (avoids remounting the page).
 * Adds / updates / removes rows so Tab A title / project / memory edits catch up.
 * Read-only: never POSTs / PATCHes / DELETEs search, sessions, or events.
 */
export function applySearchHitsSnapshot(prev: SearchHit[], next: SearchHit[]): SearchHit[] {
  const clean = next
    .map((hit) => sanitizeSearchHit(hit))
    .filter((hit): hit is SearchHit => hit !== null);
  if (
    prev.length === clean.length &&
    prev.every((row, i) => {
      const other = clean[i];
      return other !== undefined && searchHitSyncKey(row) === searchHitSyncKey(other);
    })
  ) {
    return prev;
  }
  return clean;
}

/**
 * Periodically GET the existing search API for the already-present query
 * (and on tab focus / visible). Hidden tabs skip interval ticks; becoming
 * visible fetches immediately. No query → do not force-fetch.
 */
export function startSearchSync(opts: {
  query: string;
  fetchHits: (q: string) => Promise<SearchHit[]>;
  onHits: (next: SearchHit[]) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const query = opts.query.trim();
  const intervalMs = opts.intervalMs ?? SEARCH_SYNC_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight || !query) return;
    inFlight = true;
    try {
      const next = await opts.fetchHits(query);
      if (!stopped) opts.onHits(next);
    } catch {
      // keep the last good hit list
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
