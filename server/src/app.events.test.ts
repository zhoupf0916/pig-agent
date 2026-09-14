import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { DEFAULT_SETTINGS } from "./config.ts";
import { parseEventCursor } from "./routes/sync.ts";
import { getLastEventSeq, publishPersistedEvent, readEventLog } from "./store/events.ts";

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type SseRec = {
  seq?: number;
  type: string;
  text?: string;
  phase?: string;
  after?: number;
  gap?: number;
  lastSeq?: number;
};

async function readSseRecords(
  body: ReadableStream<Uint8Array> | null,
  count: number,
  ms = 2_000,
  opts: { includeSync?: boolean } = {},
): Promise<SseRec[]> {
  if (!body) throw new Error("missing body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: SseRec[] = [];
  const deadline = Date.now() + ms;
  while (out.length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const read = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (read.done && !read.value) break;
    buffer += decoder.decode(read.value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const idLine = part.split(/\r?\n/).find((l) => l.startsWith("id:"));
      const dataLine = part
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!dataLine) continue;
      const event = JSON.parse(dataLine) as {
        type: string;
        text?: string;
        phase?: string;
        after?: number;
        gap?: number;
        lastSeq?: number;
      };
      if (!opts.includeSync && event.type === "sync") continue;
      const seqRaw = idLine?.slice(3).trim();
      const seq = seqRaw != null && seqRaw !== "" ? Number(seqRaw) : undefined;
      out.push({
        seq: Number.isFinite(seq) ? seq : undefined,
        type: event.type,
        text: event.text,
        phase: event.phase,
        after: event.after,
        gap: event.gap,
        lastSeq: event.lastSeq,
      });
      if (out.length >= count) break;
    }
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

describe("session event catch-up API", () => {
  const app = createApp();

  it("keeps default runtime pig", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
  });

  it("prefers after over Last-Event-ID for the exclusive cursor", () => {
    expect(
      parseEventCursor({
        query: (k) => (k === "after" ? "4" : undefined),
        header: (k) => (k === "Last-Event-ID" ? "1" : undefined),
      }),
    ).toBe(4);
    expect(
      parseEventCursor({
        query: () => undefined,
        header: (k) => (k === "Last-Event-ID" ? "9" : undefined),
      }),
    ).toBe(9);
  });

  it("replays persisted events after a given seq", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    await publishPersistedEvent(session.id, { type: "status", status: "running" });
    await publishPersistedEvent(session.id, { type: "token", text: "alpha" });
    await publishPersistedEvent(session.id, { type: "token", text: "beta" });

    const replay = await app.request(`/api/sessions/${session.id}/events?after=1&live=0`);
    expect(replay.status).toBe(200);
    const body = await json<{
      lastSeq: number;
      events: Array<{ seq: number; event: { type: string; text?: string } }>;
    }>(replay);
    expect(body.lastSeq).toBe(3);
    expect(body.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(body.events.map((e) => e.event.text)).toEqual(["alpha", "beta"]);
  });

  it("honors Last-Event-ID when after is omitted", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    await publishPersistedEvent(session.id, { type: "token", text: "one" });
    await publishPersistedEvent(session.id, { type: "token", text: "two" });
    const replay = await app.request(`/api/sessions/${session.id}/events?live=0`, {
      headers: { "Last-Event-ID": "1" },
    });
    const body = await json<{ events: Array<{ seq: number }> }>(replay);
    expect(body.events.map((e) => e.seq)).toEqual([2]);
  });

  it("delivers the same live sequence to two SSE subscribers", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    const res1 = await app.request(`/api/sessions/${session.id}/events`);
    const res2 = await app.request(`/api/sessions/${session.id}/events`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const collecting = Promise.all([
      readSseRecords(res1.body, 2),
      readSseRecords(res2.body, 2),
    ]);

    await publishPersistedEvent(session.id, { type: "token", text: "x" });
    await publishPersistedEvent(session.id, { type: "token", text: "y" });

    const [left, right] = await collecting;
    expect(left.map((e) => e.seq)).toEqual([1, 2]);
    expect(right.map((e) => e.seq)).toEqual([1, 2]);
    expect(left.map((e) => e.type)).toEqual(["token", "token"]);
    expect(right.map((e) => e.type)).toEqual(["token", "token"]);
  });

  it("reconnects from Last-Event-ID with the gap only (no full-history replay)", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    await publishPersistedEvent(session.id, { type: "status", status: "running" });
    await publishPersistedEvent(session.id, { type: "token", text: "alpha" });
    await publishPersistedEvent(session.id, { type: "token", text: "beta" });

    const first = await app.request(`/api/sessions/${session.id}/events?after=0`);
    const seen = await readSseRecords(first.body, 3);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(seen.map((e) => e.type)).toEqual(["status", "token", "token"]);

    await publishPersistedEvent(session.id, { type: "token", text: "gamma" });
    await publishPersistedEvent(session.id, { type: "status", status: "idle" });

    const reconnect = await app.request(`/api/sessions/${session.id}/events`, {
      headers: { "Last-Event-ID": "3", Accept: "text/event-stream" },
    });
    expect(reconnect.status).toBe(200);
    const frames = await readSseRecords(reconnect.body, 4, 2_000, { includeSync: true });
    const syncs = frames.filter((e) => e.type === "sync");
    const data = frames.filter((e) => e.type !== "sync");

    expect(syncs[0]?.phase).toBe("catching_up");
    expect(syncs[0]?.after).toBe(3);
    expect(syncs[0]?.gap).toBe(2);
    expect(syncs.some((s) => s.phase === "live")).toBe(true);

    expect(data.map((e) => e.seq)).toEqual([4, 5]);
    expect(data.every((e) => (e.seq ?? 0) > 3)).toBe(true);
    expect(data.some((e) => (e.seq ?? 0) <= 3)).toBe(false);
    expect(data.map((e) => e.type)).toEqual(["token", "status"]);
    expect(data[0]?.text).toBe("gamma");

    const persisted = await readEventLog(session.id);
    expect(persisted).toHaveLength(5);
    expect(persisted.every((r) => r.event.type !== "sync")).toBe(true);
    expect(await getLastEventSeq(session.id)).toBe(5);
  });

  it("reconnects with ?after= incrementally and does not dual-write", async () => {
    const session = await json<{ id: string }>(await app.request("/api/sessions", { method: "POST" }));
    await publishPersistedEvent(session.id, { type: "token", text: "one" });
    await publishPersistedEvent(session.id, { type: "token", text: "two" });
    await publishPersistedEvent(session.id, { type: "token", text: "three" });

    const before = await readEventLog(session.id);
    const reconnect = await app.request(`/api/sessions/${session.id}/events?after=2`);
    const frames = await readSseRecords(reconnect.body, 3, 2_000, { includeSync: true });
    const data = frames.filter((e) => e.type !== "sync");
    expect(data.map((e) => e.seq)).toEqual([3]);
    expect(data.map((e) => e.text)).toEqual(["three"]);

    const after = await readEventLog(session.id);
    expect(after).toEqual(before);
    expect(after.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});
