import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getSession } from "../store/sessions.ts";
import { getLastEventSeq, readEventsAfter } from "../store/events.ts";
import { subscribeSessionEvents } from "../store/bus.ts";

function parseAfter(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): number {
  const q = c.req.query("after");
  if (q != null && q !== "") {
    const n = Number(q);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  const lastId = c.req.header("Last-Event-ID");
  if (lastId) {
    const n = Number(lastId);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  return 0;
}

export function registerSyncRoutes(app: Hono): void {
  app.get("/api/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const after = parseAfter(c);
    const live = c.req.query("live") !== "0";
    const missed = await readEventsAfter(id, after);
    const lastSeq = await getLastEventSeq(id);

    if (!live) {
      return c.json({ events: missed, lastSeq, after });
    }

    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const write = (seq: number, event: { type: string }) => {
        writes = writes.then(() =>
          stream.writeSSE({
            id: String(seq),
            event: event.type,
            data: JSON.stringify(event),
          }),
        );
      };

      for (const record of missed) {
        write(record.seq, record.event);
      }

      const unsubscribe = subscribeSessionEvents(id, (record) => {
        write(record.seq, record.event);
      });

      const abort = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      await abort;
      unsubscribe();
      await writes;
    });
  });
}
