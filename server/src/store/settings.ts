import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectCloudStatus } from "../agent/cloud/validate.ts";
import { syncCodexHome } from "../agent/codex/home.ts";
import { inspectCodexStatus } from "../agent/codex/validate.ts";
import { DATA_DIR, DEFAULT_SETTINGS, ensureDir, resolveFromProject } from "../config.ts";
import type { AgentRuntime, CloudMode, Settings } from "../types.ts";
import { atomicWriteJson } from "../util.ts";

const FILE = join(DATA_DIR, "settings.json");

export function parseAgentRuntime(raw: unknown): AgentRuntime {
  if (raw === "codex") return "codex";
  if (raw === "cloud") return "cloud";
  return "pig";
}

export function parseCloudMode(raw: unknown): CloudMode {
  return raw === "remote" ? "remote" : "local-stub";
}

/** Strip trailing slashes and a redundant `/v1` so callers can paste either origin. */
export function normalizeCloudBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function assertCloudSettings(settings: Settings): void {
  if (settings.runtime !== "cloud") return;
  if (settings.cloudMode !== "remote") return;
  if (!settings.cloudBaseUrl) {
    throw new Error("Cloud base URL is required in remote mode");
  }
  let parsed: URL;
  try {
    parsed = new URL(settings.cloudBaseUrl);
  } catch {
    throw new Error("Cloud base URL must be a valid http(s) origin");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Cloud base URL must be http(s)");
  }
}

export function normalizeSettings(raw: Partial<Settings> = {}): Settings {
  const runtime = parseAgentRuntime(raw.runtime);
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
    cloudBaseUrl: normalizeCloudBaseUrl(raw.cloudBaseUrl ?? DEFAULT_SETTINGS.cloudBaseUrl),
    cloudToken: raw.cloudToken ?? DEFAULT_SETTINGS.cloudToken,
    cloudMode: parseCloudMode(raw.cloudMode ?? DEFAULT_SETTINGS.cloudMode),
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
    cloudBaseUrl: patch.cloudBaseUrl ?? current.cloudBaseUrl,
    cloudToken: patch.cloudToken ?? current.cloudToken,
    cloudMode: patch.cloudMode ?? current.cloudMode,
  });
  assertCloudSettings(next);
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
): Settings & {
  workspaceExists: boolean;
  codexStatus: ReturnType<typeof inspectCodexStatus>;
  cloudStatus: ReturnType<typeof inspectCloudStatus>;
} {
  return {
    ...settings,
    workspaceExists: existsSync(settings.workspaceRoot),
    codexStatus: inspectCodexStatus(settings),
    cloudStatus: inspectCloudStatus(settings),
  };
}
