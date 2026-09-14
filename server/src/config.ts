import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "../..");

loadEnv({ path: resolve(PROJECT_ROOT, ".env") });

export const SKILLS_DIR = resolve(PROJECT_ROOT, "skills");

export function resolveFromProject(input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(PROJECT_ROOT, input);
}

export const PORT = Number(process.env.PORT ?? 8787);
export const DATA_DIR = resolveFromProject(process.env.DATA_DIR ?? "./data");
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";

export const DEFAULT_SETTINGS = {
  llmBaseUrl: process.env.LLM_BASE_URL ?? "http://127.0.0.1:11434/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "ollama",
  llmModel: process.env.LLM_MODEL ?? "llama3.2",
  workspaceRoot: resolveFromProject(
    process.env.WORKSPACE_ROOT ?? "./sample-workspace",
  ),
} as const;

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

ensureDir(DATA_DIR);
