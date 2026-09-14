import type { SessionSummary } from "../types";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only pin-row refresh. Same-host tabs pick up GET /api/sessions. */
export const SESSION_PIN_POLL_MS = 2_000;

/** Existing workstation unbound option — not a new copy string. */
export const SESSION_PIN_UNBOUND = "未绑定";

/** Pin fields the chat header dropdowns / hints paint. */
export type SessionPinFields = Pick<SessionSummary, "id" | "projectId" | "expertId" | "expertTeamId">;

export function normalizeSessionPinId(id?: string | null): string | undefined {
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed ? trimmed : undefined;
}

export function sessionPinSyncKey(row: Pick<SessionPinFields, "projectId" | "expertId" | "expertTeamId">): string {
  return [
    normalizeSessionPinId(row.projectId) ?? "",
    normalizeSessionPinId(row.expertId) ?? "",
    normalizeSessionPinId(row.expertTeamId) ?? "",
  ].join("\u0001");
}

export function sessionPinSelectValue(id?: string | null): string {
  return normalizeSessionPinId(id) ?? "";
}

export function sessionPinBindingLabel(
  id: string | undefined,
  catalog: Array<{ id: string; name: string }>,
): string {
  const pin = normalizeSessionPinId(id);
  if (!pin) return SESSION_PIN_UNBOUND;
  return catalog.find((item) => item.id === pin)?.name ?? pin;
}

function assignSessionPins<T extends SessionPinFields>(base: T, pins: SessionPinFields): T {
  const next = { ...base };
  const projectId = normalizeSessionPinId(pins.projectId);
  const expertId = normalizeSessionPinId(pins.expertId);
  const expertTeamId = normalizeSessionPinId(pins.expertTeamId);
  if (projectId) next.projectId = projectId;
  else delete next.projectId;
  if (expertId) next.expertId = expertId;
  else delete next.expertId;
  if (expertTeamId) next.expertTeamId = expertTeamId;
  else delete next.expertTeamId;
  return next;
}

/**
 * Patch only project / expert / squad pins on the open session.
 * Same reference when nothing visible changed (avoids remounting the chat).
 * Read-only: never PATCHes pins or writes events.jsonl.
 */
export function applySessionPinSnapshot<T extends SessionPinFields>(
  prev: T | null,
  next: SessionPinFields | null,
): T | null {
  if (!prev) return prev;
  if (!next || next.id !== prev.id) return prev;
  const merged = assignSessionPins(prev, next);
  if (sessionPinSyncKey(prev) === sessionPinSyncKey(merged)) {
    return prev;
  }
  return merged;
}

/**
 * Periodically GET the existing session list (and on tab focus / visible),
 * then apply the active session's pin fields. Hidden tabs skip interval ticks.
 */
export function startSessionPinSync(opts: {
  sessionId: string;
  fetchList: () => Promise<SessionPinFields[]>;
  onPins: (next: SessionPinFields) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? SESSION_PIN_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  const sessionId = opts.sessionId;
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight || !sessionId) return;
    inFlight = true;
    try {
      const list = await opts.fetchList();
      const row = list.find((item) => item.id === sessionId);
      if (!stopped && row) opts.onPins(row);
    } catch {
      // keep the last good pin row
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
