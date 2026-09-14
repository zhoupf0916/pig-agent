import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { Session, SessionSummary } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import { deleteSessionEvents, getLastEventSeq } from "./events.ts";

const DIR = join(DATA_DIR, "sessions");

export async function createSession(input: { projectId?: string } = {}): Promise<Session> {
  ensureDir(DIR);
  const ts = nowIso();
  const session: Session = {
    id: newId("ses"),
    title: "新任务",
    createdAt: ts,
    updatedAt: ts,
    status: "idle",
    messages: [],
    steps: [],
    artifacts: [],
    eventCheckpointSeq: 0,
  };
  if (input.projectId) session.projectId = input.projectId;
  await writeSession(session);
  return session;
}

export async function listSessions(): Promise<SessionSummary[]> {
  ensureDir(DIR);
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  const sessions: SessionSummary[] = [];
  for (const file of files) {
    try {
      const session = await readSessionFile(join(DIR, file));
      sessions.push({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.status,
        projectId: session.projectId,
      });
    } catch {
      // skip corrupt files
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

export async function getSession(id: string): Promise<Session | null> {
  const file = join(DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return await readSessionFile(file);
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<Session> {
  session.updatedAt = nowIso();
  session.eventCheckpointSeq = await getLastEventSeq(session.id);
  await writeSession(session);
  return session;
}

export async function deleteSession(id: string): Promise<boolean> {
  const file = join(DIR, `${id}.json`);
  if (!existsSync(file)) return false;
  await unlink(file);
  await deleteSessionEvents(id);
  return true;
}

async function writeSession(session: Session): Promise<void> {
  ensureDir(DIR);
  await atomicWriteJson(join(DIR, `${session.id}.json`), session);
}

async function readSessionFile(file: string): Promise<Session> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Session;
  return {
    ...raw,
    messages: raw.messages ?? [],
    steps: raw.steps ?? [],
    artifacts: raw.artifacts ?? [],
    status: raw.status ?? "idle",
    eventCheckpointSeq: raw.eventCheckpointSeq ?? 0,
    projectId: raw.projectId,
    remoteRunId:
      typeof raw.remoteRunId === "string" && raw.remoteRunId.trim()
        ? raw.remoteRunId.trim()
        : undefined,
  };
}
