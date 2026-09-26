import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DRAFT_FORBIDDEN_KEYS,
  applyComposerDraft,
  clearComposerDraft,
  loadComposerDraft,
  persistComposerDraft,
  readComposerDraftStore,
  startComposerDraftSync,
  type ComposerDraftSyncBus,
} from "./composer-draft";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] ?? null : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    removeItem(key: string) {
      delete data[key];
    },
    data,
  };
}

describe("composer draft persistence (Milestone P)", () => {
  it("persists and restores an unsent draft for the same sessionId (refresh / reopen)", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "整理工作区并写摘要", storage);
    expect(loadComposerDraft("ses_a", storage)).toBe("整理工作区并写摘要");

    const reopened = memoryStorage({ ...storage.data });
    expect(loadComposerDraft("ses_a", reopened)).toBe("整理工作区并写摘要");
    expect(reopened.data[COMPOSER_DRAFT_STORAGE_KEY]).toBeDefined();
  });

  it("keeps per-session drafts isolated when switching sessions", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "draft A", storage);
    persistComposerDraft("ses_b", "draft B", storage);

    persistComposerDraft("ses_a", "draft A edited", storage);
    expect(loadComposerDraft("ses_a", storage)).toBe("draft A edited");
    expect(loadComposerDraft("ses_b", storage)).toBe("draft B");

    expect(loadComposerDraft("ses_b", storage)).not.toBe(loadComposerDraft("ses_a", storage));
  });

  it("clears only the current session on successful send (or explicit clear)", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "send me", storage);
    persistComposerDraft("ses_b", "keep me", storage);

    clearComposerDraft("ses_a", storage);
    expect(loadComposerDraft("ses_a", storage)).toBe("");
    expect(loadComposerDraft("ses_b", storage)).toBe("keep me");

    persistComposerDraft("ses_b", "", storage);
    expect(loadComposerDraft("ses_b", storage)).toBe("");
    expect(readComposerDraftStore(storage)).toEqual({});
    expect(storage.data[COMPOSER_DRAFT_STORAGE_KEY]).toBeUndefined();
  });

  it("never writes Settings / API key fields into draft storage", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "just a goal", storage);
    persistComposerDraft("llmApiKey", "sk-should-never-store", storage);
    persistComposerDraft("runtime", "cloud", storage);

    const store = readComposerDraftStore(storage);
    expect(store).toEqual({ ses_a: "just a goal" });
    for (const key of DRAFT_FORBIDDEN_KEYS) {
      expect(store).not.toHaveProperty(key);
    }
    const raw = storage.data[COMPOSER_DRAFT_STORAGE_KEY] ?? "";
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-/);
  });

  it("treats malformed storage as empty and ignores non-string values", () => {
    const storage = memoryStorage({ [COMPOSER_DRAFT_STORAGE_KEY]: "{not-json" });
    expect(loadComposerDraft("ses_a", storage)).toBe("");
    expect(readComposerDraftStore(null)).toEqual({});

    const dirty = memoryStorage({
      [COMPOSER_DRAFT_STORAGE_KEY]: JSON.stringify({
        ses_ok: "keep",
        llmApiKey: "sk-abcdefghijklmnop",
        bad: { text: "nope" },
      }),
    });
    expect(readComposerDraftStore(dirty)).toEqual({ ses_ok: "keep" });
    expect(loadComposerDraft("bad", dirty)).toBe("");
    expect(redactSecretsForDisplay("失败 sk-abcdefghijklmnop")).toBe("失败 …");
  });
});

