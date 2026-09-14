import { describe, expect, it } from "vitest";
import { describeExecutionSurface } from "./runtime-surface";

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
    const surface = describeExecutionSurface({ runtime: "cloud", cloudMode: "remote" });
    expect(surface.kind).toBe("cloud-remote");
    expect(surface.detail).toBe("未配置控制面 URL");
  });
});
