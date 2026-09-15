import { describe, expect, it } from "vitest";
import type { Project, ProjectSummary } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyProjectDetailSnapshot,
  applyProjectsListSnapshot,
  PROJECTS_SYNC_POLL_MS,
  projectDetailSyncKey,
  projectListSyncKey,
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

  it("keeps the last good board / members when a refresh fails or the row is missing", async () => {
    let fail = false;
    let missing = false;
    let tabBList = [summary({ id: "prj_a", name: "协作空间" })];
    let tabBDetail: Project | null = project({ id: "prj_a" });
    const { clock, tickInterval } = fakeClock(true);
    const stop = startProjectsSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        if (missing) return [listRow({ id: "prj_b", name: "别的项目" })];
        return [listRow({ id: "prj_a", name: "协作空间" })];
      },
      onList: (next) => {
        tabBList = applyProjectsListSnapshot(tabBList, next);
      },
      selectedId: "prj_a",
      fetchSelected: async () => {
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

    fail = false;
    missing = true;
    tickInterval();
    await flush();
    expect(tabBList[0]?.name).toBe("协作空间");
    expect(tabBDetail?.todos[0]?.id).toBe("td_a");
    stop();
  });
});
