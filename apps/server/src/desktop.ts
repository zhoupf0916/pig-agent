import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { desktopAuth } from "./desktop/security.ts";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { PROJECT_ROOT } from "./config.ts";
import { startAutomationScheduler } from "./automations/scheduler.ts";
import { runningTurns } from "./agent/turn.ts";
import {
  setDesktopSecrets,
  type DesktopSecrets,
} from "./store/desktop-secrets.ts";
import { loadSettings } from "./store/settings.ts";

type ParentPort = {
  postMessage(value: unknown): void;
  on(event: "message", cb: (event: { data: any }) => void): void;
};
const parent = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;
if (!parent || !process.env.PIG_DESKTOP_TOKEN)
  throw new Error("Desktop parent required");
const pending = new Map<
  number,
  { resolve(value: DesktopSecrets): void; reject(error: Error): void }
>();
let sequence = 0;
function secretRequest(
  method: "read" | "write",
  value?: DesktopSecrets,
): Promise<DesktopSecrets> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("系统密钥存储未响应"));
    }, 15000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    parent!.postMessage({ type: "secret", id, method, value });
  });
}
setDesktopSecrets({
  read: () => secretRequest("read"),
  write: async (value) => {
    await secretRequest("write", value);
  },
});
process.chdir(PROJECT_ROOT);
const token = Buffer.from(process.env.PIG_DESKTOP_TOKEN);
delete process.env.PIG_DESKTOP_TOKEN; // Never inherit desktop authorization in agent shell commands.
const app = new Hono();
app.use("*", desktopAuth(token));
app.post("/api/desktop/test-connection", async (c) => {
  const settings = await loadSettings();
  try {
    const url = new URL(
      settings.llmBaseUrl.replace(/\/$/, "") + "/chat/completions",
    );
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("protocol");
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        ...(settings.llmApiKey
          ? { Authorization: `Bearer ${settings.llmApiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: settings.llmModel,
        messages: [{ role: "user", content: "Reply OK" }],
        max_tokens: 16,
        stream: false,
      }),
    });
    if (!response.ok)
      return c.json(
        {
          error: `模型连接失败（HTTP ${response.status}），请检查地址、模型、密钥和额度。`,
        },
        400,
      );
    const body = (await response.json()) as { choices?: unknown[] };
    if (!body.choices?.length)
      return c.json(
        { error: "接口没有返回有效的 Chat Completions 响应。" },
        400,
      );
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "连接失败或超时，请检查模型地址和网络。" }, 400);
  }
});
app.route("/", createApp());
app.use("/*", serveStatic({ root: "web/dist" }));
app.get("*", serveStatic({ root: "web/dist", path: "index.html" }));
const scheduler = startAutomationScheduler();
const server = serve(
  { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
  (info) => parent.postMessage({ type: "ready", port: info.port }),
);
parent.on("message", ({ data }) => {
  if (data.type === "secret-result") {
    const item = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) item?.reject(new Error("系统密钥存储不可用"));
    else item?.resolve(data.value);
  } else if (data.type === "shutdown") {
    scheduler.stop();
    for (const controller of runningTurns.values()) controller.abort();
    server.close(() => process.exit(0));
    setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      process.exit(0);
    }, 2000).unref();
  }
});
