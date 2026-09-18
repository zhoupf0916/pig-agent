import { describe, expect, it } from "vitest";
import type { Project, ProjectSummary } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyProjectDetailSnapshot,
  applyProjectsListSnapshot,
  nextOpenProjectId,
  PROJECTS_SYNC_POLL_MS,
  projectDetailSyncKey,
  projectListSyncKey,
  shouldFetchProjectDetail,
  startProjectsSync,
  type ProjectDetailSyncFields,
  type ProjectListSyncFields,
} from "./projects-sync";

function summary(
  overrides: Partial<ProjectSummary> & { id: string } = { id: "prj_a" },
): ProjectSummary {
  return {
    id: overrides.id,
    name: overrides.name ?? "协作空间",
    instruction: overrides.instruction ?? "始终用中文",
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    memberCount: overrides.memberCount ?? 1,
    todoCount: overrides.todoCount ?? 1,
    assetCount: overrides.assetCount ?? 0,
    sessionCount: overrides.sessionCount ?? 0,
  };
}

function project(overrides: Partial<Project> & { id: string } = { id: "prj_a" }): Project {
  return {
    id: overrides.id,
    name: overrides.name ?? "协作空间",
    instruction: overrides.instruction ?? "始终用中文",
    createdAt: overrides.createdAt ?? "2026-09-14T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    members: overrides.members ?? [
      {
        id: "mem_owner",
        userId: "user_local",
        displayName: "本机用户",
        role: "owner",
        joinedAt: "2026-09-14T12:00:00.000Z",
      },
    ],
    invites: overrides.invites ?? [],
    todos: overrides.todos ?? [
      {
        id: "td_a",
        title: "写 brief",
        status: "todo",
        createdAt: "2026-09-14T12:00:00.000Z",
        updatedAt: "2026-09-14T12:00:00.000Z",
      },
    ],
    assets: overrides.assets ?? [],
    messages: overrides.messages ?? [],
    inviteToken: overrides.inviteToken ?? "inv_keep_local",
  };
}

function listRow(
  overrides: Partial<ProjectListSyncFields> & { id: string },
): ProjectListSyncFields {
  return {
    id: overrides.id,
    name: overrides.name ?? "协作空间",
    updatedAt: overrides.updatedAt ?? "2026-09-14T12:00:00.000Z",
    todoCount: overrides.todoCount ?? 1,
    assetCount: overrides.assetCount ?? 0,
    memberCount: overrides.memberCount ?? 1,
    sessionCount: overrides.sessionCount ?? 0,
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

function painted(detail: ProjectDetailSyncFields | null) {
  return {
    todos: (detail?.todos ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status })),
    assets: (detail?.assets ?? []).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
    members: (detail?.members ?? []).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      role: m.role,
    })),
    pendingInvites: (detail?.invites ?? [])
      .filter((inv) => inv.status === "pending")
      .map((inv) => inv.displayName),
  };
}

