import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudInstallHints } from "./contract.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const ENVIRONMENT_JSON_FILENAME = "environment.json";

const CANDIDATE_RELATIVE_PATHS = [
  ENVIRONMENT_JSON_FILENAME,
  ".cursor/environment.json",
  "env.json",
] as const;

const SECRET_KEY_RE = /(token|api[_-]?key|password|secret|authorization|credential)/i;
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9]{8,}|BEGIN [A-Z ]*PRIVATE KEY|DEEPSEEK_API_KEY|OPENAI_API_KEY|LLM_API_KEY|CODEX_API_KEY|PIG_CLOUD_TOKEN|CLOUD_TOKEN)/i;

export type CloudInstallHintsRead = {
  found: boolean;
  file?: string;
  hints: CloudInstallHints;
};

export function hasInstallHints(hints: CloudInstallHints | undefined): hints is CloudInstallHints {
  if (!hints) return false;
  return Boolean(
    hints.install ||
      (hints.deps && hints.deps.length > 0) ||
      (hints.tools && hints.tools.length > 0) ||
      (hints.setup && hints.setup.length > 0),
  );
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_RE.test(value);
}

function cleanStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const item = value.trim();
    return item && !isSecretValue(item) ? [item] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item && !isSecretValue(item));
}

/**
 * Cursor-style environment.json install hints (deps / tools / setup).
 * Drops secret keys and any string that looks like a provider key.
 * `env` / token / apiKey fields are never accepted.
 */
export function parseInstallHints(raw: unknown): CloudInstallHints {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const nested =
    root.environment && typeof root.environment === "object" && !Array.isArray(root.environment)
      ? (root.environment as Record<string, unknown>)
      : {};

  const pick = (key: string): unknown => {
    if (SECRET_KEY_RE.test(key)) return undefined;
    return nested[key] !== undefined ? nested[key] : root[key];
  };

  const installRaw = pick("install");
  const install = asTrimmed(installRaw);
  const hints: CloudInstallHints = {};
  if (install && !isSecretValue(install)) hints.install = install;

  const deps = cleanStringList(pick("deps") ?? pick("dependencies"));
  if (deps.length) hints.deps = deps;
  const tools = cleanStringList(pick("tools"));
  if (tools.length) hints.tools = tools;
  const setup = cleanStringList(pick("setup"));
  if (setup.length) hints.setup = setup;
  return hints;
}

export function loadInstallHintsFromPath(path: string): CloudInstallHintsRead {
  if (!existsSync(path)) return { found: false, hints: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { found: true, file: path, hints: parseInstallHints(raw) };
  } catch {
    return { found: true, file: path, hints: {} };
  }
}

/**
 * Workspace file wins over project-root file. Hints guide worker/local prep only —
 * they are never a place to store provider keys.
 */
export function loadInstallHints(options: {
  workspaceRoot?: string;
  projectRoot?: string;
} = {}): CloudInstallHintsRead {
  const roots = [options.workspaceRoot, options.projectRoot ?? PROJECT_ROOT].filter(
    (root): root is string => Boolean(root),
  );
  for (const root of roots) {
    for (const rel of CANDIDATE_RELATIVE_PATHS) {
      const path = join(root, rel);
      const read = loadInstallHintsFromPath(path);
      if (read.found && hasInstallHints(read.hints)) {
        return { ...read, file: rel };
      }
    }
  }
  return { found: false, hints: {} };
}
