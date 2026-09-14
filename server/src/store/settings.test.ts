import { describe, expect, it } from "vitest";
import { assertCloudSettings, normalizeSettings, parseAgentRuntime } from "./settings.ts";

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
    expect(settings.cloudMode).toBe("local-stub");
    expect(settings.cloudBaseUrl).toBe("");
    expect(settings.cloudRepoUrl).toBe("");
    expect(settings.cloudRepoRef).toBe("");
  });

  it("accepts cloud runtime and strips /v1 from the control-plane URL", () => {
    const settings = normalizeSettings({
      runtime: "cloud",
      cloudMode: "remote",
      cloudBaseUrl: "https://cp.example.com/v1/",
      cloudToken: "tok",
      cloudRepoUrl: "https://github.com/acme/app.git",
      cloudRepoRef: "main",
    });
    expect(settings.runtime).toBe("cloud");
    expect(settings.cloudMode).toBe("remote");
    expect(settings.cloudBaseUrl).toBe("https://cp.example.com");
    expect(settings.cloudToken).toBe("tok");
    expect(settings.cloudRepoUrl).toBe("https://github.com/acme/app.git");
    expect(settings.cloudRepoRef).toBe("main");
  });

  it("keeps unknown runtimes on pig", () => {
    expect(parseAgentRuntime("nope")).toBe("pig");
    expect(parseAgentRuntime("cloud")).toBe("cloud");
  });

  it("requires a control-plane URL only in remote mode", () => {
    const isolated = { envJson: {}, env: {} as NodeJS.ProcessEnv };
    expect(() =>
      assertCloudSettings(
        normalizeSettings({ runtime: "cloud", cloudMode: "local-stub", cloudBaseUrl: "" }),
        isolated,
      ),
    ).not.toThrow();
    expect(() =>
      assertCloudSettings(
        normalizeSettings({ runtime: "cloud", cloudMode: "remote", cloudBaseUrl: "" }),
        isolated,
      ),
    ).toThrow(/Cloud base URL is required/);
    expect(() =>
      assertCloudSettings(
        normalizeSettings({
          runtime: "cloud",
          cloudMode: "remote",
          cloudBaseUrl: "ftp://not-http.example",
        }),
        isolated,
      ),
    ).toThrow(/http\(s\)/);
    expect(() =>
      assertCloudSettings(
        normalizeSettings({ runtime: "cloud", cloudMode: "remote", cloudBaseUrl: "" }),
        { envJson: { baseUrl: "http://127.0.0.1:8080" }, env: {} },
      ),
    ).not.toThrow();
  });

  it("only enables Codex network when explicitly true", () => {
    expect(normalizeSettings({ codexNetworkAccess: false }).codexNetworkAccess).toBe(false);
    expect(normalizeSettings({}).codexNetworkAccess).toBe(false);
    expect(normalizeSettings({ codexNetworkAccess: true }).codexNetworkAccess).toBe(true);
  });
});
