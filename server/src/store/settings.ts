import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { syncCodexHome } from "../agent/codex/home.ts";
import { inspectCodexStatus } from "../agent/codex/validate.ts";
import { DATA_DIR, DEFAULT_SETTINGS, ensureDir, resolveFromProject } from "../config.ts";
import type { AgentRuntime, Settings } from "../types.ts";
import { atomicWriteJson } from "../util.ts";

const FILE = join(DATA_DIR, "settings.json");

export function normalizeSettings(raw: Partial<Settings> = {}): Settings {
  const runtime: AgentRuntime = raw.runtime === "codex" ? "codex" : "pig";
  return {
    llmBaseUrl: (raw.llmBaseUrl || DEFAULT_SETTINGS.llmBaseUrl).trim(),
    llmApiKey: raw.llmApiKey ?? DEFAULT_SETTINGS.llmApiKey,
    llmModel: (raw.llmModel || DEFAULT_SETTINGS.llmModel).trim(),
    workspaceRoot: raw.workspaceRoot
      ? resolveFromProject(raw.workspaceRoot)
      : DEFAULT_SETTINGS.workspaceRoot,
    runtime,
    codexBinaryPath: (raw.codexBinaryPath ?? DEFAULT_SETTINGS.codexBinaryPath).trim(),
    codexModel: (raw.codexModel || DEFAULT_SETTINGS.codexModel).trim(),
    codexNetworkAccess: raw.codexNetworkAccess === true,
  };
}

export async function loadSettings(): Promise<Settings> {
  ensureDir(DATA_DIR);
  if (!existsSync(FILE)) {
    return normalizeSettings();
  }
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<Settings>;
    return normalizeSettings(raw);
  } catch {
    return normalizeSettings();
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = normalizeSettings({
    llmBaseUrl: patch.llmBaseUrl ?? current.llmBaseUrl,
    llmApiKey: patch.llmApiKey ?? current.llmApiKey,
    llmModel: patch.llmModel ?? current.llmModel,
    workspaceRoot: patch.workspaceRoot ?? current.workspaceRoot,
    runtime: patch.runtime ?? current.runtime,
    codexBinaryPath: patch.codexBinaryPath ?? current.codexBinaryPath,
    codexModel: patch.codexModel ?? current.codexModel,
    codexNetworkAccess:
      patch.codexNetworkAccess !== undefined
        ? patch.codexNetworkAccess
        : current.codexNetworkAccess,
  });
  if (!next.llmBaseUrl) {
    throw new Error("LLM base URL is required");
  }
  if (!next.llmModel) {
    throw new Error("Model is required");
  }
  if (!next.workspaceRoot) {
    throw new Error("Workspace root is required");
  }
  if (!next.codexModel) {
    throw new Error("Codex model is required");
  }
  await atomicWriteJson(FILE, next);
  // Always rewrite isolated Codex trust when workspace/runtime settings change.
  // Only the realpath of the configured workspace is trusted — never extra paths.
  await syncCodexHome(next).catch(() => undefined);
  return next;
}

export function publicSettings(
  settings: Settings,
): Settings & { workspaceExists: boolean; codexStatus: ReturnType<typeof inspectCodexStatus> } {
  return {
    ...settings,
    workspaceExists: existsSync(settings.workspaceRoot),
    codexStatus: inspectCodexStatus(settings),
  };
}
