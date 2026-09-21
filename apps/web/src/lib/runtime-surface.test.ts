import { describe, expect, it } from "vitest";
import type { Settings } from "../types";
import { describeExecutionSurface, surfaceForSession } from "./runtime-surface";

describe("describeExecutionSurface", () => {
  it("keeps unknown runtimes on 本机 Pig", () => {
    const surface = describeExecutionSurface({ runtime: "nope" });
    expect(surface.runtime).toBe("pig");
    expect(surface.label).toBe("本机 Pig");
  });

  it("shows remote URL/mode for cloud remote", () => {
    const surface = describeExecutionSurface({
      runtime: "cloud",
      cloudMode: "remote",
      cloudBaseUrl: "",
      effectiveBaseUrl: "http://127.0.0.1:8080",
    });
    expect(surface.kind).toBe("cloud-remote");
    expect(surface.summary).toBe("云端 · remote · http://127.0.0.1:8080");
  });

  it("flags remote without a URL instead of looking like local-stub", () => {
    const surface = describeExecutionSurface({
      runtime: "cloud",
      cloudMode: "remote",
    });
    expect(surface.kind).toBe("cloud-remote");
    expect(surface.detail).toBe("未配置控制面 URL");
  });
});

describe("surfaceForSession", () => {
  const local = {
    runtime: "pig",
    llmModel: "deepseek-chat",
    llmBaseUrl: "https://api.deepseek.com/v1",
    cloudMode: "remote",
    cloudBaseUrl: "http://127.0.0.1:8892",
    executionSurface: describeExecutionSurface({ runtime: "pig" }),
  } as Settings;
  const cloud = {
    ...local,
    runtime: "cloud",
    executionSurface: describeExecutionSurface({
      runtime: "cloud",
      cloudMode: "remote",
      cloudBaseUrl: local.cloudBaseUrl,
    }),
  } as Settings;
  it("uses remote session instead of cached global Pig", () => {
    expect(
      surfaceForSession(local, { executionTarget: "remote", engine: "pig" }),
    ).toMatchObject({
      runtime: "cloud",
      kind: "cloud-remote",
      detail: local.cloudBaseUrl,
    });
  });
  it("uses local Pig session instead of cached global cloud", () => {
    expect(
      surfaceForSession(cloud, { executionTarget: "local", engine: "pig" }),
    ).toMatchObject({ runtime: "pig", kind: "pig" });
  });
  it("uses local Codex session instead of cached global cloud", () => {
    expect(
      surfaceForSession(cloud, { executionTarget: "local", engine: "codex" }),
    ).toMatchObject({ runtime: "codex", kind: "codex" });
  });
  it("preserves the default server surface for sessions without an override", () => {
    expect(surfaceForSession(cloud, {})).toBe(cloud.executionSurface);
  });
});
