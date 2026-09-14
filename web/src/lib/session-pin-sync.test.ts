import { describe, expect, it } from "vitest";
import type { ChatMessage, Session, SessionStatus } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applySessionPinSnapshot,
  SESSION_PIN_POLL_MS,
  SESSION_PIN_UNBOUND,
  sessionPinBindingLabel,
  sessionPinSelectValue,
  sessionPinSyncKey,
  startSessionPinSync,
  type SessionPinFields,
} from "./session-pin-sync";

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

function row(overrides: Partial<SessionPinFields> & { id: string }): SessionPinFields {
  return {
    id: overrides.id,
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

const catalogs = {
  projects: [{ id: "prj_1", name: "工作区整理" }],
  experts: [{ id: "exp_scout", name: "侦察 Scout" }],
  teams: [{ id: "team_coding", name: "编码流水线" }],
};

function painted(open: Session | null) {
  return {
    project: sessionPinSelectValue(open?.projectId),
    expert: sessionPinSelectValue(open?.expertId),
    squad: sessionPinSelectValue(open?.expertTeamId),
    projectHint: sessionPinBindingLabel(open?.projectId, catalogs.projects),
    expertHint: sessionPinBindingLabel(open?.expertId, catalogs.experts),
    squadHint: sessionPinBindingLabel(open?.expertTeamId, catalogs.teams),
  };
}

describe("session pin row sync (Milestone Y)", () => {
  it("keeps a 2s poll cadence and the existing 未绑定 label (default runtime pig)", () => {
    expect(SESSION_PIN_POLL_MS).toBe(2_000);
    expect(SESSION_PIN_UNBOUND).toBe("未绑定");
    expect(sessionPinSelectValue(undefined)).toBe("");
    expect(sessionPinBindingLabel(undefined, catalogs.projects)).toBe("未绑定");
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("returns the previous session reference when pins are unchanged", () => {
    const prev = session({ id: "ses_a", projectId: "prj_1", expertId: "exp_scout" });
    const next = row({ id: "ses_a", projectId: "prj_1", expertId: "exp_scout" });
    expect(applySessionPinSnapshot(prev, next)).toBe(prev);
    expect(sessionPinSyncKey(prev)).toBe(sessionPinSyncKey(next));
  });

  it("does not remount the transcript when only pins change", () => {
    const prev = session({ id: "ses_a", messages: [message("msg_keep")] });
    const next = applySessionPinSnapshot(prev, row({ id: "ses_a", projectId: "prj_1" }));
    expect(next).not.toBe(prev);
    expect(next?.messages).toBe(prev.messages);
    expect(next?.messages[0]?.id).toBe("msg_keep");
    expect(next?.steps).toBe(prev.steps);
    expect(next?.projectId).toBe("prj_1");
  });

  it("ignores a snapshot for another session and a missing open session", () => {
    const prev = session({ id: "ses_a" });
    expect(applySessionPinSnapshot(prev, row({ id: "ses_b", projectId: "prj_1" }))).toBe(prev);
    expect(applySessionPinSnapshot(null, row({ id: "ses_a", projectId: "prj_1" }))).toBeNull();
  });

  it("Tab B pin row follows Tab A project / expert / squad binds from list snapshots", async () => {
    const server = [
      row({ id: "ses_a" }),
      row({ id: "ses_b", projectId: "prj_other" }),
    ];
    let tabB: Session | null = session({ id: "ses_a" });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSessionPinSync({
      sessionId: "ses_a",
      fetchList: async () => server.map((s) => ({ ...s })),
      onPins: (next) => {
        tabB = applySessionPinSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(painted(tabB)).toEqual({
      project: "",
      expert: "",
      squad: "",
      projectHint: "未绑定",
      expertHint: "未绑定",
      squadHint: "未绑定",
    });

    server[0] = row({
      id: "ses_a",
      projectId: "prj_1",
      expertId: "exp_scout",
      expertTeamId: "team_coding",
    });
    tickInterval();
    await flush();

    expect(tabB?.projectId).toBe("prj_1");
    expect(tabB?.expertId).toBe("exp_scout");
    expect(tabB?.expertTeamId).toBe("team_coding");
    expect(painted(tabB)).toEqual({
      project: "prj_1",
      expert: "exp_scout",
      squad: "team_coding",
      projectHint: "工作区整理",
      expertHint: "侦察 Scout",
      squadHint: "编码流水线",
    });
    expect(tabB?.messages[0]?.content).toBe("整理工作区");
    stop();
  });

  it("unbind to 未绑定 clears the other tab's dropdowns / hints", async () => {
    const server = [
      row({
        id: "ses_a",
        projectId: "prj_1",
        expertId: "exp_scout",
        expertTeamId: "team_coding",
      }),
    ];
    let tabB: Session | null = session({
      id: "ses_a",
      projectId: "prj_1",
      expertId: "exp_scout",
      expertTeamId: "team_coding",
    });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSessionPinSync({
      sessionId: "ses_a",
      fetchList: async () => server.map((s) => ({ ...s })),
      onPins: (next) => {
        tabB = applySessionPinSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(painted(tabB).projectHint).toBe("工作区整理");

    server[0] = row({ id: "ses_a" });
    tickInterval();
    await flush();

    expect(tabB?.projectId).toBeUndefined();
    expect(tabB?.expertId).toBeUndefined();
    expect(tabB?.expertTeamId).toBeUndefined();
    expect(painted(tabB)).toEqual({
      project: "",
      expert: "",
      squad: "",
      projectHint: "未绑定",
      expertHint: "未绑定",
      squadHint: "未绑定",
    });
    expect(JSON.stringify(tabB)).not.toMatch(/prj_1|exp_scout|team_coding/);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [row({ id: "ses_a" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSessionPinSync({
      sessionId: "ses_a",
      fetchList: async () => {
        calls += 1;
        return server.map((s) => ({ ...s }));
      },
      onPins: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server[0] = row({ id: "ses_a", projectId: "prj_1" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats pin snapshots as a place to store secrets and stays GET-only", async () => {
    const snap = row({
      id: "ses_a",
      projectId: "prj_1",
      expertId: "exp_scout",
      expertTeamId: "team_coding",
    });
    const applied = applySessionPinSnapshot(session({ id: "ses_a" }), snap);
    const raw = JSON.stringify(applied);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(painted(applied).projectHint).toBe("工作区整理");

    const fetches: SessionPinFields[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSessionPinSync({
      sessionId: "ses_a",
      fetchList: async () => {
        const next = [structuredClone(snap)];
        fetches.push(next);
        return next;
      },
      onPins: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((list) => list[0]?.id === "ses_a")).toBe(true);
    stop();
  });

  it("keeps the last good pins when a refresh fails or the row is missing", async () => {
    let fail = false;
    let missing = false;
    let tabB: Session | null = session({ id: "ses_a", projectId: "prj_1" });
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSessionPinSync({
      sessionId: "ses_a",
      fetchList: async () => {
        if (fail) throw new Error("gone");
        if (missing) return [row({ id: "ses_b" })];
        return [row({ id: "ses_a", projectId: "prj_1" })];
      },
      onPins: (next) => {
        tabB = applySessionPinSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB?.projectId).toBe("prj_1");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB?.projectId).toBe("prj_1");

    fail = false;
    missing = true;
    tickInterval();
    await flush();
    expect(tabB?.projectId).toBe("prj_1");
    stop();
  });
});
