import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  parseTheme,
  persistTheme,
  readTheme,
  toggleTheme,
  writeTheme,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
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
