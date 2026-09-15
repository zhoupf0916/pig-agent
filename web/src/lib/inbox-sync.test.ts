import { describe, expect, it } from "vitest";
import type { InboxItem } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyInboxSnapshot,
  INBOX_SYNC_POLL_MS,
  inboxItemSyncKey,
  sanitizeInboxItem,
  startInboxSync,
  type InboxSnapshot,
} from "./inbox-sync";

function item(overrides: Partial<InboxItem> & { id: string } = { id: "inb_a" }): InboxItem {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "invite",
    projectId: overrides.projectId ?? "prj_a",
    title: overrides.title ?? "邀请加入「协作空间」",
    body: overrides.body ?? "本机用户 邀请 小陈 加入「协作空间」",
    read: overrides.read ?? false,
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    inviteToken: overrides.inviteToken,
    inviteId: overrides.inviteId,
    inviteStatus: overrides.inviteStatus,
    projectName: overrides.projectName ?? "协作空间",
    inviterName: overrides.inviterName ?? "本机用户",
    inviteeName: overrides.inviteeName,
    inviteNote: overrides.inviteNote,
    sessionId: overrides.sessionId,
    assetIds: overrides.assetIds,
  };
}

function snapshot(items: InboxItem[], unread = items.filter((row) => !row.read).length): InboxSnapshot {
  return { items, unread };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeClock(visible = true) {
  const intervals: Array<{ fn: () => void }> = [];
  const listeners = new Map<string, Set<() => void>>();
  let vis = visible;
  const clock: SessionListSyncClock = {
    setInterval: (fn) => {
      intervals.push({ fn });
      return intervals.length;
    },
    clearInterval: () => {
      intervals.length = 0;
    },
    addListener: (type, handler) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
    },
    removeListener: (type, handler) => {
      listeners.get(type)?.delete(handler);
    },
    isVisible: () => vis,
  };
  return {
    clock,
    tickInterval() {
      for (const item of [...intervals]) item.fn();
    },
    setVisible(next: boolean) {
      vis = next;
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
    focus() {
      for (const fn of listeners.get("focus") ?? []) fn();
    },
  };
}

function painted(row: InboxItem | undefined) {
  return {
    id: row?.id,
    kind: row?.kind,
    title: row?.title,
    body: row?.kind === "handoff" ? row.body : undefined,
    read: row?.read,
    inviteStatus: row?.inviteStatus,
    projectName: row?.projectName,
    inviterName: row?.inviterName,
    inviteeName: row?.inviteeName,
    inviteNote: row?.inviteNote,
    sessionId: row?.sessionId,
    assetIds: row?.assetIds ?? [],
  };
}

describe("inbox cross-tab sync (Milestone AF)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(INBOX_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous snapshot reference when badge + list are unchanged", () => {
    const prev = snapshot([
      item({
        id: "inb_a",
        inviteStatus: "pending",
        inviteeName: "小陈",
        inviteNote: "帮忙看 brief",
      }),
    ]);
    const next = snapshot([
      item({
        id: "inb_a",
        inviteStatus: "pending",
        inviteeName: "小陈",
        inviteNote: "帮忙看 brief",
      }),
    ]);
    expect(applyInboxSnapshot(prev, next)).toBe(prev);
    expect(inboxItemSyncKey(prev.items[0]!)).toBe(inboxItemSyncKey(sanitizeInboxItem(next.items[0]!)));
  });

  it("Tab B badge + list follow Tab A invite / transfer / read / accept / ignore without a remount", async () => {
    let server = snapshot([]);
    let tabB = snapshot([]);
    const { clock, tickInterval } = fakeClock(true);

    const stop = startInboxSync({
      fetchInbox: async () => ({
        unread: server.unread,
        items: server.items.map((row) => ({
          ...row,
          assetIds: row.assetIds ? [...row.assetIds] : undefined,
        })),
      }),
      onInbox: (next) => {
        tabB = applyInboxSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabB).toEqual({ items: [], unread: 0 });

    server = snapshot([
      item({
        id: "inb_invite",
        kind: "invite",
        inviteId: "pinv_a",
        inviteStatus: "pending",
        inviteeName: "小陈",
        inviteNote: "帮忙看 brief",
        inviteToken: "inv_keep_off_menu",
      }),
    ]);
    tickInterval();
    await flush();
    expect(tabB.unread).toBe(1);
    expect(painted(tabB.items[0])).toEqual({
      id: "inb_invite",
      kind: "invite",
      title: "邀请加入「协作空间」",
      body: undefined,
      read: false,
      inviteStatus: "pending",
      projectName: "协作空间",
      inviterName: "本机用户",
      inviteeName: "小陈",
      inviteNote: "帮忙看 brief",
      sessionId: undefined,
      assetIds: [],
    });
    expect(tabB.items[0]).not.toHaveProperty("inviteToken");

    server = snapshot([
      item({
        id: "inb_handoff",
        kind: "handoff",
        title: "转交：请接手 brief",
        body: "请从 brief 接着做",
        sessionId: "ses_a",
        assetIds: ["ast_a"],
        createdAt: "2026-09-14T12:08:00.000Z",
      }),
      ...server.items,
    ]);
    tickInterval();
    await flush();
    expect(tabB.unread).toBe(2);
    expect(tabB.items.map((row) => row.id)).toEqual(["inb_handoff", "inb_invite"]);
    expect(painted(tabB.items.find((row) => row.id === "inb_handoff"))).toEqual({
      id: "inb_handoff",
      kind: "handoff",
      title: "转交：请接手 brief",
      body: "请从 brief 接着做",
      read: false,
      inviteStatus: undefined,
      projectName: "协作空间",
      inviterName: "本机用户",
      inviteeName: undefined,
      inviteNote: undefined,
      sessionId: "ses_a",
      assetIds: ["ast_a"],
    });

    server = snapshot([
      { ...server.items[0]!, read: true },
      { ...server.items[1]!, read: true },
    ]);
    tickInterval();
    await flush();
    expect(tabB.unread).toBe(0);
    expect(tabB.items.every((row) => row.read)).toBe(true);

    server = snapshot([
      server.items[0]!,
      { ...server.items[1]!, inviteStatus: "accepted", read: true },
    ]);
    tickInterval();
    await flush();
    expect(tabB.items.find((row) => row.id === "inb_invite")?.inviteStatus).toBe("accepted");

    server = snapshot([
      server.items[0]!,
      { ...server.items[1]!, inviteStatus: "declined", read: true },
    ]);
    tickInterval();
    await flush();
    expect(tabB.items.find((row) => row.id === "inb_invite")?.inviteStatus).toBe("declined");
    expect(tabB.unread).toBe(0);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = snapshot([item({ id: "inb_a" })]);
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startInboxSync({
      fetchInbox: async () => {
        calls += 1;
        return snapshot(server.items.map((row) => ({ ...row })));
      },
      onInbox: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats inbox snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...item({
        id: "inb_a",
        title: "邀请加入「协作空间」",
        body: "本机用户 邀请 小陈 加入「协作空间」\n令牌：inv_secret_token\nsk-abcdefghijklmnop",
        inviteNote: "Bearer tok-secret",
        inviteToken: "inv_secret_token",
      }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    } as InboxItem & { llmApiKey: string; cloudToken: string };
    const applied = applyInboxSnapshot(snapshot([]), snapshot([dirty], 1));
    const raw = JSON.stringify({
      inbox: applied,
      painted: painted(applied.items[0]),
      badge: applied.unread,
    });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN|inviteToken|inv_secret_token/);
    expect(painted(applied.items[0]).inviteNote).toBe("…");
    expect(sanitizeInboxItem(dirty)).not.toHaveProperty("inviteToken");
    expect(sanitizeInboxItem(dirty)).not.toHaveProperty("llmApiKey");

    const fetches: InboxSnapshot[] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startInboxSync({
      fetchInbox: async () => {
        const next = snapshot([item({ id: "inb_a", inviteStatus: "pending" })]);
        fetches.push(next);
        return next;
      },
      onInbox: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((snap) => snap.items[0]?.id === "inb_a")).toBe(true);
    stop();
  });

  it("keeps the last good badge + list when a refresh fails", async () => {
    let fail = false;
    let tabB = snapshot([item({ id: "inb_a", inviteStatus: "pending", inviteeName: "小陈" })]);
    const { clock, tickInterval } = fakeClock(true);
    const stop = startInboxSync({
      fetchInbox: async () => {
        if (fail) throw new Error("gone");
        return snapshot([item({ id: "inb_a", inviteStatus: "pending", inviteeName: "小陈" })]);
      },
      onInbox: (next) => {
        tabB = applyInboxSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB.items[0]?.inviteeName).toBe("小陈");
    expect(tabB.unread).toBe(1);

    fail = true;
    tickInterval();
    await flush();
    expect(tabB.items[0]?.inviteeName).toBe("小陈");
    expect(tabB.unread).toBe(1);
    stop();
  });
});
