import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  executeComputerTool,
  hasComputerBridge,
  registerComputerRoutes,
} from "./computer.ts";

describe("desktop computer boundary", () => {
  it("rejects web and remote execution without a desktop parent", async () => {
    expect(hasComputerBridge()).toBe(false);
    await expect(
      executeComputerTool({ action: "click", x: 1, y: 2 }),
    ).rejects.toThrow("仅限本机");
    const app = new Hono();
    registerComputerRoutes(app);
    expect(
      await (await app.request("/api/desktop/computer/status")).json(),
    ).toEqual({ available: false, enabled: false, screenshotAvailable: false });
    expect(
      (await app.request("/api/desktop/computer/enable", { method: "POST" }))
        .status,
    ).toBe(403);
    expect((await app.request("/api/desktop/computer/screenshot")).status).toBe(
      404,
    );
  });
});
