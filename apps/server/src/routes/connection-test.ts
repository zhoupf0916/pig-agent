import type { Hono } from "hono";
import { loadSettings } from "../store/settings.ts";

export function registerConnectionTest(app: Hono): void {
  app.post("/api/settings/test-connection", async c => {
    const settings = await loadSettings();
    if (settings.runtime === "cloud") return c.json({ error: "云端请使用控制面连接状态检查。" }, 400);
    try {
      const url = new URL(settings.llmBaseUrl.replace(/\/$/, "") + "/chat/completions");
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
      const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(20000), c.req.raw.signal]),
        headers: { "Content-Type": "application/json", ...(settings.llmApiKey ? { Authorization: `Bearer ${settings.llmApiKey}` } : {}) },
        body: JSON.stringify({ model: settings.llmModel, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 16, stream: false }),
      });
      if (!response.ok) return c.json({ error: `模型连接失败（HTTP ${response.status}），请检查地址、模型、密钥和额度。` }, 400);
      const body = await response.json() as { choices?: unknown[] };
      if (!body.choices?.length) return c.json({ error: "接口没有返回有效的 Chat Completions 响应。" }, 400);
      return c.json({ ok: true, runtime: "pig" });
    } catch { return c.json({ error: "连接失败或超时，请检查模型地址和网络。" }, 400); }
  });
}
