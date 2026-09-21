import type { SessionStatus, SessionSummary } from "../types";

/** Read-only sidebar refresh interval. Same-host tabs pick up running→idle from GET /api/sessions. */
export const SESSION_LIST_POLL_MS = 2_000;

/** Fields the workstation sidebar actually paints. */
export type SessionListRow = Pick<
  SessionSummary,
  "id" | "title" | "createdAt" | "updatedAt" | "status" | "projectId" | "expertId" | "expertTeamId"
>;

export function sessionStatusLabel(status: SessionStatus): string {
  if (status === "running") return "运行中";
  if (status === "error") return "出错";
  return "空闲";
}

export function sessionListSyncKey(row: SessionListRow): string {
  return [
    row.id,
    row.status,
    row.title,
    row.updatedAt,
    row.projectId ?? "",
    row.expertId ?? "",
    row.expertTeamId ?? "",
  ].join("\u0001");
}

/**
 * Replace the sidebar list with a GET /api/sessions snapshot.
 * Same reference when nothing visible changed (avoids extra renders).
 * Read-only: never writes session JSON or events.jsonl.
 */
export function applySessionListSnapshot<T extends SessionListRow>(prev: T[], next: T[]): T[] {
  if (
    prev.length === next.length &&
    prev.every((row, i) => {
      const other = next[i];
      return other !== undefined && sessionListSyncKey(row) === sessionListSyncKey(other);
    })
  ) {
    return prev;
  }
  return next;
}

export type SessionListSyncClock = {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  addListener: (type: "visibilitychange" | "focus", handler: () => void) => void;
  removeListener: (type: "visibilitychange" | "focus", handler: () => void) => void;
  isVisible: () => boolean;
};

export function browserSessionListClock(): SessionListSyncClock {
  return {
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    addListener: (type, handler) => {
      if (type === "visibilitychange") document.addEventListener(type, handler);
      else window.addEventListener(type, handler);
    },
    removeListener: (type, handler) => {
      if (type === "visibilitychange") document.removeEventListener(type, handler);
      else window.removeEventListener(type, handler);
    },
    isVisible: () => document.visibilityState !== "hidden",
  };
}

/**
 * Periodically GET the existing session list (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 */
export function startSessionListSync(opts: {
  fetchList: () => Promise<SessionSummary[]>;
  onList: (next: SessionSummary[]) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? SESSION_LIST_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const next = await opts.fetchList();
      if (!stopped) opts.onList(next);
    } catch {
      // keep the last good sidebar list
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
