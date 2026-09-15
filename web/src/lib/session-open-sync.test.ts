import { describe, expect, it } from "vitest";
import type { ChatMessage, Session, SessionStatus, SessionSummary } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import {
  applySessionListSnapshot,
  SESSION_LIST_POLL_MS,
  startSessionListSync,
  type SessionListSyncClock,
} from "./session-list-sync";
import { parseHash, sessionHash, workstationHash } from "./hash";
import {
  applyOpenSessionFromList,
  applySessionOpenMetaSnapshot,
  nextOpenSessionHash,
  nextOpenSessionId,
  sessionOpenMetaSyncKey,
  sessionOpenStatusLabel,
  shouldFetchSessionDetail,
} from "./session-open-sync";
import { applySessionPinSnapshot, startSessionPinSync } from "./session-pin-sync";

function message(id = "msg_a"): ChatMessage {
  return {
    id,
    role: "user",
    content: "整理工作区",
    createdAt: "2026-09-14T12:00:00.000Z",
  };
}

function session(
  overrides: Partial<Session> & { id: string; status?: SessionStatus } = { id: "ses_a" },
): Session {
  return {
    id: overrides.id,
    title: overrides.title ?? "新任务",
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    status: overrides.status ?? "idle",
    messages: overrides.messages ?? [message()],
    steps: overrides.steps ?? [],
    artifacts: overrides.artifacts ?? [],
    projectId: overrides.projectId,
    expertId: overrides.expertId,
    expertTeamId: overrides.expertTeamId,
  };
}

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

function painted(open: Session | null) {
  return {
    title: open?.title ?? "",
    status: open?.status ?? "idle",
    statusLabel: sessionOpenStatusLabel(open?.status ?? "idle"),
  };
}

