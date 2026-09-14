import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay } from "./remote-retry";
import type { SessionListSyncClock } from "./session-list-sync";
import {
  applyWorkspaceFileSnapshot,
  sanitizeWorkspaceFilePreview,
  startWorkspaceFileSync,
  WORKSPACE_FILE_POLL_MS,
  workspaceFileSyncKey,
  type WorkspaceFilePreview,
} from "./workspace-file-sync";

function preview(
  path: string,
  content: string,
  size = content.length,
  binary = false,
): WorkspaceFilePreview {
  return { path, content, binary, size };
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

describe("workspace file preview sync (Milestone U)", () => {
  it("keeps a 2s poll cadence", () => {
    expect(WORKSPACE_FILE_POLL_MS).toBe(2_000);
  });

  it("returns the previous preview reference when size and content are unchanged", () => {
    const prev = applyWorkspaceFileSnapshot(null, preview("notes/a.md", "# hello", 7));
    const next = preview("notes/a.md", "# hello", 7);
    expect(applyWorkspaceFileSnapshot(prev, next)).toBe(prev);
    expect(workspaceFileSyncKey(prev)).toBe(workspaceFileSyncKey(sanitizeWorkspaceFilePreview(next)));
  });

  it("Tab B open preview follows Tab A same-path writes from file snapshots", async () => {
    const path = "notes/inbox.md";
    let server = preview(path, "inbox v1\n", 9);
    let tabB: WorkspaceFilePreview | null = applyWorkspaceFileSnapshot(null, server);
    const fetches: string[] = [];
    const { clock, tickInterval } = fakeClock(true);

    const stop = startWorkspaceFileSync({
      path,
      fetchFile: async (requested) => {
        fetches.push(requested);
        return structuredClone(server);
      },
      onFile: (next) => {
        tabB = applyWorkspaceFileSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabB?.content).toBe("inbox v1\n");
    expect(fetches.every((p) => p === path)).toBe(true);

    server = preview(path, "inbox v2 from tab A\n", 20);
    tickInterval();
    await flush();

    expect(tabB?.content).toBe("inbox v2 from tab A\n");
    expect(tabB?.size).toBe(20);
    expect(tabB?.path).toBe(path);
    stop();
  });

  it("updates when content changes even if size stays the same", async () => {
    const path = "drafts/scratch.md";
    let server = preview(path, "abc", 3);
    let tabB: WorkspaceFilePreview | null = applyWorkspaceFileSnapshot(null, server);
    const { clock, tickInterval } = fakeClock(true);

    const stop = startWorkspaceFileSync({
      path,
      fetchFile: async () => structuredClone(server),
      onFile: (next) => {
        tabB = applyWorkspaceFileSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();

    server = preview(path, "xyz", 3);
    tickInterval();
    await flush();
    expect(tabB?.content).toBe("xyz");
    stop();
  });

  it("skips interval ticks while the tab is hidden, then refreshes on visible / focus", async () => {
    const path = "readme.md";
    let server = preview(path, "one", 3);
    let calls = 0;
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);
    const stop = startWorkspaceFileSync({
      path,
      fetchFile: async () => {
        calls += 1;
        return structuredClone(server);
      },
      onFile: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    const afterMount = calls;

    setVisible(false);
    tickInterval();
    await flush();
    expect(calls).toBe(afterMount);

    server = preview(path, "two", 3);
    setVisible(true);
    await flush();
    expect(calls).toBeGreaterThan(afterMount);

    const beforeFocus = calls;
    focus();
    await flush();
    expect(calls).toBeGreaterThan(beforeFocus);
    stop();
  });

  it("never paints secrets in preview plaintext and stays GET-only", async () => {
    const dirty = preview(
      "notes.md",
      "llmApiKey=sk-abcdefghijklmnop\ncloudToken=Bearer tok-secret\nDEEPSEEK_API_KEY=sk-zzzzzzzz",
      80,
    );
    const applied = applyWorkspaceFileSnapshot(null, dirty);
    expect(applied.content).not.toMatch(/llmApiKey=sk-|cloudToken=Bearer |DEEPSEEK_API_KEY=sk-/);
    expect(applied.content).not.toMatch(/sk-abcdefghijklmnop|tok-secret|sk-zzzzzzzz/);
    expect(applied.content).toBe(redactSecretsForDisplay(dirty.content));
    expect(sanitizeWorkspaceFilePreview({ ...dirty, binary: true }).content).toBe("");

    const fetches: string[] = [];
    const server = preview("notes.md", "ok\n", 3);
    const { clock, tickInterval } = fakeClock(true);
    const stop = startWorkspaceFileSync({
      path: "notes.md",
      fetchFile: async (requested) => {
        fetches.push(requested);
        return structuredClone(server);
      },
      onFile: () => undefined,
      intervalMs: 50,
      clock,
    });
    await flush();
    tickInterval();
    await flush();
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((p) => p === "notes.md")).toBe(true);
    stop();
  });

  it("keeps the last good preview when a refresh fails", async () => {
    const path = "notes/a.md";
    let fail = false;
    let tabB: WorkspaceFilePreview | null = applyWorkspaceFileSnapshot(
      null,
      preview(path, "good", 4),
    );
    const { clock, tickInterval } = fakeClock(true);
    const stop = startWorkspaceFileSync({
      path,
      fetchFile: async () => {
        if (fail) throw new Error("gone");
        return preview(path, "good", 4);
      },
      onFile: (next) => {
        tabB = applyWorkspaceFileSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    fail = true;
    tickInterval();
    await flush();
    expect(tabB?.content).toBe("good");
    stop();
  });
});
