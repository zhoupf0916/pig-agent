import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Settings } from "../../types.ts";
import { assertCodexReady, inspectCodexStatus } from "./validate.ts";

function settings(extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "pig-key-must-not-count",
    llmModel: "deepseek-chat",
    workspaceRoot: mkdtempSync(join(tmpdir(), "pig-codex-val-")),
    runtime: "codex",
    codexBinaryPath: "/definitely/missing/codex-bin",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    cloudBaseUrl: "",
    cloudToken: "",
    cloudMode: "local-stub",
    ...extra,
  };
}

describe("Codex startup validation", () => {
  it("requires a real binary and an env key (not pig settings.llmApiKey)", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: "/empty-path" };
    delete env.DEEPSEEK_API_KEY;
    delete env.CODEX_API_KEY;
    const s = settings();
    const status = inspectCodexStatus(s, env);
    expect(status.binaryFound).toBe(false);
    expect(status.apiKeyPresent).toBe(false);
    expect(() => assertCodexReady(s, env)).toThrow(/Codex binary not found/);
  });

  it("accepts DEEPSEEK_API_KEY from the environment", () => {
    const env = { ...process.env, DEEPSEEK_API_KEY: "sk-test", PATH: "/empty-path" };
    const status = inspectCodexStatus(settings(), env);
    expect(status.apiKeyPresent).toBe(true);
  });
});
