/** Maximum time an open stream trusts its last access check while the event bus is live. */
export const AUTH_RECHECK_MS = 30_000;
/** Minimum gap between stream iterations, so bursts of notifications become one read. */
export const STREAM_COALESCE_MS = 25;
/** SSE heartbeat interval; while the bus is live each heartbeat also re-reads the stream (resync). */
export const HEARTBEAT_MS = 10_000;
/** Timers may fire a little early; treat a heartbeat as due within this slack to avoid a second wake-up. */
export const heartbeatDue = (last: number, now = Date.now()) => now - last >= HEARTBEAT_MS - 50;
/** Parses an optional X-Pig-Wait-Ms long-poll header; absent or invalid means "answer immediately". */
export const longPollMs = (header: string | undefined, max: number) => {
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : 0;
};
