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
