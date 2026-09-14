import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { Session, SessionSummary } from "../types.ts";
import { normalizeTeamRun } from "./team-run-state.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";
import { deleteSessionEvents, getLastEventSeq } from "./events.ts";

const DIR = join(DATA_DIR, "sessions");

export async function createSession(
  input: { projectId?: string; expertId?: string; expertTeamId?: string } = {},
): Promise<Session> {
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
  if (input.expertId) session.expertId = input.expertId;
  if (input.expertTeamId) session.expertTeamId = input.expertTeamId;
  await writeSession(session);
  return session;
}

export async function listSessionRecords(): Promise<Session[]> {
  ensureDir(DIR);
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  const sessions: Session[] = [];
  for (const file of files) {
    try {
      sessions.push(await readSessionFile(join(DIR, file)));
    } catch {
      // skip corrupt files
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const sessions = await listSessionRecords();
  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    projectId: session.projectId,
    expertId: session.expertId,
    expertTeamId: session.expertTeamId,
  }));
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
    expertId:
      typeof raw.expertId === "string" && raw.expertId.trim() ? raw.expertId.trim() : undefined,
    expertTeamId:
      typeof raw.expertTeamId === "string" && raw.expertTeamId.trim()
        ? raw.expertTeamId.trim()
        : undefined,
    remoteRunId:
      typeof raw.remoteRunId === "string" && raw.remoteRunId.trim()
        ? raw.remoteRunId.trim()
        : undefined,
    remoteRetry: parseRemoteRetry(raw.remoteRetry),
    localRetry: parseLocalRetry(raw.localRetry),
    teamRun: normalizeTeamRun(raw.teamRun),
  };
}

function parseRemoteRetry(raw: unknown): Session["remoteRetry"] {
  if (raw === "follow-up" || raw === "create-run" || raw === "unavailable") return raw;
  return undefined;
}

function parseLocalRetry(raw: unknown): Session["localRetry"] {
  if (raw === "turn" || raw === "unavailable") return raw;
  return undefined;
}
