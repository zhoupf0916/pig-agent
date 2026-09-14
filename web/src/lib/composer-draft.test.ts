import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay } from "./remote-retry";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DRAFT_FORBIDDEN_KEYS,
  clearComposerDraft,
  loadComposerDraft,
  persistComposerDraft,
  readComposerDraftStore,
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
