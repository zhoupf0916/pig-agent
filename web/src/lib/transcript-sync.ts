import type { AgentEvent } from "../types";

export type TranscriptSyncPhase = "idle" | "catching_up";

/** Readable workstation status while the SSE client replays only the gap. */
export const CATCH_UP_STATUS = "正在追平未送达事件…";

/**
 * Incremental reconnect cursor. Clients must send `after` and `Last-Event-ID`
 * so the host replays seq > lastSeen only — never the full jsonl history.
 */
export function sessionEventsSubscribeInit(after: number): {
  query: string;
  headers: Record<string, string>;
} {
  const cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
  return {
    query: `after=${cursor}`,
    headers: {
      "Last-Event-ID": String(cursor),
      Accept: "text/event-stream",
    },
  };
}

export function rememberEventSeq(lastSeen: number, seq?: number): number {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return lastSeen;
  return Math.max(lastSeen, Math.floor(seq));
}

export function applySyncPhase(
  event: AgentEvent,
  current: TranscriptSyncPhase,
): TranscriptSyncPhase {
  if (event.type !== "sync") return current;
  if (event.phase === "catching_up" && event.gap > 0) return "catching_up";
  return "idle";
}
