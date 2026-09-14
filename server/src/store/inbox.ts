import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, ensureDir } from "../config.ts";
import type { InboxItem, InboxKind } from "../types.ts";
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

export async function addInboxItem(input: {
  kind: InboxKind;
  projectId: string;
  title: string;
  body: string;
  inviteToken?: string;
  sessionId?: string;
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
    sessionId: input.sessionId,
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
