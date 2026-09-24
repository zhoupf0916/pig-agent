import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay } from "./remote-retry";
import type { SessionListSyncClock } from "./session-list-sync";
import { describeExecutionSurface } from "./runtime-surface";
import {
  applyWorkspaceFileSnapshot,
  isWorkspaceFileGoneError,
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
    expect(applied?.content).not.toMatch(/llmApiKey=sk-|cloudToken=Bearer |DEEPSEEK_API_KEY=sk-/);
    expect(applied?.content).not.toMatch(/sk-abcdefghijklmnop|tok-secret|sk-zzzzzzzz/);
    expect(applied?.content).toBe(redactSecretsForDisplay(dirty.content));
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

describe("open workspace preview deleted-elsewhere cleanup (Milestone AO)", () => {
  it("reuses the 2s file poll and stays on default runtime pig", () => {
    expect(WORKSPACE_FILE_POLL_MS).toBe(2_000);
    expect(describeExecutionSurface({ runtime: "pig" }).runtime).toBe("pig");
  });

  it("treats Path not found / 404 as gone, not a generic refresh failure", () => {
    expect(isWorkspaceFileGoneError(new Error("Path not found: notes/inbox.md"))).toBe(true);
    expect(isWorkspaceFileGoneError({ status: 404, message: "not found" })).toBe(true);
    expect(isWorkspaceFileGoneError(new Error("gone"))).toBe(false);
    expect(isWorkspaceFileGoneError(new Error("network"))).toBe(false);
  });

  it("clears the open preview so no ghost body text remains", () => {
    const prev = applyWorkspaceFileSnapshot(null, preview("notes/inbox.md", "ghost body\n", 11));
    expect(prev?.content).toBe("ghost body\n");
    expect(applyWorkspaceFileSnapshot(prev, null)).toBeNull();
    expect(applyWorkspaceFileSnapshot(prev, null)?.content).toBeUndefined();
  });

  it("Tab B clears a preview Tab A deleted or moved on poll / focus / visibility", async () => {
    const path = "notes/inbox.md";
    let server: WorkspaceFilePreview | null = preview(path, "inbox v1\n", 9);
    let tabB: WorkspaceFilePreview | null = applyWorkspaceFileSnapshot(null, server);
    let tabBPath: string | null = path;
    const fetches: string[] = [];
    const { clock, tickInterval, setVisible, focus } = fakeClock(true);

    const stop = startWorkspaceFileSync({
      path,
      fetchFile: async (requested) => {
        fetches.push(requested);
        if (!server) throw new Error(`Path not found: ${requested}`);
        return structuredClone(server);
      },
      onFile: (next) => {
        tabB = applyWorkspaceFileSnapshot(tabB, next);
        if (next === null) tabBPath = null;
      },
      intervalMs: 50,
      clock,
    });

    await flush();
    expect(tabB?.content).toBe("inbox v1\n");
    expect(tabBPath).toBe(path);
    expect(fetches.every((p) => p === path)).toBe(true);

    server = null;
    tickInterval();
    await flush();
    expect(tabB).toBeNull();
    expect(tabBPath).toBeNull();

    const afterPoll = fetches.length;
    setVisible(false);
    tickInterval();
    await flush();
    expect(fetches.length).toBe(afterPoll);

    setVisible(true);
    await flush();
    expect(fetches.length).toBeGreaterThan(afterPoll);
    expect(tabB).toBeNull();

    const beforeFocus = fetches.length;
    focus();
    await flush();
    expect(fetches.length).toBeGreaterThan(beforeFocus);
    expect(tabB).toBeNull();
    stop();
  });

  it("also clears when fetchFile returns null (typed gone)", async () => {
    const path = "drafts/scratch.md";
    let tabB: WorkspaceFilePreview | null = applyWorkspaceFileSnapshot(
      null,
      preview(path, "still here", 10),
    );
    const { clock, tickInterval } = fakeClock(true);
    let gone = false;
    const stop = startWorkspaceFileSync({
      path,
      fetchFile: async () => (gone ? null : preview(path, "still here", 10)),
      onFile: (next) => {
        tabB = applyWorkspaceFileSnapshot(tabB, next);
      },
      intervalMs: 50,
      clock,
    });
    await flush();
    expect(tabB?.content).toBe("still here");
    gone = true;
    tickInterval();
    await flush();
    expect(tabB).toBeNull();
    stop();
  });

  it("does not treat a failed file refresh as a delete", async () => {
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
    expect(tabB?.path).toBe(path);
    expect(tabB?.content).toBe("good");
    stop();
  });

  it("never treats deleted-open cleanup snapshots as a place to store secrets", () => {
    const dirty = preview(
      "notes.md",
      "llmApiKey=sk-abcdefghijklmnop\ncloudToken=Bearer tok-secret",
      60,
    );
    const applied = applyWorkspaceFileSnapshot(dirty, null);
    const raw = JSON.stringify({ applied, dirty: sanitizeWorkspaceFilePreview(dirty) });
    expect(applied).toBeNull();
    expect(raw).not.toMatch(/llmApiKey=sk-|cloudToken=Bearer /);
    expect(raw).not.toMatch(/sk-abcdefghijklmnop|tok-secret/);
    expect(raw).not.toMatch(/PIG_CLOUD_TOKEN|DEEPSEEK_API_KEY/);
  });
});

it("轮询发现远端文件变更或删除时保留未保存的编辑", () => {
  const draft = { ...preview("note.txt", "my draft"), dirty: true };
  expect(applyWorkspaceFileSnapshot(draft, preview("note.txt", "other writer"))).toBe(draft);
  expect(applyWorkspaceFileSnapshot(draft, null)).toBe(draft);
});
