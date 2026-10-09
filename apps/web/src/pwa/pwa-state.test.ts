import { describe, expect, it } from "vitest";
import { isIosSafari, notificationState, openTarget, runNotice } from "./pwa-state";

describe("pwa state helpers", () => {
  it("derives notification state from support, permission and preference", () => {
    expect(notificationState({ supported: false, permission: "granted", preference: "on" })).toBe("unsupported");
    expect(notificationState({ supported: true, permission: "denied", preference: "on" })).toBe("blocked");
    expect(notificationState({ supported: true, permission: "granted", preference: "on" })).toBe("on");
    expect(notificationState({ supported: true, permission: "granted", preference: null })).toBe("off");
    expect(notificationState({ supported: true, permission: "default", preference: "on" })).toBe("off");
  });
  it("detects iOS Safari but not other iOS browsers", () => {
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(isIosSafari(safari, 5)).toBe(true);
    expect(isIosSafari(safari.replace("Version/18.0", "CriOS/130.0"), 5)).toBe(false);
    expect(isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5)).toBe(true);
    expect(isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0)).toBe(false);
  });
  it("only follows same-origin hash routes from notification clicks", () => {
    expect(openTarget("/#/conversations/conv_1")).toBe("#/conversations/conv_1");
    expect(openTarget("//evil.example/#/x")).toBeNull();
    expect(openTarget("https://evil.example/#/x")).toBeNull();
    expect(openTarget("/settings")).toBeNull();
    expect(openTarget(42)).toBeNull();
  });
  it("builds short Chinese notices", () => {
    expect(runNotice("finished", "整理周报", "succeeded")).toEqual({ title: "任务已完成", body: "「整理周报」已完成，点击查看结果" });
    expect(runNotice("finished", "  ", "failed").body).toContain("「新任务」");
    expect(runNotice("approval", "部署").title).toBe("需要你的审批");
    expect(runNotice("finished", "x".repeat(200), "cancelled").body.length).toBeLessThan(80);
  });
});
