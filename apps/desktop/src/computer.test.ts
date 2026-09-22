import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateAction, createComputer } = require("./computer.cjs");
describe("native computer guards", () => {
  it("only permits bounded input and strips caller-supplied target/process arguments", () => {
    expect(
      validateAction({
        action: "click",
        x: 1,
        y: 2,
        observationId: "test",
        pid: 999,
        command: "rm",
      }),
    ).toEqual({ action: "click", x: 1, y: 2, observationId: "test" });
    for (const input of [
      { action: "shell" },
      { action: "click", x: Infinity, y: 2 },
      { action: "type", text: "x".repeat(2001) },
      { action: "key", key: "cmd+q" },
      { action: "scroll", delta: 2001 },
      { action: "scroll", delta: 1.1 },
    ])
      expect(() =>
        validateAction({ observationId: "fresh", ...input }),
      ).toThrow();
  });
  it.skipIf(process.platform !== "darwin")(
    "defaults disabled, respects native opt-in cancellation and immediate revoke",
    async () => {
      let answer = 0;
      const computer = createComputer({
        app: { getPath: () => "/tmp" },
        dialog: { showMessageBox: async () => ({ response: answer }) },
        systemPreferences: {
          isTrustedAccessibilityClient: () => false,
          getMediaAccessStatus: () => "denied",
        },
        desktopCapturer: {},
        getWindow: () => undefined,
      });
      await expect(computer("execute", { action: "observe" })).rejects.toThrow(
        "启用",
      );
      expect(await computer("enable")).toMatchObject({
        available: true,
        enabled: false,
      });
      answer = 1;
      expect(await computer("enable")).toMatchObject({
        available: true,
        enabled: true,
      });
      expect(await computer("revoke")).toMatchObject({
        available: true,
        enabled: false,
      });
      expect(await computer("status")).toMatchObject({
        enabled: false,
        accessibility: false,
        screen: "denied",
      });
    },
  );
  it.skipIf(process.platform !== "darwin")(
    "revocation while native enable confirmation is open cannot re-enable",
    async () => {
      let approve!: (value: { response: number }) => void;
      const computer = createComputer({
        app: { getPath: () => "/tmp" },
        dialog: {
          showMessageBox: () =>
            new Promise((resolve) => {
              approve = resolve;
            }),
        },
        systemPreferences: {
          isTrustedAccessibilityClient: () => false,
          getMediaAccessStatus: () => "denied",
        },
        desktopCapturer: {},
        getWindow: () => undefined,
      });
      const pending = computer("enable");
      await computer("revoke");
      approve({ response: 1 });
      expect(await pending).toMatchObject({ available: true, enabled: false });
    },
  );
});