describe("projects cross-tab sync (Milestone AA)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(PROJECTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("returns the previous list / detail reference when board · assets · members are unchanged", () => {
    const prevList = [summary({ id: "prj_a", name: "协作空间" })];
    const nextList = [listRow({ id: "prj_a", name: "协作空间" })];
    expect(applyProjectsListSnapshot(prevList, nextList)).toBe(prevList);
    expect(projectListSyncKey(prevList[0]!)).toBe(projectListSyncKey(nextList[0]!));

    const prevDetail = project({ id: "prj_a" });
    expect(applyProjectDetailSnapshot(prevDetail, prevDetail)).toBe(prevDetail);
    expect(projectDetailSyncKey(prevDetail)).toBe(
      projectDetailSyncKey({
        id: "prj_a",
        name: prevDetail.name,
        updatedAt: prevDetail.updatedAt,
        todos: prevDetail.todos,
        assets: prevDetail.assets,
        members: prevDetail.members,
        invites: prevDetail.invites,
      }),
    );
  });

  it("does not remount instruction / inviteToken when only board · assets · members change", () => {
    const prev = project({
      id: "prj_a",
      instruction: "本地正在编辑的指令",
      inviteToken: "inv_keep_local",
    });
    const next = applyProjectDetailSnapshot(prev, {
      id: "prj_a",
      name: "协作空间",
      updatedAt: "2026-09-14T12:08:00.000Z",
      todos: [
        {
          id: "td_a",
          title: "写 brief",
          status: "doing",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:08:00.000Z",
        },
      ],
      assets: [
        {
          id: "ast_a",
          filename: "brief.md",
          size: 12,
          mimeType: "text/markdown",
          createdAt: "2026-09-14T12:08:00.000Z",
        },
      ],
      members: [
        ...prev.members,
        {
          id: "mem_b",
          userId: "user_chen",
          displayName: "小陈",
          role: "member",
          joinedAt: "2026-09-14T12:08:00.000Z",
        },
      ],
      invites: [],
    });
    expect(next).not.toBe(prev);
    expect(next?.instruction).toBe("本地正在编辑的指令");
    expect(next?.inviteToken).toBe("inv_keep_local");
    expect(next?.todos[0]?.status).toBe("doing");
    expect(next?.assets[0]?.filename).toBe("brief.md");
    expect(next?.members.some((m) => m.displayName === "小陈")).toBe(true);
  });

  it("ignores a snapshot for another project and a missing open detail", () => {
    const prev = project({ id: "prj_a" });
    expect(
      applyProjectDetailSnapshot(prev, {
        id: "prj_b",
        name: "别的项目",
        updatedAt: "t2",
        todos: [],
        assets: [],
        members: [],
        invites: [],
      }),
    ).toBe(prev);
    expect(
      applyProjectDetailSnapshot(null, {
        id: "prj_a",
        name: "协作空间",
        updatedAt: "t2",
        todos: [],
        assets: [],
        members: [],
        invites: [],
      }),
    ).toBeNull();
  });

  it("Tab B open detail board · assets · members follow Tab A via GET /api/projects/:id", async () => {
    const listServer = [listRow({ id: "prj_a", todoCount: 1, assetCount: 0, memberCount: 1 })];
    let detailServer: ProjectDetailSyncFields = {
      id: "prj_a",
      name: "协作空间",
      updatedAt: "2026-09-14T12:00:00.000Z",
      todos: [
        {
          id: "td_a",
          title: "写 brief",
          status: "todo",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        },
      ],
      assets: [],
      members: [
        {
          id: "mem_owner",
          userId: "user_local",
          displayName: "本机用户",
          role: "owner",
          joinedAt: "2026-09-14T12:00:00.000Z",
        },
      ],
      invites: [
        {
          id: "pinv_a",
          token: "inv_pending",
          displayName: "小陈",
          invitedByUserId: "user_local",
          invitedByName: "本机用户",
          status: "pending",
          createdAt: "2026-09-14T12:01:00.000Z",
        },
      ],
    };
    let tabBList = [summary({ id: "prj_a" })];
    let tabBDetail: Project | null = project({
      id: "prj_a",
      instruction: "本地草稿指令",
      invites: detailServer.invites,
    });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startProjectsSync({
      fetchList: async () => listServer.map((s) => ({ ...s })),
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
      },
      selectedId: "prj_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return { ...detailServer, todos: [...detailServer.todos], assets: [...detailServer.assets], members: [...detailServer.members], invites: [...detailServer.invites] };
      },
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toContain("prj_a");
    expect(tabBDetail?.instruction).toBe("本地草稿指令");
    expect(painted(tabBDetail).todos[0]?.status).toBe("todo");
    expect(painted(tabBDetail).pendingInvites).toEqual(["小陈"]);

    listServer[0] = listRow({
      id: "prj_a",
      name: "协作空间",
      updatedAt: "2026-09-14T12:10:00.000Z",
      todoCount: 1,
      assetCount: 1,
      memberCount: 2,
    });
    detailServer = {
      id: "prj_a",
      name: "协作空间",
      updatedAt: "2026-09-14T12:10:00.000Z",
      todos: [
        {
          id: "td_a",
          title: "写 brief",
          status: "done",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:10:00.000Z",
        },
      ],
      assets: [
        {
          id: "ast_a",
          filename: "brief.md",
          size: 24,
          mimeType: "text/markdown",
          createdAt: "2026-09-14T12:10:00.000Z",
        },
      ],
      members: [
        {
          id: "mem_owner",
          userId: "user_local",
          displayName: "本机用户",
          role: "owner",
          joinedAt: "2026-09-14T12:00:00.000Z",
        },
        {
          id: "mem_b",
          userId: "user_chen",
          displayName: "小陈",
          role: "member",
          joinedAt: "2026-09-14T12:10:00.000Z",
        },
      ],
      invites: [
        {
          id: "pinv_a",
          token: "inv_pending",
          displayName: "小陈",
          invitedByUserId: "user_local",
          invitedByName: "本机用户",
          status: "accepted",
          createdAt: "2026-09-14T12:01:00.000Z",
          resolvedAt: "2026-09-14T12:10:00.000Z",
          memberId: "mem_b",
        },
      ],
    };
    tickInterval();
    await flush();

    expect(painted(tabBDetail).todos[0]?.status).toBe("done");
    expect(painted(tabBDetail).assets[0]?.filename).toBe("brief.md");
    expect(painted(tabBDetail).members.map((m) => m.displayName)).toEqual(["本机用户", "小陈"]);
    expect(painted(tabBDetail).pendingInvites).toEqual([]);
    expect(tabBDetail?.instruction).toBe("本地草稿指令");
    expect(tabBList[0]?.updatedAt).toBe("2026-09-14T12:10:00.000Z");
    expect(tabBList[0]?.assetCount).toBe(1);
    expect(tabBList[0]?.memberCount).toBe(2);
    stop();
  });

  it("does not force-fetch detail body when that project is not open", async () => {
    const selectedFetches: string[] = [];
    let tabBList = [summary({ id: "prj_a", name: "旧名" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startProjectsSync({
      fetchList: async () => [
        listRow({
          id: "prj_a",
          name: "新名",
          updatedAt: "2026-09-14T12:12:00.000Z",
        }),
      ],
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
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
    expect(tabBList[0]?.name).toBe("新名");
    expect(tabBList[0]?.updatedAt).toBe("2026-09-14T12:12:00.000Z");
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [listRow({ id: "prj_a" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startProjectsSync({
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

    server[0] = listRow({ id: "prj_a", name: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats project snapshots as a place to store secrets and stays GET-only", async () => {
    const snap = project({
      id: "prj_a",
      todos: [
        {
          id: "td_a",
          title: "整理 notes",
          status: "todo",
          createdAt: "t1",
          updatedAt: "t1",
        },
      ],
    });
    const applied = applyProjectDetailSnapshot(project({ id: "prj_a" }), snap);
    const raw = JSON.stringify(applied);
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(painted(applied).todos[0]?.title).toBe("整理 notes");

    const fetches: ProjectListSyncFields[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startProjectsSync({
      fetchList: async () => {
        const next = [listRow({ id: "prj_a" })];
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
    expect(fetches.every((list) => list[0]?.id === "prj_a")).toBe(true);
    stop();
  });

  it("keeps the last good board / members when a refresh fails", async () => {
    let fail = false;
    let tabBList = [summary({ id: "prj_a", name: "协作空间" })];
    let tabBDetail: Project | null = project({ id: "prj_a" });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startProjectsSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [listRow({ id: "prj_a", name: "协作空间" })];
      },
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
      },
      selectedId: "prj_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        if (fail) throw new Error("gone");
        return {
          id: "prj_a",
          name: "协作空间",
          updatedAt: "2026-09-14T12:00:00.000Z",
          todos: tabBDetail?.todos ?? [],
          assets: tabBDetail?.assets ?? [],
          members: tabBDetail?.members ?? [],
          invites: tabBDetail?.invites ?? [],
        };
      },
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabBList[0]?.name).toBe("协作空间");
    expect(tabBDetail?.todos[0]?.status).toBe("todo");

    fail = true;
    tickInterval();
    await flush();
    expect(tabBList[0]?.name).toBe("协作空间");
    expect(tabBDetail?.todos[0]?.status).toBe("todo");
    expect(selectedFetches.every((id) => id === "prj_a")).toBe(true);
    stop();
  });
});

describe("open project deleted-elsewhere cleanup (Milestone AP)", () => {
  it("reuses the 2s list poll and stays on default runtime pig", () => {
    expect(PROJECTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("keeps the open id when it is still in GET /api/projects", () => {
    const list = [listRow({ id: "prj_a" }), listRow({ id: "prj_b" })];
    expect(nextOpenProjectId("prj_a", list)).toBe("prj_a");
    expect(shouldFetchProjectDetail("prj_a", list)).toBe(true);
    const prev = project({ id: "prj_a" });
    expect(applyProjectDetailSnapshot(prev, prev)).toBe(prev);
  });

  it("clears the open project when the list no longer contains that id", () => {
    const prev = project({
      id: "prj_a",
      todos: [
        {
          id: "td_ghost",
          title: "幽灵看板",
          status: "todo",
          createdAt: "t1",
          updatedAt: "t1",
        },
      ],
    });
    const remaining = [listRow({ id: "prj_b", name: "其他项目" })];
    expect(applyProjectDetailSnapshot(prev, null)).toBeNull();
    expect(shouldFetchProjectDetail("prj_a", remaining)).toBe(false);
    expect(shouldFetchProjectDetail("prj_a", [])).toBe(false);
    expect(shouldFetchProjectDetail(undefined, remaining)).toBe(false);
    expect(nextOpenProjectId("prj_a", remaining)).toBe("prj_b");
    expect(nextOpenProjectId("prj_a", [])).toBeNull();
    expect(nextOpenProjectId(null, remaining)).toBeNull();
  });

  it("does not GET /api/projects/:id after the list confirms the open id is gone", async () => {
    let listServer = [listRow({ id: "prj_a" }), listRow({ id: "prj_b" })];
    const selectedFetches: string[] = [];
    const openIds: Array<string | null> = [];
    let tabBDetail: Project | null = project({ id: "prj_a" });
    let tabBOpenId: string | null = "prj_a";
    const { clock, tickInterval } = fakeClock(true);

    const stop = startProjectsSync({
      fetchList: async () => listServer.map((s) => ({ ...s })),
      onList: () => undefined,
      selectedId: "prj_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return {
          id,
          name: "协作空间",
          updatedAt: "2026-09-14T12:00:00.000Z",
          todos: tabBDetail?.todos ?? [],
          assets: tabBDetail?.assets ?? [],
          members: tabBDetail?.members ?? [],
          invites: tabBDetail?.invites ?? [],
        };
      },
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        openIds.push(nextId);
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toEqual(["prj_a"]);
    expect(tabBDetail?.id).toBe("prj_a");

    listServer = [listRow({ id: "prj_b", name: "其他项目" })];
    tickInterval();
    await flush();

    expect(selectedFetches).toEqual(["prj_a"]);
    expect(selectedFetches).not.toContain("prj_b");
    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("prj_b");
    expect(openIds).toEqual(["prj_b"]);
    stop();
  });

  it("Tab B leaves a project Tab A deleted on poll / focus / visibility", async () => {
    const server = [listRow({ id: "prj_a", name: "打开中" }), listRow({ id: "prj_b", name: "其他项目" })];
    let tabBList = [summary({ id: "prj_a", name: "打开中" }), summary({ id: "prj_b", name: "其他项目" })];
    let tabBDetail: Project | null = project({ id: "prj_a", name: "打开中" });
    let tabBOpenId: string | null = "prj_a";
    const selectedFetches: string[] = [];
    const listFetches: ProjectListSyncFields[][] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startProjectsSync({
      fetchList: async () => {
        const snap = server.map((s) => ({ ...s }));
        listFetches.push(snap);
        return snap;
      },
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
      },
      selectedId: "prj_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return {
          id,
          name: "打开中",
          updatedAt: "2026-09-14T12:00:00.000Z",
          todos: tabBDetail?.todos ?? [],
          assets: tabBDetail?.assets ?? [],
          members: tabBDetail?.members ?? [],
          invites: tabBDetail?.invites ?? [],
        };
      },
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("prj_a");
    expect(tabBList.map((p) => p.id)).toEqual(["prj_a", "prj_b"]);

    server.splice(0, 1);
    tickInterval();
    await flush();

    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("prj_b");
    expect(selectedFetches.every((id) => id === "prj_a")).toBe(true);
    expect(selectedFetches).not.toContain("prj_b");

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
    let tabBDetail: Project | null = project({ id: "prj_a" });
    let left = false;
    const { clock, tickInterval } = fakeClock(true);
    const stop = startProjectsSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [listRow({ id: "prj_a", name: "协作空间" })];
      },
      onList: () => undefined,
      selectedId: "prj_a",
      fetchSelected: async () => ({
        id: "prj_a",
        name: "协作空间",
        updatedAt: "2026-09-14T12:00:00.000Z",
        todos: tabBDetail?.todos ?? [],
        assets: tabBDetail?.assets ?? [],
        members: tabBDetail?.members ?? [],
        invites: tabBDetail?.invites ?? [],
      }),
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      onOpenId: () => {
        left = true;
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    fail = true;
    tickInterval();
    await flush();
    expect(left).toBe(false);
    expect(tabBDetail?.id).toBe("prj_a");
    expect(tabBDetail?.todos[0]?.id).toBe("td_a");
    stop();
  });

  it("never treats deleted-open cleanup snapshots as a place to store secrets", () => {
    const snap = [listRow({ id: "prj_b", name: "其他项目" })];
    const applied = applyProjectDetailSnapshot(project({ id: "prj_a", name: "已删" }), null);
    const raw = JSON.stringify({
      applied,
      snap,
      nextId: nextOpenProjectId("prj_a", snap),
      fetch: shouldFetchProjectDetail("prj_a", snap),
    });
    expect(applied).toBeNull();
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
  });
});

describe("project asset / todo session refs after session delete (Milestone AZ)", () => {
  function paintedSourceLinks(detail: ProjectDetailSyncFields | null) {
    return {
      sourceSession: (detail?.assets ?? [])
        .filter((a) => a.sourceSessionId)
        .map((a) => ({ id: a.id, sourceSessionId: a.sourceSessionId, label: "来源会话" })),
      todoSessions: (detail?.todos ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        sessionId: t.sessionId ?? "",
      })),
    };
  }

  it("reuses the existing 2s AA poll and stays on default runtime pig", () => {
    expect(PROJECTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("open-detail snapshots drop sourceSessionId / todo sessionId without rewriting title/status", () => {
    const prev = project({
      id: "prj_a",
      todos: [
        {
          id: "td_gone",
          title: "AZ 已删会话待办",
          status: "doing",
          sessionId: "ses_gone",
          createdAt: "t1",
          updatedAt: "t1",
        },
        {
          id: "td_keep",
          title: "AZ 保留会话待办",
          status: "todo",
          sessionId: "ses_keep",
          createdAt: "t1",
          updatedAt: "t1",
        },
      ],
      assets: [
        {
          id: "ast_gone",
          filename: "brief.md",
          size: 12,
          mimeType: "text/markdown",
          createdAt: "t1",
          sourceSessionId: "ses_gone",
          sourceArtifactPath: "notes/brief.md",
        },
        {
          id: "ast_keep",
          filename: "keep.md",
          size: 8,
          mimeType: "text/markdown",
          createdAt: "t1",
          sourceSessionId: "ses_keep",
        },
      ],
    });
    const cleared = project({
      id: "prj_a",
      updatedAt: "2026-09-15T08:00:00.000Z",
      todos: [
        {
          id: "td_gone",
          title: "AZ 已删会话待办",
          status: "doing",
          createdAt: "t1",
          updatedAt: "t1",
        },
        {
          id: "td_keep",
          title: "AZ 保留会话待办",
          status: "todo",
          sessionId: "ses_keep",
          createdAt: "t1",
          updatedAt: "t1",
        },
      ],
      assets: [
        {
          id: "ast_gone",
          filename: "brief.md",
          size: 12,
          mimeType: "text/markdown",
          createdAt: "t1",
          sourceArtifactPath: "notes/brief.md",
        },
        {
          id: "ast_keep",
          filename: "keep.md",
          size: 8,
          mimeType: "text/markdown",
          createdAt: "t1",
          sourceSessionId: "ses_keep",
        },
      ],
    });
    const applied = applyProjectDetailSnapshot(prev, cleared);
    expect(applied).not.toBe(prev);
    expect(paintedSourceLinks(applied).sourceSession).toEqual([
      { id: "ast_keep", sourceSessionId: "ses_keep", label: "来源会话" },
    ]);
    expect(paintedSourceLinks(applied).todoSessions).toEqual([
      { id: "td_gone", title: "AZ 已删会话待办", status: "doing", sessionId: "" },
      { id: "td_keep", title: "AZ 保留会话待办", status: "todo", sessionId: "ses_keep" },
    ]);
    expect(applied?.assets.find((a) => a.id === "ast_gone")?.sourceArtifactPath).toBe("notes/brief.md");
    expect(JSON.stringify(applied)).not.toMatch(/ses_gone|sk-|Bearer |DEEPSEEK_API_KEY/);
  });

  it("Tab B open detail drops source-session links after Tab A deletes that session", async () => {
    const listServer = [listRow({ id: "prj_a", todoCount: 2, assetCount: 2 })];
    let detailServer: ProjectDetailSyncFields = {
      id: "prj_a",
      name: "协作空间",
      updatedAt: "2026-09-14T12:00:00.000Z",
      todos: [
        {
          id: "td_gone",
          title: "AZ 已删会话待办",
          status: "doing",
          sessionId: "ses_gone",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        },
        {
          id: "td_keep",
          title: "AZ 保留会话待办",
          status: "todo",
          sessionId: "ses_keep",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        },
      ],
      assets: [
        {
          id: "ast_gone",
          filename: "brief.md",
          size: 12,
          mimeType: "text/markdown",
          createdAt: "2026-09-14T12:00:00.000Z",
          sourceSessionId: "ses_gone",
          sourceArtifactPath: "notes/brief.md",
        },
        {
          id: "ast_keep",
          filename: "keep.md",
          size: 8,
          mimeType: "text/markdown",
          createdAt: "2026-09-14T12:00:00.000Z",
          sourceSessionId: "ses_keep",
        },
      ],
      members: [
        {
          id: "mem_owner",
          userId: "user_local",
          displayName: "本机用户",
          role: "owner",
          joinedAt: "2026-09-14T12:00:00.000Z",
        },
      ],
      invites: [],
    };
    let tabBList = [summary({ id: "prj_a", todoCount: 2, assetCount: 2 })];
    let tabBDetail: Project | null = project({
      id: "prj_a",
      instruction: "本地草稿指令",
      todos: detailServer.todos,
      assets: detailServer.assets,
    });
    const selectedFetches: string[] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startProjectsSync({
      fetchList: async () => listServer.map((s) => ({ ...s })),
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
      },
      selectedId: "prj_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return {
          ...detailServer,
          todos: detailServer.todos.map((t) => ({ ...t })),
          assets: detailServer.assets.map((a) => ({ ...a })),
          members: detailServer.members.map((m) => ({ ...m })),
          invites: [...detailServer.invites],
        };
      },
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedSourceLinks(tabBDetail).sourceSession.map((a) => a.sourceSessionId)).toEqual([
      "ses_gone",
      "ses_keep",
    ]);
    expect(tabBDetail?.todos.find((t) => t.id === "td_gone")?.sessionId).toBe("ses_gone");
    expect(tabBDetail?.instruction).toBe("本地草稿指令");

    // Tab A DELETE /api/sessions/:id cleared refs on the GET snapshot (no new poller).
    detailServer = {
      ...detailServer,
      updatedAt: "2026-09-15T08:00:00.000Z",
      todos: [
        {
          id: "td_gone",
          title: "AZ 已删会话待办",
          status: "doing",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        },
        {
          id: "td_keep",
          title: "AZ 保留会话待办",
          status: "todo",
          sessionId: "ses_keep",
          createdAt: "2026-09-14T12:00:00.000Z",
          updatedAt: "2026-09-14T12:00:00.000Z",
        },
      ],
      assets: [
        {
          id: "ast_gone",
          filename: "brief.md",
          size: 12,
          mimeType: "text/markdown",
          createdAt: "2026-09-14T12:00:00.000Z",
          sourceArtifactPath: "notes/brief.md",
        },
        {
          id: "ast_keep",
          filename: "keep.md",
          size: 8,
          mimeType: "text/markdown",
          createdAt: "2026-09-14T12:00:00.000Z",
          sourceSessionId: "ses_keep",
        },
      ],
    };
    tickInterval();
    await flush();

    expect(paintedSourceLinks(tabBDetail).sourceSession).toEqual([
      { id: "ast_keep", sourceSessionId: "ses_keep", label: "来源会话" },
    ]);
    expect(paintedSourceLinks(tabBDetail).todoSessions).toEqual([
      { id: "td_gone", title: "AZ 已删会话待办", status: "doing", sessionId: "" },
      { id: "td_keep", title: "AZ 保留会话待办", status: "todo", sessionId: "ses_keep" },
    ]);
    expect(tabBDetail?.instruction).toBe("本地草稿指令");
    expect(tabBDetail?.assets.find((a) => a.id === "ast_gone")?.sourceArtifactPath).toBe(
      "notes/brief.md",
    );
    expect(selectedFetches.every((id) => id === "prj_a")).toBe(true);
    expect(tabBList[0]?.id).toBe("prj_a");

    const afterPoll = selectedFetches.length;
    setVisible(false);
    tickInterval();
    await flush();
    expect(selectedFetches.length).toBe(afterPoll);

    setVisible(true);
    await flush();
    expect(selectedFetches.length).toBeGreaterThan(afterPoll);
    expect(paintedSourceLinks(tabBDetail).sourceSession.map((a) => a.sourceSessionId)).toEqual([
      "ses_keep",
    ]);

    const beforeFocus = selectedFetches.length;
    focus();
    await flush();
    expect(selectedFetches.length).toBeGreaterThan(beforeFocus);
    expect(tabBDetail?.todos.find((t) => t.id === "td_gone")?.title).toBe("AZ 已删会话待办");
    expect(JSON.stringify(tabBDetail)).not.toMatch(/ses_gone|sk-|Bearer |DEEPSEEK_API_KEY/);
    stop();
  });
});

describe("project message sessionId after session delete (Milestone BA)", () => {
  function paintedMessages(detail: { messages?: Project["messages"] } | null) {
    return (detail?.messages ?? []).map((m) => ({
      id: m.id,
      kind: m.kind,
      body: m.body,
      createdAt: m.createdAt,
      sessionId: m.sessionId ?? "",
    }));
  }

  it("reuses the existing 2s AA poll and stays on default runtime pig", () => {
    expect(PROJECTS_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("open-detail snapshots drop message sessionId without rewriting body/kind/timestamp", () => {
    const prev = project({
      id: "prj_a",
      messages: [
        {
          id: "pmsg_act_gone",
          kind: "activity",
          body: "会话 ses_gone 已绑定到本项目",
          actorId: "user_local",
          createdAt: "t1",
          sessionId: "ses_gone",
        },
        {
          id: "pmsg_cmt_gone",
          kind: "comment",
          body: "BA 已删会话评论",
          actorId: "user_local",
          createdAt: "t2",
          sessionId: "ses_gone",
        },
        {
          id: "pmsg_hand_gone",
          kind: "handoff",
          body: "转交会话 ses_gone：BA 请接手已删会话",
          actorId: "user_local",
          createdAt: "t3",
          sessionId: "ses_gone",
        },
        {
          id: "pmsg_hand_keep",
          kind: "handoff",
          body: "转交会话 ses_keep：BA 请接手保留会话",
          actorId: "user_local",
          createdAt: "t4",
          sessionId: "ses_keep",
        },
      ],
    });
    const cleared = project({
      id: "prj_a",
      updatedAt: "2026-09-15T08:00:00.000Z",
      messages: [
        {
          id: "pmsg_act_gone",
          kind: "activity",
          body: "会话 ses_gone 已绑定到本项目",
          actorId: "user_local",
          createdAt: "t1",
        },
        {
          id: "pmsg_cmt_gone",
          kind: "comment",
          body: "BA 已删会话评论",
          actorId: "user_local",
          createdAt: "t2",
        },
        {
          id: "pmsg_hand_gone",
          kind: "handoff",
          body: "转交会话 ses_gone：BA 请接手已删会话",
          actorId: "user_local",
          createdAt: "t3",
        },
        {
          id: "pmsg_hand_keep",
          kind: "handoff",
          body: "转交会话 ses_keep：BA 请接手保留会话",
          actorId: "user_local",
          createdAt: "t4",
          sessionId: "ses_keep",
        },
      ],
    });
    const applied = applyProjectDetailSnapshot(prev, cleared);
    expect(applied).not.toBe(prev);
    expect(applied?.messages).toHaveLength(4);
    expect(paintedMessages(applied)).toEqual([
      {
        id: "pmsg_act_gone",
        kind: "activity",
        body: "会话 ses_gone 已绑定到本项目",
        createdAt: "t1",
        sessionId: "",
      },
      {
        id: "pmsg_cmt_gone",
        kind: "comment",
        body: "BA 已删会话评论",
        createdAt: "t2",
        sessionId: "",
      },
      {
        id: "pmsg_hand_gone",
        kind: "handoff",
        body: "转交会话 ses_gone：BA 请接手已删会话",
        createdAt: "t3",
        sessionId: "",
      },
      {
        id: "pmsg_hand_keep",
        kind: "handoff",
        body: "转交会话 ses_keep：BA 请接手保留会话",
        createdAt: "t4",
        sessionId: "ses_keep",
      },
    ]);
    expect(applied?.instruction).toBe(prev.instruction);
    expect(JSON.stringify(paintedMessages(applied).map((m) => m.sessionId))).not.toMatch(/ses_gone/);
    expect(JSON.stringify(applied)).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
  });

  it("Tab B open detail drops message sessionId after Tab A deletes that session", async () => {
    const listServer = [listRow({ id: "prj_a" })];
    const members: ProjectDetailSyncFields["members"] = [
      {
        id: "mem_owner",
        userId: "user_local",
        displayName: "本机用户",
        role: "owner",
        joinedAt: "2026-09-14T12:00:00.000Z",
      },
    ];
    let detailServer: ProjectDetailSyncFields = {
      id: "prj_a",
      name: "协作空间",
      updatedAt: "2026-09-14T12:00:00.000Z",
      todos: [],
      assets: [],
      members,
      invites: [],
      messages: [
        {
          id: "pmsg_act_gone",
          kind: "activity",
          body: "会话 ses_gone 已绑定到本项目",
          actorId: "user_local",
          createdAt: "2026-09-14T12:00:00.000Z",
          sessionId: "ses_gone",
        },
        {
          id: "pmsg_cmt_gone",
          kind: "comment",
          body: "BA 已删会话评论",
          actorId: "user_local",
          createdAt: "2026-09-14T12:01:00.000Z",
          sessionId: "ses_gone",
        },
        {
          id: "pmsg_hand_keep",
          kind: "handoff",
          body: "转交会话 ses_keep：BA 请接手保留会话",
          actorId: "user_local",
          createdAt: "2026-09-14T12:02:00.000Z",
          sessionId: "ses_keep",
        },
      ],
    };
    let tabBList = [summary({ id: "prj_a" })];
    let tabBDetail: Project | null = project({
      id: "prj_a",
      instruction: "本地草稿指令",
      messages: detailServer.messages,
    });
    const selectedFetches: string[] = [];
    const sessionDetailGets: string[] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startProjectsSync({
      fetchList: async () => listServer.map((s) => ({ ...s })),
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
      },
      selectedId: "prj_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return {
          ...detailServer,
          todos: detailServer.todos.map((t) => ({ ...t })),
          assets: detailServer.assets.map((a) => ({ ...a })),
          members: detailServer.members.map((m) => ({ ...m })),
          invites: [...detailServer.invites],
          messages: (detailServer.messages ?? []).map((m) => ({ ...m })),
        };
      },
      onSelected: (next) => {
        tabBDetail = applyProjectDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toContain("prj_a");
    expect(tabBDetail?.messages.find((m) => m.id === "pmsg_cmt_gone")?.sessionId).toBe("ses_gone");
    expect(tabBDetail?.instruction).toBe("本地草稿指令");

    // Tab A DELETE /api/sessions/:id cleared message sessionId on the GET snapshot (no new poller).
    detailServer = {
      ...detailServer,
      updatedAt: "2026-09-15T08:00:00.000Z",
      messages: [
        {
          id: "pmsg_act_gone",
          kind: "activity",
          body: "会话 ses_gone 已绑定到本项目",
          actorId: "user_local",
          createdAt: "2026-09-14T12:00:00.000Z",
        },
        {
          id: "pmsg_cmt_gone",
          kind: "comment",
          body: "BA 已删会话评论",
          actorId: "user_local",
          createdAt: "2026-09-14T12:01:00.000Z",
        },
        {
          id: "pmsg_hand_keep",
          kind: "handoff",
          body: "转交会话 ses_keep：BA 请接手保留会话",
          actorId: "user_local",
          createdAt: "2026-09-14T12:02:00.000Z",
          sessionId: "ses_keep",
        },
      ],
    };
    tickInterval();
    await flush();

    expect(paintedMessages(tabBDetail)).toEqual([
      {
        id: "pmsg_act_gone",
        kind: "activity",
        body: "会话 ses_gone 已绑定到本项目",
        createdAt: "2026-09-14T12:00:00.000Z",
        sessionId: "",
      },
      {
        id: "pmsg_cmt_gone",
        kind: "comment",
        body: "BA 已删会话评论",
        createdAt: "2026-09-14T12:01:00.000Z",
        sessionId: "",
      },
      {
        id: "pmsg_hand_keep",
        kind: "handoff",
        body: "转交会话 ses_keep：BA 请接手保留会话",
        createdAt: "2026-09-14T12:02:00.000Z",
        sessionId: "ses_keep",
      },
    ]);
    expect(tabBDetail?.instruction).toBe("本地草稿指令");
    expect(tabBDetail?.messages).toHaveLength(3);
    expect(selectedFetches.every((id) => id === "prj_a")).toBe(true);
    expect(sessionDetailGets).toEqual([]);
    expect(tabBList[0]?.id).toBe("prj_a");

    const afterPoll = selectedFetches.length;
    setVisible(false);
    tickInterval();
    await flush();
    expect(selectedFetches.length).toBe(afterPoll);

    setVisible(true);
    await flush();
    expect(selectedFetches.length).toBeGreaterThan(afterPoll);
    expect(tabBDetail?.messages.find((m) => m.id === "pmsg_cmt_gone")?.sessionId).toBeUndefined();

    const beforeFocus = selectedFetches.length;
    focus();
    await flush();
    expect(selectedFetches.length).toBeGreaterThan(beforeFocus);
    expect(tabBDetail?.messages.find((m) => m.id === "pmsg_hand_keep")?.sessionId).toBe("ses_keep");
    expect(JSON.stringify(tabBDetail?.messages.map((m) => m.sessionId ?? ""))).not.toMatch(/ses_gone/);
    expect(JSON.stringify(tabBDetail)).not.toMatch(/sk-|Bearer |DEEPSEEK_API_KEY/);
    stop();
  });
});
