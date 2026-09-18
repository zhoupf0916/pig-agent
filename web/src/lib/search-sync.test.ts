import { describe, expect, it } from "vitest";
import type { SearchHit } from "../types";
import { redactSecretsForDisplay } from "./remote-retry";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applySearchHitsSnapshot,
  dropSearchHit,
  isSearchTargetGoneError,
  openSearchHitOrDrop,
  probeSearchHitTarget,
  SEARCH_BOX_DROPDOWN_LIMIT,
  SEARCH_SYNC_POLL_MS,
  sanitizeSearchHit,
  searchBoxCanSoftRefetch,
  searchHitSyncKey,
  searchHitTargetRef,
  startSearchBoxSync,
  startSearchSync,
} from "./search-sync";

function hit(overrides: Partial<SearchHit> & { id: string; type?: SearchHit["type"] }): SearchHit {
  const type = overrides.type ?? "session";
  return {
    type,
    id: overrides.id,
    title: overrides.title ?? "整理笔记",
    snippet: overrides.snippet ?? "请写一份调研报告草稿",
    href: overrides.href ?? `#/sessions/${overrides.id}`,
    sessionId: overrides.sessionId,
    projectId: overrides.projectId,
    assetId: overrides.assetId,
    todoId: overrides.todoId,
    messageId: overrides.messageId,
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

function painted(row: SearchHit | null | undefined) {
  return {
    type: row?.type,
    id: row?.id,
    title: row?.title,
    snippet: row?.snippet,
    href: row?.href,
    sessionId: row?.sessionId,
    projectId: row?.projectId,
  };
}

describe("search same-query cross-tab sync (Milestone AI)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(SEARCH_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous hit list reference when snapshots are unchanged", () => {
    const prev = [hit({ id: "ses_a", title: "调研报告", sessionId: "ses_a" })];
    const next = [hit({ id: "ses_a", title: "调研报告", sessionId: "ses_a" })];
    expect(applySearchHitsSnapshot(prev, next)).toBe(prev);
    expect(searchHitSyncKey(prev[0]!)).toBe(searchHitSyncKey(next[0]!));
  });

  it("Tab B same-query hits follow Tab A title / project / memory edits without a remount", async () => {
    let server = [hit({ id: "ses_a", title: "旧标题", snippet: "近讯", sessionId: "ses_a" })];
    let tabB = server.map((row) => ({ ...row }));
    const queries: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSearchSync({
      query: "调研",
      fetchHits: async (q) => {
        queries.push(q);
        return server.map((row) => ({ ...row }));
      },
      onHits: (next) => {
        tabB = applySearchHitsSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(queries.every((q) => q === "调研")).toBe(true);
    expect(painted(tabB[0])).toEqual({
      type: "session",
      id: "ses_a",
      title: "旧标题",
      snippet: "近讯",
      href: "#/sessions/ses_a",
      sessionId: "ses_a",
      projectId: undefined,
    });

    server = [
      hit({
        id: "mem_a",
        type: "memory",
        title: "调研备忘",
        snippet: "Tab A 新钉住",
        href: "#/memory/mem_a",
      }),
      hit({
        id: "ses_a",
        title: "Tab A 改过的标题",
        snippet: "请写一份调研报告",
        sessionId: "ses_a",
      }),
      hit({
        id: "prj_a",
        type: "project",
        title: "调研项目",
        snippet: "Tab A 改过的指令",
        href: "#/projects/prj_a",
        projectId: "prj_a",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabB.map((row) => row.id)).toEqual(["mem_a", "ses_a", "prj_a"]);
    expect(painted(tabB.find((row) => row.id === "ses_a"))).toEqual({
      type: "session",
      id: "ses_a",
      title: "Tab A 改过的标题",
      snippet: "请写一份调研报告",
      href: "#/sessions/ses_a",
      sessionId: "ses_a",
      projectId: undefined,
    });
    expect(painted(tabB.find((row) => row.id === "prj_a"))).toEqual({
      type: "project",
      id: "prj_a",
      title: "调研项目",
      snippet: "Tab A 改过的指令",
      href: "#/projects/prj_a",
      sessionId: undefined,
      projectId: "prj_a",
    });
    expect(painted(tabB.find((row) => row.id === "mem_a"))).toEqual({
      type: "memory",
      id: "mem_a",
      title: "调研备忘",
      snippet: "Tab A 新钉住",
      href: "#/memory/mem_a",
      sessionId: undefined,
      projectId: undefined,
    });

    server = [
      hit({
        id: "ses_a",
        title: "Tab A 改过的标题",
        snippet: "请写一份调研报告",
        sessionId: "ses_a",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["ses_a"]);
    expect(tabB.find((row) => row.id === "mem_a")).toBeUndefined();
    stop();
  });

  it("does not force-fetch when #/search has no query", async () => {
    const queries: string[] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSearchSync({
      query: "   ",
      fetchHits: async (q) => {
        queries.push(q);
        return [];
      },
      onHits: () => undefined,
      intervalMs: 50,
      clock,
    });

    await flush();
    tickInterval();
    setVisible(true);
    focus();
    await flush();
    expect(queries).toEqual([]);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [hit({ id: "ses_a" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSearchSync({
      query: "调研",
      fetchHits: async () => {
        calls += 1;
        return server.map((row) => ({ ...row }));
      },
      onHits: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server[0] = hit({ id: "ses_a", title: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats search snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...hit({
        id: "ses_a",
        title: "调研 sk-abcdefghijklmnop",
        snippet: "Bearer tok-secret DEEPSEEK_API_KEY=sk-zzzzzzzz",
        sessionId: "ses_a",
      }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
      PIG_CLOUD_TOKEN: "tok-secret",
    } as SearchHit & { llmApiKey: string; cloudToken: string; PIG_CLOUD_TOKEN: string };
    const applied = applySearchHitsSnapshot([], [dirty]);
    const raw = JSON.stringify({
      list: applied,
      painted: painted(applied[0]),
    });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(applied[0]?.title).toBe(redactSecretsForDisplay(dirty.title));
    expect(applied[0]?.snippet).toBe(redactSecretsForDisplay(dirty.snippet));
    expect(sanitizeSearchHit(dirty)).not.toHaveProperty("llmApiKey");
    expect(sanitizeSearchHit(dirty)).not.toHaveProperty("PIG_CLOUD_TOKEN");

    const fetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSearchSync({
      query: "调研",
      fetchHits: async (q) => {
        fetches.push(q);
        return [hit({ id: "ses_a", title: "调研报告", sessionId: "ses_a" })];
      },
      onHits: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((q) => q === "调研")).toBe(true);
    stop();
  });

  it("keeps the last good hit list when a refresh fails", async () => {
    let fail = false;
    let tabB = [hit({ id: "ses_a", title: "调研报告", sessionId: "ses_a" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSearchSync({
      query: "调研",
      fetchHits: async () => {
        if (fail) throw new Error("gone");
        return [hit({ id: "ses_a", title: "调研报告", sessionId: "ses_a" })];
      },
      onHits: (next) => {
        tabB = applySearchHitsSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB[0]?.title).toBe("调研报告");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.title).toBe("调研报告");
    stop();
  });
});

describe("top-bar SearchBox same-query sync (Milestone AL)", () => {
  it("soft-refetches only when a query is present and the dropdown is open", () => {
    expect(SEARCH_BOX_DROPDOWN_LIMIT).toBe(8);
    expect(SEARCH_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(searchBoxCanSoftRefetch({ query: "调研", dropdownOpen: true })).toBe(true);
    expect(searchBoxCanSoftRefetch({ query: "调研", dropdownOpen: false })).toBe(false);
    expect(searchBoxCanSoftRefetch({ query: "   ", dropdownOpen: true })).toBe(false);
    expect(searchBoxCanSoftRefetch({ query: "", dropdownOpen: true })).toBe(false);
    expect(searchBoxCanSoftRefetch({ query: "调研", dropdownOpen: false })).toBe(false);
  });

  it("Tab B open-dropdown same-query hits follow Tab A title / project / memory edits", async () => {
    let server = [hit({ id: "ses_a", title: "旧标题", snippet: "近讯", sessionId: "ses_a" })];
    let tabB = server.map((row) => ({ ...row }));
    const queries: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSearchBoxSync({
      query: "调研",
      dropdownOpen: true,
      fetchHits: async (q) => {
        queries.push(q);
        return server.map((row) => ({ ...row }));
      },
      onHits: (next) => {
        tabB = applySearchHitsSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(queries.every((q) => q === "调研")).toBe(true);
    expect(painted(tabB[0])).toEqual({
      type: "session",
      id: "ses_a",
      title: "旧标题",
      snippet: "近讯",
      href: "#/sessions/ses_a",
      sessionId: "ses_a",
      projectId: undefined,
    });

    server = [
      hit({
        id: "mem_a",
        type: "memory",
        title: "调研备忘",
        snippet: "Tab A 新钉住",
        href: "#/memory/mem_a",
      }),
      hit({
        id: "ses_a",
        title: "Tab A 改过的标题",
        snippet: "请写一份调研报告",
        sessionId: "ses_a",
      }),
      hit({
        id: "prj_a",
        type: "project",
        title: "调研项目",
        snippet: "Tab A 改过的指令",
        href: "#/projects/prj_a",
        projectId: "prj_a",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabB.map((row) => row.id)).toEqual(["mem_a", "ses_a", "prj_a"]);
    expect(painted(tabB.find((row) => row.id === "ses_a"))).toEqual({
      type: "session",
      id: "ses_a",
      title: "Tab A 改过的标题",
      snippet: "请写一份调研报告",
      href: "#/sessions/ses_a",
      sessionId: "ses_a",
      projectId: undefined,
    });
    expect(painted(tabB.find((row) => row.id === "prj_a"))).toEqual({
      type: "project",
      id: "prj_a",
      title: "调研项目",
      snippet: "Tab A 改过的指令",
      href: "#/projects/prj_a",
      sessionId: undefined,
      projectId: "prj_a",
    });
    expect(painted(tabB.find((row) => row.id === "mem_a"))).toEqual({
      type: "memory",
      id: "mem_a",
      title: "调研备忘",
      snippet: "Tab A 新钉住",
      href: "#/memory/mem_a",
      sessionId: undefined,
      projectId: undefined,
    });
    stop();
  });

  it("does not force-fetch when the dropdown is closed or there is no query", async () => {
    const queries: string[] = [];
    const fetchHits = async (q: string) => {
      queries.push(q);
      return [];
    };
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stopClosed = startSearchBoxSync({
      query: "调研",
      dropdownOpen: false,
      fetchHits,
      onHits: () => undefined,
      intervalMs: 50,
      clock,
    });
    const stopEmpty = startSearchBoxSync({
      query: "   ",
      dropdownOpen: true,
      fetchHits,
      onHits: () => undefined,
      intervalMs: 50,
      clock,
    });

    await flush();
    tickInterval();
    setVisible(true);
    focus();
    await flush();
    expect(queries).toEqual([]);
    stopClosed();
    stopEmpty();
  });

  it("never treats SearchBox snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...hit({
        id: "ses_a",
        title: "调研 sk-abcdefghijklmnop",
        snippet: "Bearer tok-secret DEEPSEEK_API_KEY=sk-zzzzzzzz",
        sessionId: "ses_a",
      }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
      PIG_CLOUD_TOKEN: "tok-secret",
    } as SearchHit & { llmApiKey: string; cloudToken: string; PIG_CLOUD_TOKEN: string };
    const applied = applySearchHitsSnapshot([], [dirty]);
    const raw = JSON.stringify({
      list: applied,
      painted: painted(applied[0]),
    });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(applied[0]?.title).toBe(redactSecretsForDisplay(dirty.title));
    expect(applied[0]?.snippet).toBe(redactSecretsForDisplay(dirty.snippet));

    const fetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSearchBoxSync({
      query: "调研",
      dropdownOpen: true,
      fetchHits: async (q) => {
        fetches.push(q);
        return [hit({ id: "ses_a", title: "调研报告", sessionId: "ses_a" })];
      },
      onHits: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((q) => q === "调研")).toBe(true);
    stop();
  });
});

describe("search hits after target delete (Milestone BC)", () => {
  it("soft-refresh drops a deleted session / project / memory id without a remount", async () => {
    let server = [
      hit({ id: "ses_gone", title: "调研会话", sessionId: "ses_gone" }),
      hit({
        id: "prj_gone",
        type: "project",
        title: "调研项目",
        href: "#/projects/prj_gone",
        projectId: "prj_gone",
      }),
      hit({
        id: "mem_gone",
        type: "memory",
        title: "调研备忘",
        href: "#/memory/mem_gone",
      }),
    ];
    let tabB = server.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSearchSync({
      query: "调研",
      fetchHits: async () => server.map((row) => ({ ...row })),
      onHits: (next) => {
        tabB = applySearchHitsSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["ses_gone", "prj_gone", "mem_gone"]);

    server = [];
    tickInterval();
    await flush();
    expect(tabB).toEqual([]);
    expect(tabB.find((row) => row.id === "ses_gone")).toBeUndefined();
    expect(tabB.find((row) => row.id === "prj_gone")).toBeUndefined();
    expect(tabB.find((row) => row.id === "mem_gone")).toBeUndefined();
    stop();
  });

  it("SearchBox open-dropdown soft-refresh also drops the deleted id", async () => {
    let server = [hit({ id: "ses_gone", title: "调研会话", sessionId: "ses_gone" })];
    let tabB = server.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSearchBoxSync({
      query: "调研",
      dropdownOpen: true,
      fetchHits: async () => server.map((row) => ({ ...row })),
      onHits: (next) => {
        tabB = applySearchHitsSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["ses_gone"]);

    server = [hit({ id: "ses_keep", title: "调研还在", sessionId: "ses_keep" })];
    tickInterval();
    await flush();
    expect(tabB.map((row) => row.id)).toEqual(["ses_keep"]);
    expect(tabB.find((row) => row.id === "ses_gone")).toBeUndefined();
    stop();
  });

  it("click-before-refresh 404/gone drops the row and does not open a ghost detail", async () => {
    expect(isSearchTargetGoneError({ status: 404, message: "Session not found" })).toBe(true);
    expect(isSearchTargetGoneError(new Error("Project not found"))).toBe(true);
    expect(isSearchTargetGoneError(new Error("Memory note not found"))).toBe(true);
    expect(isSearchTargetGoneError(new Error("gone"))).toBe(true);
    expect(isSearchTargetGoneError(new Error("network"))).toBe(false);
    expect(searchHitTargetRef(hit({ id: "ses_gone", sessionId: "ses_gone" }))).toEqual({
      kind: "session",
      id: "ses_gone",
    });
    expect(
      searchHitTargetRef(
        hit({
          id: "todo_a",
          type: "todo",
          href: "#/projects/prj_gone?todo=todo_a",
          projectId: "prj_gone",
          todoId: "todo_a",
        }),
      ),
    ).toEqual({ kind: "project", id: "prj_gone" });

    const stale = [
      hit({ id: "ses_gone", title: "调研会话", sessionId: "ses_gone" }),
      hit({
        id: "mem_keep",
        type: "memory",
        title: "调研备忘",
        href: "#/memory/mem_keep",
      }),
    ];
    let tabB = stale.map((row) => ({ ...row }));
    const opened: string[] = [];
    const probed: string[] = [];

    const result = await openSearchHitOrDrop({
      hit: stale[0]!,
      probe: (row) =>
        probeSearchHitTarget(row, {
          session: async (id) => {
            probed.push(id);
            const err = new Error("Session not found");
            (err as Error & { status: number }).status = 404;
            throw err;
          },
          project: async () => undefined,
          memory: async () => undefined,
        }),
      onOpen: (row) => {
        opened.push(row.href);
      },
      onDrop: (gone) => {
        tabB = dropSearchHit(tabB, gone);
      },
    });

    expect(result).toBe("drop");
    expect(probed).toEqual(["ses_gone"]);
    expect(opened).toEqual([]);
    expect(tabB.map((row) => row.id)).toEqual(["mem_keep"]);
    expect(tabB.find((row) => row.id === "ses_gone")).toBeUndefined();
    expect(JSON.stringify({ tabB, opened })).not.toMatch(/#\/sessions\/ses_gone/);

    const keep = await openSearchHitOrDrop({
      hit: stale[1]!,
      probe: async () => undefined,
      onOpen: (row) => {
        opened.push(row.href);
      },
      onDrop: (gone) => {
        tabB = dropSearchHit(tabB, gone);
      },
    });
    expect(keep).toBe("open");
    expect(opened).toEqual(["#/memory/mem_keep"]);

    const same = dropSearchHit(tabB, { type: "session", id: "ses_gone" });
    expect(same).toBe(tabB);
  });

  it("does not invent a new poller and stays GET-only / pig / secret-free", async () => {
    expect(SEARCH_SYNC_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");

    const dirty = {
      ...hit({
        id: "ses_gone",
        title: "调研 sk-abcdefghijklmnop",
        snippet: "Bearer tok-secret DEEPSEEK_API_KEY=sk-zzzzzzzz",
        sessionId: "ses_gone",
      }),
      llmApiKey: "sk-abcdefghijklmnop",
    } as SearchHit & { llmApiKey: string };
    const dropped = dropSearchHit(applySearchHitsSnapshot([], [dirty]), {
      type: "session",
      id: "ses_gone",
    });
    const raw = JSON.stringify({ dropped, painted: painted(dropped[0]) });
    expect(raw).not.toMatch(/llmApiKey|DEEPSEEK_API_KEY|sk-|Bearer /);

    const methods: string[] = [];
    await openSearchHitOrDrop({
      hit: hit({ id: "ses_a", sessionId: "ses_a" }),
      probe: (row) =>
        probeSearchHitTarget(row, {
          session: async (id) => {
            methods.push(`GET /api/sessions/${id}`);
          },
          project: async () => {
            methods.push("GET /api/projects");
          },
          memory: async () => {
            methods.push("GET /api/memory");
          },
        }),
      onOpen: () => undefined,
      onDrop: () => undefined,
    });
    expect(methods).toEqual(["GET /api/sessions/ses_a"]);
    expect(methods.join(" ")).not.toMatch(/POST|PATCH|DELETE|events\.jsonl|webhook/i);
  });
});
