import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "../..");

loadEnv({ path: resolve(PROJECT_ROOT, ".env") });
loadEnv({ path: resolve(PROJECT_ROOT, ".env.local"), override: true });

export const SKILLS_DIR = resolve(PROJECT_ROOT, "skills");

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_MODEL = "deepseek-chat";
/** Codex provider root — not the pig Chat Completions `/v1` path. */
export const CODEX_DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
export const CODEX_DEFAULT_MODEL = "deepseek-flash";

export function resolveFromProject(input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(PROJECT_ROOT, input);
}

export function resolveLlmApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.LLM_API_KEY?.trim() ||
    env.DEEPSEEK_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    ""
  );
}

/** Codex keys come from the environment only — never from pig llmBaseUrl / settings.json. */
export function resolveCodexApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEEPSEEK_API_KEY?.trim() || env.CODEX_API_KEY?.trim() || "";
}

export function resolveCodexApiKeyEnvName(
  env: NodeJS.ProcessEnv = process.env,
): "DEEPSEEK_API_KEY" | "CODEX_API_KEY" {
  if (env.DEEPSEEK_API_KEY?.trim()) return "DEEPSEEK_API_KEY";
  return "CODEX_API_KEY";
}

/**
 * Codex provider base URL. Intentionally ignores `LLM_BASE_URL` / settings.llmBaseUrl
 * (those are OpenAI-compatible Chat Completions paths such as `…/v1`).
 */
export function resolveCodexBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_BASE_URL?.trim();
  if (!raw) return CODEX_DEEPSEEK_BASE_URL;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR = resolveFromProject(process.env.DATA_DIR ?? "./data");
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";

/** Isolated home for pig's Codex backend. Does not reuse ~/.codex (`CODEX_HOME`). */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PIG_CODEX_HOME?.trim();
  if (override) return resolveFromProject(override);
  return resolve(DATA_DIR, "codex-home");
}

/** Comma-separated host suffixes. Empty = any public host (still SSRF-blocked). */
export const HTTP_FETCH_ALLOWLIST = (process.env.HTTP_FETCH_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const DEFAULT_SETTINGS = {
  llmBaseUrl: process.env.LLM_BASE_URL?.trim() || DEEPSEEK_BASE_URL,
  llmApiKey: resolveLlmApiKey(),
  llmModel: process.env.LLM_MODEL?.trim() || DEEPSEEK_MODEL,
  workspaceRoot: resolveFromProject(
    process.env.WORKSPACE_ROOT ?? "./sample-workspace",
  ),
  runtime: "pig" as const,
  codexBinaryPath: process.env.CODEX_BIN?.trim() || "",
  codexModel: process.env.CODEX_MODEL?.trim() || CODEX_DEFAULT_MODEL,
  codexNetworkAccess: false,
} as const;

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

ensureDir(DATA_DIR);