describe("open session title/status sync (Milestone AM)", () => {
  it("reuses the 2s list poll and existing Chinese status labels (default runtime pig)", () => {
    expect(SESSION_LIST_POLL_MS).toBe(2_000);
    expect(sessionOpenStatusLabel("running")).toBe("运行中");
    expect(sessionOpenStatusLabel("idle")).toBe("空闲");
    expect(sessionOpenStatusLabel("error")).toBe("出错");
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("returns the previous session reference when title and status are unchanged", () => {
    const prev = session({ id: "ses_a", title: "整理工作区", status: "idle" });
    const next = row({ id: "ses_a", title: "整理工作区", status: "idle" });
    expect(applySessionOpenMetaSnapshot(prev, next)).toBe(prev);
    expect(sessionOpenMetaSyncKey(prev)).toBe(sessionOpenMetaSyncKey(next));
  });

  it("does not remount the transcript when only title / status change", () => {
    const prev = session({
      id: "ses_a",
      title: "新任务",
      status: "idle",
      messages: [message("msg_keep")],
      steps: [{ id: "step_1", title: "查看目录", status: "done" }],
    });
    const next = applySessionOpenMetaSnapshot(
      prev,
      row({ id: "ses_a", title: "搜索笔记并整理工作区", status: "running" }),
    );
    expect(next).not.toBe(prev);
    expect(next?.messages).toBe(prev.messages);
    expect(next?.messages[0]?.id).toBe("msg_keep");
    expect(next?.steps).toBe(prev.steps);
    expect(next?.title).toBe("搜索笔记并整理工作区");
    expect(next?.status).toBe("running");
    expect(painted(next).statusLabel).toBe("运行中");
  });

  it("ignores a snapshot for another session (title/status patch stays on the open id)", () => {
    const prev = session({ id: "ses_a", title: "新任务" });
    expect(applySessionOpenMetaSnapshot(prev, row({ id: "ses_b", title: "其他会话", status: "running" }))).toBe(
      prev,
    );
    expect(applySessionOpenMetaSnapshot(null, row({ id: "ses_a", title: "搜索笔记", status: "running" }))).toBeNull();
  });

  it("Tab B open session follows Tab A rename and running ↔ idle from list snapshots", async () => {
    const server = [
      row({ id: "ses_a", title: "新任务", status: "idle" }),
      row({ id: "ses_b", title: "其他会话", status: "idle" }),
    ];
    let tabBList = server.map((s) => ({ ...s }));
    let tabB: Session | null = session({ id: "ses_a", title: "新任务", status: "idle" });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSessionListSync({
      fetchList: async () => server.map((s) => ({ ...s })),
      onList: (next) => {
        tabBList = applySessionListSnapshot(tabBList, next);
        tabB = applyOpenSessionFromList(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(painted(tabB)).toEqual({ title: "新任务", status: "idle", statusLabel: "空闲" });
    expect(tabBList.find((s) => s.id === "ses_a")?.status).toBe("idle");

    server[0] = row({
      id: "ses_a",
      title: "搜索笔记并整理工作区",
      status: "running",
      updatedAt: "2026-09-14T12:00:05.000Z",
    });
    tickInterval();
    await flush();

    expect(painted(tabB)).toEqual({
      title: "搜索笔记并整理工作区",
      status: "running",
      statusLabel: "运行中",
    });
    expect(tabB?.messages[0]?.content).toBe("整理工作区");
    expect(tabBList.find((s) => s.id === "ses_a")?.title).toBe("搜索笔记并整理工作区");

    server[0] = row({
      id: "ses_a",
      title: "搜索笔记并整理工作区",
      status: "idle",
      updatedAt: "2026-09-14T12:00:20.000Z",
    });
    tickInterval();
    await flush();

    expect(painted(tabB).status).toBe("idle");
    expect(painted(tabB).statusLabel).toBe("空闲");
    expect(tabB?.title).toBe("搜索笔记并整理工作区");
    stop();
  });

  it("also flips error as a terminal open-session status without touching pins", () => {
    const prev = session({
      id: "ses_a",
      title: "远程任务",
      status: "running",
      projectId: "prj_1",
    });
    const next = applySessionOpenMetaSnapshot(
      prev,
      row({ id: "ses_a", title: "远程任务", status: "error" }),
    );
    expect(next?.status).toBe("error");
    expect(sessionOpenStatusLabel(next!.status)).toBe("出错");
    expect(next?.projectId).toBe("prj_1");
    expect(next?.messages).toBe(prev.messages);
  });

  it("pin-row snapshots can also patch title / status (same GET /api/sessions row)", async () => {
    const server = [row({ id: "ses_a", title: "新任务", status: "idle", projectId: "prj_1" })];
    let tabB: Session | null = session({ id: "ses_a", title: "新任务", status: "idle", projectId: "prj_1" });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSessionPinSync({
      sessionId: "ses_a",
      fetchList: async () => server.map((s) => ({ ...s })),
      onPins: (next) => {
        tabB = applySessionOpenMetaSnapshot(applySessionPinSnapshot(tabB, next), next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    server[0] = row({
      id: "ses_a",
      title: "改过的标题",
      status: "running",
      projectId: "prj_1",
    });
    tickInterval();
    await flush();

    expect(tabB?.title).toBe("改过的标题");
    expect(tabB?.status).toBe("running");
    expect(tabB?.projectId).toBe("prj_1");
    expect(tabB?.messages[0]?.id).toBe("msg_a");
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [row({ id: "ses_a", title: "新任务", status: "idle" })];
    let calls = 0;
    let tabB: Session | null = session({ id: "ses_a" });
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSessionListSync({
      fetchList: async () => {
        calls += 1;
        return server.map((s) => ({ ...s }));
      },
      onList: (next) => {
        tabB = applyOpenSessionFromList(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server[0] = row({ id: "ses_a", title: "可见后", status: "running" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);
    expect(tabB?.title).toBe("可见后");
    expect(tabB?.status).toBe("running");

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats title / status snapshots as a place to store secrets and stays GET-only", async () => {
    const snap = row({ id: "ses_a", title: "整理工作区", status: "running" });
    const applied = applySessionOpenMetaSnapshot(session({ id: "ses_a" }), snap);
    const raw = JSON.stringify(applied);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(painted(applied).title).toBe("整理工作区");
    expect(painted(applied).statusLabel).toBe("运行中");

    const fetches: SessionSummary[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSessionListSync({
      fetchList: async () => {
        const next = [structuredClone(snap)];
        fetches.push(next);
        return next;
      },
      onList: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((list) => list[0]?.id === "ses_a")).toBe(true);
    expect(JSON.stringify(fetches)).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    stop();
  });

  it("keeps the last good title / status when a refresh fails", async () => {
    let fail = false;
    let tabB: Session | null = session({ id: "ses_a", title: "整理工作区", status: "running" });
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSessionListSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [row({ id: "ses_a", title: "整理工作区", status: "running" })];
      },
      onList: (next) => {
        tabB = applyOpenSessionFromList(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB?.title).toBe("整理工作区");
    expect(tabB?.status).toBe("running");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB?.title).toBe("整理工作区");
    expect(tabB?.status).toBe("running");
    expect(tabB?.messages[0]?.content).toBe("整理工作区");
    stop();
  });
});

describe("open session deleted-elsewhere cleanup (Milestone AN)", () => {
  it("reuses the 2s list poll and stays on default runtime pig", () => {
    expect(SESSION_LIST_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("keeps the open id when it is still in GET /api/sessions", () => {
    const list = [row({ id: "ses_a", title: "整理工作区" }), row({ id: "ses_b" })];
    expect(nextOpenSessionId("ses_a", list)).toBe("ses_a");
    const prev = session({ id: "ses_a", title: "整理工作区", status: "idle" });
    expect(applyOpenSessionFromList(prev, list)).toBe(prev);
  });

  it("clears the open session when the list no longer contains that id", () => {
    const prev = session({
      id: "ses_a",
      title: "已删会话",
      messages: [message("msg_ghost")],
    });
    const remaining = [row({ id: "ses_b", title: "其他会话" })];
    expect(applyOpenSessionFromList(prev, remaining)).toBeNull();
    expect(applyOpenSessionFromList(prev, [])).toBeNull();
    expect(nextOpenSessionId("ses_a", remaining)).toBe("ses_b");
    expect(nextOpenSessionId("ses_a", [])).toBeNull();
    expect(nextOpenSessionId(null, remaining)).toBeNull();
    expect(nextOpenSessionHash("ses_a", remaining)).toBe(sessionHash("ses_b"));
    expect(nextOpenSessionHash("ses_a", [])).toBe(workstationHash());
    expect(nextOpenSessionHash("ses_a", [row({ id: "ses_a" })])).toBeNull();
    expect(nextOpenSessionHash(null, remaining)).toBeNull();
  });

  it("does not GET /api/sessions/:deletedId after the list says the id is gone (DEF-AN-02-1)", () => {
    const remaining = [row({ id: "ses_b", title: "其他会话" })];
    const deletedId = "ses_a";
    expect(shouldFetchSessionDetail(deletedId, remaining)).toBe(false);
    expect(shouldFetchSessionDetail("ses_b", remaining)).toBe(true);
    expect(shouldFetchSessionDetail(deletedId, [])).toBe(false);
    expect(shouldFetchSessionDetail(null, remaining)).toBe(false);
    expect(shouldFetchSessionDetail(deletedId, [row({ id: deletedId })])).toBe(true);

    // Stale #/sessions/:deletedId + activeId already switched (main 1e0de3e race).
    const detailGets: string[] = [];
    const routeLoad = (hash: string, currentId: string | null, list: Array<{ id: string }>) => {
      const route = parseHash(hash);
      if (route.name !== "workstation" || !route.sessionId) return;
      if (route.sessionId === currentId) return;
      if (!shouldFetchSessionDetail(route.sessionId, list)) return;
      detailGets.push(route.sessionId);
    };

    routeLoad(sessionHash(deletedId), "ses_b", remaining);
    routeLoad(sessionHash(deletedId), null, []);
    routeLoad(workstationHash(), null, []);
    expect(detailGets).toEqual([]);

    // Hash rewritten first — route sync may load the next listed id only.
    const nextHash = nextOpenSessionHash(deletedId, remaining);
    expect(nextHash).toBe(sessionHash("ses_b"));
    routeLoad(nextHash!, null, remaining);
    expect(detailGets).toEqual(["ses_b"]);
    expect(detailGets).not.toContain(deletedId);
  });

  it("does not pull a transcript or touch another session's messages when leaving", () => {
    const deleted = session({
      id: "ses_a",
      title: "幽灵会话",
      messages: [message("msg_deleted")],
      steps: [{ id: "step_gone", title: "旧步骤", status: "done" }],
    });
    const other = session({
      id: "ses_b",
      title: "其他会话",
      messages: [message("msg_keep")],
    });
    const list = [row({ id: "ses_b", title: "其他会话" })];
    expect(applyOpenSessionFromList(deleted, list)).toBeNull();
    expect(applyOpenSessionFromList(other, list)?.messages).toBe(other.messages);
    expect(other.messages[0]?.id).toBe("msg_keep");
    expect(JSON.stringify(list)).not.toMatch(/msg_deleted|step_gone/);
  });

  it("Tab B leaves a session Tab A deleted on poll / focus / visibility", async () => {
    const server = [
      row({ id: "ses_a", title: "打开中", status: "idle" }),
      row({ id: "ses_b", title: "其他会话", status: "idle" }),
    ];
    let tabBList = server.map((s) => ({ ...s }));
    let tabB: Session | null = session({ id: "ses_a", title: "打开中", status: "idle" });
    let tabBOpenId: string | null = "ses_a";
    let tabBHash = sessionHash("ses_a");
    const fetches: SessionSummary[][] = [];
    const detailGets: string[] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const routeLoad = (hash: string, currentId: string | null, list: SessionSummary[]) => {
      const route = parseHash(hash);
      if (route.name !== "workstation" || !route.sessionId) return;
      if (route.sessionId === currentId) return;
      if (!shouldFetchSessionDetail(route.sessionId, list)) return;
      detailGets.push(route.sessionId);
    };

    const applyList = (next: SessionSummary[]) => {
      tabBList = applySessionListSnapshot(tabBList, next);
      const nextId = nextOpenSessionId(tabBOpenId, next);
      if (tabBOpenId && nextId !== tabBOpenId) {
        const nextHash = nextOpenSessionHash(tabBOpenId, next);
        if (nextHash) tabBHash = nextHash;
        tabB = applyOpenSessionFromList(tabB, next);
        tabBOpenId = nextId;
        routeLoad(tabBHash, tabBOpenId, next);
        if (nextId && shouldFetchSessionDetail(nextId, next)) detailGets.push(nextId);
        return;
      }
      tabB = applyOpenSessionFromList(tabB, next);
    };

    const stop = startSessionListSync({
      fetchList: async () => {
        const snap = server.map((s) => ({ ...s }));
        fetches.push(snap);
        return snap;
      },
      onList: applyList,
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabB?.id).toBe("ses_a");
    expect(tabBList.map((s) => s.id)).toEqual(["ses_a", "ses_b"]);

    server.splice(0, 1);
    tickInterval();
    await flush();

    expect(tabB).toBeNull();
    expect(tabBOpenId).toBe("ses_b");
    expect(tabBHash).toBe(sessionHash("ses_b"));
    expect(tabBList.map((s) => s.id)).toEqual(["ses_b"]);
    expect(detailGets).not.toContain("ses_a");
    expect(fetches.every((list) => list.every((item) => "id" in item && "title" in item))).toBe(true);

    const afterPoll = fetches.length;
    setVisible(false);
    server.length = 0;
    tickInterval();
    await flush();
    expect(fetches.length).toBe(afterPoll);

    setVisible(true);
    await flush();
    expect(fetches.length).toBeGreaterThan(afterPoll);
    expect(tabB).toBeNull();
    expect(tabBOpenId).toBeNull();
    expect(tabBHash).toBe(workstationHash());
    expect(tabBList).toEqual([]);
    expect(detailGets).not.toContain("ses_a");

    const beforeFocus = fetches.length;
    focus();
    await flush();
    expect(fetches.length).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("does not treat a failed list refresh as a delete", async () => {
    let fail = false;
    let tabB: Session | null = session({ id: "ses_a", title: "整理工作区" });
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSessionListSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [row({ id: "ses_a", title: "整理工作区" })];
      },
      onList: (next) => {
        const nextId = nextOpenSessionId(tabB?.id, next);
        if (tabB?.id && nextId !== tabB.id) {
          tabB = applyOpenSessionFromList(tabB, next);
          return;
        }
        tabB = applyOpenSessionFromList(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    fail = true;
    tickInterval();
    await flush();
    expect(tabB?.id).toBe("ses_a");
    expect(tabB?.title).toBe("整理工作区");
    expect(tabB?.messages[0]?.content).toBe("整理工作区");
    stop();
  });

  it("never treats deleted-open cleanup snapshots as a place to store secrets", () => {
    const snap = [row({ id: "ses_b", title: "其他会话", status: "idle" })];
    const applied = applyOpenSessionFromList(session({ id: "ses_a", title: "已删" }), snap);
    const raw = JSON.stringify({
      applied,
      snap,
      nextId: nextOpenSessionId("ses_a", snap),
      nextHash: nextOpenSessionHash("ses_a", snap),
      fetchDeleted: shouldFetchSessionDetail("ses_a", snap),
    });
    expect(applied).toBeNull();
    expect(shouldFetchSessionDetail("ses_a", snap)).toBe(false);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
  });
});
