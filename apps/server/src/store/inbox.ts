import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { InboxItem, InboxKind, ProjectInviteStatus } from "../types.ts";
import { atomicWriteJson, newId, nowIso } from "../util.ts";

const FILE = join(DATA_DIR, "inbox.json");

async function loadAll(): Promise<InboxItem[]> {
  if (!existsSync(FILE)) return [];
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as InboxItem[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveAll(items: InboxItem[]): Promise<void> {
  ensureDir(DATA_DIR);
  await atomicWriteJson(FILE, items);
}

export async function listInbox(): Promise<InboxItem[]> {
  const items = await loadAll();
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

export async function getInboxItem(id: string): Promise<InboxItem | null> {
  const items = await loadAll();
  return items.find((i) => i.id === id) ?? null;
}

export async function addInboxItem(input: {
  kind: InboxKind;
  projectId: string;
  title: string;
  body: string;
  inviteToken?: string;
  inviteId?: string;
  inviteStatus?: ProjectInviteStatus;
  projectName?: string;
  inviterName?: string;
  inviteeName?: string;
  inviteNote?: string;
  sessionId?: string;
  assetIds?: string[];
}): Promise<InboxItem> {
  const items = await loadAll();
  const item: InboxItem = {
    id: newId("inb"),
    kind: input.kind,
    projectId: input.projectId,
    title: input.title,
    body: input.body,
    read: false,
    createdAt: nowIso(),
    inviteToken: input.inviteToken,
    inviteId: input.inviteId,
    inviteStatus: input.inviteStatus,
    projectName: input.projectName,
    inviterName: input.inviterName,
    inviteeName: input.inviteeName,
    inviteNote: input.inviteNote,
    sessionId: input.sessionId,
    assetIds: input.assetIds?.length ? input.assetIds : undefined,
  };
  items.push(item);
  await saveAll(items);
  return item;
}

export async function markInboxRead(id: string): Promise<InboxItem | null> {
  const items = await loadAll();
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  item.read = true;
  await saveAll(items);
  return item;
}

/**
 * Unbind inbox rows that still name a deleted session.
 * Same field-clear as omitting sessionId; title / body / project / invite stay.
 */
export async function clearInboxSessionRefs(sessionId: string): Promise<void> {
  const target = sessionId.trim();
  if (!target) return;
  const items = await loadAll();
  let changed = false;
  for (const item of items) {
    if (item.sessionId !== target) continue;
    delete item.sessionId;
    changed = true;
  }
  if (changed) await saveAll(items);
}

/**
 * Drop inbox rows that still name a deleted project.
 * Invite / transfer stay the existing kinds — no archive / history model.
 */
export async function removeInboxItemsForProject(projectId: string): Promise<void> {
  const target = projectId.trim();
  if (!target) return;
  const items = await loadAll();
  const next = items.filter((item) => item.projectId !== target);
  if (next.length !== items.length) await saveAll(next);
}

export async function syncInboxInviteStatus(input: {
  inviteId?: string;
  inviteToken?: string;
  status: ProjectInviteStatus;
  markRead?: boolean;
}): Promise<InboxItem[]> {
  const inviteId = input.inviteId?.trim();
  const token = input.inviteToken?.trim();
  if (!inviteId && !token) return [];
  const items = await loadAll();
  const touched: InboxItem[] = [];
  for (const item of items) {
    if (item.kind !== "invite") continue;
    const match =
      (inviteId && item.inviteId === inviteId) ||
      (token && item.inviteToken === token);
    if (!match) continue;
    item.inviteStatus = input.status;
    if (input.markRead !== false) item.read = true;
    touched.push(item);
  }
  if (touched.length > 0) await saveAll(items);
  return touched;
}
