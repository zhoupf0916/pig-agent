import { codexEnvironment } from "./environment.ts";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexApiKey, resolveCodexHome } from "../../config.ts";
import type { CodexStatus, Settings } from "../../types.ts";
import { CodexValidationError } from "./errors.ts";

export { CodexValidationError } from "./errors.ts";

export function resolveCodexBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = binaryPath.trim() || env.CODEX_BIN?.trim() || "codex";
  if (configured.includes("/") || configured.includes("\\")) {
    return configured;
  }
  const found = findOnPath(configured, env);
  if (found) return found;
  if (configured === "codex" && process.platform === "darwin") {
    for (const candidate of ["/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex"]) {
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next app */ }
    }
  }
  return configured;
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
  env = codexEnvironment(settings, env);
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
    homeWritable = false;
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
  env = codexEnvironment(settings, env);
  const binary = resolveCodexBinary(settings.codexBinaryPath, env);
  const home = resolveCodexHome(env);
  if (!status.binaryFound) {
    throw new CodexValidationError("binary_missing", binary);
  }
  if (!status.homeWritable) {
    throw new CodexValidationError("home_unwritable", home);
  }
  if (!status.apiKeyPresent) {
    throw new CodexValidationError("api_key_missing");
  }
  return { binary, home };
}
