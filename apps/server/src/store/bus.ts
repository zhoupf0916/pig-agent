import type { SessionEventRecord } from "../types.ts";

export type SessionEventListener = (record: SessionEventRecord) => void;

const listeners = new Map<string, Set<SessionEventListener>>();

export function subscribeSessionEvents(
  sessionId: string,
  listener: SessionEventListener,
): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(sessionId);
  };
}

export function subscriberCount(sessionId: string): number {
  return listeners.get(sessionId)?.size ?? 0;
}

export function publishSessionEvent(sessionId: string, record: SessionEventRecord): void {
  const set = listeners.get(sessionId);
  if (!set || set.size === 0) return;
  for (const listener of [...set]) {
    try {
      listener(record);
    } catch {
      // a broken subscriber must not block the rest
    }
  }
}
