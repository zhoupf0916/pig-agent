import { describe, expect, it } from "vitest";
import type { Automation } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyAutomationLastRunSnapshot,
  applyAutomationsListLastRun,
  AUTOMATION_LAST_RUN_NEVER,
  AUTOMATIONS_LIST_POLL_MS,
  automationLastErrorLabel,
  automationLastRunLabel,
  automationLastRunSyncKey,
  automationLastSessionLabel,
  startAutomationsListSync,
  type AutomationLastRunFields,
} from "./automations-list-sync";

function automation(
  overrides: Partial<Automation> & { id: string } = { id: "atm_a" },
): Automation {
  return {
    id: overrides.id,
    name: overrides.name ?? "每日整理",
    enabled: overrides.enabled ?? true,
    prompt: overrides.prompt ?? "整理工作区并写一份简报",
    schedule: overrides.schedule ?? "@daily",
    runtime: overrides.runtime ?? "pig",
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    expertId: overrides.expertId,
    expertTeamId: overrides.expertTeamId,
    projectId: overrides.projectId,
    saveArtifactsToProject: overrides.saveArtifactsToProject,
    lastRunAt: overrides.lastRunAt,
    lastSessionId: overrides.lastSessionId,
    lastError: overrides.lastError,
  };
}

function row(overrides: Partial<AutomationLastRunFields> & { id: string }): AutomationLastRunFields {
  return {
    id: overrides.id,
    lastRunAt: overrides.lastRunAt,
    lastSessionId: overrides.lastSessionId,
    lastError: overrides.lastError,
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

function painted(item: AutomationLastRunFields | null) {
  return {
    lastRun: automationLastRunLabel(item?.lastRunAt),
    session: automationLastSessionLabel(item?.lastSessionId),
    error: automationLastErrorLabel(item?.lastError),
  };
}

describe("automations list last-run sync (Milestone Z)", () => {
  it("keeps a 2s poll cadence, 尚未运行 copy, and default runtime pig", () => {
    expect(AUTOMATIONS_LIST_POLL_MS).toBe(2_000);
    expect(AUTOMATION_LAST_RUN_NEVER).toBe("尚未运行");
    expect(automationLastRunLabel(undefined)).toBe("上次运行：尚未运行");
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("returns the previous list / detail reference when last-run is unchanged", () => {
    const prevList = [
      automation({
        id: "atm_a",
        lastRunAt: "2026-09-14T12:00:00.000Z",
        lastSessionId: "ses_a",
      }),
    ];
    const nextList = [
      row({
        id: "atm_a",
        lastRunAt: "2026-09-14T12:00:00.000Z",
        lastSessionId: "ses_a",
      }),
    ];
    expect(applyAutomationsListLastRun(prevList, nextList)).toBe(prevList);
    expect(applyAutomationLastRunSnapshot(prevList[0]!, nextList[0]!)).toBe(prevList[0]);
    expect(automationLastRunSyncKey(prevList[0]!)).toBe(automationLastRunSyncKey(nextList[0]!));
  });

  it("does not remount name / prompt / schedule when only last-run changes", () => {
    const prev = automation({ id: "atm_a", name: "每日整理", prompt: "整理工作区并写一份简报" });
    const next = applyAutomationLastRunSnapshot(
      prev,
      row({
        id: "atm_a",
        lastRunAt: "2026-09-14T12:05:00.000Z",
        lastSessionId: "ses_run",
      }),
    );
    expect(next).not.toBe(prev);
    expect(next?.name).toBe(prev.name);
    expect(next?.prompt).toBe(prev.prompt);
    expect(next?.schedule).toBe(prev.schedule);
    expect(next?.runtime).toBe("pig");
    expect(next?.lastRunAt).toBe("2026-09-14T12:05:00.000Z");
    expect(next?.lastSessionId).toBe("ses_run");
  });

  it("ignores a snapshot for another automation and a missing open detail", () => {
    const prev = automation({ id: "atm_a" });
    expect(
      applyAutomationLastRunSnapshot(prev, row({ id: "atm_b", lastSessionId: "ses_other" })),
    ).toBe(prev);
    expect(applyAutomationLastRunSnapshot(null, row({ id: "atm_a", lastSessionId: "ses_a" }))).toBeNull();
  });

  it("Tab B list last-run follows Tab A / cron even when detail is not open", async () => {
    const server = [
      row({ id: "atm_a" }),
      row({
        id: "atm_b",
        lastRunAt: "2026-09-14T11:00:00.000Z",
        lastSessionId: "ses_old",
      }),
    ];
    let tabB = [
      automation({ id: "atm_a" }),
      automation({
        id: "atm_b",
        lastRunAt: "2026-09-14T11:00:00.000Z",
        lastSessionId: "ses_old",
      }),
    ];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((s) => ({ ...s })),
      onList: (next) => {
        tabB = applyAutomationsListLastRun(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(painted(tabB[0]!)).toEqual({
      lastRun: "上次运行：尚未运行",
      session: undefined,
      error: undefined,
    });

    const ranAt = "2026-09-14T12:08:00.000Z";
    server[0] = row({
      id: "atm_a",
      lastRunAt: ranAt,
      lastSessionId: "ses_from_tab_a",
    });
    tickInterval();
    await flush();

    const during = tabB.find((item) => item.id === "atm_a");
    expect(during?.lastRunAt).toBe(ranAt);
    expect(during?.lastSessionId).toBe("ses_from_tab_a");
    expect(during?.lastError).toBeUndefined();
    expect(painted(during!).session).toBe("会话 ses_from_tab_a");
    expect(painted(during!).lastRun).toMatch(/^上次运行：/);
    expect(painted(during!).lastRun).not.toMatch(/尚未运行/);
    expect(tabB.find((item) => item.id === "atm_b")?.lastSessionId).toBe("ses_old");
    expect(tabB[0]?.name).toBe("每日整理");
    stop();
  });

  it("selected detail last-run also follows GET /api/automations/:id without remounting draft fields", async () => {
    const server = [row({ id: "atm_a" })];
    let selected: AutomationLastRunFields = row({ id: "atm_a" });
    let tabBDetail: Automation | null = automation({ id: "atm_a", prompt: "本地草稿提示词" });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((s) => ({ ...s })),
      onList: () => undefined,
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return { ...selected };
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationLastRunSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toContain("atm_a");
    expect(tabBDetail?.prompt).toBe("本地草稿提示词");

    selected = row({
      id: "atm_a",
      lastRunAt: "2026-09-14T12:10:00.000Z",
      lastSessionId: "ses_detail",
      lastError: "cron 失败",
    });
    tickInterval();
    await flush();

    expect(tabBDetail?.lastRunAt).toBe("2026-09-14T12:10:00.000Z");
    expect(tabBDetail?.lastSessionId).toBe("ses_detail");
    expect(tabBDetail?.lastError).toBe("cron 失败");
    expect(tabBDetail?.prompt).toBe("本地草稿提示词");
    expect(painted(tabBDetail).error).toBe("cron 失败");
    stop();
  });

  it("clears lastError after a later successful run", () => {
    const prev = [
      automation({
        id: "atm_a",
        lastRunAt: "t1",
        lastSessionId: "ses_fail",
        lastError: "上一轮失败",
      }),
    ];
    const next = applyAutomationsListLastRun(prev, [
      row({
        id: "atm_a",
        lastRunAt: "t2",
        lastSessionId: "ses_ok",
      }),
    ]);
    expect(next[0]?.lastSessionId).toBe("ses_ok");
    expect(next[0]?.lastError).toBeUndefined();
    expect(painted(next[0]!).error).toBeUndefined();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [row({ id: "atm_a" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startAutomationsListSync({
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

    server[0] = row({ id: "atm_a", lastSessionId: "ses_a" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats last-run snapshots as a place to store secrets and stays GET-only", async () => {
    const snap = row({
      id: "atm_a",
      lastRunAt: "2026-09-14T12:00:00.000Z",
      lastSessionId: "ses_a",
      lastError: "失败 sk-abcdefghijklmnop 与 Bearer tok-abc",
    });
    const applied = applyAutomationLastRunSnapshot(automation({ id: "atm_a" }), snap);
    const raw = JSON.stringify(applied);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(painted(applied).error).toBe("失败 … 与 …");

    const fetches: AutomationLastRunFields[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
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
    expect(fetches.every((list) => list[0]?.id === "atm_a")).toBe(true);
    stop();
  });

  it("keeps the last good last-run when a refresh fails or the row is missing", async () => {
    let fail = false;
    let missing = false;
    let tabB = [
      automation({
        id: "atm_a",
        lastRunAt: "t1",
        lastSessionId: "ses_keep",
      }),
    ];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        if (missing) return [row({ id: "atm_b", lastSessionId: "ses_other" })];
        return [row({ id: "atm_a", lastRunAt: "t1", lastSessionId: "ses_keep" })];
      },
      onList: (next) => {
        tabB = applyAutomationsListLastRun(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB[0]?.lastSessionId).toBe("ses_keep");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.lastSessionId).toBe("ses_keep");

    fail = false;
    missing = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.lastSessionId).toBe("ses_keep");
    stop();
  });
});
