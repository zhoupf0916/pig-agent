import { describe, expect, it } from "vitest";
import type { Automation } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyAutomationDetailSnapshot,
  applyAutomationLastRunSnapshot,
  applyAutomationsListLastRun,
  applyAutomationsListSnapshot,
  AUTOMATION_LAST_RUN_NEVER,
  AUTOMATIONS_LIST_POLL_MS,
  automationLastErrorLabel,
  automationLastRunLabel,
  automationLastRunSyncKey,
  automationLastSessionLabel,
  automationSyncKey,
  nextOpenAutomationId,
  sanitizeAutomation,
  shouldFetchAutomationDetail,
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

function paintedDirectory(item: Automation | null) {
  return {
    id: item?.id,
    name: item?.name,
    enabled: item?.enabled,
    schedule: item?.schedule ?? null,
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
      automation({ id: "atm_a" }),
      automation({
        id: "atm_b",
        lastRunAt: "2026-09-14T11:00:00.000Z",
        lastSessionId: "ses_old",
      }),
    ];
    let tabB = server.map((item) => ({ ...item }));
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
    server[0] = automation({
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
    const server = [automation({ id: "atm_a" })];
    let selected: Automation = automation({ id: "atm_a" });
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

    selected = automation({
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
    const server = [automation({ id: "atm_a" })];
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

    server[0] = automation({ id: "atm_a", lastSessionId: "ses_a" });
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

    const fetches: Automation[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        const next = [automation({ id: "atm_a" })];
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
        if (missing) return [automation({ id: "atm_b", lastSessionId: "ses_other" })];
        return [automation({ id: "atm_a", lastRunAt: "t1", lastSessionId: "ses_keep" })];
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

describe("automations directory full-list sync (Milestone AG)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(AUTOMATIONS_LIST_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous list / detail reference when the snapshot is unchanged", () => {
    const prevList = [automation({ id: "atm_a", name: "每日整理", enabled: true, schedule: "@daily" })];
    const nextList = [automation({ id: "atm_a", name: "每日整理", enabled: true, schedule: "@daily" })];
    expect(applyAutomationsListSnapshot(prevList, nextList)).toBe(prevList);
    expect(automationSyncKey(prevList[0]!)).toBe(automationSyncKey(nextList[0]!));

    const prevDetail = automation({ id: "atm_a" });
    expect(applyAutomationDetailSnapshot(prevDetail, prevDetail)).toBe(prevDetail);
  });

  it("does not remount create-draft fields when only list / open detail name changes", () => {
    const createDraft = { name: "本地正在输入的名称", prompt: "本地草稿提示词" };
    const prev = automation({ id: "atm_a", name: "旧名称", schedule: "@daily" });
    const next = applyAutomationDetailSnapshot(
      prev,
      automation({
        id: "atm_a",
        name: "Tab A 改过的名称",
        schedule: "0 9 * * 1",
        enabled: false,
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    );
    expect(next).not.toBe(prev);
    expect(next?.name).toBe("Tab A 改过的名称");
    expect(next?.schedule).toBe("0 9 * * 1");
    expect(next?.enabled).toBe(false);
    expect(next?.runtime).toBe("pig");
    expect(createDraft).toEqual({ name: "本地正在输入的名称", prompt: "本地草稿提示词" });
  });

  it("ignores a snapshot for another automation and a missing open detail", () => {
    const prev = automation({ id: "atm_a" });
    expect(applyAutomationDetailSnapshot(prev, automation({ id: "atm_b", name: "别的自动化" }))).toBe(
      prev,
    );
    expect(applyAutomationDetailSnapshot(null, automation({ id: "atm_a", name: "每日整理" }))).toBeNull();
  });

  it("Tab B list follows Tab A create / enable / cron / rename / delete without a full remount", async () => {
    let server = [automation({ id: "atm_a", name: "每日整理", enabled: true, schedule: "@daily" })];
    let tabB = server.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabB = applyAutomationsListSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedDirectory(tabB[0]!)).toEqual({
      id: "atm_a",
      name: "每日整理",
      enabled: true,
      schedule: "@daily",
      lastRun: "上次运行：尚未运行",
      session: undefined,
      error: undefined,
    });

    server = [
      automation({
        id: "atm_b",
        name: "每周简报",
        enabled: true,
        schedule: "0 9 * * 1",
        updatedAt: "2026-09-14T12:09:00.000Z",
      }),
      automation({
        id: "atm_a",
        name: "每日整理 · 已改名",
        enabled: false,
        schedule: "@hourly",
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabB.map((row) => row.id)).toEqual(["atm_b", "atm_a"]);
    expect(paintedDirectory(tabB.find((row) => row.id === "atm_a")!)).toEqual({
      id: "atm_a",
      name: "每日整理 · 已改名",
      enabled: false,
      schedule: "@hourly",
      lastRun: "上次运行：尚未运行",
      session: undefined,
      error: undefined,
    });
    expect(paintedDirectory(tabB.find((row) => row.id === "atm_b")!)).toEqual({
      id: "atm_b",
      name: "每周简报",
      enabled: true,
      schedule: "0 9 * * 1",
      lastRun: "上次运行：尚未运行",
      session: undefined,
      error: undefined,
    });
    expect(tabB.find((row) => row.id === "atm_a")?.runtime).toBe("pig");

    server = [
      automation({
        id: "atm_b",
        name: "每周简报",
        enabled: true,
        schedule: "0 9 * * 1",
        updatedAt: "2026-09-14T12:09:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["atm_b"]);
    expect(tabB.find((row) => row.id === "atm_a")).toBeUndefined();
    stop();
  });

  it("Tab B last-run still follows Tab A / cron via the full list snapshot (Milestone Z)", async () => {
    let server = [
      automation({ id: "atm_a" }),
      automation({
        id: "atm_b",
        lastRunAt: "2026-09-14T11:00:00.000Z",
        lastSessionId: "ses_old",
      }),
    ];
    let tabB = server.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabB = applyAutomationsListSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    const ranAt = "2026-09-14T12:08:00.000Z";
    server = [
      automation({
        id: "atm_a",
        lastRunAt: ranAt,
        lastSessionId: "ses_from_tab_a",
        updatedAt: ranAt,
      }),
      automation({
        id: "atm_b",
        lastRunAt: "2026-09-14T11:00:00.000Z",
        lastSessionId: "ses_old",
      }),
    ];
    tickInterval();
    await flush();

    const during = tabB.find((item) => item.id === "atm_a");
    expect(during?.lastRunAt).toBe(ranAt);
    expect(during?.lastSessionId).toBe("ses_from_tab_a");
    expect(during?.name).toBe("每日整理");
    expect(painted(during!).lastRun).toMatch(/^上次运行：/);
    expect(painted(during!).lastRun).not.toMatch(/尚未运行/);
    expect(tabB.find((item) => item.id === "atm_b")?.lastSessionId).toBe("ses_old");
    stop();
  });

  it("open detail also follows GET /api/automations/:id without remounting the page", async () => {
    const listServer = [automation({ id: "atm_a", name: "每日整理", enabled: true })];
    let detailServer: Automation = automation({ id: "atm_a", name: "每日整理", enabled: true });
    let tabBDetail: Automation | null = automation({ id: "atm_a", name: "每日整理", enabled: true });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => listServer.map((row) => ({ ...row })),
      onList: () => undefined,
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return { ...detailServer };
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toContain("atm_a");
    expect(tabBDetail?.name).toBe("每日整理");

    detailServer = automation({
      id: "atm_a",
      name: "Tab A 改过的名称",
      enabled: false,
      schedule: "@hourly",
      prompt: "整理工作区并写一份简报 · 已编辑",
      updatedAt: "2026-09-14T12:10:00.000Z",
    });
    tickInterval();
    await flush();

    expect(tabBDetail?.name).toBe("Tab A 改过的名称");
    expect(tabBDetail?.enabled).toBe(false);
    expect(tabBDetail?.schedule).toBe("@hourly");
    expect(tabBDetail?.prompt).toBe("整理工作区并写一份简报 · 已编辑");
    expect(tabBDetail?.runtime).toBe("pig");
    expect(tabBDetail?.id).toBe("atm_a");
    stop();
  });

  it("does not force-fetch detail body when that automation is not open", async () => {
    const selectedFetches: string[] = [];
    let tabB = [automation({ id: "atm_a", name: "旧名称", enabled: true })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => [
        automation({
          id: "atm_a",
          name: "新名称",
          enabled: false,
          schedule: "@hourly",
          updatedAt: "2026-09-14T12:12:00.000Z",
        }),
      ],
      onList: (next) => {
        tabB = applyAutomationsListSnapshot(tabB, next);
      },
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return null;
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    tickInterval();
    await flush();
    expect(selectedFetches).toEqual([]);
    expect(tabB[0]?.name).toBe("新名称");
    expect(tabB[0]?.enabled).toBe(false);
    expect(tabB[0]?.schedule).toBe("@hourly");
    stop();
  });

  it("clears the open detail when Tab A deletes that automation without GET :id", async () => {
    let server: Automation[] = [automation({ id: "atm_a", name: "每日整理" })];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: Automation | null = automation({ id: "atm_a", name: "每日整理" });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyAutomationsListSnapshot(tabBList, next);
      },
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        const found = server.find((row) => row.id === "atm_a");
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("atm_a");
    expect(selectedFetches).toEqual(["atm_a"]);

    server = [];
    tickInterval();
    await flush();
    expect(tabBList).toEqual([]);
    expect(tabBDetail).toBeNull();
    expect(selectedFetches).toEqual(["atm_a"]);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [automation({ id: "atm_a" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        calls += 1;
        return server.map((row) => ({ ...row }));
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

    server[0] = automation({ id: "atm_a", name: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats automation snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...automation({ id: "atm_a", name: "每日整理", lastError: "失败 sk-abcdefghijklmnop 与 Bearer tok-abc" }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    } as Automation & { llmApiKey: string; cloudToken: string };
    const applied = applyAutomationsListSnapshot([], [dirty]);
    const detail = applyAutomationDetailSnapshot(automation({ id: "atm_a" }), dirty);
    const raw = JSON.stringify({ list: applied, detail, painted: paintedDirectory(applied[0]!) });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(paintedDirectory(applied[0]!).error).toBe("失败 … 与 …");
    expect(sanitizeAutomation(dirty)).not.toHaveProperty("llmApiKey");

    const fetches: Automation[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        const next = [automation({ id: "atm_a", name: "每日整理" })];
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

  it("keeps the last good list / detail when a refresh fails", async () => {
    let fail = false;
    let tabB = [automation({ id: "atm_a", name: "每日整理", enabled: true })];
    let tabBDetail: Automation | null = automation({ id: "atm_a", name: "每日整理", enabled: true });
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [automation({ id: "atm_a", name: "每日整理", enabled: true })];
      },
      onList: (next) => {
        tabB = applyAutomationsListSnapshot(tabB, next);
      },
      selectedId: "atm_a",
      fetchSelected: async () => {
        if (fail) throw new Error("gone");
        return automation({ id: "atm_a", name: "每日整理", enabled: true });
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB[0]?.name).toBe("每日整理");
    expect(tabBDetail?.enabled).toBe(true);

    fail = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.name).toBe("每日整理");
    expect(tabBDetail?.enabled).toBe(true);
    stop();
  });
});

describe("open automation detail deleted-elsewhere cleanup (Milestone AS)", () => {
  it("reuses the 2s list poll and stays on default runtime pig", () => {
    expect(AUTOMATIONS_LIST_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("keeps the open id when it is still in GET /api/automations", () => {
    const list = [automation({ id: "atm_a" }), automation({ id: "atm_b" })];
    expect(nextOpenAutomationId("atm_a", list)).toBe("atm_a");
    expect(shouldFetchAutomationDetail("atm_a", list)).toBe(true);
    const prev = automation({ id: "atm_a" });
    expect(applyAutomationDetailSnapshot(prev, prev)).toBe(prev);
  });

  it("clears the open automation when the list no longer contains that id", () => {
    const prev = automation({ id: "atm_a", name: "幽灵详情", prompt: "幽灵提示词" });
    const remaining = [automation({ id: "atm_b", name: "其他自动化" })];
    expect(applyAutomationDetailSnapshot(prev, null)).toBeNull();
    expect(shouldFetchAutomationDetail("atm_a", remaining)).toBe(false);
    expect(shouldFetchAutomationDetail("atm_a", [])).toBe(false);
    expect(shouldFetchAutomationDetail(undefined, remaining)).toBe(false);
    expect(nextOpenAutomationId("atm_a", remaining)).toBe("atm_b");
    expect(nextOpenAutomationId("atm_a", [])).toBeNull();
    expect(nextOpenAutomationId(null, remaining)).toBeNull();
  });

  it("does not GET /api/automations/:id after the list confirms the open id is gone", async () => {
    let listServer = [automation({ id: "atm_a" }), automation({ id: "atm_b" })];
    const selectedFetches: string[] = [];
    const openIds: Array<string | null> = [];
    let tabBDetail: Automation | null = automation({ id: "atm_a" });
    let tabBOpenId: string | null = "atm_a";
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => listServer.map((row) => ({ ...row })),
      onList: () => undefined,
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return automation({ id });
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        openIds.push(nextId);
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toEqual(["atm_a"]);
    expect(tabBDetail?.id).toBe("atm_a");

    listServer = [automation({ id: "atm_b", name: "其他自动化" })];
    tickInterval();
    await flush();

    expect(selectedFetches).toEqual(["atm_a"]);
    expect(selectedFetches).not.toContain("atm_b");
    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("atm_b");
    expect(openIds).toEqual(["atm_b"]);
    stop();
  });

  it("Tab B leaves an automation Tab A deleted on poll / focus / visibility", async () => {
    const server = [
      automation({ id: "atm_a", name: "打开中" }),
      automation({ id: "atm_b", name: "其他自动化" }),
    ];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: Automation | null = automation({ id: "atm_a", name: "打开中" });
    let tabBOpenId: string | null = "atm_a";
    const selectedFetches: string[] = [];
    const listFetches: Automation[][] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => {
        const snap = server.map((row) => ({ ...row }));
        listFetches.push(snap);
        return snap;
      },
      onList: (next) => {
        tabBList = applyAutomationsListSnapshot(tabBList, next);
      },
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return automation({ id, name: "打开中" });
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("atm_a");
    expect(tabBList.map((row) => row.id)).toEqual(["atm_a", "atm_b"]);

    server.splice(0, 1);
    tickInterval();
    await flush();

    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("atm_b");
    expect(selectedFetches.every((id) => id === "atm_a")).toBe(true);
    expect(selectedFetches).not.toContain("atm_b");

    const afterPoll = listFetches.length;
    setVisible(false);
    server.length = 0;
    tickInterval();
    await flush();
    expect(listFetches.length).toBe(afterPoll);

    setVisible(true);
    await flush();
    expect(listFetches.length).toBeGreaterThan(afterPoll);
    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBeNull();

    const beforeFocus = listFetches.length;
    focus();
    await flush();
    expect(listFetches.length).toBeGreaterThan(beforeFocus);
    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBeNull();
    stop();
  });

  it("does not treat a failed list refresh as a delete", async () => {
    let fail = false;
    let tabBDetail: Automation | null = automation({ id: "atm_a" });
    let left = false;
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [automation({ id: "atm_a", name: "每日整理" })];
      },
      onList: () => undefined,
      selectedId: "atm_a",
      fetchSelected: async () => automation({ id: "atm_a", name: "每日整理" }),
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      onOpenId: () => {
        left = true;
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    fail = true;
    tickInterval();
    await flush();
    expect(left).toBe(false);
    expect(tabBDetail?.id).toBe("atm_a");
    expect(tabBDetail?.name).toBe("每日整理");
    stop();
  });

  it("never treats deleted-open cleanup snapshots as a place to store secrets", () => {
    const snap = [automation({ id: "atm_b", name: "其他自动化" })];
    const applied = applyAutomationDetailSnapshot(automation({ id: "atm_a", name: "已删" }), null);
    const raw = JSON.stringify({
      applied,
      snap,
      nextId: nextOpenAutomationId("atm_a", snap),
      fetch: shouldFetchAutomationDetail("atm_a", snap),
    });
    expect(applied).toBeNull();
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
  });
});

describe("automation pins after expert / team / project delete (Milestone AU)", () => {
  const catalogs = {
    experts: [
      { id: "exp_custom", name: "AU 文档专家" },
      { id: "exp_scout", name: "侦察 Scout" },
    ],
    teams: [
      { id: "team_docs", name: "AU 文档小队" },
      { id: "team_coding", name: "编码流水线" },
    ],
    projects: [
      { id: "prj_gone", name: "AU 已删项目" },
      { id: "prj_keep", name: "AU 保留项目" },
    ],
  };

  function paintedPins(item: Automation | null) {
    const expertName = catalogs.experts.find((e) => e.id === item?.expertId)?.name;
    const teamName = catalogs.teams.find((t) => t.id === item?.expertTeamId)?.name;
    const projectName = catalogs.projects.find((p) => p.id === item?.projectId)?.name;
    return {
      expertId: item?.expertId ?? "",
      expertTeamId: item?.expertTeamId ?? "",
      projectId: item?.projectId ?? "",
      expertHint: expertName ? `专家 ${expertName}` : "",
      teamHint: teamName ? `小队 ${teamName}` : "",
      projectHint: projectName ? `项目 ${projectName}` : "",
    };
  }

  it("reuses the existing 2s AG list poll and stays on default runtime pig", () => {
    expect(AUTOMATIONS_LIST_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("list / open detail snapshots drop a cleared expertId without remounting other pins", () => {
    const prev = automation({
      id: "atm_a",
      expertId: "exp_custom",
      expertTeamId: "team_coding",
      projectId: "prj_keep",
      name: "每日整理",
    });
    const list = applyAutomationsListSnapshot(
      [prev],
      [automation({ id: "atm_a", expertTeamId: "team_coding", projectId: "prj_keep", name: "每日整理" })],
    );
    const detail = applyAutomationDetailSnapshot(
      prev,
      automation({ id: "atm_a", expertTeamId: "team_coding", projectId: "prj_keep", name: "每日整理" }),
    );
    expect(list[0]?.expertId).toBeUndefined();
    expect(list[0]?.expertTeamId).toBe("team_coding");
    expect(list[0]?.projectId).toBe("prj_keep");
    expect(detail?.expertId).toBeUndefined();
    expect(detail?.expertTeamId).toBe("team_coding");
    expect(paintedPins(detail)).toEqual({
      expertId: "",
      expertTeamId: "team_coding",
      projectId: "prj_keep",
      expertHint: "",
      teamHint: "小队 编码流水线",
      projectHint: "项目 AU 保留项目",
    });
    expect(JSON.stringify({ list, detail })).not.toMatch(/exp_custom|AU 文档专家|sk-|Bearer |DEEPSEEK_API_KEY/);
  });

  it("Tab B list and open detail unbind after Tab A deletes the pinned custom expert", async () => {
    let server = [
      automation({
        id: "atm_a",
        name: "打开中",
        expertId: "exp_custom",
        expertTeamId: "team_coding",
        projectId: "prj_keep",
      }),
      automation({ id: "atm_b", name: "其他自动化", expertId: "exp_scout" }),
    ];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: Automation | null = automation({
      id: "atm_a",
      name: "打开中",
      expertId: "exp_custom",
      expertTeamId: "team_coding",
      projectId: "prj_keep",
    });
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyAutomationsListSnapshot(tabBList, next);
      },
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        const found = server.find((row) => row.id === id);
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedPins(tabBDetail).expertHint).toBe("专家 AU 文档专家");
    expect(tabBList.find((row) => row.id === "atm_a")?.expertId).toBe("exp_custom");

    // Tab A DELETE /api/experts/:id cleared expertId on the GET snapshot (no new poller).
    server = [
      automation({
        id: "atm_a",
        name: "打开中",
        expertTeamId: "team_coding",
        projectId: "prj_keep",
        updatedAt: "2026-09-15T07:20:00.000Z",
      }),
      automation({ id: "atm_b", name: "其他自动化", expertId: "exp_scout" }),
    ];
    tickInterval();
    await flush();

    expect(tabBDetail?.expertId).toBeUndefined();
    expect(tabBDetail?.expertTeamId).toBe("team_coding");
    expect(tabBDetail?.projectId).toBe("prj_keep");
    expect(tabBDetail?.id).toBe("atm_a");
    expect(paintedPins(tabBDetail).expertHint).toBe("");
    expect(tabBList.find((row) => row.id === "atm_a")?.expertId).toBeUndefined();
    expect(tabBList.find((row) => row.id === "atm_b")?.expertId).toBe("exp_scout");
    expect(JSON.stringify({ list: tabBList, detail: tabBDetail })).not.toMatch(
      /exp_custom|AU 文档专家|sk-|Bearer |DEEPSEEK_API_KEY/,
    );

    const afterPoll = server[0]!;
    setVisible(false);
    tickInterval();
    await flush();
    expect(tabBDetail?.expertTeamId).toBe("team_coding");

    setVisible(true);
    await flush();
    expect(tabBDetail?.expertId).toBeUndefined();
    focus();
    await flush();
    expect(tabBDetail?.name).toBe(afterPoll.name);
    expect(tabBDetail?.runtime).toBe("pig");
    stop();
  });

  it("Tab B unbinds expertTeamId after a custom team delete and projectId after a project delete", async () => {
    let server = [
      automation({
        id: "atm_a",
        expertId: "exp_scout",
        expertTeamId: "team_docs",
        projectId: "prj_gone",
      }),
    ];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: Automation | null = automation({
      id: "atm_a",
      expertId: "exp_scout",
      expertTeamId: "team_docs",
      projectId: "prj_gone",
    });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startAutomationsListSync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyAutomationsListSnapshot(tabBList, next);
      },
      selectedId: "atm_a",
      fetchSelected: async (id) => {
        const found = server.find((row) => row.id === id);
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyAutomationDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedPins(tabBDetail)).toMatchObject({
      teamHint: "小队 AU 文档小队",
      projectHint: "项目 AU 已删项目",
    });

    server = [
      automation({
        id: "atm_a",
        expertId: "exp_scout",
        projectId: "prj_gone",
        updatedAt: "2026-09-15T07:21:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabBDetail?.expertTeamId).toBeUndefined();
    expect(tabBDetail?.expertId).toBe("exp_scout");
    expect(tabBDetail?.projectId).toBe("prj_gone");
    expect(paintedPins(tabBDetail).teamHint).toBe("");
    expect(tabBList[0]?.expertTeamId).toBeUndefined();

    server = [
      automation({
        id: "atm_a",
        expertId: "exp_scout",
        updatedAt: "2026-09-15T07:22:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabBDetail?.projectId).toBeUndefined();
    expect(tabBDetail?.expertId).toBe("exp_scout");
    expect(paintedPins(tabBDetail).projectHint).toBe("");
    expect(tabBList[0]?.projectId).toBeUndefined();
    expect(JSON.stringify({ list: tabBList, detail: tabBDetail })).not.toMatch(
      /team_docs|AU 文档小队|prj_gone|AU 已删项目|sk-|Bearer |DEEPSEEK_API_KEY/,
    );
    stop();
  });

  it("never treats cleared-pin snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...automation({
        id: "atm_a",
        lastError: "失败 sk-abcdefghijklmnop 与 Bearer tok-abc",
      }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    } as Automation & { llmApiKey: string; cloudToken: string };
    const applied = applyAutomationsListSnapshot(
      [automation({ id: "atm_a", expertId: "exp_custom" })],
      [dirty],
    );
    const detail = applyAutomationDetailSnapshot(automation({ id: "atm_a", expertId: "exp_custom" }), dirty);
    const raw = JSON.stringify({ list: applied, detail, painted: paintedPins(detail) });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(applied[0]?.expertId).toBeUndefined();
    expect(detail?.expertId).toBeUndefined();

    const fetches: Automation[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startAutomationsListSync({
      fetchList: async () => {
        const next = [automation({ id: "atm_a" })];
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
});
