import { describe, expect, it } from "vitest";
import type { Expert, ExpertTeam, ProjectSummary } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyPinExpertCatalogSnapshot,
  applyPinProjectCatalogSnapshot,
  applyPinTeamCatalogSnapshot,
  PIN_CATALOG_POLL_MS,
  pinCatalogSelectOptions,
  pinExpertCatalogKey,
  pinProjectCatalogKey,
  pinTeamCatalogKey,
  sanitizePinExpert,
  sanitizePinProject,
  sanitizePinTeam,
  startPinCatalogSync,
} from "./pin-catalog-sync";
import { SESSION_PIN_UNBOUND, sessionPinBindingLabel, sessionPinSelectValue } from "./session-pin-sync";

function project(overrides: Partial<ProjectSummary> & { id: string } = { id: "prj_1" }): ProjectSummary {
  return {
    id: overrides.id,
    name: overrides.name ?? "工作区整理",
    instruction: overrides.instruction ?? "按笔记整理工作区。",
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    memberCount: overrides.memberCount ?? 1,
    todoCount: overrides.todoCount ?? 0,
    assetCount: overrides.assetCount ?? 0,
    sessionCount: overrides.sessionCount ?? 0,
  };
}

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

function paintedDropdowns(
  projects: ProjectSummary[],
  experts: Expert[],
  teams: ExpertTeam[],
  bound?: { projectId?: string; expertId?: string; teamId?: string },
) {
  return {
    projectOptions: pinCatalogSelectOptions(projects),
    expertOptions: pinCatalogSelectOptions(experts),
    teamOptions: pinCatalogSelectOptions(teams),
    project: sessionPinSelectValue(bound?.projectId),
    expert: sessionPinSelectValue(bound?.expertId),
    squad: sessionPinSelectValue(bound?.teamId),
    projectHint: sessionPinBindingLabel(bound?.projectId, projects),
    expertHint: sessionPinBindingLabel(bound?.expertId, experts),
    squadHint: sessionPinBindingLabel(bound?.teamId, teams),
  };
}

