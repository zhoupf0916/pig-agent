import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  applyThemeSnapshot,
  parseTheme,
  persistTheme,
  readTheme,
  startThemeSync,
  toggleTheme,
  writeTheme,
  type Theme,
  type ThemeSyncBus,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] ?? null : null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    data,
  };
}

function memoryRoot() {
  const dataset: Record<string, string> = {};
  return {
    dataset: dataset as unknown as DOMStringMap,
    style: { colorScheme: "" },
  };
}

describe("theme persistence", () => {
  it("defaults to light when storage is empty or invalid", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(parseTheme(undefined)).toBe("light");
    expect(parseTheme("")).toBe("light");
    expect(parseTheme("system")).toBe("light");
    expect(readTheme(memoryStorage())).toBe("light");
    expect(readTheme(null)).toBe("light");
  });

  it("reads a stored dark choice", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "dark" });
    expect(readTheme(storage)).toBe("dark");
  });

  it("persists dark and applies data-theme + color-scheme", () => {
    const storage = memoryStorage();
    const root = memoryRoot();
    expect(persistTheme("dark", { storage, root })).toBe("dark");
    expect(storage.data[THEME_STORAGE_KEY]).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("round-trips light after a dark write (reload equivalent)", () => {
    const storage = memoryStorage();
    const root = memoryRoot();
    persistTheme("dark", { storage, root });
    expect(readTheme(storage)).toBe("dark");
    persistTheme("light", { storage, root });
    expect(readTheme(storage)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("treats invalid stored values as light", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "neon" });
    expect(readTheme(storage)).toBe("light");
    expect(writeTheme("nope" as never, storage)).toBe("light");
    expect(applyTheme("nope" as never, memoryRoot())).toBe("light");
  });

  it("toggles between light and dark", () => {
    expect(toggleTheme("light")).toBe("dark");
    expect(toggleTheme("dark")).toBe("light");
  });
});

function fakeThemeBus() {
  const storageListeners = new Set<(event: { key: string | null; newValue?: string | null }) => void>();
  const listeners = new Map<string, Set<() => void>>();
  const bus: ThemeSyncBus = {
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

describe("theme cross-tab sync (Milestone V)", () => {
  it("returns the previous theme reference when the value is unchanged", () => {
    const prev: Theme = "dark";
    expect(applyThemeSnapshot(prev, "dark")).toBe(prev);
    expect(applyThemeSnapshot(prev, "light")).toBe("light");
    expect(applyThemeSnapshot("light", "nope" as never)).toBe("light");
  });

  it("Tab B follows Tab A via storage without a full refresh", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "light" });
    const root = memoryRoot();
    let tabB: Theme = "light";
    const { bus, emitStorage } = fakeThemeBus();
    const stop = startThemeSync({
      storage,
      root,
      onTheme: (next) => {
        tabB = applyThemeSnapshot(tabB, next);
      },
      bus,
    });

    persistTheme("dark", { storage });
    emitStorage(THEME_STORAGE_KEY, storage.data[THEME_STORAGE_KEY] ?? null);
    expect(tabB).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(storage.data[THEME_STORAGE_KEY]).toBe("dark");
    expect(Object.keys(storage.data)).toEqual([THEME_STORAGE_KEY]);
    stop();
  });

  it("reloads the stored theme on focus / visibility (missed storage event)", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "light" });
    const root = memoryRoot();
    let tabB: Theme = "light";
    const { bus, focus, visibility } = fakeThemeBus();
    const stop = startThemeSync({
      storage,
      root,
      onTheme: (next) => {
        tabB = applyThemeSnapshot(tabB, next);
      },
      bus,
    });

    persistTheme("dark", { storage });
    expect(tabB).toBe("light");
    expect(root.dataset.theme).toBeUndefined();
    focus();
    expect(tabB).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");

    persistTheme("light", { storage });
    visibility();
    expect(tabB).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    stop();
  });

  it("ignores unrelated storage keys and never writes Settings / secrets", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "light" });
    const root = memoryRoot();
    let tabB: Theme = "light";
    let calls = 0;
    const writes: Array<{ key: string; value: string }> = [];
    const tracking = {
      getItem: storage.getItem,
      setItem(key: string, value: string) {
        writes.push({ key, value });
        storage.setItem(key, value);
      },
      data: storage.data,
    };
    const { bus, emitStorage } = fakeThemeBus();
    const stop = startThemeSync({
      storage: tracking,
      root,
      onTheme: (next) => {
        calls += 1;
        tabB = applyThemeSnapshot(tabB, next);
      },
      bus,
    });

    emitStorage("pig-agent.composer-drafts", '{"ses_a":"draft"}');
    emitStorage("llmApiKey", "sk-should-never-store");
    expect(calls).toBe(0);
    expect(tabB).toBe("light");
    expect(root.dataset.theme).toBeUndefined();

    persistTheme("dark", { storage: tracking });
    emitStorage(THEME_STORAGE_KEY, tracking.data[THEME_STORAGE_KEY] ?? null);
    expect(tabB).toBe("dark");
    expect(writes).toEqual([{ key: THEME_STORAGE_KEY, value: "dark" }]);
    expect(Object.keys(tracking.data)).toEqual([THEME_STORAGE_KEY]);
    expect(JSON.stringify(tracking.data)).not.toMatch(/llmApiKey|cloudToken|DEEPSEEK_API_KEY|sk-/);
    expect(redactSecretsForDisplay("失败 sk-abcdefghijklmnop")).toBe("失败 …");
    stop();
  });

  it("does not apply after stop; invalid stored values stay light", () => {
    const storage = memoryStorage({ [THEME_STORAGE_KEY]: "dark" });
    const root = memoryRoot();
    let tabB: Theme = "dark";
    applyTheme("dark", root);
    const { bus, emitStorage, focus } = fakeThemeBus();
    const stop = startThemeSync({
      storage,
      root,
      onTheme: (next) => {
        tabB = applyThemeSnapshot(tabB, next);
      },
      bus,
    });
    stop();

    persistTheme("light", { storage });
    emitStorage(THEME_STORAGE_KEY, "light");
    focus();
    expect(tabB).toBe("dark");
    expect(root.dataset.theme).toBe("dark");

    const liveRoot = memoryRoot();
    let live: Theme = "dark";
    const liveBus = fakeThemeBus();
    const stopLive = startThemeSync({
      storage: memoryStorage({ [THEME_STORAGE_KEY]: "neon" }),
      root: liveRoot,
      onTheme: (next) => {
        live = applyThemeSnapshot(live, next);
      },
      bus: liveBus.bus,
    });
    liveBus.focus();
    expect(live).toBe("light");
    expect(liveRoot.dataset.theme).toBe("light");
    stopLive();
  });
});
