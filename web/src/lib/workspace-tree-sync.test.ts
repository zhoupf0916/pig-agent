import { describe, expect, it } from "vitest";
import type { WorkspaceNode } from "../types";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyWorkspaceTreeSnapshot,
  sanitizeWorkspaceTree,
  startWorkspaceTreeSync,
  WORKSPACE_TREE_POLL_MS,
  workspaceTreeFilePaths,
  workspaceTreeSyncKey,
} from "./workspace-tree-sync";

function file(path: string, size = 12): WorkspaceNode {
  const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return { name, path, type: "file", size };
}

function dir(path: string, children: WorkspaceNode[]): WorkspaceNode {
  const name = path === "." ? "." : path.slice(path.lastIndexOf("/") + 1);
  return { name, path, type: "dir", children };
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

describe("workspace browser tree sync (Milestone T)", () => {
  it("keeps a 2s poll cadence", () => {
    expect(WORKSPACE_TREE_POLL_MS).toBe(2_000);
  });

  it("returns the previous tree reference when the snapshot is unchanged", () => {
    const prev = dir(".", [dir("notes", [file("notes/a.md", 40)])]);
    const next = dir(".", [dir("notes", [file("notes/a.md", 40)])]);
    expect(applyWorkspaceTreeSnapshot(prev, next)).toBe(prev);
    expect(workspaceTreeSyncKey(prev)).toBe(workspaceTreeSyncKey(next));
  });

  it("Tab B tree follows Tab A new / modified sandbox files from tree snapshots", async () => {
    let server = dir(".", [
      dir("notes", [file("notes/inbox.md", 80)]),
      dir("drafts", [file("drafts/scratch.md", 20)]),
    ]);
    let tabB: WorkspaceNode | null = applyWorkspaceTreeSnapshot(null, server);
    const fetches: WorkspaceNode[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startWorkspaceTreeSync({
      fetchTree: async () => {
        const snap = structuredClone(server);
        fetches.push(snap);
        return snap;
      },
      onTree: (next) => {
        tabB = applyWorkspaceTreeSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(workspaceTreeFilePaths(tabB)).toEqual(["notes/inbox.md", "drafts/scratch.md"]);

    server = dir(".", [
      dir("notes", [file("notes/inbox.md", 80)]),
      dir("drafts", [file("drafts/scratch.md", 20)]),
      dir("out", [file("out/report.md", 240)]),
    ]);
    tickInterval();
    await flush();

    expect(workspaceTreeFilePaths(tabB)).toContain("out/report.md");
    expect(workspaceTreeFilePaths(tabB)).toContain("notes/inbox.md");

    server = dir(".", [
      dir("notes", [file("notes/inbox.md", 96)]),
      dir("drafts", [file("drafts/scratch.md", 20)]),
      dir("out", [file("out/report.md", 240)]),
    ]);
    tickInterval();
    await flush();

    const inbox = tabB?.children
      ?.find((c) => c.path === "notes")
      ?.children?.find((c) => c.path === "notes/inbox.md");
    expect(inbox?.size).toBe(96);
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    let server = dir(".", [file("readme.md", 10)]);
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startWorkspaceTreeSync({
      fetchTree: async () => {
        calls += 1;
        return structuredClone(server);
      },
      onTree: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server = dir(".", [file("readme.md", 10), file("new.md", 4)]);
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never paints secrets or file contents in the tree and stays GET-only", async () => {
    const dirty = {
      name: ".",
      path: ".",
      type: "dir" as const,
      children: [
        {
          name: "notes.md",
          path: "notes.md",
          type: "file" as const,
          size: 12,
          content: "llmApiKey=sk-abcdefghijklmnop\ncloudToken=Bearer tok-secret",
        },
      ],
    } as unknown as WorkspaceNode;
    const applied = applyWorkspaceTreeSnapshot(null, dirty);
    const painted = JSON.stringify(applied);
    expect(painted).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-|Bearer /);
    expect(painted).not.toContain("content");
    expect(sanitizeWorkspaceTree(dirty).children?.[0]).toEqual({
      name: "notes.md",
      path: "notes.md",
      type: "file",
      size: 12,
    });

    const fetches: WorkspaceNode[] = [];
    const serverTree = dir(".", [file("notes.md", 12)]);
    const { clock, tickInterval } = fakeClock(true);
    const stop = startWorkspaceTreeSync({
      fetchTree: async () => {
        fetches.push(structuredClone(serverTree));
        return structuredClone(serverTree);
      },
      onTree: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((row) => workspaceTreeFilePaths(row).includes("notes.md"))).toBe(true);
    stop();
  });
});
