import { desktopSecrets } from "./desktop-secrets.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CloudHintResolveOptions,
  resolveEffectiveCloudBaseUrl,
} from "../agent/cloud/env-json.ts";
import { cloudRemoteError } from "../agent/cloud/errors.ts";
import { inspectCloudStatus } from "../agent/cloud/validate.ts";
import { inspectExecutionSurface } from "../agent/runtime-surface.ts";
import { syncCodexHome } from "../agent/codex/home.ts";
import { inspectCodexStatus } from "../agent/codex/validate.ts";
import {
  DATA_DIR,
  DEFAULT_SETTINGS,
  ensureDir,
  resolveFromProject,
} from "../config.ts";
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

export function assertCloudSettings(
  settings: Settings,
  options: Omit<CloudHintResolveOptions, "settings"> = {},
): void {
  if (settings.runtime !== "cloud") return;
  if (settings.cloudMode !== "remote") return;
  const baseUrl = resolveEffectiveCloudBaseUrl(settings, options);
  if (!baseUrl) {
    throw cloudRemoteError("missing_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw cloudRemoteError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw cloudRemoteError("invalid_url");
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
    codexBinaryPath: (
      raw.codexBinaryPath ?? DEFAULT_SETTINGS.codexBinaryPath
    ).trim(),
    codexModel: (raw.codexModel || DEFAULT_SETTINGS.codexModel).trim(),
    codexNetworkAccess: raw.codexNetworkAccess === true,
    cloudBaseUrl: normalizeCloudBaseUrl(
      raw.cloudBaseUrl ?? DEFAULT_SETTINGS.cloudBaseUrl,
    ),
    cloudToken: raw.cloudToken ?? DEFAULT_SETTINGS.cloudToken,
    cloudMode: parseCloudMode(raw.cloudMode ?? DEFAULT_SETTINGS.cloudMode),
    cloudRepoUrl: (raw.cloudRepoUrl ?? DEFAULT_SETTINGS.cloudRepoUrl).trim(),
    cloudRepoRef: (raw.cloudRepoRef ?? DEFAULT_SETTINGS.cloudRepoRef).trim(),
  };
}

export async function loadSettings(): Promise<Settings> {
  ensureDir(DATA_DIR);
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<Settings>;
  } catch {
    /* first launch */
  }
  // Fail closed if the OS credential store cannot be read.
  if (desktopSecrets) Object.assign(raw, await desktopSecrets.read());
  return normalizeSettings(raw);
}

export async function saveSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  const current = await loadSettings();
  const next = normalizeSettings({
    llmBaseUrl: patch.llmBaseUrl ?? current.llmBaseUrl,
    llmApiKey:
      (desktopSecrets && !patch.llmApiKey
        ? current.llmApiKey
        : patch.llmApiKey) ?? current.llmApiKey,
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
    cloudToken:
      (desktopSecrets && !patch.cloudToken
        ? current.cloudToken
        : patch.cloudToken) ?? current.cloudToken,
    cloudMode: patch.cloudMode ?? current.cloudMode,
    cloudRepoUrl: patch.cloudRepoUrl ?? current.cloudRepoUrl,
    cloudRepoRef: patch.cloudRepoRef ?? current.cloudRepoRef,
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
  if (desktopSecrets) {
    await desktopSecrets.write({
      llmApiKey: next.llmApiKey,
      cloudToken: next.cloudToken,
    });
    await atomicWriteJson(FILE, { ...next, llmApiKey: "", cloudToken: "" });
  } else {
    await atomicWriteJson(FILE, next);
  }
  // Always rewrite isolated Codex trust when workspace/runtime settings change.
  // Only the realpath of the configured workspace is trusted — never extra paths.
  await syncCodexHome(next).catch(() => undefined);
  return next;
}

export function publicSettings(settings: Settings): Settings & {
  llmApiKeyConfigured?: boolean;
  cloudTokenConfigured?: boolean;
  workspaceExists: boolean;
  codexStatus: ReturnType<typeof inspectCodexStatus>;
  cloudStatus: ReturnType<typeof inspectCloudStatus>;
  executionSurface: ReturnType<typeof inspectExecutionSurface>;
} {
  return {
    ...settings,
    ...(desktopSecrets
      ? {
          llmApiKey: "",
          cloudToken: "",
          llmApiKeyConfigured: !!settings.llmApiKey,
          cloudTokenConfigured: !!settings.cloudToken,
        }
      : {}),
    workspaceExists: existsSync(settings.workspaceRoot),
    codexStatus: inspectCodexStatus(settings),
    cloudStatus: inspectCloudStatus(settings),
    executionSurface: inspectExecutionSurface(settings),
  };
}
