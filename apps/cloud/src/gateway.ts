import { networkRequestSchema, fetchApprovedNetwork } from "./network-fetch.ts";
import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
const app = new Hono();
app.onError((error, c) => {
  console.error(error.name);
  return c.json({ error: "模型网关暂时无法连接上游服务" }, 502);
});
app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
const control = process.env.CONTROL_URL || "http://cloud:8890";
app.get("/health", (c) => c.json({ ok: true }));
app.post("/approvals", async (c) => {
  const body = await c.req.json();
  const r = await fetch(control + "/internal/approvals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_TOKEN}`,
    },
    body: JSON.stringify({
      ...body,
      token: c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
    }),
    signal: AbortSignal.timeout(10000),
  });
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
});
app.post("/approvals/:id/poll", async (c) => {
  if (!/^approval_[a-f0-9]{32}$/.test(c.req.param("id")))
    return c.json({ error: "Invalid approval" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const r = await fetch(
    control + `/internal/approvals/${c.req.param("id")}/poll`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        requestId: body?.requestId,
        token: c.req.header("Authorization")?.replace(/^Bearer /, "") || "",
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
});
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
app.post("/network/fetch", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = networkRequestSchema.safeParse(body.request);
  if (!parsed.success || typeof body.callId !== "string")
    return c.json({ error: "无效网络请求" }, 400);
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  const claim = await fetch(control + "/internal/network/claim", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_TOKEN}`,
    },
    body: JSON.stringify({ token, callId: body.callId, request: parsed.data }),
    signal: AbortSignal.timeout(5000),
  });
  if (!claim.ok)
    return c.json({ error: "单次网络授权不可用；未访问目标地址" }, 403);
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    c.req.raw.signal,
    cancelled.signal,
    AbortSignal.timeout(parsed.data.timeoutMs),
  ]);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void authorize(token)
      .then((r) => {
        if (!r.ok) cancelled.abort();
      })
      .catch(() => cancelled.abort())
      .finally(() => {
        checking = false;
      });
  }, 500);
  try {
    return c.json(await fetchApprovedNetwork(parsed.data, signal));
  } catch {
    return c.json(
      {
        error:
          "网络访问失败、已取消或超时。该单次授权已使用；重试需要重新申请。",
      },
      502,
    );
  } finally {
    clearInterval(timer);
  }
});
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
    const networkTarget = [...(body.messages || [])].reverse().find((m: {role:string;content?:string})=>m.role === "user" && m.content?.includes("[NETWORK_ACCEPTANCE:"))?.content?.match(/\[NETWORK_ACCEPTANCE:(https:\/\/[^\]]+)\]/)?.[1];
    // Deterministic MCP probe for the existing local mock-model mode only.
    const mcpTarget = [...(body.messages || [])].reverse().find((m: {role:string;content?:string}) => m.role === "user" && m.content?.includes("[MCP_ACCEPTANCE:"))?.content?.match(/\[MCP_ACCEPTANCE:(echo|write_marker|slow)\]/)?.[1];
    const mcpTool = mcpTarget ? (body.tools || []).find((t: {function?:{name?:string}}) => t.function?.name?.endsWith("__" + mcpTarget)) : undefined;
    const call = mcpTarget ? (tools.length === 0 && mcpTool ? {id:"mcp-proof",type:"function",function:{name:mcpTool.function.name,arguments:JSON.stringify(mcpTarget === "write_marker" ? {marker:"MCP_RUNTIME_PROOF",path:"acceptance.txt"} : mcpTarget === "slow" ? {delayMs:15000} : {text:"MCP_RUNTIME_PROOF"})}} : null) : networkTarget ? (tools.length === 0 ? {
      id: "network-shell-probe", type: "function", function: {name:"run_shell",arguments:JSON.stringify({command:`node -e 'const https=require("https");const r=https.get("https://example.com/",()=>{console.log("UNEXPECTED_NETWORK");process.exit(0)});r.on("error",()=>{console.error("NETWORK_RESTRICTED");process.exit(1)});setTimeout(()=>{r.destroy();console.error("NETWORK_RESTRICTED");process.exit(1)},1500)'`,timeout_ms:3000})}
    } : tools.length === 1 ? {id:"network-read-proof",type:"function",function:{name:"http_fetch",arguments:JSON.stringify({url:networkTarget,timeout_ms:10000,max_bytes:200000})}} : null) :
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
          content: mcpTarget ? (mcpTool ? "MCP 模拟模型流程结束，请以实际工具结果核验。" : "MCP 工具不可用，本次未调用。") : networkTarget ? "单次网络访问验收：工具结果已返回（模拟模型），请以实际工具结果核验。" :
            "沙箱执行验收通过：已创建并读回 cloud-proof.txt。当前为模拟模型模式，尚未调用真实提供商。",
        };
    if (body.stream && !call) {
      // Deliberately paced mock output exercises the real streaming path.
      return streamSSE(c, async (stream) => {
        const text = message.content || "";
        for (let i = 0; i < text.length && !stream.aborted; i += 4) {
          await stream.writeSSE({
            data: JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: text.slice(i, i + 4) },
                  finish_reason: null,
                },
              ],
            }),
          });
          await stream.sleep(80);
        }
        if (!stream.aborted) {
          await stream.writeSSE({
            data: JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
        }
      });
    }
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
app.post("/mcp/tools", async (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  const response = await fetch(control + "/internal/mcp/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WORKER_TOKEN}` },
    body: JSON.stringify({ token }),
    signal: AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(120000)]),
  });
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
});
app.post("/mcp/invoke", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "") || "";
  const response = await fetch(control + "/internal/mcp/invoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WORKER_TOKEN}` },
    body: JSON.stringify({
      token,
      callId: body.callId,
      tool: body.tool,
      args: body.args,
      url: body.url,
      credentialVersion: body.credentialVersion,
    }),
    signal: AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(125000)]),
  });
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
});
app.onError((_e, c) => c.json({ error: "模型网关暂时不可用" }, 502));
serve({ fetch: app.fetch, port: 8891 });
