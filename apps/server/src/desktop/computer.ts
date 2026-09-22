import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
type ComputerBridge = (
  method: "status" | "enable" | "revoke" | "execute" | "cancel",
  value?: Record<string, unknown>,
) => Promise<any>;
let bridge: ComputerBridge | undefined;
let screenshot: string | undefined;
export function setComputerBridge(value: ComputerBridge) {
  bridge = value;
}
export const computerToolDefinition = {
  type: "function" as const,
  function: {
    name: "computer_use",
    description:
      "Operate this Mac only through explicit user confirmation. Observe an app first (optional appName exact running app name, otherwise foreground app; Pig Agent itself and system permission apps are forbidden), then use accessibility coordinates. Never available in web or remote runs. Observations may contain private information. Screenshot preview is for the user; use returned accessibility elements to reason. Use observationId on every input, valid for 60 seconds and a single action. AX x/y/width/height allow targeting element centers. Re-observe after every action.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["observe", "click", "type", "key", "scroll"],
        },
        appName: { type: "string", maxLength: 100 },
        observationId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string", maxLength: 2000 },
        key: {
          type: "string",
          enum: [
            "enter",
            "tab",
            "escape",
            "backspace",
            "up",
            "down",
            "left",
            "right",
          ],
        },
        delta: { type: "integer", minimum: -2000, maximum: 2000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
export function hasComputerBridge() {
  return !!bridge;
}
export async function executeComputerTool(
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (!bridge)
    throw new Error("电脑操作仅限本机桌面客户端，网页及远端执行不可用");
  if (signal?.aborted) throw new Error("电脑操作已取消");
  if (args.action === "observe") screenshot = undefined;
  const requestId = randomUUID();
  const cancel = () => {
    void bridge!("cancel", { requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let result;
  try {
    result = await bridge("execute", { ...args, requestId });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (signal?.aborted) throw new Error("电脑操作已取消");
  const { screenshot: preview, ...text } = result;
  if (preview) screenshot = preview;
  return JSON.stringify({
    ...text,
    ...(preview
      ? { screenshotPreview: "/api/desktop/computer/screenshot" }
      : {}),
  });
}
export function registerComputerRoutes(app: Hono) {
  app.get("/api/desktop/computer/status", async (c) =>
    c.json(
      bridge
        ? { ...(await bridge("status")), screenshotAvailable: !!screenshot }
        : { available: false, enabled: false, screenshotAvailable: false },
    ),
  );
  for (const method of ["enable", "revoke"] as const)
    app.post(`/api/desktop/computer/${method}`, async (c) => {
      if (!bridge) return c.json({ error: "仅桌面客户端可用" }, 403);
      try {
        if (method === "revoke") screenshot = undefined;
        return c.json(await bridge(method));
      } catch (error) {
        return c.json(
          { error: error instanceof Error ? error.message : "操作失败" },
          400,
        );
      }
    });
  app.get("/api/desktop/computer/screenshot", (c) => {
    if (!screenshot) return c.json({ error: "暂无截图" }, 404);
    c.header("Cache-Control", "no-store");
    return c.body(
      Buffer.from(screenshot.replace(/^data:image\/png;base64,/, ""), "base64"),
      200,
      { "Content-Type": "image/png" },
    );
  });
}
