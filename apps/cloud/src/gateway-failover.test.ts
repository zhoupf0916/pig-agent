import { afterEach, expect, it, vi } from "vitest";
const captured = vi.hoisted(() => ({ fetch: undefined as undefined | ((r: Request) => Promise<Response>) }));
vi.mock("@hono/node-server", () => ({ serve: (options: { fetch: (r: Request) => Promise<Response> }) => { captured.fetch = options.fetch; } }));
import "./gateway.ts";

const providers = [
  { id: "channel_" + "a".repeat(32), baseUrl: "https://primary.test/v1", model: "p", apiKey: "test-only", maxOutputTokens: 300 },
  { id: "channel_" + "b".repeat(32), baseUrl: "https://standby.test/v1", model: "s", apiKey: "test-only", maxOutputTokens: 300 },
];
const call = (body: unknown) =>
  captured.fetch!(new Request("http://gateway/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
function stub(upstream: (url: string, body: any) => Response | Promise<Response>) {
  const settles: any[] = [];
  const upstreamCalls: Array<{ url: string; body: any }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const path = String(url);
    if (path.endsWith("/internal/authorize")) return Response.json({ billingId: "7", provider: providers[0], providers });
    if (path.endsWith("/internal/model-settle")) {
      settles.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true });
    }
    const body = JSON.parse(String(options?.body));
    upstreamCalls.push({ url: path, body });
    return upstream(path, body);
  });
  return { settles, upstreamCalls };
}
afterEach(() => vi.restoreAllMocks());

it("主渠道 503 时切换到备用渠道，并按实际渠道结算", async () => {
  const { settles, upstreamCalls } = stub((url) =>
    url.includes("primary") ? new Response("down", { status: 503 }) : Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  );
  const r = await call({ messages: [{ role: "user", content: "hi" }], max_tokens: 99999 });
  expect(r.status).toBe(200);
  expect(upstreamCalls.map((c) => [new URL(c.url).hostname, c.body.model, c.body.max_tokens])).toEqual([["primary.test", "p", 300], ["standby.test", "s", 300]]);
  expect(settles).toEqual([{ billingId: "7", usage: { prompt_tokens: 3, completion_tokens: 1 }, kind: "usage", channelId: providers[1]!.id }]);
});

it("所有渠道失败时返回 502 并释放预留", async () => {
  const { settles } = stub(() => new Response("busy", { status: 429 }));
  const r = await call({ messages: [{ role: "user", content: "hi" }] });
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ attempts: 2 });
  expect(settles).toEqual([{ billingId: "7", usage: { prompt_tokens: 0, completion_tokens: 0 }, kind: "usage" }]);
});

it("提供商无视 max_tokens 时在输出上限处截断流并按估算结算", async () => {
  const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "字".repeat(50) } }] })}\n\n`;
  let sent = 0;
  const { settles } = stub(() =>
    new Response(new ReadableStream({ pull(c) { sent++; if (sent > 200) c.close(); else c.enqueue(new TextEncoder().encode(frame)); } }), { headers: { "Content-Type": "text/event-stream" } }),
  );
  const r = await call({ messages: [{ role: "user", content: "写很长" }], stream: true });
  const text = await r.text();
  expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  expect(text).toContain('"finish_reason":"length"');
  expect(sent).toBeLessThan(20); // cap 300 + slack 139 ≈ 9 frames of 50 tokens
  expect(settles).toHaveLength(1);
  expect(settles[0]).toMatchObject({ kind: "estimated", channelId: providers[0]!.id });
  expect(settles[0].usage.completion_tokens).toBeGreaterThan(300);
});

it("流式响应带 usage 时只结算一次真实用量", async () => {
  const body = [
    { choices: [{ index: 0, delta: { content: "hi" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 1 } },
  ].map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  const { settles } = stub(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const r = await call({ messages: [{ role: "user", content: "hi" }], stream: true });
  expect(await r.text()).toBe(body);
  expect(settles).toEqual([{ billingId: "7", usage: { prompt_tokens: 4, completion_tokens: 1 }, kind: "usage", channelId: providers[0]!.id }]);
});
