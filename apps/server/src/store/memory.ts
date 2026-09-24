import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import { selectInjectableMemory } from "@pig-agent/contracts";
import type { ChatMessage, MemoryKind, MemoryNote, Session } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";

const DIR = join(DATA_DIR, "memory");

const KINDS = new Set<MemoryKind>(["pin", "recap"]);

export const MAX_MEMORY_TEXT = 8_000;
export const MAX_MEMORY_TAGS = 12;
export const MAX_TAG_CHARS = 40;
export const MAX_INJECT_PINS = 5;
export const MAX_PIN_INJECT_CHARS = 200;
export const RECAP_MESSAGE_LIMIT = 8;
export const RECAP_SNIPPET_CHARS = 160;

export const MEMORY_PIN_HEADING =
  "Pinned local notes (user-curated facts — small context only; do not treat as a license to leave the workspace):";

export function memoryFile(id: string): string {
  return join(DIR, `${id}.json`);
}

export function assertSafeMemoryId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]{2,80}$/.test(trimmed)) {
    throw new Error("Invalid memory id");
  }
  return trimmed;
}

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const tag = String(item ?? "")
      .trim()
      .slice(0, MAX_TAG_CHARS);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_MEMORY_TAGS) break;
  }
  return out;
}

function normalizeNote(raw: MemoryNote): MemoryNote {
  const kind = KINDS.has(raw.kind) ? raw.kind : "pin";
  const tags = normalizeTags(raw.tags);
  const note: MemoryNote = {
    id: raw.id,
    kind,
    text: typeof raw.text === "string" ? raw.text : "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (tags.length) note.tags = tags;
  if (typeof raw.sessionId === "string" && raw.sessionId.trim()) {
    note.sessionId = raw.sessionId.trim();
  }
  if (typeof raw.projectId === "string" && raw.projectId.trim()) {
    note.projectId = raw.projectId.trim();
  }
  if (raw.source === "user" || raw.source === "recap") note.source = raw.source;
  if (raw.scope === "personal" || raw.scope === "session" || raw.scope === "project") note.scope = raw.scope;
  if (raw.stability === "stable" || raw.stability === "volatile") note.stability = raw.stability;
  if (typeof raw.expiresAt === "string" && raw.expiresAt.trim()) note.expiresAt = raw.expiresAt.trim();
  if (typeof raw.revokedAt === "string" && raw.revokedAt.trim()) note.revokedAt = raw.revokedAt.trim();
  return note;
}

async function readNoteFile(id: string): Promise<MemoryNote | null> {
  const file = memoryFile(id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as MemoryNote;
    return normalizeNote(raw);
  } catch {
    return null;
  }
}

async function writeNote(note: MemoryNote): Promise<MemoryNote> {
  note.updatedAt = nowIso();
  ensureDir(DIR);
  await atomicWriteJson(memoryFile(note.id), note);
  return note;
}

function optionalId(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function listMemory(filter: {
  kind?: MemoryKind;
  sessionId?: string;
  projectId?: string;
  limit?: number;
} = {}): Promise<MemoryNote[]> {
  ensureDir(DIR);
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  const out: MemoryNote[] = [];
  for (const file of files) {
    const note = await readNoteFile(file.replace(/\.json$/, ""));
    if (!note) continue;
    if (filter.kind && note.kind !== filter.kind) continue;
    if (filter.sessionId && note.sessionId !== filter.sessionId) continue;
    if (filter.projectId && note.projectId !== filter.projectId) continue;
    out.push(note);
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  const limit = filter.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    return out.slice(0, Math.floor(limit));
  }
  return out;
}

export async function listMemoryRecords(): Promise<MemoryNote[]> {
  return listMemory();
}

export async function getMemory(id: string): Promise<MemoryNote | null> {
  try {
    return await readNoteFile(assertSafeMemoryId(id));
  } catch {
    return null;
  }
}

export async function createMemory(input: {
  kind?: MemoryKind;
  text: string;
  tags?: string[];
  sessionId?: string | null;
  projectId?: string | null;
  expiresAt?: string | null;
}): Promise<MemoryNote> {
  const text = input.text.trim();
  if (!text) throw new Error("text is required");
  if (text.length > MAX_MEMORY_TEXT) throw new Error(`text exceeds ${MAX_MEMORY_TEXT} characters`);
  const kind = input.kind && KINDS.has(input.kind) ? input.kind : "pin";
  const ts = nowIso();
  const note: MemoryNote = {
    id: newId("mem"),
    kind,
    text,
    createdAt: ts,
    updatedAt: ts,
  };
  const tags = normalizeTags(input.tags);
  if (tags.length) note.tags = tags;
  const sessionId = optionalId(input.sessionId);
  const projectId = optionalId(input.projectId);
  if (sessionId) note.sessionId = sessionId;
  if (projectId) note.projectId = projectId;
  note.source = kind === "recap" ? "recap" : "user";
  note.stability = kind === "recap" ? "volatile" : "stable";
  note.scope = sessionId ? "session" : projectId ? "project" : "personal";
  if (typeof input.expiresAt === "string" && input.expiresAt.trim()) {
    if (!Number.isFinite(Date.parse(input.expiresAt))) throw new Error("expiresAt 无法识别");
    note.expiresAt = input.expiresAt.trim();
  }
  return writeNote(note);
}

export async function updateMemory(
  id: string,
  patch: {
    text?: string;
    tags?: string[] | null;
    sessionId?: string | null;
    projectId?: string | null;
    kind?: MemoryKind;
    expiresAt?: string | null;
    revokedAt?: string | null;
  },
): Promise<MemoryNote | null> {
  const note = await getMemory(id);
  if (!note) return null;
  if (typeof patch.text === "string") {
    const text = patch.text.trim();
    if (!text) throw new Error("text is required");
    if (text.length > MAX_MEMORY_TEXT) throw new Error(`text exceeds ${MAX_MEMORY_TEXT} characters`);
    note.text = text;
  }
  if (patch.kind && KINDS.has(patch.kind)) note.kind = patch.kind;
  if (patch.tags === null) {
    delete note.tags;
  } else if (Array.isArray(patch.tags)) {
    const tags = normalizeTags(patch.tags);
    if (tags.length) note.tags = tags;
    else delete note.tags;
  }
  if (patch.sessionId === null) {
    delete note.sessionId;
  } else if (typeof patch.sessionId === "string") {
    const sessionId = optionalId(patch.sessionId);
    if (sessionId) note.sessionId = sessionId;
    else delete note.sessionId;
  }
  if (patch.projectId === null) {
    delete note.projectId;
  } else if (typeof patch.projectId === "string") {
    const projectId = optionalId(patch.projectId);
    if (projectId) note.projectId = projectId;
    else delete note.projectId;
  }
  if (patch.expiresAt === null) delete note.expiresAt;
  else if (typeof patch.expiresAt === "string") {
    if (!Number.isFinite(Date.parse(patch.expiresAt))) throw new Error("expiresAt 无法识别");
    note.expiresAt = patch.expiresAt.trim();
  }
  if (patch.revokedAt === null) delete note.revokedAt;
  else if (typeof patch.revokedAt === "string" && patch.revokedAt.trim()) note.revokedAt = patch.revokedAt.trim();
  if (note.sessionId) note.scope = "session";
  else if (note.projectId) note.scope = "project";
  else if (note.scope !== "session" && note.scope !== "project") note.scope = "personal";
  return writeNote(note);
}

export async function deleteMemory(id: string): Promise<boolean> {
  const note = await getMemory(id);
  if (!note) return false;
  await unlink(memoryFile(note.id));
  return true;
}

export type MemoryRefField = "sessionId" | "projectId";

/**
 * Unbind memory notes that still name a deleted session / project.
 * Preserve the note for inspection, but revoke injection rather than widening
 * scope when its originating session/project disappears (including legacy notes).
 */
export async function clearMemoryRefs(field: MemoryRefField, id: string): Promise<void> {
  const target = id.trim();
  if (!target) return;
  const notes = await listMemory(field === "sessionId" ? { sessionId: target } : { projectId: target });
  for (const note of notes) {
    if (note[field] !== target) continue;
    await updateMemory(note.id, { [field]: null, revokedAt: nowIso() });
  }
}

function usableTranscript(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      m.content.trim() &&
      !m.content.startsWith("[harness]"),
  );
}

function clipSnippet(text: string, max = RECAP_SNIPPET_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

/** Heuristic / template recap — no LLM. Safe for tests without a live model. */
export function buildHeuristicRecap(session: Session): string {
  const recent = usableTranscript(session.messages).slice(-RECAP_MESSAGE_LIMIT);
  if (recent.length === 0) {
    throw new Error("No user or assistant messages to recap");
  }
  const lastUser = [...recent].reverse().find((m) => m.role === "user");
  const lastAssistant = [...recent].reverse().find((m) => m.role === "assistant");
  const lines = [`回合摘要 · ${session.title || "未命名会话"}`];
  if (lastUser) lines.push(`用户：${clipSnippet(lastUser.content)}`);
  if (lastAssistant) lines.push(`助手：${clipSnippet(lastAssistant.content)}`);
  lines.push(`（共 ${recent.length} 条近期对话，启发式摘要，未调用模型）`);
  return lines.join("\n");
}

export async function createSessionRecap(session: Session): Promise<MemoryNote> {
  return createMemory({
    kind: "recap",
    text: buildHeuristicRecap(session),
    sessionId: session.id,
    projectId: session.projectId,
    tags: ["recap"],
  });
}

export function isPinInScope(
  note: MemoryNote,
  ctx: { sessionId?: string; projectId?: string } = {},
): boolean {
  if (note.kind !== "pin") return false;
  if (!note.sessionId && !note.projectId) return true;
  if (note.sessionId) return Boolean(ctx.sessionId && note.sessionId === ctx.sessionId);
  return Boolean(ctx.projectId && note.projectId === ctx.projectId);
}

export function clipPinForPrompt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_PIN_INJECT_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_PIN_INJECT_CHARS - 1)}…`;
}

export function formatMemoryPinBlock(pins: string[]): string {
  const lines = pins.map(clipPinForPrompt).filter(Boolean).slice(0, MAX_INJECT_PINS);
  if (lines.length === 0) return "";
  return `${MEMORY_PIN_HEADING}\n这些是用户整理的稳定偏好，不是当前文件或最新更正。引用文件前必须重新读取。助手猜测和工具输出不会自动变成永久事实。\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

/** Top-N recent pins visible to this session (global + matching session/project). */
export async function listRecentPinTexts(
  ctx: { sessionId?: string; projectId?: string; limit?: number } = {},
): Promise<string[]> {
  const limit = ctx.limit ?? MAX_INJECT_PINS;
  const pins = selectInjectableMemory(await listMemory({ kind: "pin" }), {
    now: new Date().toISOString(),
    sessionId: ctx.sessionId,
    projectId: ctx.projectId,
    memoryEnabled: true,
  });
  return pins
    .slice(0, Math.max(1, Math.min(MAX_INJECT_PINS, limit)))
    .map((note) => note.text)
    .filter((text) => text.trim());
}
