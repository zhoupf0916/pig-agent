import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_DEEPSEEK_BASE_URL } from "../../config.ts";
import {
  assertCwdMatchesWorkspace,
  projectTableHeader,
  renderCodexConfig,
  resolveTrustedWorkspace,
  rewriteProjectTrust,
  stripProjectTables,
  syncCodexHome,
  trustedProjectsInToml,
} from "./home.ts";
import type { Settings } from "../../types.ts";

function settings(workspaceRoot: string, extra: Partial<Settings> = {}): Settings {
  return {
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "should-not-appear",
    llmModel: "deepseek-chat",
    workspaceRoot,
    runtime: "codex",
    codexBinaryPath: "",
    codexModel: "deepseek-flash",
    codexNetworkAccess: false,
    ...extra,
  };
}

describe("Codex project trust", () => {
  it("trusts only the realpath workspace and matches -C cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "pig-codex-trust-"));
    const real = realpathSync(root);
    const toml = renderCodexConfig({
      home: "/tmp/codex-home",
      model: "deepseek-flash",
      workspaceRealPath: real,
      networkAccess: false,
      baseUrl: CODEX_DEEPSEEK_BASE_URL,
    });
    expect(toml).toContain(projectTableHeader(real));
    expect(toml).toContain('trust_level = "trusted"');
    expect(trustedProjectsInToml(toml)).toEqual([real]);
    assertCwdMatchesWorkspace(real, real);
    expect(() => assertCwdMatchesWorkspace("/tmp", real)).toThrow(/does not match/);
  });

  it("rewrites stale project tables and never keeps arbitrary paths", () => {
    const dirty = [
      'model = "x"',
      "",
      '[projects."/etc"]',
      'trust_level = "trusted"',
      "",
      '[projects."/home/someone/secrets"]',
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const next = rewriteProjectTrust(dirty, "/safe/ws");
    expect(next).toContain('[projects."/safe/ws"]');
    expect(trustedProjectsInToml(next)).toEqual(["/safe/ws"]);
    expect(next).not.toContain("/etc");
    expect(next).not.toContain("/home/someone/secrets");
    expect(stripProjectTables(dirty)).not.toMatch(/projects\./);
  });

  it("resolves workspace through realpath (symlink)", () => {
    const real = mkdtempSync(join(tmpdir(), "pig-codex-real-"));
    const parent = mkdtempSync(join(tmpdir(), "pig-codex-link-"));
    const link = join(parent, "ws");
    symlinkSync(real, link);
    expect(resolveTrustedWorkspace(link)).toBe(realpathSync(real));
  });

  it("does not map pig Chat Completions /v1 into the Codex provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pig-codex-ws-"));
    const home = mkdtempSync(join(tmpdir(), "pig-codex-home-"));
    const { configPath } = await syncCodexHome(settings(workspace), {
      home,
      env: {
        ...process.env,
        LLM_BASE_URL: "https://api.deepseek.com/v1",
        CODEX_BASE_URL: "",
      },
    });
    const toml = readFileSync(configPath, "utf8");
    expect(toml).toContain(`base_url = "${CODEX_DEEPSEEK_BASE_URL}"`);
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain("network_access = false");
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).not.toContain("/v1");
    expect(toml).not.toContain("should-not-appear");
    expect(toml).not.toContain("experimental_bearer_token");
  });
});
