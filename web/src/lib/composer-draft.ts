/** Client-only unsent composer drafts, keyed by session. Not settings / secrets. */

export const COMPOSER_DRAFT_STORAGE_KEY = "pig-agent.composer-drafts";

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Settings / credential field names that must never be written into draft storage. */
export const DRAFT_FORBIDDEN_KEYS = [
  "llmApiKey",
  "llmBaseUrl",
  "cloudToken",
  "apiKey",
  "DEEPSEEK_API_KEY",
  "CODEX_API_KEY",
  "PIG_CLOUD_TOKEN",
  "runtime",
] as const;

export function browserDraftStorage(): DraftStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 200 &&
    !value.includes("\n") &&
    !DRAFT_FORBIDDEN_KEYS.includes(value as (typeof DRAFT_FORBIDDEN_KEYS)[number])
  );
}

function parseStore(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isSessionId(key)) continue;
      if (DRAFT_FORBIDDEN_KEYS.includes(key as (typeof DRAFT_FORBIDDEN_KEYS)[number])) continue;
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readComposerDraftStore(storage?: DraftStorage | null): Record<string, string> {
  try {
    return parseStore(storage?.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

function writeStore(next: Record<string, string>, storage?: DraftStorage | null): void {
  if (!storage) return;
  try {
    if (Object.keys(next).length === 0) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      return;
    }
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota */
  }
}

/** Restore the unsent composer text for one session (empty if none). */
export function loadComposerDraft(sessionId: string, storage?: DraftStorage | null): string {
  if (!isSessionId(sessionId)) return "";
  return readComposerDraftStore(storage)[sessionId] ?? "";
}

/**
 * Persist unsent composer text for one session.
 * Empty text is an explicit clear of that session only.
 */
export function persistComposerDraft(
  sessionId: string,
  text: string,
  storage?: DraftStorage | null,
): void {
  if (!isSessionId(sessionId)) return;
  if (!text) {
    clearComposerDraft(sessionId, storage);
    return;
  }
  const next = { ...readComposerDraftStore(storage), [sessionId]: text };
  writeStore(next, storage);
}

/** Remove only this session's draft (successful send or explicit clear). */
export function clearComposerDraft(sessionId: string, storage?: DraftStorage | null): void {
  if (!isSessionId(sessionId)) return;
  const current = readComposerDraftStore(storage);
  if (!(sessionId in current)) return;
  const { [sessionId]: _removed, ...rest } = current;
  writeStore(rest, storage);
}

/** Same string keeps the previous reference (avoids extra composer renders). */
export function applyComposerDraft(prev: string, next: string): string {
  return prev === next ? prev : next;
}

export type StorageEventLike = {
  key: string | null;
  newValue?: string | null;
};

export type ComposerDraftSyncBus = {
  addStorageListener: (handler: (event: StorageEventLike) => void) => void;
  removeStorageListener: (handler: (event: StorageEventLike) => void) => void;
  addListener: (type: "visibilitychange" | "focus", handler: () => void) => void;
  removeListener: (type: "visibilitychange" | "focus", handler: () => void) => void;
};

export function browserComposerDraftSyncBus(): ComposerDraftSyncBus {
  return {
    addStorageListener: (handler) => {
      window.addEventListener("storage", handler as EventListener);
    },
    removeStorageListener: (handler) => {
      window.removeEventListener("storage", handler as EventListener);
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
 * Same-host Tab B follows Tab A's unsent draft from localStorage.
 * Live path: `storage` event. Catch-up: focus / visibility.
 * Client-only — no server write, no BroadcastChannel.
 */
export function startComposerDraftSync(opts: {
  sessionId: string | (() => string | null);
  storage?: DraftStorage | null;
  onDraft: (next: string) => void;
  bus?: ComposerDraftSyncBus;
}): () => void {
  const storage = opts.storage === undefined ? browserDraftStorage() : opts.storage;
  const bus = opts.bus ?? browserComposerDraftSyncBus();
  let stopped = false;

  const currentSessionId = () =>
    typeof opts.sessionId === "function" ? opts.sessionId() : opts.sessionId;

  const refresh = () => {
    if (stopped) return;
    const sessionId = currentSessionId();
    if (!sessionId) return;
    opts.onDraft(loadComposerDraft(sessionId, storage));
  };

  const onStorage = (event: StorageEventLike) => {
    if (event.key !== null && event.key !== COMPOSER_DRAFT_STORAGE_KEY) return;
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
