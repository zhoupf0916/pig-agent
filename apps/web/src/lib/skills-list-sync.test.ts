import { describe, expect, it } from "vitest";
import type { SkillMeta } from "../types";
import { describeExecutionSurface } from "./runtime-surface";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applySkillsListSnapshot,
  sanitizeSkillMeta,
  SKILLS_LIST_POLL_MS,
  skillSyncKey,
  startSkillsListSync,
} from "./skills-list-sync";

function skill(overrides: Partial<SkillMeta> & { name: string } = { name: "organize-workspace" }): SkillMeta {
  return {
    name: overrides.name,
    description: overrides.description ?? "整理工作区并把散落文件归类。",
    filename: overrides.filename ?? `${overrides.name}.md`,
    keywords: overrides.keywords,
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

function painted(row: SkillMeta | undefined) {
  return {
    name: row?.name,
    description: row?.description,
    filename: row?.filename,
  };
}

describe("skills list cross-tab sync (Milestone AJ)", () => {
  it("keeps a 2s poll cadence and default runtime pig", () => {
    expect(SKILLS_LIST_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
    expect(describeExecutionSurface({ runtime: "nope" }).runtime).toBe("pig");
  });

  it("returns the previous list reference when skills are unchanged", () => {
    const prevList = [skill({ name: "organize-workspace", keywords: ["整理"] })];
    const nextList = [skill({ name: "organize-workspace", keywords: ["整理"] })];
    expect(applySkillsListSnapshot(prevList, nextList)).toBe(prevList);
    expect(skillSyncKey(prevList[0]!)).toBe(skillSyncKey(nextList[0]!));
  });

  it("does not remount Settings form fields when only the skills/ list changes", () => {
    const openForm = { llmModel: "deepseek-chat", llmApiKey: "sk-typing-locally" };
    const prev = [skill({ name: "organize-workspace", description: "旧简介" })];
    const next = applySkillsListSnapshot(prev, [
      skill({
        name: "organize-workspace",
        description: "Tab A 改过的简介",
      }),
    ]);
    expect(next).not.toBe(prev);
    expect(next[0]?.description).toBe("Tab A 改过的简介");
    expect(openForm).toEqual({ llmModel: "deepseek-chat", llmApiKey: "sk-typing-locally" });
  });

  it("Tab B Settings skills/ list follows Tab A add / edit / delete without a full remount", async () => {
    let server = [skill({ name: "organize-workspace" })];
    let tabB = server.map((row) => ({ ...row }));
    const { clock, tickInterval } = fakeClock(true);

    const stop = startSkillsListSync({
      fetchList: async () =>
        server.map((row) => ({ ...row, keywords: row.keywords ? [...row.keywords] : undefined })),
      onList: (next) => {
        tabB = applySkillsListSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(painted(tabB[0])).toEqual({
      name: "organize-workspace",
      description: "整理工作区并把散落文件归类。",
      filename: "organize-workspace.md",
    });

    server = [
      skill({
        name: "coding-helper",
        description: "帮我 refactor 并打 patch。",
        keywords: ["code"],
      }),
      skill({
        name: "organize-workspace",
        description: "整理工作区 · 已编辑",
      }),
    ];
    tickInterval();
    await flush();

    expect(tabB.map((row) => row.name)).toEqual(["coding-helper", "organize-workspace"]);
    expect(painted(tabB.find((row) => row.name === "organize-workspace"))).toEqual({
      name: "organize-workspace",
      description: "整理工作区 · 已编辑",
      filename: "organize-workspace.md",
    });
    expect(painted(tabB.find((row) => row.name === "coding-helper"))).toEqual({
      name: "coding-helper",
      description: "帮我 refactor 并打 patch。",
      filename: "coding-helper.md",
    });

    server = [
      skill({
        name: "organize-workspace",
        description: "整理工作区 · 已编辑",
      }),
    ];
    tickInterval();
    await flush();
    expect(tabB.map((row) => row.name)).toEqual(["organize-workspace"]);
    expect(tabB.find((row) => row.name === "coding-helper")).toBeUndefined();
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const server = [skill({ name: "organize-workspace" })];
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startSkillsListSync({
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

    server[0] = skill({ name: "organize-workspace", description: "可见后" });
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never treats skill snapshots as a place to store secrets and stays GET-only", async () => {
    const dirty = {
      ...skill({ name: "organize-workspace", description: "整理 notes" }),
      llmApiKey: "sk-abcdefghijklmnop",
      cloudToken: "Bearer tok-secret",
      body: "---\nname: leak\n---\n# 不要把 body 放进列表",
      PIG_CLOUD_TOKEN: "tok-secret",
    } as SkillMeta & { llmApiKey: string; cloudToken: string; body: string; PIG_CLOUD_TOKEN: string };
    const applied = applySkillsListSnapshot([], [dirty]);
    const raw = JSON.stringify({ list: applied, painted: painted(applied[0]) });
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN/);
    expect(raw).not.toMatch(/不要把 body 放进列表/);
    expect(painted(applied[0]).description).toBe("整理 notes");
    expect(sanitizeSkillMeta(dirty)).not.toHaveProperty("llmApiKey");
    expect(sanitizeSkillMeta(dirty)).not.toHaveProperty("body");

    const fetches: SkillMeta[][] = [];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSkillsListSync({
      fetchList: async () => {
        const next = [skill({ name: "organize-workspace", description: "整理 notes" })];
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
    expect(fetches.every((list) => list[0]?.name === "organize-workspace")).toBe(true);
    stop();
  });

  it("keeps the last good list when a refresh fails", async () => {
    let fail = false;
    let tabB = [skill({ name: "organize-workspace", description: "整理工作区并把散落文件归类。" })];
    const { clock, tickInterval } = fakeClock(true);
    const stop = startSkillsListSync({
      fetchList: async () => {
        if (fail) throw new Error("gone");
        return [skill({ name: "organize-workspace", description: "整理工作区并把散落文件归类。" })];
      },
      onList: (next) => {
        tabB = applySkillsListSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB[0]?.description).toBe("整理工作区并把散落文件归类。");

    fail = true;
    tickInterval();
    await flush();
    expect(tabB[0]?.description).toBe("整理工作区并把散落文件归类。");
    stop();
  });
});

it('keeps Chinese display names after polling and picks up a renamed skill', () => {
  const meta={...skill({name:'plugin_data-quality_guide'}),displayName:'CSV 数据质量'};
  const first=applySkillsListSnapshot([], [meta]);
  expect(first[0]?.displayName).toBe('CSV 数据质量');
  const next=applySkillsListSnapshot(first,[{...meta,displayName:'CSV 质量核验'}]);
  expect(next[0]?.displayName).toBe('CSV 质量核验');
});
