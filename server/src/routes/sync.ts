import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSession } from "../store/sessions.ts";
import { getLastEventSeq, readEventsAfter } from "../store/events.ts";
import { subscribeSessionEvents } from "../store/bus.ts";
import type { AgentEvent, SessionEventRecord } from "../types.ts";

/** Exclusive cursor: `after` query wins, else `Last-Event-ID`. */
export function parseEventCursor(input: {
  query: (k: string) => string | undefined;
  header: (k: string) => string | undefined;
}): number {
  const q = input.query("after");
  if (q != null && q !== "") {
    const n = Number(q);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  const lastId = input.header("Last-Event-ID");
  if (lastId) {
    const n = Number(lastId);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  return 0;
}

function syncFrame(
  phase: "catching_up" | "live",
  after: number,
  lastSeq: number,
  gap: number,
): AgentEvent {
  return { type: "sync", phase, after, lastSeq, gap };
}

export function registerSyncRoutes(app: Hono): void {
  app.get("/api/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const after = parseEventCursor({
      query: (k) => c.req.query(k),
      header: (k) => c.req.header(k),
    });
    const live = c.req.query("live") !== "0";

    if (!live) {
      const missed = await readEventsAfter(id, after);
      const lastSeq = await getLastEventSeq(id);
      return c.json({ events: missed, lastSeq, after });
    }

    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const writeRecord = (seq: number, event: AgentEvent) => {
        writes = writes.then(() =>
          stream.writeSSE({
            id: String(seq),
            event: event.type,
            data: JSON.stringify(event),
          }),
        );
      };
      const writeTransient = (event: AgentEvent) => {
        writes = writes.then(() =>
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          }),
        );
      };

      const seen = new Set<number>();
      const pending: SessionEventRecord[] = [];
      let attached = false;

      // Subscribe first so events published during the jsonl read are not dropped.
      const unsubscribe = subscribeSessionEvents(id, (record) => {
        if (record.seq <= after || seen.has(record.seq)) return;
        if (!attached) {
          pending.push(record);
          return;
        }
        seen.add(record.seq);
        writeRecord(record.seq, record.event);
      });

      const missed = await readEventsAfter(id, after);
      const lastSeq = await getLastEventSeq(id);

      writeTransient(syncFrame("catching_up", after, lastSeq, missed.length));

      for (const record of missed) {
        if (record.seq <= after || seen.has(record.seq)) continue;
        seen.add(record.seq);
        writeRecord(record.seq, record.event);
      }

      attached = true;
      for (const record of pending) {
        if (record.seq <= after || seen.has(record.seq)) continue;
        seen.add(record.seq);
        writeRecord(record.seq, record.event);
      }

      const tip = seen.size ? Math.max(lastSeq, ...seen) : lastSeq;
      writeTransient(syncFrame("live", after, tip, 0));

      const abort = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      await abort;
      unsubscribe();
      await writes;
    });
  });
}
