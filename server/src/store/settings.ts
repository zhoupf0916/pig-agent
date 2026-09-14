import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_SETTINGS, ensureDir, resolveFromProject } from "../config.ts";
import type { Settings } from "../types.ts";
import { atomicWriteJson } from "../util.ts";

const FILE = join(DATA_DIR, "settings.json");

export async function loadSettings(): Promise<Settings> {
  ensureDir(DATA_DIR);
  if (!existsSync(FILE)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<Settings>;
    return {
      llmBaseUrl: raw.llmBaseUrl || DEFAULT_SETTINGS.llmBaseUrl,
      llmApiKey: raw.llmApiKey ?? DEFAULT_SETTINGS.llmApiKey,
      llmModel: raw.llmModel || DEFAULT_SETTINGS.llmModel,
      workspaceRoot: raw.workspaceRoot
        ? resolveFromProject(raw.workspaceRoot)
        : DEFAULT_SETTINGS.workspaceRoot,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = {
    llmBaseUrl: (patch.llmBaseUrl ?? current.llmBaseUrl).trim(),
    llmApiKey: patch.llmApiKey ?? current.llmApiKey,
    llmModel: (patch.llmModel ?? current.llmModel).trim(),
    workspaceRoot: resolveFromProject(
      (patch.workspaceRoot ?? current.workspaceRoot).trim(),
    ),
  };
  if (!next.llmBaseUrl) {
    throw new Error("LLM base URL is required");
  }
  if (!next.llmModel) {
    throw new Error("Model is required");
  }
  if (!next.workspaceRoot) {
    throw new Error("Workspace root is required");
  }
  await atomicWriteJson(FILE, next);
  return next;
}

export function publicSettings(settings: Settings): Settings & { workspaceExists: boolean } {
  return {
    ...settings,
    workspaceExists: existsSync(settings.workspaceRoot),
  };
}
