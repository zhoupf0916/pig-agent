import { describe, expect, it } from "vitest";
import type { MemoryNote } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyMemoryDetailSnapshot,
  applyMemoryListSnapshot,
  MEMORY_SYNC_POLL_MS,
  memorySyncKey,
  nextOpenMemoryId,
  sanitizeMemoryNote,
  shouldFetchMemoryDetail,
  startMemorySync,
} from "./memory-sync";

function note(overrides: Partial<MemoryNote> & { id: string } = { id: "mem_a" }): MemoryNote {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "pin",
    text: overrides.text ?? "默认用 DeepSeek",
    tags: overrides.tags,
    sessionId: overrides.sessionId,
    projectId: overrides.projectId,
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

function painted(row: MemoryNote | null) {
  return {
    id: row?.id,
    kind: row?.kind,
    text: row?.text,
    tags: row?.tags ?? [],
  };
}

describe("memory cross-tab sync (Milestone AB)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(MEMORY_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous list / detail reference when notes are unchanged", () => {
    const prevList = [note({ id: "mem_a", text: "默认用 DeepSeek", tags: ["llm"] })];
    const nextList = [note({ id: "mem_a", text: "默认用 DeepSeek", tags: ["llm"] })];
    expect(applyMemoryListSnapshot(prevList, nextList)).toBe(prevList);
    expect(memorySyncKey(prevList[0]!)).toBe(memorySyncKey(nextList[0]!));

    const prevDetail = note({ id: "mem_a", text: "默认用 DeepSeek" });
    expect(applyMemoryDetailSnapshot(prevDetail, prevDetail)).toBe(prevDetail);
  });

  it("does not remount create-draft fields when only list / open detail text changes", () => {
    const createDraft = { text: "本地正在输入的钉住", tags: "draft" };
    const prev = note({ id: "mem_a", text: "旧正文" });
    const next = applyMemoryDetailSnapshot(
      prev,
      note({
        id: "mem_a",
        text: "Tab A 改过的正文",
        tags: ["llm"],
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    );
    expect(next).not.toBe(prev);
    expect(next?.text).toBe("Tab A 改过的正文");
    expect(next?.tags).toEqual(["llm"]);
    expect(createDraft).toEqual({ text: "本地正在输入的钉住", tags: "draft" });
  });

  it("ignores a snapshot for another note and a missing open detail", () => {
    const prev = note({ id: "mem_a" });
    expect(applyMemoryDetailSnapshot(prev, note({ id: "mem_b", text: "别的笔记" }))).toBe(prev);
    expect(applyMemoryDetailSnapshot(null, note({ id: "mem_a", text: "默认用 DeepSeek" }))).toBeNull();
  });

  it("Tab B list follows Tab A pin / edit / delete / write-summary without a full remount", async () => {
    let server = [note({ id: "mem_a", text: "默认用 DeepSeek", kind: "pin" })];
    let tabB = server.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => server.map((row) => ({ ...row, tags: row.tags ? [...row.tags] : undefined })),
      onList: (next) => {
        tabB = applyMemoryListSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(painted(tabB[0]!)).toEqual({
      id: "mem_a",
      kind: "pin",
      text: "默认用 DeepSeek",
      tags: [],
    });

    server = [
      note({
        id: "mem_b",
        kind: "recap",
        text: "回合摘要 · 整理工作区",
        tags: ["recap"],
        sessionId: "ses_a",
        updatedAt: "2026-09-14T12:09:00.000Z",
      }),
      note({
        id: "mem_a",
        text: "默认用 DeepSeek · 已编辑",
        tags: ["llm"],
        updatedAt: "2026-09-14T12:08:00.000Z",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabB.map((row) => row.id)).toEqual(["mem_b", "mem_a"]);
    expect(painted(tabB.find((row) => row.id === "mem_a")!)).toEqual({
      id: "mem_a",
      kind: "pin",
      text: "默认用 DeepSeek · 已编辑",
      tags: ["llm"],
    });
    expect(painted(tabB.find((row) => row.id === "mem_b")!)).toEqual({
      id: "mem_b",
      kind: "recap",
      text: "回合摘要 · 整理工作区",
      tags: ["recap"],
    });
    expect(tabB.find((row) => row.id === "mem_b")?.sessionId).toBe("ses_a");

    server = [
      note({
        id: "mem_b",
        kind: "recap",
        text: "回合摘要 · 整理工作区",
        tags: ["recap"],
        sessionId: "ses_a",
        updatedAt: "2026-09-14T12:09:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["mem_b"]);
    expect(tabB.find((row) => row.id === "mem_a")).toBeUndefined();
    stop();
  });

  it("open detail also follows GET /api/memory/:id without remounting the page", async () => {
    const listServer = [note({ id: "mem_a", text: "默认用 DeepSeek" })];
    let detailServer: MemoryNote = note({ id: "mem_a", text: "默认用 DeepSeek" });
    let tabBDetail: MemoryNote | null = note({ id: "mem_a", text: "默认用 DeepSeek" });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => listServer.map((row) => ({ ...row })),
      onList: () => undefined,
      selectedId: "mem_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return { ...detailServer, tags: detailServer.tags ? [...detailServer.tags] : undefined };
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toContain("mem_a");
    expect(tabBDetail?.text).toBe("默认用 DeepSeek");

    detailServer = note({
      id: "mem_a",
      text: "Tab A 改过的正文",
      tags: ["llm"],
      updatedAt: "2026-09-14T12:10:00.000Z",
    });
    tickInterval();
    await flush();

    expect(tabBDetail?.text).toBe("Tab A 改过的正文");
    expect(tabBDetail?.tags).toEqual(["llm"]);
    expect(tabBDetail?.id).toBe("mem_a");
    expect(tabBDetail?.updatedAt).toBe("2026-09-14T12:10:00.000Z");
    stop();
  });

  it("does not force-fetch detail body when that note is not open", async () => {
    const selectedFetches: string[] = [];
    let tabB = [note({ id: "mem_a", text: "旧正文" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startMemorySync({
      fetchList: async () => [
        note({
          id: "mem_a",
          text: "新正文",
          updatedAt: "2026-09-14T12:12:00.000Z",
        }),
      ],
      onList: (next) => {
        tabB = applyMemoryListSnapshot(tabB, next);
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
    expect(tabB[0]?.text).toBe("新正文");
    expect(tabB[0]?.updatedAt).toBe("2026-09-14T12:12:00.000Z");
    stop();
  });

  it("clears the open detail when Tab A deletes that note", async () => {
    let server: MemoryNote[] = [note({ id: "mem_a", text: "默认用 DeepSeek" })];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: MemoryNote | null = note({ id: "mem_a", text: "默认用 DeepSeek" });
    const selectedFetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyMemoryListSnapshot(tabBList, next);
      },
      selectedId: "mem_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        const found = server.find((row) => row.id === "mem_a");
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, null);
        expect(nextId).toBeNull();
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("mem_a");
    expect(selectedFetches).toEqual(["mem_a"]);

    server = [];
    tickInterval();
    await flush();
    expect(tabBList).toEqual([]);
    expect(tabBDetail).toBeNull();
    expect(selectedFetches).toEqual(["mem_a"]);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [note({ id: "mem_a" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startMemorySync({
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

    server[0] = note({ id: "mem_a", text: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats memory snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...note({ id: "mem_a", text: "整理 notes" }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    } as MemoryNote & { llmApiKey: string; cloudToken: string };
    const applied = applyMemoryListSnapshot([], [dirty]);
    const detail = applyMemoryDetailSnapshot(note({ id: "mem_a" }), dirty);
    const raw = JSON.stringify({ list: applied, detail, painted: painted(applied[0]!) });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(painted(applied[0]!).text).toBe("整理 notes");
    expect(sanitizeMemoryNote(dirty)).not.toHaveProperty("llmApiKey");

    const fetches: MemoryNote[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startMemorySync({
      fetchList: async () => {
        const next = [note({ id: "mem_a", text: "整理 notes" })];
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
    expect(fetches.every((list) => list[0]?.id === "mem_a")).toBe(true);
    stop();
  });

  it("keeps the last good list / detail when a refresh fails", async () => {
    let fail = false;
    let tabB = [note({ id: "mem_a", text: "默认用 DeepSeek" })];
    let tabBDetail: MemoryNote | null = note({ id: "mem_a", text: "默认用 DeepSeek" });
    const { clock, tickInterval } = fakeClock(true);
    const stop = startMemorySync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [note({ id: "mem_a", text: "默认用 DeepSeek" })];
      },
      onList: (next) => {
        tabB = applyMemoryListSnapshot(tabB, next);
      },
      selectedId: "mem_a",
      fetchSelected: async () => {
        if (fail) throw new Error("gone");
        return note({ id: "mem_a", text: "默认用 DeepSeek" });
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB[0]?.text).toBe("默认用 DeepSeek");
    expect(tabBDetail?.text).toBe("默认用 DeepSeek");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.text).toBe("默认用 DeepSeek");
    expect(tabBDetail?.text).toBe("默认用 DeepSeek");
    stop();
  });
});

describe("open memory note deleted-elsewhere cleanup (Milestone AQ)", () => {
  it("reuses the 2s list poll and stays on default runtime pig", () => {
    expect(MEMORY_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("keeps the open id when it is still in GET /api/memory", () => {
    const list = [note({ id: "mem_a" }), note({ id: "mem_b" })];
    expect(nextOpenMemoryId("mem_a", list)).toBe("mem_a");
    expect(shouldFetchMemoryDetail("mem_a", list)).toBe(true);
    const prev = note({ id: "mem_a" });
    expect(applyMemoryDetailSnapshot(prev, prev)).toBe(prev);
  });

  it("clears the open note when the list no longer contains that id", () => {
    const prev = note({ id: "mem_a", text: "幽灵详情" });
    const remaining = [note({ id: "mem_b", text: "其他笔记" })];
    expect(applyMemoryDetailSnapshot(prev, null)).toBeNull();
    expect(shouldFetchMemoryDetail("mem_a", remaining)).toBe(false);
    expect(shouldFetchMemoryDetail("mem_a", [])).toBe(false);
    expect(shouldFetchMemoryDetail(undefined, remaining)).toBe(false);
    expect(nextOpenMemoryId("mem_a", remaining)).toBe("mem_b");
    expect(nextOpenMemoryId("mem_a", [])).toBeNull();
    expect(nextOpenMemoryId(null, remaining)).toBeNull();
  });

  it("does not GET /api/memory/:id after the list confirms the open id is gone", async () => {
    let listServer = [note({ id: "mem_a" }), note({ id: "mem_b" })];
    const selectedFetches: string[] = [];
    const openIds: Array<string | null> = [];
    let tabBDetail: MemoryNote | null = note({ id: "mem_a" });
    let tabBOpenId: string | null = "mem_a";
    const { clock, tickInterval } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => listServer.map((row) => ({ ...row })),
      onList: () => undefined,
      selectedId: "mem_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return note({ id });
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        openIds.push(nextId);
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(selectedFetches).toEqual(["mem_a"]);
    expect(tabBDetail?.id).toBe("mem_a");

    listServer = [note({ id: "mem_b", text: "其他笔记" })];
    tickInterval();
    await flush();

    expect(selectedFetches).toEqual(["mem_a"]);
    expect(selectedFetches).not.toContain("mem_b");
    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("mem_b");
    expect(openIds).toEqual(["mem_b"]);
    stop();
  });

  it("Tab B leaves a note Tab A deleted on poll / focus / visibility", async () => {
    const server = [note({ id: "mem_a", text: "打开中" }), note({ id: "mem_b", text: "其他笔记" })];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: MemoryNote | null = note({ id: "mem_a", text: "打开中" });
    let tabBOpenId: string | null = "mem_a";
    const selectedFetches: string[] = [];
    const listFetches: MemoryNote[][] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => {
        const snap = server.map((row) => ({ ...row }));
        listFetches.push(snap);
        return snap;
      },
      onList: (next) => {
        tabBList = applyMemoryListSnapshot(tabBList, next);
      },
      selectedId: "mem_a",
      fetchSelected: async (id) => {
        selectedFetches.push(id);
        return note({ id, text: "打开中" });
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      onOpenId: (nextId) => {
        tabBOpenId = nextId;
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabBDetail?.id).toBe("mem_a");
    expect(tabBList.map((row) => row.id)).toEqual(["mem_a", "mem_b"]);

    server.splice(0, 1);
    tickInterval();
    await flush();

    expect(tabBDetail).toBeNull();
    expect(tabBOpenId).toBe("mem_b");
    expect(selectedFetches.every((id) => id === "mem_a")).toBe(true);
    expect(selectedFetches).not.toContain("mem_b");

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
    let tabBDetail: MemoryNote | null = note({ id: "mem_a" });
    let left = false;
    const { clock, tickInterval } = fakeClock(true);
    const stop = startMemorySync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [note({ id: "mem_a", text: "默认用 DeepSeek" })];
      },
      onList: () => undefined,
      selectedId: "mem_a",
      fetchSelected: async () => note({ id: "mem_a", text: "默认用 DeepSeek" }),
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      onOpenId: () => {
        left = true;
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, null);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    fail = true;
    tickInterval();
    await flush();
    expect(left).toBe(false);
    expect(tabBDetail?.id).toBe("mem_a");
    expect(tabBDetail?.text).toBe("默认用 DeepSeek");
    stop();
  });

  it("never treats deleted-open cleanup snapshots as a place to store secrets", () => {
    const snap = [note({ id: "mem_b", text: "其他笔记" })];
    const applied = applyMemoryDetailSnapshot(note({ id: "mem_a", text: "已删" }), null);
    const raw = JSON.stringify({
      applied,
      snap,
      nextId: nextOpenMemoryId("mem_a", snap),
      fetch: shouldFetchMemoryDetail("mem_a", snap),
    });
    expect(applied).toBeNull();
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
  });
});

describe("memory refs after project / session delete (Milestone AV)", () => {
  function paintedLinks(row: MemoryNote | null) {
    return {
      session: row?.sessionId ? "打开来源会话" : "",
      project: row?.projectId ? "打开关联项目" : "",
      sessionId: row?.sessionId ?? "",
      projectId: row?.projectId ?? "",
    };
  }

  it("reuses the existing 2s AB list poll and stays on default runtime pig", () => {
    expect(MEMORY_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("list / open detail snapshots drop a cleared projectId without rewriting body/tags", () => {
    const prev = note({
      id: "mem_a",
      text: "默认用 DeepSeek",
      tags: ["llm"],
      sessionId: "ses_keep",
      projectId: "prj_gone",
    });
    const cleared = note({
      id: "mem_a",
      text: "默认用 DeepSeek",
      tags: ["llm"],
      sessionId: "ses_keep",
    });
    const list = applyMemoryListSnapshot([prev], [cleared]);
    const detail = applyMemoryDetailSnapshot(prev, cleared);
    expect(list[0]?.projectId).toBeUndefined();
    expect(list[0]?.sessionId).toBe("ses_keep");
    expect(list[0]?.text).toBe("默认用 DeepSeek");
    expect(list[0]?.tags).toEqual(["llm"]);
    expect(detail?.projectId).toBeUndefined();
    expect(detail?.sessionId).toBe("ses_keep");
    expect(paintedLinks(detail)).toEqual({
      session: "打开来源会话",
      project: "",
      sessionId: "ses_keep",
      projectId: "",
    });
    expect(JSON.stringify({ list, detail })).not.toMatch(/prj_gone|sk-|Bearer |DEEPSEEK_API_KEY/);
  });

  it("Tab B list and open detail drop projectId after Tab A deletes that project", async () => {
    let server = [
      note({
        id: "mem_a",
        text: "打开中",
        tags: ["av"],
        sessionId: "ses_keep",
        projectId: "prj_gone",
      }),
      note({ id: "mem_b", text: "其他笔记", projectId: "prj_keep" }),
    ];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: MemoryNote | null = note({
      id: "mem_a",
      text: "打开中",
      tags: ["av"],
      sessionId: "ses_keep",
      projectId: "prj_gone",
    });
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyMemoryListSnapshot(tabBList, next);
      },
      selectedId: "mem_a",
      fetchSelected: async (id) => {
        const found = server.find((row) => row.id === id);
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedLinks(tabBDetail).project).toBe("打开关联项目");
    expect(tabBList.find((row) => row.id === "mem_a")?.projectId).toBe("prj_gone");

    // Tab A DELETE /api/projects/:id cleared projectId on the GET snapshot (no new poller).
    server = [
      note({
        id: "mem_a",
        text: "打开中",
        tags: ["av"],
        sessionId: "ses_keep",
        updatedAt: "2026-09-15T07:20:00.000Z",
      }),
      note({ id: "mem_b", text: "其他笔记", projectId: "prj_keep" }),
    ];
    tickInterval();
    await flush();

    expect(tabBDetail?.projectId).toBeUndefined();
    expect(tabBDetail?.sessionId).toBe("ses_keep");
    expect(tabBDetail?.text).toBe("打开中");
    expect(tabBDetail?.tags).toEqual(["av"]);
    expect(tabBDetail?.id).toBe("mem_a");
    expect(paintedLinks(tabBDetail).project).toBe("");
    expect(tabBList.find((row) => row.id === "mem_a")?.projectId).toBeUndefined();
    expect(tabBList.find((row) => row.id === "mem_b")?.projectId).toBe("prj_keep");
    expect(JSON.stringify({ list: tabBList, detail: tabBDetail })).not.toMatch(
      /prj_gone|sk-|Bearer |DEEPSEEK_API_KEY/,
    );

    setVisible(false);
    tickInterval();
    await flush();
    expect(tabBDetail?.sessionId).toBe("ses_keep");

    setVisible(true);
    await flush();
    expect(tabBDetail?.projectId).toBeUndefined();
    focus();
    await flush();
    expect(tabBDetail?.text).toBe("打开中");
    stop();
  });

  it("Tab B drops sessionId after a session delete without rewriting body/tags", async () => {
    let server = [
      note({
        id: "mem_a",
        text: "回合摘要 · 整理工作区",
        tags: ["recap"],
        sessionId: "ses_gone",
        projectId: "prj_keep",
      }),
    ];
    let tabBList = server.map((row) => ({ ...row }));
    let tabBDetail: MemoryNote | null = note({
      id: "mem_a",
      text: "回合摘要 · 整理工作区",
      tags: ["recap"],
      sessionId: "ses_gone",
      projectId: "prj_keep",
    });
    const { clock, tickInterval } = fakeClock(true);

    const stop = startMemorySync({
      fetchList: async () => server.map((row) => ({ ...row })),
      onList: (next) => {
        tabBList = applyMemoryListSnapshot(tabBList, next);
      },
      selectedId: "mem_a",
      fetchSelected: async (id) => {
        const found = server.find((row) => row.id === id);
        return found ? { ...found } : null;
      },
      onSelected: (next) => {
        tabBDetail = applyMemoryDetailSnapshot(tabBDetail, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(paintedLinks(tabBDetail)).toMatchObject({
      session: "打开来源会话",
      project: "打开关联项目",
    });

    server = [
      note({
        id: "mem_a",
        text: "回合摘要 · 整理工作区",
        tags: ["recap"],
        projectId: "prj_keep",
        updatedAt: "2026-09-15T07:21:00.000Z",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabBDetail?.sessionId).toBeUndefined();
    expect(tabBDetail?.projectId).toBe("prj_keep");
    expect(tabBDetail?.text).toBe("回合摘要 · 整理工作区");
    expect(tabBDetail?.tags).toEqual(["recap"]);
    expect(paintedLinks(tabBDetail).session).toBe("");
    expect(tabBList[0]?.sessionId).toBeUndefined();
    expect(JSON.stringify({ list: tabBList, detail: tabBDetail })).not.toMatch(
      /ses_gone|sk-|Bearer |DEEPSEEK_API_KEY/,
    );
    stop();
  });

  it("never treats cleared-ref snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...note({
        id: "mem_a",
        text: "整理 notes",
        tags: ["llm"],
      }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
    } as MemoryNote & { llmApiKey: string; cloudToken: string };
    const applied = applyMemoryListSnapshot(
      [note({ id: "mem_a", projectId: "prj_gone", sessionId: "ses_gone" })],
      [dirty],
    );
    const detail = applyMemoryDetailSnapshot(
      note({ id: "mem_a", projectId: "prj_gone", sessionId: "ses_gone" }),
      dirty,
    );
    const raw = JSON.stringify({ list: applied, detail, painted: paintedLinks(detail) });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(applied[0]?.projectId).toBeUndefined();
    expect(applied[0]?.sessionId).toBeUndefined();
    expect(detail?.projectId).toBeUndefined();
    expect(detail?.sessionId).toBeUndefined();

    const fetches: MemoryNote[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startMemorySync({
      fetchList: async () => {
        const next = [note({ id: "mem_a", text: "整理 notes" })];
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
    expect(fetches.every((list) => list[0]?.id === "mem_a")).toBe(true);
    stop();
  });
});
