import { describe, expect, it } from "vitest";
import type { SessionStatus, SessionSummary } from "../types";
import {
  applySessionListSnapshot,
  SESSION_LIST_POLL_MS,
  sessionStatusLabel,
  startSessionListSync,
  type SessionListSyncClock,
} from "./session-list-sync";

function row(
  overrides: Partial<SessionSummary> & { id: string; status?: SessionStatus } = { id: "ses_a" },
): SessionSummary {
  return {
    id: overrides.id,
    title: overrides.title ?? "新任务",
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    status: overrides.status ?? "idle",
    projectId: overrides.projectId,
    expertId: overrides.expertId,
    expertTeamId: overrides.expertTeamId,
  };
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

describe("session list sidebar sync (Milestone Q)", () => {
  it("keeps a 2s poll cadence and Chinese status labels", () => {
    expect(SESSION_LIST_POLL_MS).toBe(2_000);
    expect(sessionStatusLabel("running")).toBe("运行中");
    expect(sessionStatusLabel("idle")).toBe("空闲");
    expect(sessionStatusLabel("error")).toBe("出错");
  });

  it("returns the previous list reference when the snapshot is unchanged", () => {
    const prev = [row({ id: "ses_a", status: "idle" })];
    const next = [row({ id: "ses_a", status: "idle" })];
    expect(applySessionListSnapshot(prev, next)).toBe(prev);
  });

  it("Tab B sidebar follows Tab A running → idle (and title) from list snapshots", async () => {
    const server = [
      row({ id: "ses_a", title: "新任务", status: "idle" }),
      row({ id: "ses_b", title: "其他会话", status: "idle" }),
    ];
    let tabB = server.map((s) => ({ ...s }));
    const fetches: SessionSummary[][] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSessionListSync({
      fetchList: async () => {
        const snap = server.map((s) => ({ ...s }));
        fetches.push(snap);
        return snap;
      },
      onList: (next) => {
        tabB = applySessionListSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabB.find((s) => s.id === "ses_a")?.status).toBe("idle");

    const runningAt = "2026-09-14T12:00:05.000Z";
    server[0] = {
      ...server[0]!,
      status: "running",
      title: "搜索笔记并整理工作区",
      updatedAt: runningAt,
    };
    tickInterval();
    await flush();

    const during = tabB.find((s) => s.id === "ses_a");
    expect(during?.status).toBe("running");
    expect(during?.title).toBe("搜索笔记并整理工作区");
    expect(during?.updatedAt).toBe(runningAt);
    expect(tabB.find((s) => s.id === "ses_b")?.status).toBe("idle");

    server[0] = {
      ...server[0]!,
      status: "idle",
      updatedAt: "2026-09-14T12:00:20.000Z",
    };
    tickInterval();
    await flush();

    const after = tabB.find((s) => s.id === "ses_a");
    expect(after?.status).toBe("idle");
    expect(after?.title).toBe("搜索笔记并整理工作区");
    expect(after?.updatedAt).toBe("2026-09-14T12:00:20.000Z");
    stop();
  });

  it("also accepts error as a terminal sidebar status", () => {
    const prev = [row({ id: "ses_a", status: "running", title: "远程任务" })];
    const next = applySessionListSnapshot(prev, [
      row({ id: "ses_a", status: "error", title: "远程任务", updatedAt: "t2" }),
    ]);
    expect(next[0]?.status).toBe("error");
    expect(sessionStatusLabel(next[0]!.status)).toBe("出错");
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [row({ id: "ses_a", status: "idle" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSessionListSync({
      fetchList: async () => {
        calls += 1;
        return server.map((s) => ({ ...s }));
      },
      onList: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server[0] = { ...server[0]!, status: "running" };
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats list snapshots as a place to store secrets", () => {
    const snap = [
      row({ id: "ses_a", title: "整理工作区", status: "running" }),
      row({ id: "ses_b", title: "写摘要", status: "idle" }),
    ];
    const applied = applySessionListSnapshot([], snap);
    const raw = JSON.stringify(applied);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(applied.every((s) => s.status === "running" || s.status === "idle" || s.status === "error")).toBe(
      true,
    );
  });
});
