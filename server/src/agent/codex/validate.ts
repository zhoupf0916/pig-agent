import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexApiKey, resolveCodexHome } from "../../config.ts";
import type { CodexStatus, Settings } from "../../types.ts";

export class CodexValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexValidationError";
  }
}

export function resolveCodexBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = binaryPath.trim() || env.CODEX_BIN?.trim() || "codex";
  if (configured.includes("/") || configured.includes("\\")) {
    return configured;
  }
  const found = findOnPath(configured, env);
  return found ?? configured;
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env.PATH ?? "";
  const dirs = pathVar.split(env.Path && process.platform === "win32" ? ";" : ":");
  const ext = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const suffix of ext) {
      const candidate = join(dir, `${name}${suffix}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return null;
}

export function inspectCodexStatus(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): CodexStatus {
  const binary = resolveCodexBinary(settings.codexBinaryPath, env);
  let binaryFound = false;
  try {
    accessSync(binary, constants.X_OK);
    binaryFound = true;
  } catch {
    binaryFound = Boolean(findOnPath(binary, env));
  }

  const home = resolveCodexHome(env);
  let homeWritable = false;
  try {
    mkdirSync(home, { recursive: true });
    const probe = join(home, ".pig-write-probe");
    writeFileSync(probe, "ok");
    homeWritable = true;
  } catch {
    homeWritable = existsSync(home);
  }

  return {
    binaryFound,
    homeWritable,
    apiKeyPresent: Boolean(resolveCodexApiKey(env)),
  };
}

export function assertCodexReady(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): { binary: string; home: string } {
  const status = inspectCodexStatus(settings, env);
  const binary = resolveCodexBinary(settings.codexBinaryPath, env);
  const home = resolveCodexHome(env);
  if (!status.binaryFound) {
    throw new CodexValidationError(
      `Codex binary not found (${binary}). Install @openai/codex 0.154.x+ or set the Codex binary path / CODEX_BIN.`,
    );
  }
  if (!status.homeWritable) {
    throw new CodexValidationError(`CODEX_HOME is not writable: ${home}`);
  }
  if (!status.apiKeyPresent) {
    throw new CodexValidationError(
      "Missing DEEPSEEK_API_KEY or CODEX_API_KEY. Codex keys come from the environment only — never commit them.",
    );
  }
  return { binary, home };
}
