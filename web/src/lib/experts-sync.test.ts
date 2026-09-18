import { describe, expect, it } from "vitest";
import type { Expert, ExpertTeam } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyExpertDetailSnapshot,
  applyExpertTeamsListSnapshot,
  applyExpertsListSnapshot,
  EXPERTS_SYNC_POLL_MS,
  expertSyncKey,
  expertTeamSyncKey,
  nextOpenExpertId,
  sanitizeExpert,
  sanitizeExpertTeam,
  shouldFetchExpertDetail,
  startExpertsSync,
} from "./experts-sync";

function expert(overrides: Partial<Expert> & { id: string } = { id: "exp_scout" }): Expert {
  return {
    id: overrides.id,
    name: overrides.name ?? "侦察 Scout",
    description: overrides.description ?? "Explore and cite paths.",
    instruction: overrides.instruction ?? "只探索并引用路径。默认不改文件。",
    kind: overrides.kind ?? "scout",
    skillIds: overrides.skillIds ?? [],
    bundled: overrides.bundled ?? true,
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
  };
}

function team(overrides: Partial<ExpertTeam> & { id: string } = { id: "team_coding" }): ExpertTeam {
  return {
    id: overrides.id,
    name: overrides.name ?? "编码流水线",
    description: overrides.description ?? "scout → plan → implement → review",
    mode: overrides.mode ?? "chain",
    expertIds: overrides.expertIds ?? ["exp_scout", "exp_plan", "exp_implement", "exp_review"],
    bundled: overrides.bundled ?? true,
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
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

function paintedExpert(row: Expert | null) {
  return {
    id: row?.id,
    name: row?.name,
    kind: row?.kind,
    instruction: row?.instruction,
    skillIds: row?.skillIds ?? [],
  };
}

function paintedTeam(row: ExpertTeam | null) {
  return {
    id: row?.id,
    name: row?.name,
    mode: row?.mode,
    expertIds: row?.expertIds ?? [],
  };
}

describe("experts cross-tab sync (Milestone AC)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(EXPERTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous list / detail / team reference when snapshots are unchanged", () => {
    const prevList = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    const nextList = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    expect(applyExpertsListSnapshot(prevList, nextList)).toBe(prevList);
    expect(expertSyncKey(prevList[0]!)).toBe(expertSyncKey(nextList[0]!));

    const prevDetail = expert({ id: "exp_scout" });
    expect(applyExpertDetailSnapshot(prevDetail, prevDetail)).toBe(prevDetail);

    const prevTeams = [team({ id: "team_coding" })];
    const nextTeams = [team({ id: "team_coding" })];
    expect(applyExpertTeamsListSnapshot(prevTeams, nextTeams)).toBe(prevTeams);
    expect(expertTeamSyncKey(prevTeams[0]!)).toBe(expertTeamSyncKey(nextTeams[0]!));
  });

  it("does not remount create-draft fields when only list / open detail instruction changes", () => {
    const createDraft = { name: "本地正在输入的专家", instruction: "本地草稿指令" };
    const prev = expert({ id: "exp_custom", name: "旧名称", instruction: "旧指令", bundled: false });
    const next = applyExpertDetailSnapshot(
      prev,
      expert({
        id: "exp_custom",
        name: "Tab A 改过的名称",
        instruction: "Tab A 改过的指令",
        bundled: false,
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    );
    expect(next).not.toBe(prev);
    expect(next?.name).toBe("Tab A 改过的名称");
    expect(next?.instruction).toBe("Tab A 改过的指令");
    expect(createDraft).toEqual({ name: "本地正在输入的专家", instruction: "本地草稿指令" });
  });

  it("ignores a snapshot for another expert and a missing open detail", () => {
    const prev = expert({ id: "exp_scout" });
    expect(applyExpertDetailSnapshot(prev, expert({ id: "exp_plan", name: "规划 Plan" }))).toBe(prev);
    expect(applyExpertDetailSnapshot(null, expert({ id: "exp_scout", name: "侦察 Scout" }))).toBeNull();
  });

  it("Tab B list follows Tab A create / edit / delete without a full remount", async () => {
    let server = [expert({ id: "exp_scout", name: "侦察 Scout", kind: "scout" })];
    let tabB = server.map((row) => ({ ...row, skillIds: [...row.skillIds] }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => server.map((row) => ({ ...row, skillIds: [...row.skillIds] })),
      onList: (next) => {
        tabB = applyExpertsListSnapshot(tabB, next);
      },
      fetchTeams: async () => [],
      onTeams: () => undefined,
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedExpert(tabB[0]!)).toEqual({
      id: "exp_scout",
      name: "侦察 Scout",
      kind: "scout",
      instruction: "只探索并引用路径。默认不改文件。",
      skillIds: [],
    });

    server = [
      expert({
        id: "exp_custom",
        name: "本机助手",
        kind: "custom",
        instruction: "只整理 sample-workspace。",
        bundled: false,
        skillIds: ["coding-helper"],
        updatedAt: "2026-09-14T12:09:00.000Z",
      }),
      expert({
        id: "exp_scout",
        name: "侦察 Scout · 已编辑",
        instruction: "只探索并引用路径。默认不改文件。· 已编辑",
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabB.map((row) => row.id)).toEqual(["exp_custom", "exp_scout"]);
    expect(paintedExpert(tabB.find((row) => row.id === "exp_scout")!)).toEqual({
      id: "exp_scout",
      name: "侦察 Scout · 已编辑",
      kind: "scout",
      instruction: "只探索并引用路径。默认不改文件。· 已编辑",
      skillIds: [],
    });
    expect(paintedExpert(tabB.find((row) => row.id === "exp_custom")!)).toEqual({
      id: "exp_custom",
      name: "本机助手",
      kind: "custom",
      instruction: "只整理 sample-workspace。",
      skillIds: ["coding-helper"],
    });

    server = [
      expert({
        id: "exp_scout",
        name: "侦察 Scout · 已编辑",
        instruction: "只探索并引用路径。默认不改文件。· 已编辑",
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["exp_scout"]);
    expect(tabB.find((row) => row.id === "exp_custom")).toBeUndefined();
    stop();
  });

  it("Tab B team list follows GET /api/expert-teams without remounting the page", async () => {
    let teamServer = [team({ id: "team_coding", name: "编码流水线", mode: "chain" })];
    let tabBTeams = teamServer.map((row) => ({ ...row, expertIds: [...row.expertIds] }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => [expert({ id: "exp_scout" })],
      onList: () => undefined,
      fetchTeams: async () => teamServer.map((row) => ({ ...row, expertIds: [...row.expertIds] })),
      onTeams: (next) => {
        tabBTeams = applyExpertTeamsListSnapshot(tabBTeams, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedTeam(tabBTeams[0]!)).toEqual({
      id: "team_coding",
      name: "编码流水线",
      mode: "chain",
      expertIds: ["exp_scout", "exp_plan", "exp_implement", "exp_review"],
    });

    teamServer = [
      team({
        id: "team_docs",
        name: "文档小队",
        mode: "parallel",
        expertIds: ["exp_scout", "exp_review"],
        bundled: false,
        updatedAt: "2026-09-14T12:11:00.000Z",
      }),
      team({
        id: "team_coding",
        name: "编码流水线 · 已编辑",
        mode: "chain",
        expertIds: ["exp_plan", "exp_implement"],
        updatedAt: "2026-09-14T12:10:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabBTeams.map((row) => row.id)).toEqual(["team_docs", "team_coding"]);
    expect(paintedTeam(tabBTeams.find((row) => row.id === "team_coding")!)).toEqual({
      id: "team_coding",
      name: "编码流水线 · 已编辑",
      mode: "chain",
      expertIds: ["exp_plan", "exp_implement"],
    });
    expect(paintedTeam(tabBTeams.find((row) => row.id === "team_docs")!)).toEqual({
      id: "team_docs",
      name: "文档小队",
      mode: "parallel",
      expertIds: ["exp_scout", "exp_review"],
    });

    teamServer = [
      team({
        id: "team_coding",
        name: "编码流水线 · 已编辑",
        expertIds: ["exp_plan", "exp_implement"],
        updatedAt: "2026-09-14T12:10:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabBTeams.map((row) => row.id)).toEqual(["team_coding"]);
    expect(tabBTeams.find((row) => row.id === "team_docs")).toBeUndefined();
    stop();
  });

  it("open detail also follows GET /api/experts/:id without remounting the page", async () => {
    const listServer = [expert({ id: "exp_scout", instruction: "只探索并引用路径。" })];
    let detailServer: Expert = expert({ id: "exp_scout", instruction: "只探索并引用路径。" });
    let tabBDetail: Expert | null = expert({ id: "exp_scout", instruction: "只探索并引用路径。" });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => listServer.map((row) => ({ ...row })),
      onList: () => undefined,
      fetchTeams: async () => [],
      onTeams: () => undefined,
      selectedId: "exp_scout",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return { ...detailServer, skillIds: [...detailServer.skillIds] };
      },
      onSelected: (next) => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toContain("exp_scout");
    expect(tabBDetail?.instruction).toBe("只探索并引用路径。");

    detailServer = expert({
      id: "exp_scout",
      name: "侦察 Scout",
      instruction: "Tab A 改过的指令",
      description: "Tab A 改过的简介",
      updatedAt: "2026-09-14T12:10:00.000Z",
    });
    tickInterval();
    await flush();

    expect(tabBDetail?.instruction).toBe("Tab A 改过的指令");
    expect(tabBDetail?.description).toBe("Tab A 改过的简介");
    expect(tabBDetail?.id).toBe("exp_scout");
    expect(tabBDetail?.updatedAt).toBe("2026-09-14T12:10:00.000Z");
    stop();
  });

  it("does not force-fetch detail body when that expert is not open", async () => {
    const selectedFetches: string[] = [];
    let tabB = [expert({ id: "exp_scout", instruction: "旧指令" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startExpertsSync({
      fetchList: async () => [
        expert({
          id: "exp_scout",
          instruction: "新指令",
          updatedAt: "2026-09-14T12:12:00.000Z",
        }),
      ],
      onList: (next) => {
        tabB = applyExpertsListSnapshot(tabB, next);
      },
      fetchTeams: async () => [],
      onTeams: () => undefined,
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
    expect(tabB[0]?.instruction).toBe("新指令");
    expect(tabB[0]?.updatedAt).toBe("2026-09-14T12:12:00.000Z");
    stop();
  });

  it("clears the open detail when Tab A deletes that expert", async () => {
    let server: Expert[] = [expert({ id: "exp_custom", name: "本机助手", bundled: false })];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: Expert | null = expert({ id: "exp_custom", name: "本机助手", bundled: false });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyExpertsListSnapshot(tabBList, next);
      },
      fetchTeams: async () => [],
      onTeams: () => undefined,
      selectedId: "exp_custom",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        const found = server.find((row) => row.id === "exp_custom");
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, next);
      },
      onOpenId: () => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("exp_custom");
    expect(selectedFetches).toEqual(["exp_custom"]);

    server = [];
    tickInterval();
    await flush();
    expect(tabBList).toEqual([]);
    expect(tabBDetail).toBeNull();
    expect(selectedFetches).toEqual(["exp_custom"]);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [expert({ id: "exp_scout" })];
    let calls = 0;
    let teamCalls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startExpertsSync({
      fetchList: async () => {
        calls += 1;
        return server.map((row) => ({ ...row }));
      },
      onList: () => undefined,
      fetchTeams: async () => {
        teamCalls += 1;
        return [];
      },
      onTeams: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;
    const teamsAfterMount = teamCalls;
    expect(teamsAfterMount).toBe(afterMount);

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);
    expect(teamCalls).toBe(teamsAfterMount);

    server[0] = expert({ id: "exp_scout", name: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);
    expect(teamCalls).toBeGreaterThan(teamsAfterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats expert snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...expert({ id: "exp_scout", instruction: "只探索并引用路径。" }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    } as Expert & { llmApiKey: string; cloudToken: string };
    const dirtyTeam = {
      ...team({ id: "team_coding" }),
      llmApiKey: "sk-abcdefghijklmnop",
      PIG_CLOUD_TOKEN: "tok-secret",
    } as ExpertTeam & { llmApiKey: string; PIG_CLOUD_TOKEN: string };
    const applied = applyExpertsListSnapshot([], [dirty]);
    const teams = applyExpertTeamsListSnapshot([], [dirtyTeam]);
    const detail = applyExpertDetailSnapshot(expert({ id: "exp_scout" }), dirty);
    const raw = JSON.stringify({
      list: applied,
      teams,
      detail,
      painted: paintedExpert(applied[0]!),
    });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(paintedExpert(applied[0]!).instruction).toBe("只探索并引用路径。");
    expect(sanitizeExpert(dirty)).not.toHaveProperty("llmApiKey");
    expect(sanitizeExpertTeam(dirtyTeam)).not.toHaveProperty("PIG_CLOUD_TOKEN");

    const fetches: Expert[][] = [];
    const teamFetches: ExpertTeam[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startExpertsSync({
      fetchList: async () => {
        const next = [expert({ id: "exp_scout", instruction: "只探索并引用路径。" })];
        fetches.push(next);
        return next;
      },
      onList: () => undefined,
      fetchTeams: async () => {
        const next = [team({ id: "team_coding" })];
        teamFetches.push(next);
        return next;
      },
      onTeams: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(teamFetches.length).toBeGreaterThan(0);
    expect(fetches.every((list) => list[0]?.id === "exp_scout")).toBe(true);
    expect(teamFetches.every((list) => list[0]?.id === "team_coding")).toBe(true);
    stop();
  });

  it("keeps the last good list / detail / teams when a refresh fails", async () => {
    let fail = false;
    let tabB = [expert({ id: "exp_scout", instruction: "只探索并引用路径。" })];
    let tabBDetail: Expert | null = expert({ id: "exp_scout", instruction: "只探索并引用路径。" });
    let tabBTeams = [team({ id: "team_coding" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startExpertsSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [expert({ id: "exp_scout", instruction: "只探索并引用路径。" })];
      },
      onList: (next) => {
        tabB = applyExpertsListSnapshot(tabB, next);
      },
      fetchTeams: async () => {
        if (fail) throw new Error("gone");
        return [team({ id: "team_coding" })];
      },
      onTeams: (next) => {
        tabBTeams = applyExpertTeamsListSnapshot(tabBTeams, next);
      },
      selectedId: "exp_scout",
      fetchSelected: async () => {
        if (fail) throw new Error("gone");
        return expert({ id: "exp_scout", instruction: "只探索并引用路径。" });
      },
      onSelected: (next) => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB[0]?.instruction).toBe("只探索并引用路径。");
    expect(tabBDetail?.instruction).toBe("只探索并引用路径。");
    expect(tabBTeams[0]?.name).toBe("编码流水线");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.instruction).toBe("只探索并引用路径。");
    expect(tabBDetail?.instruction).toBe("只探索并引用路径。");
    expect(tabBTeams[0]?.name).toBe("编码流水线");
    stop();
  });
});

describe("open expert detail deleted-elsewhere cleanup (Milestone AR)", () => {
  it("reuses the 2s list poll and stays on default runtime pig", () => {
    expect(EXPERTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("keeps the open id when it is still in GET /api/experts", () => {
    const list = [expert({ id: "exp_custom" }), expert({ id: "exp_scout" })];
    expect(nextOpenExpertId("exp_custom", list)).toBe("exp_custom");
    expect(shouldFetchExpertDetail("exp_custom", list)).toBe(true);
    const prev = expert({ id: "exp_custom" });
    expect(applyExpertDetailSnapshot(prev, prev)).toBe(prev);
  });

  it("clears the open expert when the list no longer contains that id", () => {
    const prev = expert({ id: "exp_custom", name: "幽灵详情", bundled: false });
    const remaining = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    expect(applyExpertDetailSnapshot(prev, null)).toBeNull();
    expect(shouldFetchExpertDetail("exp_custom", remaining)).toBe(false);
    expect(shouldFetchExpertDetail("exp_custom", [])).toBe(false);
    expect(shouldFetchExpertDetail(undefined, remaining)).toBe(false);
    expect(nextOpenExpertId("exp_custom", remaining)).toBe("exp_scout");
    expect(nextOpenExpertId("exp_custom", [])).toBeNull();
    expect(nextOpenExpertId(null, remaining)).toBeNull();
  });

  it("does not GET /api/experts/:id after the list confirms the open id is gone", async () => {
    let listServer = [expert({ id: "exp_custom", bundled: false }), expert({ id: "exp_scout" })];
    const selectedFetches: string[] = [];
    const openIds: Array<string | null> = [];
    let tabBDetail: Expert | null = expert({ id: "exp_custom", bundled: false });
    let tabBOpenId: string | null = "exp_custom";
    const { clock, tickInterval } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => listServer.map((row) => ({ ...row })),
      onList: () => undefined,
      fetchTeams: async () => [],
      onTeams: () => undefined,
      selectedId: "exp_custom",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return expert({ id });
      },
      onSelected: (next) => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        openIds.push(nextId);
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toEqual(["exp_custom"]);
    expect(tabBDetail?.id).toBe("exp_custom");

    listServer = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    tickInterval();
    await flush();

    expect(selectedFetches).toEqual(["exp_custom"]);
    expect(selectedFetches).not.toContain("exp_scout");
    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("exp_scout");
    expect(openIds).toEqual(["exp_scout"]);
    stop();
  });

  it("Tab B leaves an expert Tab A deleted on poll / focus / visibility", async () => {
    const server = [
      expert({ id: "exp_custom", name: "打开中", bundled: false }),
      expert({ id: "exp_scout", name: "侦察 Scout" }),
    ];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: Expert | null = expert({ id: "exp_custom", name: "打开中", bundled: false });
    let tabBOpenId: string | null = "exp_custom";
    const selectedFetches: string[] = [];
    const listFetches: Expert[][] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => {
        const snap = server.map((row) => ({ ...row }));
        listFetches.push(snap);
        return snap;
      },
      onList: (next) => {
        tabBList = applyExpertsListSnapshot(tabBList, next);
      },
      fetchTeams: async () => [],
      onTeams: () => undefined,
      selectedId: "exp_custom",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return expert({ id, name: "打开中", bundled: false });
      },
      onSelected: (next) => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("exp_custom");
    expect(tabBList.map((row) => row.id)).toEqual(["exp_custom", "exp_scout"]);

    server.splice(0, 1);
    tickInterval();
    await flush();

    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("exp_scout");
    expect(selectedFetches.every((id) => id === "exp_custom")).toBe(true);
    expect(selectedFetches).not.toContain("exp_scout");

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
    let tabBDetail: Expert | null = expert({ id: "exp_custom", bundled: false });
    let left = false;
    const { clock, tickInterval } = fakeClock(true);
    const stop = startExpertsSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [expert({ id: "exp_custom", name: "本机助手", bundled: false })];
      },
      onList: () => undefined,
      fetchTeams: async () => {
        if (fail) throw new Error("gone");
        return [];
      },
      onTeams: () => undefined,
      selectedId: "exp_custom",
      fetchSelected: async () => expert({ id: "exp_custom", name: "本机助手", bundled: false }),
      onSelected: (next) => {
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, next);
      },
      onOpenId: () => {
        left = true;
        tabBDetail = applyExpertDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    fail = true;
    tickInterval();
    await flush();
    expect(left).toBe(false);
    expect(tabBDetail?.id).toBe("exp_custom");
    expect(tabBDetail?.name).toBe("本机助手");
    stop();
  });

  it("never treats deleted-open cleanup snapshots as a place to store secrets", () => {
    const snap = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    const applied = applyExpertDetailSnapshot(expert({ id: "exp_custom", name: "已删", bundled: false }), null);
    const raw = JSON.stringify({
      applied,
      snap,
      nextId: nextOpenExpertId("exp_custom", snap),
      fetch: shouldFetchExpertDetail("exp_custom", snap),
    });
    expect(applied).toBeNull();
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
  });
});

describe("team expertIds after custom expert delete (Milestone AY)", () => {
  it("reuses the existing 2s GET /api/expert-teams poll and stays on default runtime pig", () => {
    expect(EXPERTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("applies a GET /api/expert-teams snapshot that dropped the deleted member", () => {
    const prev = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_custom", "exp_scout"],
      }),
    ];
    const next = applyExpertTeamsListSnapshot(prev, [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_scout"],
        updatedAt: "2026-09-18T07:00:00.000Z",
      }),
    ]);
    expect(next).not.toBe(prev);
    expect(next[0]?.expertIds).toEqual(["exp_scout"]);
    expect(next[0]?.expertIds).not.toContain("exp_custom");
    expect(expertTeamSyncKey(next[0]!)).not.toBe(expertTeamSyncKey(prev[0]!));
  });

  it("Tab B team list drops the ghost member via existing AC GET /api/expert-teams", async () => {
    let teamServer = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_custom", "exp_scout"],
      }),
      team({
        id: "team_empty",
        name: "将变空小队",
        bundled: false,
        expertIds: ["exp_custom"],
      }),
    ];
    let tabBTeams = teamServer.map((row) => ({ ...row, expertIds: [...row.expertIds] }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startExpertsSync({
      fetchList: async () => [expert({ id: "exp_scout" })],
      onList: () => undefined,
      fetchTeams: async () => teamServer.map((row) => ({ ...row, expertIds: [...row.expertIds] })),
      onTeams: (next) => {
        tabBTeams = applyExpertTeamsListSnapshot(tabBTeams, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBTeams.find((row) => row.id === "team_docs")?.expertIds).toEqual(["exp_custom", "exp_scout"]);

    // Tab A DELETE /api/experts/:id cleared expertIds on the GET snapshot (no new poller).
    teamServer = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_scout"],
        updatedAt: "2026-09-18T07:01:00.000Z",
      }),
      team({
        id: "team_empty",
        name: "将变空小队",
        bundled: false,
        expertIds: [],
        updatedAt: "2026-09-18T07:01:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabBTeams.map((row) => row.id)).toEqual(["team_docs", "team_empty"]);
    expect(paintedTeam(tabBTeams.find((row) => row.id === "team_docs")!)).toEqual({
      id: "team_docs",
      name: "文档小队",
      mode: "chain",
      expertIds: ["exp_scout"],
    });
    expect(tabBTeams.find((row) => row.id === "team_empty")?.expertIds).toEqual([]);
    expect(tabBTeams.every((row) => !row.expertIds.includes("exp_custom"))).toBe(true);
    expect(JSON.stringify(tabBTeams)).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    stop();
  });
});