function fakeDraftBus() {
  const storageListeners = new Set<(event: { key: string | null; newValue?: string | null }) => void>();
  const listeners = new Map<string, Set<() => void>>();
  const bus: ComposerDraftSyncBus = {
    addStorageListener: (handler) => {
      storageListeners.add(handler);
    },
    removeStorageListener: (handler) => {
      storageListeners.delete(handler);
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
  };
  return {
    bus,
    emitStorage(key: string | null, newValue?: string | null) {
      for (const fn of [...storageListeners]) fn({ key, newValue });
    },
    focus() {
      for (const fn of listeners.get("focus") ?? []) fn();
    },
    visibility() {
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
    },
  };
}

describe("composer draft cross-tab sync (Milestone S)", () => {
  it("returns the previous draft reference when the text is unchanged", () => {
    const prev = "整理工作区";
    expect(applyComposerDraft(prev, "整理工作区")).toBe(prev);
    expect(applyComposerDraft(prev, "写摘要")).toBe("写摘要");
  });

  it("Tab B same sessionId follows Tab A edits via storage without a full refresh", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "hello from A", storage);
    persistComposerDraft("ses_b", "keep B", storage);

    let tabB = "hello from A";
    const { bus, emitStorage } = fakeDraftBus();
    const stop = startComposerDraftSync({
      sessionId: "ses_a",
      storage,
      onDraft: (next) => {
        tabB = applyComposerDraft(tabB, next);
      },
      bus,
    });

    persistComposerDraft("ses_a", "hello from A edited", storage);
    emitStorage(COMPOSER_DRAFT_STORAGE_KEY, storage.data[COMPOSER_DRAFT_STORAGE_KEY] ?? null);
    expect(tabB).toBe("hello from A edited");
    expect(loadComposerDraft("ses_b", storage)).toBe("keep B");
    stop();
  });

  it("clears Tab B after Tab A send/clear; other sessions stay isolated", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "send me", storage);
    persistComposerDraft("ses_b", "keep me", storage);

    let tabA = "send me";
    let tabOther = "keep me";
    const { bus, emitStorage } = fakeDraftBus();
    const stopA = startComposerDraftSync({
      sessionId: "ses_a",
      storage,
      onDraft: (next) => {
        tabA = applyComposerDraft(tabA, next);
      },
      bus,
    });
    const stopOther = startComposerDraftSync({
      sessionId: "ses_b",
      storage,
      onDraft: (next) => {
        tabOther = applyComposerDraft(tabOther, next);
      },
      bus,
    });

    clearComposerDraft("ses_a", storage);
    emitStorage(COMPOSER_DRAFT_STORAGE_KEY, storage.data[COMPOSER_DRAFT_STORAGE_KEY] ?? null);
    expect(tabA).toBe("");
    expect(tabOther).toBe("keep me");
    expect(loadComposerDraft("ses_b", storage)).toBe("keep me");

    persistComposerDraft("ses_b", "keep me edited", storage);
    emitStorage(COMPOSER_DRAFT_STORAGE_KEY, storage.data[COMPOSER_DRAFT_STORAGE_KEY] ?? null);
    expect(tabA).toBe("");
    expect(tabOther).toBe("keep me edited");
    stopA();
    stopOther();
  });

  it("reloads the current session draft on focus / visibility (missed storage event)", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "before", storage);
    let tabB = "before";
    const { bus, focus, visibility } = fakeDraftBus();
    const stop = startComposerDraftSync({
      sessionId: "ses_a",
      storage,
      onDraft: (next) => {
        tabB = applyComposerDraft(tabB, next);
      },
      bus,
    });

    persistComposerDraft("ses_a", "after focus", storage);
    expect(tabB).toBe("before");
    focus();
    expect(tabB).toBe("after focus");

    persistComposerDraft("ses_a", "", storage);
    visibility();
    expect(tabB).toBe("");
    stop();
  });

  it("ignores unrelated storage keys and never writes Settings / secrets into drafts", () => {
    const storage = memoryStorage();
    persistComposerDraft("ses_a", "just a goal", storage);
    let tabB = "just a goal";
    let calls = 0;
    const { bus, emitStorage } = fakeDraftBus();
    const stop = startComposerDraftSync({
      sessionId: "ses_a",
      storage,
      onDraft: (next) => {
        calls += 1;
        tabB = applyComposerDraft(tabB, next);
      },
      bus,
    });

    emitStorage("pig-agent.theme", "dark");
    expect(calls).toBe(0);
    expect(tabB).toBe("just a goal");

    persistComposerDraft("llmApiKey", "sk-should-never-store", storage);
    persistComposerDraft("runtime", "cloud", storage);
    emitStorage(COMPOSER_DRAFT_STORAGE_KEY, storage.data[COMPOSER_DRAFT_STORAGE_KEY] ?? null);
    expect(tabB).toBe("just a goal");
    const store = readComposerDraftStore(storage);
    expect(store).toEqual({ ses_a: "just a goal" });
    for (const key of DRAFT_FORBIDDEN_KEYS) {
      expect(store).not.toHaveProperty(key);
    }
    const raw = storage.data[COMPOSER_DRAFT_STORAGE_KEY] ?? "";
    expect(raw).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-/);
    expect(redactSecretsForDisplay("失败 sk-abcdefghijklmnop")).toBe("失败 …");
    stop();
  });
});

describe("rejected message draft recovery", () => {
  it("restores rejected text for refresh without changing another conversation", async () => {
    const { restoreUnsentComposerDraft } = await import('./composer-draft');
    const storage = memoryStorage();
    persistComposerDraft('ses_b', '其他对话', storage);
    expect(restoreUnsentComposerDraft('ses_a', '未发出的内容', storage)).toBe('未发出的内容');
    expect(loadComposerDraft('ses_a', storage)).toBe('未发出的内容');
    expect(loadComposerDraft('ses_b', storage)).toBe('其他对话');
  });
  it("keeps a newer draft instead of overwriting it with an older rejected message", async () => {
    const { restoreUnsentComposerDraft } = await import('./composer-draft');
    const storage = memoryStorage();
    persistComposerDraft('ses_a', '后来输入的草稿', storage);
    expect(restoreUnsentComposerDraft('ses_a', '旧发送内容', storage)).toBe('后来输入的草稿');
    expect(loadComposerDraft('ses_a', storage)).toBe('后来输入的草稿');
  });
});
