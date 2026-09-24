import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Never load a developer's .env files or share their persisted settings in tests.
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

const temporaryRoot = realpathSync(tmpdir());
process.env.TMPDIR = temporaryRoot;
const testData = mkdtempSync(join(temporaryRoot, "pig-agent-test-data-"));
const testWorkspace = mkdtempSync(join(temporaryRoot, "pig-agent-test-workspace-"));
process.env.DATA_DIR = testData;
process.env.WORKSPACE_ROOT = testWorkspace;
for (const key of [
  "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "DEEPSEEK_API_KEY", "OPENAI_API_KEY",
  "CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_MODEL", "CODEX_BIN", "PIG_CODEX_HOME",
  "PIG_CLOUD_BASE_URL", "PIG_CLOUD_TOKEN", "PIG_CLOUD_MODE", "PIG_CLOUD_REPO_URL",
  "PIG_CLOUD_REPO_REF", "PIG_CLOUD_RUNS_DIR", "CLOUD_BASE_URL", "CLOUD_TOKEN",
]) {
  delete process.env[key];
}

afterAll(() => {
  rmSync(testData, { recursive: true, force: true });
  rmSync(testWorkspace, { recursive: true, force: true });
});
