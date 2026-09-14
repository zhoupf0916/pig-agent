import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../config.ts";
import { describeExecutionSurface, inspectExecutionSurface } from "./runtime-surface.ts";

describe("execution surface", () => {
  it("defaults to 本机 Pig and distinguishes Codex / Cloud stub / Cloud remote", () => {
    const pig = describeExecutionSurface({
      runtime: "pig",
      llmModel: "deepseek-chat",
      llmBaseUrl: "https://api.deepseek.com/v1",
    });
    expect(pig.kind).toBe("pig");
    expect(pig.label).toBe("本机 Pig");
    expect(pig.summary).toContain("deepseek-chat");

    const codex = describeExecutionSurface({
      runtime: "codex",
      codexModel: "deepseek-flash",
      codexNetworkAccess: false,
    });
    expect(codex.kind).toBe("codex");
    expect(codex.label).toBe("本机 Codex");
    expect(codex.summary).toBe("本机 Codex · deepseek-flash");

    const stub = describeExecutionSurface({ runtime: "cloud", cloudMode: "local-stub" });
    expect(stub.kind).toBe("cloud-stub");
    expect(stub.label).toBe("云端 · local-stub");
    expect(stub.summary).toBe("云端 · local-stub");

    const remote = describeExecutionSurface({
      runtime: "cloud",
      cloudMode: "remote",
      effectiveBaseUrl: "http://127.0.0.1:8080",
    });
    expect(remote.kind).toBe("cloud-remote");
    expect(remote.label).toBe("云端 · remote");
    expect(remote.detail).toBe("http://127.0.0.1:8080");
    expect(remote.summary).toBe("云端 · remote · http://127.0.0.1:8080");
  });

  it("inspects default settings as pig without changing DEFAULT_SETTINGS.runtime", () => {
    expect(DEFAULT_SETTINGS.runtime).toBe("pig");
    const surface = inspectExecutionSurface({ ...DEFAULT_SETTINGS });
    expect(surface.runtime).toBe("pig");
    expect(surface.kind).toBe("pig");
    expect(surface.label).toBe("本机 Pig");
  });
});
