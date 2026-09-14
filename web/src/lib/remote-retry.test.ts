import { describe, expect, it } from "vitest";
import { redactSecretsForDisplay, retryActionLabel } from "./remote-retry";

describe("remote retry labels", () => {
  it("names follow-up vs create-run and keeps remote unavailable as 重试", () => {
    expect(retryActionLabel("follow-up")).toBe("重试 · 继续跟进");
    expect(retryActionLabel("create-run")).toBe("重试 · 重新创建运行");
    expect(retryActionLabel("unavailable")).toBe("重试");
  });

  it("labels a local pig or Codex failure as 重试本轮", () => {
    expect(retryActionLabel(undefined, "turn")).toBe("重试本轮");
    expect(retryActionLabel()).toBe("重试本轮");
    expect(retryActionLabel(undefined, "unavailable")).toBe("无法重试");
  });

  it("redacts secrets so the banner never shows plaintext keys", () => {
    expect(redactSecretsForDisplay("失败 sk-abcdefghijklmnop 与 Bearer tok-abc")).toBe(
      "失败 … 与 …",
    );
  });
});
