export const THEME_STORAGE_KEY = "pig-agent.theme";
export const DEFAULT_THEME = "light" as const;

export type Theme = "light" | "dark";

export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
export type ThemeRoot = {
  dataset: DOMStringMap;
  style: { colorScheme: string };
};

export function parseTheme(value: unknown): Theme {
  return value === "dark" ? "dark" : DEFAULT_THEME;
}

export function readTheme(storage?: ThemeStorage | null): Theme {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeTheme(theme: Theme, storage?: ThemeStorage | null): Theme {
  const next = parseTheme(theme);
  try {
    storage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode / quota */
  }
  return next;
}

export function applyTheme(theme: Theme, root?: ThemeRoot | null): Theme {
  const next = parseTheme(theme);
  if (root) {
    root.dataset.theme = next;
    root.style.colorScheme = next;
  }
  return next;
}

export function persistTheme(
  theme: Theme,
  opts?: { storage?: ThemeStorage | null; root?: ThemeRoot | null },
): Theme {
  const next = writeTheme(theme, opts?.storage);
  return applyTheme(next, opts?.root);
}

export function toggleTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

export function browserThemeStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function browserThemeRoot(): ThemeRoot | null {
  try {
    return globalThis.document?.documentElement ?? null;
  } catch {
    return null;
  }
}

export function loadPersistedTheme(): Theme {
  const theme = readTheme(browserThemeStorage());
  applyTheme(theme, browserThemeRoot());
  return theme;
}

/** Same value keeps the previous reference (avoids extra theme renders). */
export function applyThemeSnapshot(prev: Theme, next: Theme): Theme {
  const parsed = parseTheme(next);
  return prev === parsed ? prev : parsed;
}

export type StorageEventLike = {
  key: string | null;
  newValue?: string | null;
};

export type ThemeSyncBus = {
  addStorageListener: (handler: (event: StorageEventLike) => void) => void;
  removeStorageListener: (handler: (event: StorageEventLike) => void) => void;
  addListener: (type: "visibilitychange" | "focus", handler: () => void) => void;
  removeListener: (type: "visibilitychange" | "focus", handler: () => void) => void;
};

const storageListeners = new WeakMap<(event: StorageEventLike) => void, EventListener>();

export function browserThemeSyncBus(): ThemeSyncBus {
  return {
    addStorageListener: (handler) => {
      const listener: EventListener = (event) => {
        handler(event as StorageEvent);
      };
      storageListeners.set(handler, listener);
      window.addEventListener("storage", listener);
    },
    removeStorageListener: (handler) => {
      const listener = storageListeners.get(handler);
      if (!listener) return;
      window.removeEventListener("storage", listener);
      storageListeners.delete(handler);
    },
    addListener: (type, handler) => {
      if (type === "visibilitychange") document.addEventListener(type, handler);
      else window.addEventListener(type, handler);
    },
    removeListener: (type, handler) => {
      if (type === "visibilitychange") document.removeEventListener(type, handler);
      else window.removeEventListener(type, handler);
    },
  };
}

/**
 * Same-host Tab B follows Tab A's light/dark theme from localStorage.
 * Live path: `storage` event. Catch-up: focus / visibility.
 * Client-only — existing `pig-agent.theme` key only; no server write, no BroadcastChannel.
 */
export function startThemeSync(opts: {
  storage?: ThemeStorage | null;
  root?: ThemeRoot | null;
  onTheme: (next: Theme) => void;
  bus?: ThemeSyncBus;
}): () => void {
  const storage = opts.storage === undefined ? browserThemeStorage() : opts.storage;
  const root = opts.root === undefined ? browserThemeRoot() : opts.root;
  const bus = opts.bus ?? browserThemeSyncBus();
  let stopped = false;

  const refresh = () => {
    if (stopped) return;
    const next = readTheme(storage);
    applyTheme(next, root);
    opts.onTheme(next);
  };

  const onStorage = (event: StorageEventLike) => {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    refresh();
  };

  bus.addStorageListener(onStorage);
  bus.addListener("visibilitychange", refresh);
  bus.addListener("focus", refresh);

  return () => {
    stopped = true;
    bus.removeStorageListener(onStorage);
    bus.removeListener("visibilitychange", refresh);
    bus.removeListener("focus", refresh);
  };
}