describe("workbench pin-dropdown catalogs (Milestone AK)", () => {
  it("keeps a 2s poll cadence, 未绑定, and default runtime pig", () => {
    expect(PIN_CATALOG_POLL_MS).toBe(2_000);
    expect(SESSION_PIN_UNBOUND).toBe("未绑定");
    expect(pinCatalogSelectOptions([])).toEqual([{ value: "", label: "未绑定" }]);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous catalog references when dropdown-visible id / name are unchanged", () => {
    const prevProjects = [project({ id: "prj_1" })];
    const prevExperts = [expert({ id: "exp_scout" })];
    const prevTeams = [team({ id: "team_coding" })];
    expect(applyPinProjectCatalogSnapshot(prevProjects, [project({ id: "prj_1" })])).toBe(prevProjects);
    expect(applyPinExpertCatalogSnapshot(prevExperts, [expert({ id: "exp_scout" })])).toBe(prevExperts);
    expect(applyPinTeamCatalogSnapshot(prevTeams, [team({ id: "team_coding" })])).toBe(prevTeams);
    expect(pinProjectCatalogKey(prevProjects[0]!)).toBe(pinProjectCatalogKey(project({ id: "prj_1" })));
    expect(pinExpertCatalogKey(prevExperts[0]!)).toBe(pinExpertCatalogKey(expert({ id: "exp_scout" })));
    expect(pinTeamCatalogKey(prevTeams[0]!)).toBe(pinTeamCatalogKey(team({ id: "team_coding" })));
  });

  it("does not remount the pin row or change Milestone Y bindings when only catalogs change", () => {
    const bound = { projectId: "prj_1", expertId: "exp_scout", expertTeamId: "team_coding" };
    const prev = [project({ id: "prj_1", name: "旧名" })];
    const next = applyPinProjectCatalogSnapshot(prev, [project({ id: "prj_1", name: "Tab A 改过的项目" })]);
    expect(next).not.toBe(prev);
    expect(next[0]?.name).toBe("Tab A 改过的项目");
    expect(bound).toEqual({ projectId: "prj_1", expertId: "exp_scout", expertTeamId: "team_coding" });
    expect(sessionPinSelectValue(bound.projectId)).toBe("prj_1");
  });

  it("Tab B pin dropdowns follow Tab A create / rename / delete without a full remount", async () => {
    let serverProjects = [project({ id: "prj_1", name: "工作区整理" })];
    let serverExperts = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    let serverTeams = [team({ id: "team_coding", name: "编码流水线" })];
    let tabBProjects = serverProjects.map((row) => ({ ...row }));
    let tabBExperts = serverExperts.map((row) => ({ ...row }));
    let tabBTeams = serverTeams.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startPinCatalogSync({
      fetchProjects: async () => serverProjects.map((row) => ({ ...row })),
      onProjects: (next) => {
        tabBProjects = applyPinProjectCatalogSnapshot(tabBProjects, next);
      },
      fetchExperts: async () => serverExperts.map((row) => ({ ...row })),
      onExperts: (next) => {
        tabBExperts = applyPinExpertCatalogSnapshot(tabBExperts, next);
      },
      fetchTeams: async () => serverTeams.map((row) => ({ ...row })),
      onTeams: (next) => {
        tabBTeams = applyPinTeamCatalogSnapshot(tabBTeams, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedDropdowns(tabBProjects, tabBExperts, tabBTeams).projectOptions).toEqual([
      { value: "", label: "未绑定" },
      { value: "prj_1", label: "工作区整理" },
    ]);

    serverProjects = [
      project({ id: "prj_2", name: "Tab A 新建项目" }),
      project({ id: "prj_1", name: "工作区整理 · 已改名" }),
    ];
    serverExperts = [
      expert({ id: "exp_custom", name: "Tab A 新建专家", kind: "custom", bundled: false }),
      expert({ id: "exp_scout", name: "侦察 Scout · 已改名" }),
    ];
    serverTeams = [
      team({ id: "team_docs", name: "Tab A 新建小队", bundled: false, expertIds: ["exp_custom"] }),
      team({ id: "team_coding", name: "编码流水线 · 已改名" }),
    ];
    tickInterval();
    await flush();

    const painted = paintedDropdowns(tabBProjects, tabBExperts, tabBTeams, {
      projectId: "prj_1",
      expertId: "exp_scout",
      teamId: "team_coding",
    });
    expect(painted.projectOptions.map((opt) => opt.value)).toEqual(["", "prj_2", "prj_1"]);
    expect(painted.expertOptions.map((opt) => opt.label)).toEqual(["未绑定", "Tab A 新建专家", "侦察 Scout · 已改名"]);
    expect(painted.teamOptions.map((opt) => opt.label)).toEqual(["未绑定", "Tab A 新建小队", "编码流水线 · 已改名"]);
    expect(painted.projectHint).toBe("工作区整理 · 已改名");
    expect(painted.expertHint).toBe("侦察 Scout · 已改名");
    expect(painted.squadHint).toBe("编码流水线 · 已改名");
    expect(painted.project).toBe("prj_1");

    serverProjects = [project({ id: "prj_2", name: "Tab A 新建项目" })];
    serverExperts = [expert({ id: "exp_scout", name: "侦察 Scout · 已改名" })];
    serverTeams = [team({ id: "team_coding", name: "编码流水线 · 已改名" })];
    tickInterval();
    await flush();

    expect(tabBProjects.map((row) => row.id)).toEqual(["prj_2"]);
    expect(tabBExperts.map((row) => row.id)).toEqual(["exp_scout"]);
    expect(tabBTeams.map((row) => row.id)).toEqual(["team_coding"]);
    expect(tabBProjects.find((row) => row.id === "prj_1")).toBeUndefined();
    expect(tabBExperts.find((row) => row.id === "exp_custom")).toBeUndefined();
    expect(tabBTeams.find((row) => row.id === "team_docs")).toBeUndefined();
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = {
      projects: [project({ id: "prj_1" })],
      experts: [expert({ id: "exp_scout" })],
      teams: [team({ id: "team_coding" })],
    };
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startPinCatalogSync({
      fetchProjects: async () => {
        calls += 1;
        return server.projects.map((row) => ({ ...row }));
      },
      onProjects: () => undefined,
      fetchExperts: async () => server.experts.map((row) => ({ ...row })),
      onExperts: () => undefined,
      fetchTeams: async () => server.teams.map((row) => ({ ...row })),
      onTeams: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server.projects[0] = project({ id: "prj_1", name: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats pin catalogs as a place to store secrets and stays GET-only", async () => {
    const dirtyProject = {
      ...project({ id: "prj_1", name: "整理 sk-abcdefghijklmnop", instruction: "Bearer tok-secret" }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
      PIG_CLOUD_TOKEN: "tok-secret",
    } as ProjectSummary & { llmApiKey: string; cloudToken: string; PIG_CLOUD_TOKEN: string };
    const dirtyExpert = {
      ...expert({
        id: "exp_scout",
        name: "侦察 DEEPSEEK_API_KEY=sk-zzzzzzzz",
        instruction: "PIG_CLOUD_TOKEN=tok-secret",
      }),
      llmApiKey: "sk-abcdefghijklmnop",
    } as Expert & { llmApiKey: string };
    const dirtyTeam = {
      ...team({ id: "team_coding", name: "小队 Bearer tok-secret" }),
      cloudToken: "Bearer tok-secret",
    } as ExpertTeam & { cloudToken: string };

    const projects = applyPinProjectCatalogSnapshot([], [dirtyProject]);
    const experts = applyPinExpertCatalogSnapshot([], [dirtyExpert]);
    const teams = applyPinTeamCatalogSnapshot([], [dirtyTeam]);
    const raw = JSON.stringify({
      projects,
      experts,
      teams,
      painted: paintedDropdowns(projects, experts, teams),
    });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(projects[0]?.name).toBe(redactSecretsForDisplay(dirtyProject.name));
    expect(experts[0]?.name).toBe(redactSecretsForDisplay(dirtyExpert.name));
    expect(teams[0]?.name).toBe(redactSecretsForDisplay(dirtyTeam.name));
    expect(sanitizePinProject(dirtyProject)).not.toHaveProperty("llmApiKey");
    expect(sanitizePinExpert(dirtyExpert)).not.toHaveProperty("llmApiKey");
    expect(sanitizePinTeam(dirtyTeam)).not.toHaveProperty("cloudToken");

    const fetches: { projects: number; experts: number; teams: number } = {
      projects: 0,
      experts: 0,
      teams: 0,
    };
    const { clock, tickInterval } = fakeClock(true);
    const stop = startPinCatalogSync({
      fetchProjects: async () => {
        fetches.projects += 1;
        return [project({ id: "prj_1" })];
      },
      onProjects: () => undefined,
      fetchExperts: async () => {
        fetches.experts += 1;
        return [expert({ id: "exp_scout" })];
      },
      onExperts: () => undefined,
      fetchTeams: async () => {
        fetches.teams += 1;
        return [team({ id: "team_coding" })];
      },
      onTeams: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.projects).toBeGreaterThan(0);
    expect(fetches.experts).toBe(fetches.projects);
    expect(fetches.teams).toBe(fetches.projects);
    stop();
  });

  it("keeps the last good catalogs when a refresh fails", async () => {
    let fail = false;
    let tabBProjects = [project({ id: "prj_1", name: "工作区整理" })];
    let tabBExperts = [expert({ id: "exp_scout" })];
    let tabBTeams = [team({ id: "team_coding" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startPinCatalogSync({
      fetchProjects: async () => {
        if (fail) throw new Error("gone");
        return [project({ id: "prj_1", name: "工作区整理" })];
      },
      onProjects: (next) => {
        tabBProjects = applyPinProjectCatalogSnapshot(tabBProjects, next);
      },
      fetchExperts: async () => [expert({ id: "exp_scout" })],
      onExperts: (next) => {
        tabBExperts = applyPinExpertCatalogSnapshot(tabBExperts, next);
      },
      fetchTeams: async () => [team({ id: "team_coding" })],
      onTeams: (next) => {
        tabBTeams = applyPinTeamCatalogSnapshot(tabBTeams, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabBProjects[0]?.name).toBe("工作区整理");

    fail = true;
    tickInterval();
    await flush();
    expect(tabBProjects[0]?.name).toBe("工作区整理");
    expect(tabBExperts[0]?.id).toBe("exp_scout");
    expect(tabBTeams[0]?.id).toBe("team_coding");
    stop();
  });
});

describe("workbench team catalog after custom expert delete (Milestone AY)", () => {
  it("applies GET /api/expert-teams member-clear onto the existing AK catalog", () => {
    const prev = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_custom", "exp_scout"],
      }),
    ];
    const next = applyPinTeamCatalogSnapshot(prev, [
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
    expect(pinTeamCatalogKey(next[0]!)).not.toBe(pinTeamCatalogKey(prev[0]!));
  });

  it("Tab B pin-dropdown team catalog drops the ghost member via existing AK", async () => {
    let serverExperts = [
      expert({ id: "exp_custom", name: "AY 文档专家", kind: "custom", bundled: false }),
      expert({ id: "exp_scout", name: "侦察 Scout" }),
    ];
    let serverTeams = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_custom", "exp_scout"],
      }),
    ];
    let tabBExperts = serverExperts.map((row) => ({ ...row }));
    let tabBTeams = serverTeams.map((row) => ({ ...row, expertIds: [...row.expertIds] }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startPinCatalogSync({
      fetchProjects: async () => [project({ id: "prj_1" })],
      onProjects: () => undefined,
      fetchExperts: async () => serverExperts.map((row) => ({ ...row })),
      onExperts: (next) => {
        tabBExperts = applyPinExpertCatalogSnapshot(tabBExperts, next);
      },
      fetchTeams: async () => serverTeams.map((row) => ({ ...row, expertIds: [...row.expertIds] })),
      onTeams: (next) => {
        tabBTeams = applyPinTeamCatalogSnapshot(tabBTeams, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBExperts.map((row) => row.id)).toEqual(["exp_custom", "exp_scout"]);
    expect(tabBTeams[0]?.expertIds).toEqual(["exp_custom", "exp_scout"]);

    serverExperts = [expert({ id: "exp_scout", name: "侦察 Scout" })];
    serverTeams = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_scout"],
        updatedAt: "2026-09-18T07:01:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabBExperts.map((row) => row.id)).toEqual(["exp_scout"]);
    expect(tabBTeams.map((row) => row.id)).toEqual(["team_docs"]);
    expect(tabBTeams[0]?.expertIds).toEqual(["exp_scout"]);
    expect(tabBTeams[0]?.expertIds).not.toContain("exp_custom");
    expect(pinCatalogSelectOptions(tabBTeams).map((opt) => opt.label)).toEqual(["未绑定", "文档小队"]);
    expect(JSON.stringify({ experts: tabBExperts, teams: tabBTeams })).not.toMatch(
      /llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /,
    );
    stop();
  });
});

describe("workbench empty custom team catalog (Milestone BD)", () => {
  it("keeps an emptied custom team in the existing AK catalog until DELETE", async () => {
    let serverTeams = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: ["exp_custom"],
      }),
    ];
    let tabBTeams = serverTeams.map((row) => ({ ...row, expertIds: [...row.expertIds] }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startPinCatalogSync({
      fetchProjects: async () => [project({ id: "prj_1" })],
      onProjects: () => undefined,
      fetchExperts: async () => [expert({ id: "exp_scout", name: "侦察 Scout" })],
      onExperts: () => undefined,
      fetchTeams: async () => serverTeams.map((row) => ({ ...row, expertIds: [...row.expertIds] })),
      onTeams: (next) => {
        tabBTeams = applyPinTeamCatalogSnapshot(tabBTeams, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBTeams[0]?.expertIds).toEqual(["exp_custom"]);

    serverTeams = [
      team({
        id: "team_docs",
        name: "文档小队",
        bundled: false,
        expertIds: [],
        updatedAt: "2026-09-18T08:01:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabBTeams.map((row) => row.id)).toEqual(["team_docs"]);
    expect(tabBTeams[0]?.expertIds).toEqual([]);
    expect(pinCatalogSelectOptions(tabBTeams).map((opt) => opt.label)).toEqual(["未绑定", "文档小队"]);

    serverTeams = [];
    tickInterval();
    await flush();

    expect(tabBTeams).toEqual([]);
    expect(JSON.stringify(tabBTeams)).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    stop();
  });
});
