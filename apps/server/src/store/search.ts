import { classifyAssetPreview, readAssetBytes } from "./asset-preview.ts";
import { listMemoryRecords } from "./memory.ts";
import { listProjectRecords } from "./projects.ts";
import { listSessionRecords } from "./sessions.ts";
import type {
  ChatMessage,
  MemoryNote,
  Project,
  ProjectAsset,
  SearchHit,
  SearchHitType,
  SearchResponse,
  Session,
} from "../types.ts";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_ASSET_SEARCH_BYTES = 256_000;
export const RECENT_MESSAGE_LIMIT = 40;
const MAX_FIELD_CHARS = 8_000;
const MAX_MESSAGES_PER_PROJECT = 3;
const MAX_ASSETS_PER_PROJECT = 5;

export type RankedHit = SearchHit & { score: number; updatedAt: string };

export function clampSearchLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(raw)));
}

export function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

export function tokenizeQuery(q: string): string[] {
  const norm = normalizeQuery(q).toLowerCase();
  if (!norm) return [];
  const parts = norm.split(/[\s/\\,.;:|!?'"()[\]{}]+/).filter((t) => t.length > 0);
  return parts.length > 0 ? parts : [norm];
}

export function makeSnippet(text: string, needle: string, radius = 72): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const hay = collapsed.toLowerCase();
  const n = needle.toLowerCase().trim();
  let idx = n ? hay.indexOf(n) : 0;
  if (idx < 0) {
    idx = 0;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(collapsed.length, idx + Math.max(n.length, 12) + radius);
  let out = collapsed.slice(start, end);
  if (start > 0) out = `…${out}`;
  if (end < collapsed.length) out = `${out}…`;
  return out;
}

export function fieldMatch(
  text: string,
  query: string,
  tokens: string[],
): { matched: boolean; score: number } {
  if (!text) return { matched: false, score: 0 };
  const hay = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let matched = false;
  if (q && hay.includes(q)) {
    matched = true;
    if (hay === q) score += 24;
    else if (hay.startsWith(q)) score += 16;
    else score += 10;
  }
  if (tokens.length > 0) {
    let hits = 0;
    for (const token of tokens) {
      if (hay.includes(token)) hits += 1;
    }
    if (hits === tokens.length) {
      matched = true;
      score += hits * 3;
    }
  }
  return { matched, score };
}

export function shouldScanAssetContent(asset: ProjectAsset): boolean {
  if (asset.size > MAX_ASSET_SEARCH_BYTES) return false;
  const kind = classifyAssetPreview(asset.filename, asset.mimeType);
  return kind === "text" || kind === "markdown" || kind === "json";
}

function recencyBoost(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / 86_400_000;
  if (ageDays < 1) return 4;
  if (ageDays < 7) return 2;
  if (ageDays < 30) return 1;
  return 0;
}

function clip(text: string): string {
  return text.length <= MAX_FIELD_CHARS ? text : text.slice(0, MAX_FIELD_CHARS);
}

function snippetFor(text: string, query: string, tokens: string[]): string {
  const needle = query || tokens[0] || "";
  return makeSnippet(clip(text), needle);
}

function sessionHref(id: string): string {
  return `#/sessions/${id}`;
}

function projectHref(
  id: string,
  extra?: { assetId?: string; todoId?: string },
): string {
  const qs = new URLSearchParams();
  if (extra?.assetId) qs.set("asset", extra.assetId);
  if (extra?.todoId) qs.set("todo", extra.todoId);
  const q = qs.toString();
  return q ? `#/projects/${id}?${q}` : `#/projects/${id}`;
}

function memoryHref(id: string): string {
  return `#/memory/${id}`;
}

function recentTranscript(session: Session): ChatMessage[] {
  const usable = session.messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim(),
  );
  return usable.slice(-RECENT_MESSAGE_LIMIT);
}

function searchSession(session: Session, query: string, tokens: string[]): RankedHit | null {
  const titleHit = fieldMatch(session.title, query, tokens);
  let bestScore = titleHit.matched ? titleHit.score * 2 : 0;
  let snippet = titleHit.matched ? snippetFor(session.title, query, tokens) : "";
  let matched = titleHit.matched;

  for (const message of recentTranscript(session)) {
    const hit = fieldMatch(clip(message.content), query, tokens);
    if (!hit.matched) continue;
    matched = true;
    if (hit.score + 4 >= bestScore) {
      bestScore = hit.score + 4;
      snippet = snippetFor(message.content, query, tokens);
    }
  }

  if (!matched) return null;
  return {
    type: "session",
    id: session.id,
    title: session.title,
    snippet: snippet || session.title,
    href: sessionHref(session.id),
    sessionId: session.id,
    projectId: session.projectId,
    score: bestScore + recencyBoost(session.updatedAt),
    updatedAt: session.updatedAt,
  };
}

function pushHit(hits: RankedHit[], hit: RankedHit | null): void {
  if (hit) hits.push(hit);
}

function searchProjectMeta(project: Project, query: string, tokens: string[]): RankedHit | null {
  const nameHit = fieldMatch(project.name, query, tokens);
  const instHit = fieldMatch(clip(project.instruction), query, tokens);
  if (!nameHit.matched && !instHit.matched) return null;
  const score = nameHit.score * 2 + instHit.score + recencyBoost(project.updatedAt);
  const snippet = nameHit.matched
    ? snippetFor(project.name, query, tokens)
    : snippetFor(project.instruction, query, tokens);
  return {
    type: "project",
    id: project.id,
    title: project.name,
    snippet,
    href: projectHref(project.id),
    projectId: project.id,
    score,
    updatedAt: project.updatedAt,
  };
}

async function readAssetSearchText(projectId: string, asset: ProjectAsset): Promise<string | null> {
  if (!shouldScanAssetContent(asset)) return null;
  const buf = await readAssetBytes(projectId, asset);
  if (!buf || buf.length > MAX_ASSET_SEARCH_BYTES || buf.includes(0)) return null;
  return buf.toString("utf8");
}

async function searchProjectChildren(
  project: Project,
  query: string,
  tokens: string[],
): Promise<RankedHit[]> {
  const hits: RankedHit[] = [];

  for (const todo of project.todos) {
    const hit = fieldMatch(todo.title, query, tokens);
    if (!hit.matched) continue;
    hits.push({
      type: "todo",
      id: todo.id,
      title: todo.title,
      snippet: snippetFor(todo.title, query, tokens),
      href: projectHref(project.id, { todoId: todo.id }),
      projectId: project.id,
      todoId: todo.id,
      score: hit.score + recencyBoost(todo.updatedAt),
      updatedAt: todo.updatedAt,
    });
  }

  const messageHits: RankedHit[] = [];
  for (const message of project.messages) {
    const hit = fieldMatch(clip(message.body), query, tokens);
    if (!hit.matched) continue;
    messageHits.push({
      type: "project_message",
      id: message.id,
      title: `${project.name} · 动态`,
      snippet: snippetFor(message.body, query, tokens),
      href: projectHref(project.id),
      projectId: project.id,
      messageId: message.id,
      sessionId: message.sessionId,
      score: hit.score + recencyBoost(message.createdAt),
      updatedAt: message.createdAt,
    });
  }
  messageHits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  hits.push(...messageHits.slice(0, MAX_MESSAGES_PER_PROJECT));

  const assetHits: RankedHit[] = [];
  for (const asset of project.assets) {
    const nameHit = fieldMatch(asset.filename, query, tokens);
    let contentScore = 0;
    let contentSnippet = "";
    const text = await readAssetSearchText(project.id, asset);
    if (text) {
      const contentHit = fieldMatch(clip(text), query, tokens);
      if (contentHit.matched) {
        contentScore = contentHit.score;
        contentSnippet = snippetFor(text, query, tokens);
      }
    }
    if (!nameHit.matched && contentScore === 0) continue;
    const stamp = asset.updatedAt ?? asset.createdAt;
    assetHits.push({
      type: "asset",
      id: asset.id,
      title: asset.filename,
      snippet: nameHit.matched ? snippetFor(asset.filename, query, tokens) : contentSnippet,
      href: projectHref(project.id, { assetId: asset.id }),
      projectId: project.id,
      assetId: asset.id,
      sessionId: asset.sourceSessionId,
      score: nameHit.score * 2 + contentScore + recencyBoost(stamp),
      updatedAt: stamp,
    });
  }
  assetHits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  hits.push(...assetHits.slice(0, MAX_ASSETS_PER_PROJECT));

  return hits;
}

function memoryTitle(note: MemoryNote): string {
  const first = note.text.replace(/\s+/g, " ").trim();
  if (!first) return note.kind === "recap" ? "回合摘要" : "钉住笔记";
  return first.length <= 48 ? first : `${first.slice(0, 47)}…`;
}

function searchMemory(note: MemoryNote, query: string, tokens: string[]): RankedHit | null {
  const textHit = fieldMatch(clip(note.text), query, tokens);
  const tagHay = (note.tags ?? []).join(" ");
  const tagHit = fieldMatch(tagHay, query, tokens);
  if (!textHit.matched && !tagHit.matched) return null;
  const score = textHit.score + tagHit.score + recencyBoost(note.updatedAt);
  const snippet = textHit.matched
    ? snippetFor(note.text, query, tokens)
    : snippetFor(tagHay, query, tokens);
  return {
    type: "memory",
    id: note.id,
    title: memoryTitle(note),
    snippet,
    href: memoryHref(note.id),
    sessionId: note.sessionId,
    projectId: note.projectId,
    score,
    updatedAt: note.updatedAt,
  };
}

function toPublicHit(hit: RankedHit): SearchHit {
  const out: SearchHit = {
    type: hit.type,
    id: hit.id,
    title: hit.title,
    snippet: hit.snippet,
    href: hit.href,
  };
  if (hit.sessionId) out.sessionId = hit.sessionId;
  if (hit.projectId) out.projectId = hit.projectId;
  if (hit.assetId) out.assetId = hit.assetId;
  if (hit.todoId) out.todoId = hit.todoId;
  if (hit.messageId) out.messageId = hit.messageId;
  return out;
}

export async function searchLocal(
  rawQuery: string,
  opts: { limit?: number } = {},
): Promise<SearchResponse> {
  const q = normalizeQuery(rawQuery);
  const limit = clampSearchLimit(opts.limit ?? DEFAULT_SEARCH_LIMIT);
  if (!q) return { q: "", limit, hits: [] };

  const tokens = tokenizeQuery(q);
  const ranked: RankedHit[] = [];

  const [sessions, projects, notes] = await Promise.all([
    listSessionRecords(),
    listProjectRecords(),
    listMemoryRecords(),
  ]);
  for (const session of sessions) {
    pushHit(ranked, searchSession(session, q, tokens));
  }
  for (const project of projects) {
    pushHit(ranked, searchProjectMeta(project, q, tokens));
    ranked.push(...(await searchProjectChildren(project, q, tokens)));
  }
  for (const note of notes) {
    pushHit(ranked, searchMemory(note, q, tokens));
  }

  ranked.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  return { q, limit, hits: ranked.slice(0, limit).map(toPublicHit) };
}

export function searchHitTypes(): SearchHitType[] {
  return ["session", "project", "todo", "asset", "project_message", "memory"];
}
