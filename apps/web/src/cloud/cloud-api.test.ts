import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceCloudIdentity, cloudRequest } from "./cloud-api";
describe("cloud identity request boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("does not let an old account 401 expire the new account", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const pending = cloudRequest("/v1/memory").catch((e) => e);
    advanceCloudIdentity();
    complete(
      new Response(JSON.stringify({ error: "expired" }), { status: 401 }),
    );
    expect((await pending).message).toBe("账号已切换，已忽略旧请求");
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it("expires the current account on its own 401 and preserves idempotency headers", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ error: "expired" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      cloudRequest(
        "/v1/schedules/test/run",
        "POST",
        {},
        { "Idempotency-Key": "request-1" },
      ),
    ).rejects.toThrow("expired");
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"),
    ).toBe("request-1");
  });
});
