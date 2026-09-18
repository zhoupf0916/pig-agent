import type { SearchHit, SearchHitType } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only `#/search` / SearchBox refresh. Same-host tabs pick up same-query hits from GET /api/search. */
export const SEARCH_SYNC_POLL_MS = 2_000;

/** Top-bar dropdown uses the existing GET /api/search with the same short limit as live typeahead. */
export const SEARCH_BOX_DROPDOWN_LIMIT = 8;

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
 * Fields the `#/search` / SearchBox hit list actually paints.
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
 * Replace the `#/search` or SearchBox hit list with a GET /api/search?q= snapshot.
 * Same array reference when nothing visible changed (avoids remounting the page / dropdown).
 * Adds / updates / removes rows so Tab A title / project / memory edits
 * — and deletes of those hit targets — catch up.
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

export type SearchHitTargetKind = "session" | "project" | "memory";

/** Session / project / memory id the hit would open (todo / asset use the parent project). */
export function searchHitTargetRef(hit: SearchHit): { kind: SearchHitTargetKind; id: string } {
  if (hit.type === "session") {
    return { kind: "session", id: hit.sessionId || hit.id };
  }
  if (hit.type === "memory") {
    return { kind: "memory", id: hit.id };
  }
  return { kind: "project", id: hit.projectId || hit.id };
}

/**
 * Drop one stale row (clicked-before-refresh 404 / gone).
 * Same array reference when that id is already absent.
 */
export function dropSearchHit(hits: SearchHit[], gone: Pick<SearchHit, "type" | "id">): SearchHit[] {
  const next = hits.filter((row) => row.type !== gone.type || row.id !== gone.id);
  return next.length === hits.length ? hits : next;
}

/**
 * Navigate-to-hit 404 / gone. Transient network errors are not gone.
 * Once this is true, do not open / keep a ghost detail route (AN-02: no GET :id after gone).
 */
export function isSearchTargetGoneError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = Number((err as { status: unknown }).status);
    if (status === 404 || status === 410) return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /(not found|\bgone\b)/i.test(msg);
}

/** Existing session / project / memory GET used by navigate-to-hit. No new search index. */
export async function probeSearchHitTarget(
  hit: SearchHit,
  fetchers: {
    session: (id: string) => Promise<unknown>;
    project: (id: string) => Promise<unknown>;
    memory: (id: string) => Promise<unknown>;
  },
): Promise<void> {
  const ref = searchHitTargetRef(hit);
  if (ref.kind === "session") {
    await fetchers.session(ref.id);
    return;
  }
  if (ref.kind === "memory") {
    await fetchers.memory(ref.id);
    return;
  }
  await fetchers.project(ref.id);
}

/**
 * Click a hit: probe the target first. 404 / gone → drop the row and do not
 * open a ghost `#/sessions/:id` / `#/projects/:id` / `#/memory/:id`. Other errors fall through
 * to the existing open path.
 */
export async function openSearchHitOrDrop(opts: {
  hit: SearchHit;
  probe: (hit: SearchHit) => Promise<void>;
  onOpen: (hit: SearchHit) => void;
  onDrop: (hit: SearchHit) => void;
}): Promise<"open" | "drop"> {
  try {
    await opts.probe(opts.hit);
  } catch (err) {
    if (isSearchTargetGoneError(err)) {
      opts.onDrop(opts.hit);
      return "drop";
    }
  }
  opts.onOpen(opts.hit);
  return "open";
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

/**
 * Top-bar SearchBox (Milestone AL): soft-refetch only when a query is
 * present **and** the dropdown is open. Closed or blank → do not force-fetch.
 */
export function searchBoxCanSoftRefetch(opts: {
  query: string;
  dropdownOpen: boolean;
}): boolean {
  return opts.dropdownOpen && Boolean(opts.query.trim());
}

/**
 * Same GET /api/search poll as `#/search`, gated on the open dropdown.
 * No new write path or state machine — just AI's startSearchSync when active.
 */
export function startSearchBoxSync(opts: {
  query: string;
  dropdownOpen: boolean;
  fetchHits: (q: string) => Promise<SearchHit[]>;
  onHits: (next: SearchHit[]) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  if (!searchBoxCanSoftRefetch({ query: opts.query, dropdownOpen: opts.dropdownOpen })) {
    return () => {};
  }
  return startSearchSync({
    query: opts.query,
    fetchHits: opts.fetchHits,
    onHits: opts.onHits,
    intervalMs: opts.intervalMs,
    clock: opts.clock,
  });
}
