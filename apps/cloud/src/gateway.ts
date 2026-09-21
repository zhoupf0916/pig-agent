import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
const app = new Hono();
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
const control = process.env.CONTROL_URL || "http://cloud:8890";
app.get("/health", (c) => c.json({ ok: true }));
async function authorize(token: string, reserve = false) {
  return fetch(control + "/internal/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_TOKEN}`,
    },
    body: JSON.stringify({ token, reserve }),
    signal: AbortSignal.timeout(5000),
  });
}
app.get("/task", async (c) => {
  const r = await authorize(
    c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
  );
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
});
app.post("/v1/chat/completions", async (c) => {
  const auth = await authorize(
    c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    true,
  );
  if (!auth.ok)
    return c.json({ error: "运行令牌失效或调用预算不足" }, auth.status as 401);
  const { provider } = (await auth.json()) as {
    provider?: { baseUrl: string; model: string; apiKey: string };
  };
  const body = await c.req.json();
  if (!provider && (process.env.MODEL_MODE || "mock") === "mock") {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const tools = (body.messages || []).filter(
      (m: { role: string }) => m.role === "tool",
    );
    const call =
      tools.length === 0
        ? {
            id: "write-proof",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "cloud-proof.txt",
                content: "PIG_CLOUD_CONTAINER_OK\n",
              }),
            },
          }
        : tools.length === 1
          ? {
              id: "read-proof",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "cloud-proof.txt" }),
              },
            }
          : null;
    const message = call
      ? { role: "assistant", content: null, tool_calls: [call] }
      : {
          role: "assistant",
          content:
            "容器执行验收通过：已创建并读回 cloud-proof.txt。当前为模拟模型模式，尚未调用真实提供商。",
        };
    if (body.stream) {
      const delta = call
        ? { tool_calls: [{ index: 0, ...call }] }
        : { content: message.content };
      return c.body(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        200,
        { "Content-Type": "text/event-stream" },
      );
    }
    return c.json({
      choices: [{ message, finish_reason: call ? "tool_calls" : "stop" }],
    });
  }
  if (!provider?.apiKey && !process.env.MODEL_API_KEY)
    return c.json({ error: "平台尚未配置模型 Key" }, 503);
  const response = await fetch(
    (
      provider?.baseUrl ||
      process.env.MODEL_BASE_URL ||
      "https://api.deepseek.com/v1"
    ).replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider?.apiKey || process.env.MODEL_API_KEY}`,
      },
      body: JSON.stringify({
        ...body,
        model: provider?.model || process.env.MODEL_NAME || "deepseek-chat",
        max_tokens: Math.min(Number(body.max_tokens) || 4096, 4096),
      }),
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90000)]),
    },
  );
  if (!response.ok)
    return c.json({ error: `模型服务 HTTP ${response.status}` }, 502);
  return new Response(response.body, {
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") || "application/json",
    },
  });
});
app.onError((_e, c) => c.json({ error: "模型网关暂时不可用" }, 502));
serve({ fetch: app.fetch, port: 8891 });
