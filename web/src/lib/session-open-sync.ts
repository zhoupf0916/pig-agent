import type { SessionStatus, SessionSummary } from "../types";
import { sessionStatusLabel } from "./session-list-sync";

/** Fields the already-open session exposes for title / running↔idle. */
export type SessionOpenMeta = Pick<SessionSummary, "id" | "title" | "status">;

/** List / pin-row snapshot — title / status are optional so pin-only rows still type-check. */
export type SessionOpenMetaPatch = Pick<SessionSummary, "id"> &
  Partial<Pick<SessionSummary, "title" | "status">>;

const STATUSES = new Set<SessionStatus>(["idle", "running", "error"]);

export function normalizeSessionOpenTitle(title?: string | null): string {
  if (typeof title !== "string") return "";
  return title;
}

export function normalizeSessionOpenStatus(status?: string | null): SessionStatus | undefined {
  return STATUSES.has(status as SessionStatus) ? (status as SessionStatus) : undefined;
}

export function sessionOpenMetaSyncKey(row: SessionOpenMeta): string {
  return [row.id, row.status, normalizeSessionOpenTitle(row.title)].join("\u0001");
}

/**
 * Patch only title / status on the open session.
 * Same reference when nothing visible changed (avoids remounting the chat).
 * Transcript / steps stay put. Read-only: never PATCHes or writes events.jsonl.
 */
export function applySessionOpenMetaSnapshot<T extends SessionOpenMeta>(
  prev: T | null,
  next: SessionOpenMetaPatch | null,
): T | null {
  if (!prev) return prev;
  if (!next || next.id !== prev.id) return prev;
  const title = typeof next.title === "string" ? next.title : prev.title;
  const status = normalizeSessionOpenStatus(next.status) ?? prev.status;
  if (prev.title === title && prev.status === status) {
    return prev;
  }
  return { ...prev, title, status };
}

/**
 * When the open id is still in GET /api/sessions, keep it.
 * When it is gone, pick the next sidebar row (or null to clear).
 * Does not load transcripts.
 */
export function nextOpenSessionId(
  openId: string | null | undefined,
  list: Array<{ id: string }>,
): string | null {
  if (!openId) return null;
  if (list.some((item) => item.id === openId)) return openId;
  return list[0]?.id ?? null;
}

/**
 * Find the open session's list row and patch title / status.
 * Missing row → null so the caller can clear or switch (no ghost open session).
 */
export function applyOpenSessionFromList<T extends SessionOpenMeta>(
  prev: T | null,
  list: SessionOpenMetaPatch[],
): T | null {
  if (!prev) return prev;
  const row = list.find((item) => item.id === prev.id);
  if (!row) return null;
  return applySessionOpenMetaSnapshot(prev, row);
}

/** Existing sidebar / list labels — not a third status string. */
export function sessionOpenStatusLabel(status: SessionStatus): string {
  return sessionStatusLabel(status);
}
