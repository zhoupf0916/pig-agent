import { describe, expect, it } from "vitest";
import { normalizeSettings } from "./settings.ts";

describe("normalizeSettings", () => {
  it("defaults runtime to pig and network_access to false", () => {
    const settings = normalizeSettings({
      llmBaseUrl: "https://api.deepseek.com/v1",
      llmModel: "deepseek-chat",
      workspaceRoot: "/tmp",
    });
    expect(settings.runtime).toBe("pig");
    expect(settings.codexNetworkAccess).toBe(false);
    expect(settings.codexModel).toBe("deepseek-flash");
  });

  it("only enables Codex network when explicitly true", () => {
    expect(normalizeSettings({ codexNetworkAccess: false }).codexNetworkAccess).toBe(false);
    expect(normalizeSettings({}).codexNetworkAccess).toBe(false);
    expect(normalizeSettings({ codexNetworkAccess: true }).codexNetworkAccess).toBe(true);
  });
});
