import type { Settings } from "../../types.ts";

/** Explicit Codex settings override only the Codex provider, never Pig credentials. */
export function codexEnvironment(settings: Settings, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (settings.codexApiKey?.trim()) {
    delete env.DEEPSEEK_API_KEY;
    env.CODEX_API_KEY = settings.codexApiKey.trim();
  }
  if (settings.codexBaseUrl?.trim()) env.CODEX_BASE_URL = settings.codexBaseUrl.trim();
  return env;
}
