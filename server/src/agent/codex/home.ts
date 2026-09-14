import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  resolveCodexApiKeyEnvName,
  resolveCodexBaseUrl,
  resolveCodexHome,
} from "../../config.ts";
import type { Settings } from "../../types.ts";
import { CODEX_MODELS_CATALOG } from "./models-catalog.ts";

export class CodexTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexTrustError";
  }
}

/** Canonical workspace path used for Codex `-C` and `[projects."…"]` trust. */
export function resolveTrustedWorkspace(workspaceRoot: string): string {
  const resolved = resolve(workspaceRoot.trim());
  if (!existsSync(resolved)) {
    throw new CodexTrustError(`Workspace root does not exist: ${resolved}`);
  }
  const real = realpathSync(resolved);
  if (!statSync(real).isDirectory()) {
    throw new CodexTrustError(`Workspace root is not a directory: ${real}`);
  }
  return real;
}

export function assertCwdMatchesWorkspace(cwd: string, workspaceReal: string): void {
  const cwdReal = existsSync(cwd) ? realpathSync(resolve(cwd)) : resolve(cwd);
  if (cwdReal !== workspaceReal) {
    throw new CodexTrustError(
      `Codex -C cwd (${cwdReal}) does not match trusted workspace (${workspaceReal})`,
    );
  }
}

export function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function projectTableHeader(workspaceRealPath: string): string {
  return `[projects."${tomlEscape(workspaceRealPath)}"]`;
}

/**
 * Drop every `[projects."…"]` table and keep only the realpath workspace.
 * Never copies caller-supplied extra paths into the trusted set.
 */
export function rewriteProjectTrust(toml: string, workspaceRealPath: string): string {
  const stripped = stripProjectTables(toml).trimEnd();
  const block = [
    projectTableHeader(workspaceRealPath),
    'trust_level = "trusted"',
    "",
  ].join("\n");
  return `${stripped ? `${stripped}\n\n` : ""}${block}`;
}

export function stripProjectTables(toml: string): string {
  const lines = toml.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      skipping = /^\s*projects(\.|$)/i.test(header[1] ?? "");
      if (skipping) continue;
    }
    if (skipping) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function renderCodexConfig(options: {
  home: string;
  model: string;
  workspaceRealPath: string | null;
  networkAccess: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
}): string {
  const baseUrl = options.baseUrl ?? resolveCodexBaseUrl();
  const apiKeyEnv = options.apiKeyEnv ?? resolveCodexApiKeyEnvName();
  const catalog = join(options.home, "models.json");
  const lines = [
    `model = "${tomlEscape(options.model)}"`,
    `model_provider = "deepseek"`,
    `preferred_auth_method = "apikey"`,
    `forced_login_method = "api"`,
    `model_reasoning_effort = "high"`,
    `model_catalog_json = "${tomlEscape(catalog)}"`,
    `approval_policy = "never"`,
    `sandbox_mode = "workspace-write"`,
    "",
    "[sandbox_workspace_write]",
    `network_access = ${options.networkAccess ? "true" : "false"}`,
    "",
    "[model_providers.deepseek]",
    `name = "deepseek"`,
    `base_url = "${tomlEscape(baseUrl)}"`,
    `wire_api = "responses"`,
    `env_key = "${tomlEscape(apiKeyEnv)}"`,
    "",
  ];
  let toml = lines.join("\n");
  if (options.workspaceRealPath) {
    toml = rewriteProjectTrust(toml, options.workspaceRealPath);
  }
  return toml.endsWith("\n") ? toml : `${toml}\n`;
}

export async function syncCodexHome(
  settings: Settings,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ home: string; workspaceRealPath: string | null; configPath: string }> {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveCodexHome(env); // isolated; ignores user ~/.codex
  await mkdir(home, { recursive: true });

  let workspaceRealPath: string | null = null;
  try {
    workspaceRealPath = resolveTrustedWorkspace(settings.workspaceRoot);
  } catch {
    workspaceRealPath = null;
  }

  const config = renderCodexConfig({
    home,
    model: settings.codexModel,
    workspaceRealPath,
    networkAccess: settings.codexNetworkAccess === true,
    baseUrl: resolveCodexBaseUrl(env),
    apiKeyEnv: resolveCodexApiKeyEnvName(env),
  });

  const configPath = join(home, "config.toml");
  await writeFile(join(home, "models.json"), `${JSON.stringify(CODEX_MODELS_CATALOG, null, 2)}\n`, "utf8");
  await writeFile(configPath, config, "utf8");
  return { home, workspaceRealPath, configPath };
}

export function trustedProjectsInToml(toml: string): string[] {
  const paths: string[] = [];
  const re = /\[projects\."((?:\\.|[^"\\])*)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(toml))) {
    const raw = match[1] ?? "";
    paths.push(raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return paths;
}
