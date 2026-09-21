import { spawn } from "node:child_process";
import { resolve } from "node:path";
const env = {
  ...process.env,
  PIG_DESKTOP: "1",
  PORT: "8799",
  DATA_DIR: resolve("data/redesign-local/store"),
  WORKSPACE_ROOT: resolve("data/redesign-local/workspace"),
};
for (const key of Object.keys(env))
  if (/^(LLM_|DEEPSEEK_|OPENAI_|CODEX_|CLOUD_|PIG_CLOUD_)/.test(key))
    delete env[key];
const p = spawn(
  process.execPath,
  ["--import", "tsx", "apps/server/src/index.ts"],
  { env, stdio: "inherit" },
);
process.on("SIGTERM", () => p.kill("SIGTERM"));
process.on("SIGINT", () => p.kill("SIGTERM"));
