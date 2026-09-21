import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { AgentEvent, SessionEventRecord } from "../types.ts";
import { nowIso } from "../util.ts";
import { publishSessionEvent } from "./bus.ts";

const SESSIONS_DIR = join(DATA_DIR, "sessions");
const lastSeqCache = new Map<string, number>();
const writeLocks = new Map<string, Promise<void>>();

export function sessionEventsDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}

export function sessionEventsPath(sessionId: string): string {
  return join(sessionEventsDir(sessionId), "events.jsonl");
}

export async function getLastEventSeq(sessionId: string): Promise<number> {
  const cached = lastSeqCache.get(sessionId);
  if (cached != null) return cached;
  const records = await readEventLog(sessionId);
  const last = records.at(-1)?.seq ?? 0;
  lastSeqCache.set(sessionId, last);
  return last;
}

export async function readEventLog(sessionId: string): Promise<SessionEventRecord[]> {
  const file = sessionEventsPath(sessionId);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  const records: SessionEventRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SessionEventRecord;
      if (typeof parsed.seq === "number" && parsed.event) records.push(parsed);
    } catch {
      // skip corrupt lines
    }
  }
  records.sort((a, b) => a.seq - b.seq);
  return records;
}

export async function readEventsAfter(
  sessionId: string,
  after: number,
): Promise<SessionEventRecord[]> {
  const records = await readEventLog(sessionId);
  return records.filter((r) => r.seq > after);
}

async function withWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(
    sessionId,
    prev.then(() => gate),
  );
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(sessionId) === gate) writeLocks.delete(sessionId);
  }
}

export async function appendSessionEvent(
  sessionId: string,
  event: AgentEvent,
): Promise<SessionEventRecord> {
  return withWriteLock(sessionId, async () => {
    const seq = (await getLastEventSeq(sessionId)) + 1;
    const record: SessionEventRecord = { seq, ts: nowIso(), event };
    const dir = sessionEventsDir(sessionId);
    ensureDir(dir);
    await mkdir(dir, { recursive: true });
    await appendFile(sessionEventsPath(sessionId), `${JSON.stringify(record)}\n`, "utf8");
    lastSeqCache.set(sessionId, seq);
    return record;
  });
}

/** Persist + fan-out to every live SSE subscriber on this session. */
export async function publishPersistedEvent(
  sessionId: string,
  event: AgentEvent,
): Promise<SessionEventRecord> {
  const record = await appendSessionEvent(sessionId, event);
  publishSessionEvent(sessionId, record);
  return record;
}

export async function deleteSessionEvents(sessionId: string): Promise<void> {
  lastSeqCache.delete(sessionId);
  const dir = sessionEventsDir(sessionId);
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
}
