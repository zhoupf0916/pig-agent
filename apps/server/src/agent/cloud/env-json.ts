import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../../config.ts";
import type { Settings } from "../../types.ts";



/** Project-root file for non-secret remote-cloud hints. Never put tokens or API keys here. */
export const ENV_JSON_FILENAME = "env.json";

export function defaultEnvJsonPath(): string {
  return resolve(PROJECT_ROOT, ENV_JSON_FILENAME);
}

export type CloudEnvJsonHints = {
  baseUrl?: string;
  repoUrl?: string;
  repoRef?: string;
};

export type CloudEnvJsonRead = {
  found: boolean;
  path: string;
  hints: CloudEnvJsonHints;
};

export type CloudHintSource = "settings" | "env.json" | "env";

export type CloudHintResolveOptions = {
  settings?: Pick<Settings, "cloudBaseUrl" | "cloudRepoUrl" | "cloudRepoRef"> | Partial<Settings>;
  envJson?: CloudEnvJsonHints;
  env?: NodeJS.ProcessEnv;
  /** When `envJson` is omitted, read this path instead of the project-root default. */
  envJsonPath?: string;
};

const SECRET_KEY_RE = /(token|api[_-]?key|password|secret|authorization|credential)/i;

export function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return "";
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dropSecretKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = dropSecretKeys(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function pickHint(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asTrimmed(obj[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Parse non-secret remote-cloud hints. Tokens / API keys are dropped even if present.
 *
 * Accepted shapes (first match wins per field):
 * - `{ "cloud": { "baseUrl", "repoUrl", "repoRef" } }` (documented)
 * - top-level `PIG_CLOUD_BASE_URL` / `PIG_CLOUD_REPO_URL` / `PIG_CLOUD_REPO_REF`
 */
export function parseCloudEnvJson(raw: unknown): CloudEnvJsonHints {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = dropSecretKeys(raw as Record<string, unknown>);
  const nested =
    root.cloud && typeof root.cloud === "object" && !Array.isArray(root.cloud)
      ? dropSecretKeys(root.cloud as Record<string, unknown>)
      : {};

  const baseUrl = firstNonEmpty(
    pickHint(nested, ["baseUrl", "PIG_CLOUD_BASE_URL", "CLOUD_BASE_URL"]),
    pickHint(root, ["baseUrl", "PIG_CLOUD_BASE_URL", "CLOUD_BASE_URL"]),
  );
  const repoUrl = firstNonEmpty(
    pickHint(nested, ["repoUrl", "PIG_CLOUD_REPO_URL"]),
    pickHint(root, ["repoUrl", "PIG_CLOUD_REPO_URL"]),
  );
  const repoRef = firstNonEmpty(
    pickHint(nested, ["repoRef", "ref", "PIG_CLOUD_REPO_REF"]),
    pickHint(root, ["repoRef", "ref", "PIG_CLOUD_REPO_REF"]),
  );

  const hints: CloudEnvJsonHints = {};
  if (baseUrl) hints.baseUrl = baseUrl;
  if (repoUrl) hints.repoUrl = repoUrl;
  if (repoRef) hints.repoRef = repoRef;
  return hints;
}

export function loadCloudEnvJson(path = defaultEnvJsonPath()): CloudEnvJsonRead {
  if (!existsSync(path)) return { found: false, path, hints: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { found: true, path, hints: parseCloudEnvJson(raw) };
  } catch {
    return { found: true, path, hints: {} };
  }
}

export function loadCloudEnvJsonHints(path = defaultEnvJsonPath()): CloudEnvJsonHints {
  return loadCloudEnvJson(path).hints;
}

function resolveHints(options: CloudHintResolveOptions = {}): {
  settings: Partial<Settings>;
  hints: CloudEnvJsonHints;
  env: NodeJS.ProcessEnv;
} {
  const hints =
    options.envJson ??
    loadCloudEnvJson(options.envJsonPath ?? defaultEnvJsonPath()).hints;
  return {
    settings: options.settings ?? {},
    hints,
    env: options.env ?? process.env,
  };
}

function pickLayered(
  settingsValue: string | undefined,
  envJsonValue: string | undefined,
  envValue: string | undefined,
): { value: string; source?: CloudHintSource } {
  const settings = settingsValue?.trim() ?? "";
  if (settings) return { value: settings, source: "settings" };
  const fromFile = envJsonValue?.trim() ?? "";
  if (fromFile) return { value: fromFile, source: "env.json" };
  const fromEnv = envValue?.trim() ?? "";
  if (fromEnv) return { value: fromEnv, source: "env" };
  return { value: "" };
}

/**
 * Effective control-plane origin.
 * Precedence: non-empty Settings/UI → env.json → PIG_CLOUD_BASE_URL / CLOUD_BASE_URL.
 */
export function resolveEffectiveCloudBaseUrl(
  settings: Pick<Settings, "cloudBaseUrl"> | Partial<Settings> = {},
  options: Omit<CloudHintResolveOptions, "settings"> = {},
): string {
  const { hints, env } = resolveHints({ ...options, settings });
  return pickLayered(
    settings.cloudBaseUrl,
    hints.baseUrl,
    env.PIG_CLOUD_BASE_URL || env.CLOUD_BASE_URL,
  ).value;
}

export function resolveCloudRepoHintDetailed(options: CloudHintResolveOptions = {}): {
  repoUrl?: string;
  ref?: string;
  repoUrlSource?: CloudHintSource;
  refSource?: CloudHintSource;
} {
  const { settings, hints, env } = resolveHints(options);
  const url = pickLayered(settings.cloudRepoUrl, hints.repoUrl, env.PIG_CLOUD_REPO_URL);
  const ref = pickLayered(settings.cloudRepoRef, hints.repoRef, env.PIG_CLOUD_REPO_REF);
  return {
    ...(url.value ? { repoUrl: url.value, repoUrlSource: url.source } : {}),
    ...(ref.value ? { ref: ref.value, refSource: ref.source } : {}),
  };
}

/** Optional clone hint for remote create-run. Snapshot is still preferred when the workspace exists. */
export function resolveCloudRepoHint(
  options: CloudHintResolveOptions = {},
): { repoUrl?: string; ref?: string } {
  const detailed = resolveCloudRepoHintDetailed(options);
  const hint: { repoUrl?: string; ref?: string } = {};
  if (detailed.repoUrl) hint.repoUrl = detailed.repoUrl;
  if (detailed.ref) hint.ref = detailed.ref;
  return hint;
}
