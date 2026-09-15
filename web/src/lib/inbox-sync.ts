import type { InboxItem, ProjectInviteStatus } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  browserSessionListClock,
  type SessionListSyncClock,
} from "./session-list-sync";

/** Read-only inbox refresh. Same-host tabs pick up invite / transfer / read from GET /api/inbox. */
export const INBOX_SYNC_POLL_MS = 2_000;

const KINDS = new Set<InboxItem["kind"]>(["invite", "handoff"]);
const STATUSES = new Set<ProjectInviteStatus>(["pending", "accepted", "declined", "revoked"]);

/** Existing GET /api/inbox body — unread badge + list. */
export type InboxSnapshot = {
  items: InboxItem[];
  unread: number;
};

export function normalizeInboxText(value?: string | null): string {
  if (typeof value !== "string") return "";
  return value;
}

function normalizeKind(kind: InboxItem["kind"] | string | undefined): InboxItem["kind"] {
  return kind === "handoff" ? "handoff" : "invite";
}

function normalizeStatus(
  status: InboxItem["inviteStatus"] | string | undefined,
): ProjectInviteStatus | undefined {
  return STATUSES.has(status as ProjectInviteStatus) ? (status as ProjectInviteStatus) : undefined;
}

function normalizeIds(ids?: string[] | null): string[] | undefined {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  return ids.map((id) => String(id));
}

function scrubInboxText(value?: string | null, token?: string | null): string {
  const redacted = redactSecretsForDisplay(normalizeInboxText(value));
  const secret = typeof token === "string" ? token.trim() : "";
  return secret ? redacted.split(secret).join("…") : redacted;
}

function optionalScrubbed(value?: string | null, token?: string | null): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return scrubInboxText(value, token);
}

/**
 * Fields the header inbox menu and unread badge actually paint.
 * Drops `inviteToken` and unknown keys so snapshots never become a secret store.
 */
export function sanitizeInboxItem(item: InboxItem): InboxItem {
  const token = typeof item.inviteToken === "string" ? item.inviteToken : undefined;
  const clean: InboxItem = {
    id: item.id,
    kind: KINDS.has(item.kind) ? item.kind : normalizeKind(item.kind),
    projectId: item.projectId,
    title: scrubInboxText(item.title, token),
    body: scrubInboxText(item.body, token),
    read: Boolean(item.read),
    createdAt: item.createdAt,
  };
  const inviteStatus = normalizeStatus(item.inviteStatus);
  if (inviteStatus) clean.inviteStatus = inviteStatus;
  if (typeof item.inviteId === "string" && item.inviteId) clean.inviteId = item.inviteId;
  const projectName = optionalScrubbed(item.projectName, token);
  if (projectName) clean.projectName = projectName;
  const inviterName = optionalScrubbed(item.inviterName, token);
  if (inviterName) clean.inviterName = inviterName;
  const inviteeName = optionalScrubbed(item.inviteeName, token);
  if (inviteeName) clean.inviteeName = inviteeName;
  const inviteNote = optionalScrubbed(item.inviteNote, token);
  if (inviteNote) clean.inviteNote = inviteNote;
  if (typeof item.sessionId === "string" && item.sessionId) clean.sessionId = item.sessionId;
  const assetIds = normalizeIds(item.assetIds);
  if (assetIds) clean.assetIds = assetIds;
  return clean;
}

export function inboxItemSyncKey(item: InboxItem): string {
  return [
    item.id,
    normalizeKind(item.kind),
    item.projectId ?? "",
    normalizeInboxText(item.title),
    normalizeInboxText(item.body),
    item.read ? "1" : "0",
    item.inviteStatus ?? "",
    item.inviteId ?? "",
    normalizeInboxText(item.projectName),
    normalizeInboxText(item.inviterName),
    normalizeInboxText(item.inviteeName),
    normalizeInboxText(item.inviteNote),
    item.sessionId ?? "",
    (item.assetIds ?? []).join("\u0002"),
    item.createdAt ?? "",
  ].join("\u0001");
}

export function inboxUnreadFromItems(items: InboxItem[]): number {
  return items.filter((item) => !item.read).length;
}

export function normalizeInboxUnread(value: number | undefined, items: InboxItem[]): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return inboxUnreadFromItems(items);
}

/**
 * Replace the header inbox with a GET /api/inbox snapshot.
 * Same object reference when badge + list are unchanged (avoids extra renders).
 * Adds / updates / removes rows so Tab A invite / transfer / read / accept / ignore catch up.
 * Read-only: never POSTs accept / decline / read or writes sessions / events.
 */
export function applyInboxSnapshot(prev: InboxSnapshot, next: InboxSnapshot): InboxSnapshot {
  const items = next.items.map(sanitizeInboxItem);
  const unread = normalizeInboxUnread(next.unread, items);
  if (
    prev.unread === unread &&
    prev.items.length === items.length &&
    prev.items.every((row, i) => {
      const other = items[i];
      return other !== undefined && inboxItemSyncKey(row) === inboxItemSyncKey(other);
    })
  ) {
    return prev;
  }
  return { items, unread };
}

/**
 * Periodically GET the existing inbox (and on tab focus / visible).
 * Hidden tabs skip interval ticks; becoming visible fetches immediately.
 */
export function startInboxSync(opts: {
  fetchInbox: () => Promise<InboxSnapshot>;
  onInbox: (next: InboxSnapshot) => void;
  intervalMs?: number;
  clock?: SessionListSyncClock;
}): () => void {
  const intervalMs = opts.intervalMs ?? INBOX_SYNC_POLL_MS;
  const clock = opts.clock ?? browserSessionListClock();
  let stopped = false;
  let inFlight = false;

  const refresh = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const next = await opts.fetchInbox();
      if (!stopped) opts.onInbox(next);
    } catch {
      // keep the last good badge / list
    } finally {
      inFlight = false;
    }
  };

  const tick = () => {
    if (clock.isVisible()) void refresh();
  };

  void refresh();
  const timer = clock.setInterval(tick, intervalMs);
  clock.addListener("visibilitychange", tick);
  clock.addListener("focus", tick);

  return () => {
    stopped = true;
    clock.clearInterval(timer);
    clock.removeListener("visibilitychange", tick);
    clock.removeListener("focus", tick);
  };
}
