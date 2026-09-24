import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  handler: undefined as undefined | ((request: Request) => Promise<Response>),
  target: vi.fn(),
}));
vi.mock("@hono/node-server", () => ({ serve: (options: { fetch: typeof state.handler }) => { state.handler = options.fetch; } }));
vi.mock("./network-fetch.ts", async (original) => ({
  ...await original<typeof import("./network-fetch.ts")>(),
  fetchApprovedNetwork: state.target,
}));
import "./gateway.ts";
import { NetworkAccessError } from "./network-errors.ts";
afterEach(() => { vi.restoreAllMocks(); state.target.mockReset(); });
function request() {
  return new Request("http://gateway/network/fetch", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId: "fixture-call", request: { url: "https://example.com/" } }),
  });
}
it("未批准的网络请求返回 403 且不连接目标", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
  const response = await state.handler!(request());
  expect(response.status).toBe(403);
  expect(state.target).not.toHaveBeenCalled();
  expect(((await response.json()) as { error: string }).error).toContain("未访问目标");
});
it("已批准但 DNS 失败时返回明确阶段而非再次要求开放沙箱", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
  state.target.mockRejectedValue(new NetworkAccessError("DNS_FAILED", "dns", "域名解析失败"));
  const response = await state.handler!(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "域名解析失败 此次网络审批已经通过并使用；重新请求需要再次批准。",
    code: "DNS_FAILED", phase: "dns",
  });
  expect(state.target).toHaveBeenCalledTimes(1);
});
